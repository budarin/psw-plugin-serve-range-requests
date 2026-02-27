import type {
    FetchResponse,
    PluginContext,
    ServiceWorkerPlugin,
} from '@budarin/pluggable-serviceworker';
import { matchByUrl } from '@budarin/pluggable-serviceworker/utils';

import {
    HEADER_CONTENT_LENGTH,
    HEADER_RANGE,
} from '@budarin/http-constants/headers';
import { HTTP_STATUS_PARTIAL_CONTENT } from '@budarin/http-constants/statuses';

import type {
    CachedRange,
    FileMetadata,
    RangeCacheKey,
    UrlString,
} from './types.js';
import {
    buildRangeResponseHeaders,
    extractMetadataFromResponse,
} from './rangeResponse.js';
import {
    type Range,
    createRangeStream,
    ifRangeMatches,
    parseRangeHeader,
    shouldProcessFile,
} from './rangeUtils.js';

export {
    VIDEO_PRESET,
    AUDIO_PRESET,
    MAPS_PRESET,
    DOCS_PRESET,
    getAdaptivePresets,
} from './presets.js';

export interface RangePluginOptions {
    /**
     * Имя кеша для поиска файлов
     */
    cacheName: string;
    /**
     * Порядок выполнения плагина (по умолчанию -10, чтобы выполняться раньше основного кеширования)
     */
    order?: number;
    /**
     * Максимальное количество закешированных range-ответов (по умолчанию 100).
     * Для видео при перемотках почти бесполезно — каждый seek запрашивает новый диапазон,
     * повторное попадание в тот же участок редко. Для карт и документов — полезно.
     */
    maxCachedRanges?: number;
    /**
     * Включить подробное логирование (по умолчанию false)
     */
    enableLogging?: boolean;
    /**
     * Максимальный размер одной кешируемой записи (диапазона) в байтах (по умолчанию 10MB).
     * Диапазоны больше не кешируются — защита от переполнения памяти.
     */
    maxCacheableRangeSize?: number;
    /**
     * Маски файлов для обработки (glob паттерны)
     * Если указано, плагин будет обрабатывать только файлы, соответствующие этим маскам
     * Примеры: ['*.pmtiles'], ['*.mp4', '*.webm'], ['/videos/*']
     */
    include?: string[];
    /**
     * Маски файлов для исключения (glob паттерны)
     * Файлы, соответствующие этим маскам, не будут обрабатываться
     * Примеры: ['*.json'], ['/small-files/*']
     */
    exclude?: string[];
    /**
     * Значение заголовка Cache-Control для ответов 206.
     * По умолчанию не задано — заголовок не выставляется.
     * Можно передать строку (например `max-age=3600`) для других типов контента.
     */
    rangeResponseCacheControl?: string;
    /**
     * Максимум одновременных чтений диапазонов на один URL (по умолчанию 4).
     * Карты: 4–8 для параллельной загрузки тайлов. Видео: 2–4, иначе при перемотке
     * слишком много конкурирующих запросов.
     */
    maxConcurrentRangesPerUrl?: number;
    /**
     * true (по умолчанию) — видео/аудио: семафор, LIFO-очередь, abort при новом запросе.
     * false — карты/документы: без очередей, все запросы параллельно.
     */
    prioritizeLatestRequest?: boolean;
    /**
     * true (по умолчанию) — при отсутствии файла в кеше возвращать undefined и параллельно
     * запускать фоновую загрузку в кеш (восстановление повреждённого кеша по аналогии с restoreAssetToCache).
     * false — только возвращать undefined, без восстановления.
     */
    restoreMissingToCache?: boolean;
    /**
     * Максимум разных файлов (URL), по которым плагин учитывает ограничение одновременных запросов.
     * На каждый уникальный URL ведётся запись в памяти; при большом числе разных файлов без лимита
     * потребление памяти растёт. maxTrackedUrls ограничивает число таких записей; при превышении
     * вытесняются данные по файлам, по которым нет активных или ожидающих запросов. По умолчанию 512.
     */
    maxTrackedUrls?: number;
}

/**
 * Плагин для обработки HTTP Range запросов: отдаёт частичное содержимое файлов из кеша SW.
 *
 * @param options - Опции конфигурации плагина
 * @returns ServiceWorkerPlugin для обработки Range запросов
 */
export function serveRangeRequests(
    options: RangePluginOptions
): ServiceWorkerPlugin {
    const {
        cacheName,
        order = -10,
        maxCachedRanges = 100,
        enableLogging = false,
        include,
        exclude,
        rangeResponseCacheControl,
        maxConcurrentRangesPerUrl = 4,
        prioritizeLatestRequest = true,
        restoreMissingToCache = true,
        maxTrackedUrls = 512,
    } = options;

    // Кеш для range-ответов (LRU через Map)
    const rangeCache = new Map<RangeCacheKey, CachedRange>();
    // Кеш метаданных файлов
    const fileMetadataCache = new Map<UrlString, FileMetadata>();
    // Кеш для Cache API объектов
    let cacheInstance: Cache | null = null;
    /** URL, по которым идёт восстановление в кеш (чтобы не дублировать) */
    const restoreInProgress = new Set<UrlString>();
    /** Единственный ожидающий слот. При новом запросе предыдущий отменяется через resolve(null). */
    interface NextWaiter {
        resolve: (release: (() => void) | null) => void;
        wake: () => void;
    }

    type UrlState = {
        count: number;
        nextWaiter: NextWaiter | null;
        abortController: AbortController;
    };
    let urlSemaphore: Map<UrlString, UrlState> | null = null;
    /** Лимит записей по URL (семафор) — из maxTrackedUrls; при 0 лимит не применяется. */
    const maxUrlStates = maxTrackedUrls;

    function getOrCreateUrlState(url: UrlString): UrlState {
        if (!urlSemaphore) {
            urlSemaphore = new Map();
        }
        let state = urlSemaphore.get(url);
        if (!state) {
            if (maxUrlStates > 0 && urlSemaphore.size >= maxUrlStates) {
                for (const [key, s] of urlSemaphore) {
                    if (s.count === 0 && !s.nextWaiter) {
                        urlSemaphore.delete(key);
                        break;
                    }
                }
            }
            state = {
                count: 0,
                nextWaiter: null,
                abortController: new AbortController(),
            };
            urlSemaphore.set(url, state);
        }
        return state;
    }

    /**
     * Объединяет несколько AbortSignal — при отмене любого работа останавливается.
     */
    function mergeAbortSignals(...signals: AbortSignal[]): AbortSignal {
        const aborted = signals.find((s) => s.aborted);
        if (aborted) {
            return aborted;
        }
        if (typeof AbortSignal.any === 'function') {
            return AbortSignal.any(signals);
        }
        const ac = new AbortController();
        const abort = () => ac.abort();
        for (const s of signals) {
            s.addEventListener('abort', abort, { once: true });
        }
        return ac.signal;
    }

    function acquireRangeSlot(url: UrlString): Promise<(() => void) | null> {
        if (!prioritizeLatestRequest) {
            return Promise.resolve(() => {});
        }

        const state = getOrCreateUrlState(url);

        return new Promise<(() => void) | null>((resolve) => {
            const release = () => {
                state.count--;
                const waiter = state.nextWaiter;
                state.nextWaiter = null;
                if (waiter) {
                    waiter.wake();
                }
            };

            const wake = () => {
                state.count++;
                resolve(release);
            };

            if (state.count < maxConcurrentRangesPerUrl) {
                state.count++;
                resolve(release);
                return;
            }

            state.abortController.abort();
            state.abortController = new AbortController();
            const prev = state.nextWaiter;
            state.nextWaiter = null;
            if (prev) {
                prev.resolve(null);
            }

            state.nextWaiter = { resolve, wake };
        });
    }

    /**
     * Получает кеш инстанс (с кешированием). При ошибке сбрасывает cacheInstance.
     */
    async function getCache(): Promise<Cache> {
        try {
            if (!cacheInstance) {
                cacheInstance = await caches.open(cacheName);
            }
            return cacheInstance;
        } catch (error) {
            cacheInstance = null;
            throw error;
        }
    }

    /**
     * Управляет размером кеша метаданных (LRU стратегия). Лимит = maxCachedRanges.
     */
    function manageMetadataCacheSize(): void {
        if (maxCachedRanges <= 0) {
            return;
        }
        if (fileMetadataCache.size >= maxCachedRanges) {
            const firstKey = fileMetadataCache.keys().next().value;
            if (firstKey) {
                fileMetadataCache.delete(firstKey);
                if (enableLogging) {
                    console.log(
                        `Metadata cache: removed old entry ${firstKey}`
                    );
                }
            }
        }
    }

    /**
     * Получает запись из кеша и обновляет её позицию (LRU)
     */
    function getCachedRange(cacheKey: RangeCacheKey): CachedRange | undefined {
        const cached = rangeCache.get(cacheKey);
        if (cached) {
            // Перемещаем в конец для LRU
            rangeCache.delete(cacheKey);
            rangeCache.set(cacheKey, cached);
        }
        return cached;
    }

    return {
        name: 'range-requests',
        order,

        async fetch(event: FetchEvent, context: PluginContext): FetchResponse {
            const request = event.request;
            // Имя заголовка passthrough приходит из контекста фреймворка
            const passthroughHeader = context.passthroughHeader!;

            // Не обрабатываем свои же внутренние запросы (fallback и restore) — пусть уходят в сеть
            if (request.headers.get(passthroughHeader)) {
                return;
            }

            const rangeHeader = request.headers.get(HEADER_RANGE);

            if (!rangeHeader) {
                return;
            }
            if (request.method !== 'GET') {
                return;
            }
            const signal = request.signal;
            if (signal.aborted) {
                if (enableLogging) {
                    console.log(
                        `serveRangeRequests plugin: abort handling for ${request.url} (signal already aborted)`
                    );
                }
                throw new DOMException(
                    'The operation was aborted.',
                    'AbortError'
                );
            }

            // Проверяем, должен ли файл обрабатываться на основе include/exclude масок
            if (!shouldProcessFile(request.url, include, exclude)) {
                if (enableLogging) {
                    console.log(
                        `serveRangeRequests plugin: skipping ${request.url} (filtered out by include/exclude rules)`
                    );
                }
                return;
            }

            const url: UrlString = request.url;
            const cacheKey: RangeCacheKey = `${url}|${rangeHeader}`;

            // Проверяем кеш range-ответов (с LRU обновлением)
            const cachedRange =
                maxCachedRanges > 0 ? getCachedRange(cacheKey) : undefined;
            if (cachedRange) {
                const { data, headers } = cachedRange;
                if (enableLogging) {
                    console.log(
                        `serveRangeRequests plugin: returning 206 from range cache for ${url} data.byteLength=${data.byteLength}`
                    );
                }
                return new Response(data, {
                    headers,
                    status: HTTP_STATUS_PARTIAL_CONTENT,
                });
            }

            const doFallbackFetch = (): Promise<Response> => {
                // Передаём заголовки как объект. Обязательно mode: 'cors': при mode no-cors (напр. от <video>)
                // браузер оставляет только CORS-safelisted заголовки — Range и X-PSW-Passthrough снимаются.
                // Range задаём явно из уже распарсенного rangeHeader, чтобы fallback всегда шёл за диапазоном.
                const headerRecord: Record<string, string> = {
                    ...Object.fromEntries(request.headers.entries()),
                    [passthroughHeader]: '1',
                    [HEADER_RANGE]: rangeHeader,
                };
                const fallbackRequest = new Request(request.url, {
                    method: request.method,
                    mode: 'cors',
                    credentials: request.credentials,
                    headers: headerRecord,
                    signal: request.signal,
                });
                if (enableLogging) {
                    const keys = [...fallbackRequest.headers.keys()];
                    console.log(
                        `serveRangeRequests plugin: fallback fetch for ${url}, passthroughHeader: '${String(passthroughHeader)}', has passthrough: ${passthroughHeader ? fallbackRequest.headers.has(passthroughHeader) : false}, request header keys: ${keys.join(', ')}`
                    );
                }
                return context.fetchPassthrough(fallbackRequest);
            };

            try {
                const requestAbortController = new AbortController();
                const abortPromise = new Promise<undefined>((resolve) => {
                    signal.addEventListener(
                        'abort',
                        () => {
                            requestAbortController.abort();
                            resolve(undefined);
                        },
                        { once: true }
                    );
                });

                const workPromise = (async (): Promise<
                    | {
                          stream: ReadableStream<Uint8Array>;
                          headers: Headers;
                          range: Range;
                          metadata: FileMetadata;
                      }
                    | undefined
                > => {
                    const release = await Promise.race([
                        acquireRangeSlot(url),
                        abortPromise.then(() => undefined),
                    ]);
                    if (!release) return undefined;

                    const workSignal = prioritizeLatestRequest
                        ? mergeAbortSignals(
                              signal,
                              requestAbortController.signal,
                              getOrCreateUrlState(url).abortController.signal
                          )
                        : mergeAbortSignals(
                              signal,
                              requestAbortController.signal
                          );

                    try {
                        if (workSignal.aborted) return undefined;

                        const cache = await getCache();
                        if (workSignal.aborted) return undefined;

                        let cachedResponse: Response | undefined;
                        try {
                            cachedResponse = await matchByUrl(cache, request);
                        } catch (matchError) {
                            cacheInstance = null;
                            if (enableLogging) {
                                console.error(
                                    'serveRangeRequests plugin: matchByUrl failed',
                                    matchError
                                );
                            }
                            return undefined;
                        }
                        if (enableLogging) {
                            console.log(
                                `serveRangeRequests plugin: matchByUrl cacheName=${cacheName} request.url=${request.url} result=${cachedResponse ? 'found' : 'null'}`
                            );
                        }

                        if (!cachedResponse) {
                            if (
                                restoreMissingToCache &&
                                !restoreInProgress.has(url)
                            ) {
                                const runRestore = (): void => {
                                    restoreInProgress.add(url);
                                    void (async (): Promise<void> => {
                                        try {
                                            const c = await getCache();
                                            if (
                                                await matchByUrl(
                                                    c,
                                                    new Request(url)
                                                )
                                            ) {
                                                if (enableLogging) {
                                                    console.log(
                                                        `serveRangeRequests plugin: restore skipped for ${url} (already in cache)`
                                                    );
                                                }
                                                return;
                                            }
                                            const fullRequest = new Request(
                                                url,
                                                {
                                                    method: 'GET',
                                                    headers: {
                                                        [passthroughHeader]:
                                                            '1',
                                                    },
                                                }
                                            );
                                            if (enableLogging) {
                                                console.log(
                                                    `serveRangeRequests plugin: restore fetch for ${url} (full file, no Range)`
                                                );
                                            }
                                            const response =
                                                await context.fetchPassthrough(fullRequest);
                                            if (response.ok) {
                                                await c.put(
                                                    fullRequest,
                                                    response
                                                );
                                                if (enableLogging) {
                                                    console.log(
                                                        `serveRangeRequests plugin: cache put done for ${url} cacheName=${cacheName}`
                                                    );
                                                }
                                            }
                                        } catch {
                                            // Игнорируем ошибки restore — следующий запрос попробует снова
                                        } finally {
                                            restoreInProgress.delete(url);
                                            if (enableLogging) {
                                                console.log(
                                                    `serveRangeRequests plugin: restore finished for ${url}`
                                                );
                                            }
                                        }
                                    })();
                                };

                                runRestore();
                            }
                            // При промахе не ждём restore: текущий запрос идёт в сеть (fallback),
                            // restore заполняет кэш для следующих запросов.
                            if (!cachedResponse) {
                                if (enableLogging) {
                                    console.log(
                                        `serveRangeRequests plugin: skipping ${url} (file not in cache)`
                                    );
                                }
                                return undefined;
                            }
                        }
                        if (workSignal.aborted) return undefined;

                        let metadata = fileMetadataCache.get(url);
                        if (metadata) {
                            const contentLength = cachedResponse.headers.get(
                                HEADER_CONTENT_LENGTH
                            );
                            if (contentLength !== String(metadata.size)) {
                                metadata = undefined;
                            }
                        }
                        if (!metadata) {
                            metadata =
                                extractMetadataFromResponse(cachedResponse);
                        }
                        if (!metadata) {
                            if (enableLogging) {
                                console.log(
                                    `serveRangeRequests plugin: skipping ${url} (no valid metadata)`
                                );
                            }
                            return undefined;
                        }

                        const ifRangeHeader = request.headers.get('If-Range');
                        if (
                            ifRangeHeader &&
                            !ifRangeMatches(ifRangeHeader, metadata)
                        ) {
                            if (enableLogging) {
                                console.log(
                                    `serveRangeRequests plugin: skipping ${url} (If-Range does not match)`
                                );
                            }
                            return undefined;
                        }

                        const range = parseRangeHeader(
                            rangeHeader,
                            metadata.size
                        );

                        if (!cachedResponse.body) {
                            if (enableLogging) {
                                console.log(
                                    `serveRangeRequests plugin: skipping ${url} (cached response has no body)`
                                );
                            }
                            return undefined;
                        }
                        if (workSignal.aborted) return undefined;

                        const rangeSize = range.end - range.start + 1;
                        const stream = createRangeStream(
                            cachedResponse.body,
                            range,
                            workSignal
                        );

                        const headers = buildRangeResponseHeaders(
                            range,
                            metadata,
                            rangeSize,
                            rangeResponseCacheControl
                        );

                        return { stream, headers, range, metadata };
                    } catch (error) {
                        const isAbort =
                            (error instanceof Error &&
                                error.message === 'Request aborted') ||
                            (typeof DOMException !== 'undefined' &&
                                error instanceof DOMException &&
                                error.name === 'AbortError');
                        if (!isAbort) {
                            cacheInstance = null;
                        }
                        if (!isAbort && enableLogging) {
                            console.error(
                                `serveRangeRequests plugin error for ${url} with range ${rangeHeader}:`,
                                error
                            );
                        }
                        return undefined;
                    } finally {
                        release();
                    }
                })();

                const result = await Promise.race([workPromise, abortPromise]);
                if (!result) {
                    if (signal.aborted) {
                        throw new DOMException(
                            'The operation was aborted.',
                            'AbortError'
                        );
                    }
                    const fallbackResponse = await doFallbackFetch();
                    if (fallbackResponse.status !== 206) {
                        console.warn(
                            `[serveRangeRequests] Fallback for ${url} returned ${fallbackResponse.status} instead of 206. ` +
                                'The next plugin (e.g. restore) is handling our internal fetch. ' +
                                'It must skip requests with the passthrough header (context.passthroughHeader).'
                        );
                    }
                    if (enableLogging) {
                        console.log(
                            `serveRangeRequests plugin: fallback response for ${url} status=${fallbackResponse.status}`
                        );
                    }
                    return fallbackResponse;
                }

                const { stream, headers, range } = result;
                const rangeSize = range.end - range.start + 1;

                manageMetadataCacheSize();
                fileMetadataCache.set(url, result.metadata);

                if (enableLogging) {
                    console.log(
                        `serveRangeRequests plugin: returning 206 for ${url} range size: ${rangeSize} bytes`
                    );
                }
                return new Response(stream, {
                    status: HTTP_STATUS_PARTIAL_CONTENT,
                    headers,
                });
            } catch (err) {
                // Любое исключение до fallback (getCache, acquireRangeSlot и т.д.) не должно
                // уходить во фреймворк — иначе следующий плагин (restore) отдаст 200 и весь файл.
                if (signal.aborted) {
                    throw new DOMException(
                        'The operation was aborted.',
                        'AbortError'
                    );
                }
                if (enableLogging) {
                    console.error(
                        `serveRangeRequests plugin: unexpected error for ${url}, falling back to network:`,
                        err
                    );
                }
                try {
                    const fallbackResponse = await doFallbackFetch();
                    if (enableLogging) {
                        console.log(
                            `serveRangeRequests plugin: fallback (after error) response for ${url} status=${fallbackResponse.status}`
                        );
                    }
                    return fallbackResponse;
                } catch (fetchErr) {
                    throw fetchErr;
                }
            }
        },
    };
}
