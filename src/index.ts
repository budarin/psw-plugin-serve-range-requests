import type {
    FetchResponse,
    ServiceWorkerPlugin,
} from '@budarin/pluggable-serviceworker';

import {
    HEADER_RANGE,
    HEADER_CACHE_CONTROL,
    HEADER_CONTENT_TYPE,
    HEADER_CONTENT_RANGE,
    HEADER_CONTENT_LENGTH,
    HEADER_ETAG,
    HEADER_LAST_MODIFIED,
} from '@budarin/http-constants/headers';

import { HTTP_STATUS_PARTIAL_CONTENT } from '@budarin/http-constants/statuses';
import { MIME_APPLICATION_OCTET_STREAM } from '@budarin/http-constants/mime-types';

import type { RangeCacheKey, UrlString } from './types.js';
import {
    type Range,
    parseRangeHeader,
    ifRangeMatches,
    shouldCacheRange,
    shouldProcessFile,
} from './rangeUtils.js';

export {
    VIDEO_PRESET,
    AUDIO_PRESET,
    MAPS_PRESET,
    DOCS_PRESET,
    getAdaptivePresets,
} from './presets.js';

interface CachedRange {
    data: ArrayBuffer;
    headers: Headers;
}

interface FileMetadata {
    size: number;
    type: string;
    etag?: string;
    lastModified?: string;
}

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
     * По умолчанию `max-age=31536000, immutable` — браузер кеширует ответ надолго.
     * Можно задать свою строку (например `no-store`, `max-age=3600`) или пустую, чтобы не выставлять.
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
     * Задержка перед стартом restore в мс (по умолчанию 2500). При cache miss не запускаем restore сразу,
     * а откладываем — первые запросы идут в сеть без конкуренции, снижаем ERR_FAILED.
     */
    restoreDelay?: number;
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
        maxCacheableRangeSize = 10 * 1024 * 1024, // 10MB
        include,
        exclude,
        rangeResponseCacheControl = 'max-age=31536000, immutable',
        maxConcurrentRangesPerUrl = 4,
        prioritizeLatestRequest = true,
        restoreMissingToCache = true,
        restoreDelay = 2500,
    } = options;

    // Кеш для range-ответов (LRU через Map)
    const rangeCache = new Map<RangeCacheKey, CachedRange>();
    // Кеш метаданных файлов
    const fileMetadataCache = new Map<UrlString, FileMetadata>();
    // Кеш для Cache API объектов
    let cacheInstance: Cache | null = null;
    /** URL, по которым идёт восстановление в кеш (чтобы не дублировать) */
    const restoreInProgress = new Set<UrlString>();
    /** URL с запланированным restore (таймер ещё не сработал) */
    const restoreScheduled = new Set<UrlString>();
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

    function getOrCreateUrlState(url: UrlString): UrlState {
        if (!urlSemaphore) {
            urlSemaphore = new Map();
        }
        let state = urlSemaphore.get(url);
        if (!state) {
            state = {
                count: 0,
                nextWaiter: null,
                abortController: new AbortController(),
            };
            urlSemaphore!.set(url, state);
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

    /**
     * Создаёт заголовки для 206-ответа с опциональным Cache-Control.
     */
    function buildRangeResponseHeaders(
        range: Range,
        metadata: FileMetadata,
        dataByteLength: number,
        cacheControl?: string
    ): Headers {
        const headers = new Headers({
            [HEADER_CONTENT_RANGE]: `bytes ${String(range.start)}-${String(range.end)}/${String(metadata.size)}`,
            [HEADER_CONTENT_LENGTH]: String(dataByteLength),
            [HEADER_CONTENT_TYPE]: metadata.type,
        });
        if (cacheControl) {
            headers.set(HEADER_CACHE_CONTROL, cacheControl);
        }
        return headers;
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
     * Читает указанный диапазон байтов из потока.
     * Учитывает AbortSignal — при отмене запроса прекращает чтение.
     */
    async function readRangeFromStream(
        stream: ReadableStream<Uint8Array>,
        range: Range,
        signal?: AbortSignal
    ): Promise<ArrayBuffer> {
        let offset = 0;
        let position = 0;

        const reader = stream.getReader();
        if (signal) {
            signal.addEventListener(
                'abort',
                () => {
                    reader.cancel().catch(() => {});
                },
                { once: true }
            );
        }
        const result = new Uint8Array(range.end - range.start + 1);

        try {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            while (true) {
                if (signal?.aborted) {
                    throw new Error('Request aborted');
                }

                let chunk: ReadableStreamReadResult<Uint8Array>;
                try {
                    chunk = await reader.read();
                } catch (readError) {
                    if (signal?.aborted) {
                        throw new Error('Request aborted');
                    }
                    throw readError;
                }
                const { done, value } = chunk;
                if (done) {
                    break;
                }

                const chunkStart = position;
                const chunkEnd = position + value.length;

                position = chunkEnd;

                if (chunkEnd < range.start) {
                    continue;
                }

                if (chunkStart > range.end) {
                    break;
                }

                const start = Math.max(range.start - chunkStart, 0);
                const end = Math.min(range.end - chunkStart + 1, value.length);

                if (start >= end) {
                    continue;
                }

                result.set(value.subarray(start, end), offset);
                offset += end - start;
            }
        } finally {
            reader.releaseLock();
        }

        return result.buffer;
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
     * Извлекает метаданные файла из Response (размер, тип, ETag, Last-Modified).
     */
    function extractMetadataFromResponse(
        response: Response
    ): FileMetadata | undefined {
        const contentLengthHeader = response.headers.get(HEADER_CONTENT_LENGTH);
        if (!contentLengthHeader) {
            return;
        }

        const size = parseInt(contentLengthHeader, 10);
        if (isNaN(size) || size <= 0) {
            return;
        }

        const etag = response.headers.get(HEADER_ETAG) ?? undefined;
        const lastModified =
            response.headers.get(HEADER_LAST_MODIFIED) ?? undefined;

        return {
            size,
            type:
                response.headers.get(HEADER_CONTENT_TYPE) ??
                MIME_APPLICATION_OCTET_STREAM,
            ...(etag && { etag }),
            ...(lastModified && { lastModified }),
        };
    }

    /**
     * Управляет размером кеша range-ответов (LRU стратегия)
     */
    function manageCacheSize(): void {
        if (maxCachedRanges <= 0) {
            return;
        }
        if (rangeCache.size >= maxCachedRanges) {
            // Удаляем самую старую запись (первую в Map - это LRU поведение)
            const firstKey = rangeCache.keys().next().value;
            if (firstKey) {
                rangeCache.delete(firstKey);
                if (enableLogging) {
                    console.log(`Range cache: removed old entry ${firstKey}`);
                }
            }
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

        async fetch(event: FetchEvent): FetchResponse {
            const request = event.request;
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
                return;
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
                return new Response(data, {
                    headers,
                    status: HTTP_STATUS_PARTIAL_CONTENT,
                });
            }

            const requestAbortController = new AbortController();
            const abortPromise = new Promise<null>((resolve) => {
                signal.addEventListener('abort', () => {
                    requestAbortController.abort();
                    resolve(null);
                }, { once: true });
            });

            const workPromise = (async (): Promise<{
                data: ArrayBuffer;
                headers: Headers;
                range: Range;
                metadata: FileMetadata;
            } | null> => {
                const release = await Promise.race([
                    acquireRangeSlot(url),
                    abortPromise.then(() => null),
                ]);
                if (!release) return null;

                const workSignal = prioritizeLatestRequest
                    ? mergeAbortSignals(
                          signal,
                          requestAbortController.signal,
                          getOrCreateUrlState(url).abortController.signal
                      )
                    : mergeAbortSignals(signal, requestAbortController.signal);

                try {
                    if (workSignal.aborted) return null;

                    const cache = await getCache();
                    if (workSignal.aborted) return null;

                    let cachedResponse: Response | undefined;
                    try {
                        cachedResponse = await cache.match(url);
                    } catch (matchError) {
                        cacheInstance = null;
                        if (enableLogging) {
                            console.error(
                                'serveRangeRequests plugin: cache.match failed',
                                matchError
                            );
                        }
                        return null;
                    }

                    if (!cachedResponse) {
                        if (
                            restoreMissingToCache &&
                            !restoreInProgress.has(url) &&
                            !restoreScheduled.has(url)
                        ) {
                            const runRestore = (): void => {
                                restoreInProgress.add(url);
                                (async () => {
                                    try {
                                        const fullRequest = new Request(
                                            url,
                                            { method: 'GET' }
                                        );
                                        const response =
                                            await fetch(fullRequest);
                                        if (response.ok) {
                                            const c = await getCache();
                                            await c.put(
                                                fullRequest,
                                                response
                                            );
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

                            if (restoreDelay > 0) {
                                restoreScheduled.add(url);
                                setTimeout(() => {
                                    restoreScheduled.delete(url);
                                    if (!restoreInProgress.has(url)) {
                                        runRestore();
                                    }
                                }, restoreDelay);
                            } else {
                                runRestore();
                            }
                        }
                        if (!cachedResponse) {
                            if (enableLogging) {
                                console.log(
                                    `serveRangeRequests plugin: skipping ${url} (file not in cache)`
                                );
                            }
                            return null;
                        }
                    }
                    if (workSignal.aborted) return null;

                    let metadata = fileMetadataCache.get(url);
                    if (metadata) {
                        const contentLength =
                            cachedResponse.headers.get(HEADER_CONTENT_LENGTH);
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
                        return null;
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
                        return null;
                    }

                    const range = parseRangeHeader(rangeHeader, metadata.size);

                    if (!cachedResponse.body) {
                        if (enableLogging) {
                            console.log(
                                `serveRangeRequests plugin: skipping ${url} (cached response has no body)`
                            );
                        }
                        return null;
                    }
                    if (workSignal.aborted) return null;

                    const data = await readRangeFromStream(
                        cachedResponse.body,
                        range,
                        workSignal
                    );

                    const headers = buildRangeResponseHeaders(
                        range,
                        metadata,
                        data.byteLength,
                        rangeResponseCacheControl
                    );

                    return { data, headers, range, metadata };
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
                    return null;
                } finally {
                    release();
                }
            })();

            const result = await Promise.race([workPromise, abortPromise]);
            if (!result) {
                return;
            }

            const { data, headers, range } = result;

            // Кешируем range-ответ только если он подходящего размера и кеш включен
            if (
                maxCachedRanges > 0 &&
                shouldCacheRange(range, maxCacheableRangeSize)
            ) {
                manageCacheSize();
                rangeCache.set(cacheKey, { data, headers });
                manageMetadataCacheSize();
                fileMetadataCache.set(url, result.metadata);

                if (enableLogging) {
                    const rangeSize = range.end - range.start + 1;
                    console.log(
                        `serveRangeRequests plugin: cached range for ${url}, size: ${rangeSize} bytes`
                    );
                }
            } else if (enableLogging) {
                const rangeSize = range.end - range.start + 1;
                console.log(
                    `serveRangeRequests plugin: skipped caching for ${url}, size: ${rangeSize} bytes (exceeds maxCacheableRangeSize)`
                );
            }

            return new Response(data, {
                status: HTTP_STATUS_PARTIAL_CONTENT,
                headers,
            });
        },
    };
}
