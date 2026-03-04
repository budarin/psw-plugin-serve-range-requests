import type {
    FetchResponse,
    PluginContext,
    ServiceWorkerPlugin,
} from '@budarin/pluggable-serviceworker';
import { matchByUrl } from '@budarin/pluggable-serviceworker/utils';

import { HEADER_RANGE } from '@budarin/http-constants/headers';
import { HTTP_STATUS_PARTIAL_CONTENT } from '@budarin/http-constants/statuses';

import type {
    CachedRange,
    FileMetadata,
    RangeCacheKey,
    UrlString,
} from './types.js';
import {
    createRangeSlotManager,
    mergeAbortSignals,
    type UrlState,
} from './rangeSlot.js';
import { startRestore, type RestoreOptions } from './restore.js';
import { serveRangeFromCachedResponse } from './serveFromCache.js';
import {
    type Range,
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

export interface RangePluginOptions {
    /**
     * Имя кеша для поиска файлов
     */
    cacheName: string;
    /**
     * Список pathname'ов ресурсов (assets/precache). Исключительно pathname'ы (например `/assets/Meeting.mp4`),
     * не полные URL — при сборке origin неизвестен. Если задан, restore при промахе запускается только для запросов,
     * чей pathname есть в списке. Если не задан — restore для любого обработанного URL.
     */
    assets?: string[];
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

/** Контекст для шагов обработчика: полный кэш, семафор, restore, инвалидация. */
interface RangeHandlerContext {
    getCache: () => Promise<Cache>;
    cacheName: string;
    enableLogging: boolean;
    rangeResponseCacheControl: string | undefined;
    restoreInProgress: Set<UrlString>;
    fileMetadataCache: Map<UrlString, FileMetadata>;
    restoreMissingToCache: boolean;
    /** Если задан — restore только для запросов, чей pathname есть в списке (в Set — pathname'ы). */
    assetUrls: Set<UrlString> | undefined;
    restoreOptions: RestoreOptions;
    acquireRangeSlot: (url: UrlString) => Promise<(() => void) | null>;
    mergeAbortSignals: (...s: AbortSignal[]) => AbortSignal;
    getOrCreateUrlState: (url: UrlString) => UrlState;
    prioritizeLatestRequest: boolean;
    matchByUrl: (
        cache: Cache,
        request: Request
    ) => Promise<Response | undefined>;
    invalidateCache: () => void;
    /**
     * URL, по которым уже отдавали ответ из сети (passthrough) в этой сессии SW.
     * Для таких URL не переключаемся на кэш до перезапуска SW (обход бага Chromium: смена источника ломает плеер).
     * @see https://bugs.chromium.org/p/chromium/issues/detail?id=1026867
     */
    urlsServedFromNetwork: Set<UrlString>;
    maxTrackedUrls: number;
}

/** Результат успешной попытки ответа из полного кэша. */
interface TryFullCacheResult {
    stream: ReadableStream<Uint8Array>;
    headers: Headers;
    range: Range;
    metadata: FileMetadata;
}

/**
 * Плагин для обработки HTTP Range запросов: отдаёт частичное содержимое файлов из кеша SW.
 *
 * В рамках одной сессии SW для каждого URL используется только один источник (сеть или кэш):
 * если первый запрос по URL был отдан из сети (промах кэша), все последующие запросы по этому URL
 * до перезапуска SW тоже отдаются из сети, даже когда файл уже в кэше. Восстановление в кэш при этом
 * по-прежнему выполняется в фоне для следующих загрузок. Это вынужденное поведение из-за бага Chromium:
 * при смене источника в середине воспроизведения (сеть → кэш) медиа-пайплайн игнорирует ответ из кэша
 * и воспроизведение падает с PIPELINE_ERROR_READ.
 *
 * @param options - Опции конфигурации плагина
 * @returns ServiceWorkerPlugin для обработки Range запросов
 * @see https://bugs.chromium.org/p/chromium/issues/detail?id=1026867
 * @see https://phoboslab.org/files/bugs/chrome-serviceworker-video/
 */
export function serveRangeRequests(
    options: RangePluginOptions
): ServiceWorkerPlugin {
    const {
        cacheName,
        order = -10,
        maxCachedRanges = 100,
        maxCacheableRangeSize = 10 * 1024 * 1024, // 10MB
        enableLogging = false,
        include,
        exclude,
        rangeResponseCacheControl,
        maxConcurrentRangesPerUrl = 4,
        prioritizeLatestRequest = true,
        restoreMissingToCache = true,
        maxTrackedUrls = 512,
        assets,
    } = options;

    const assetUrlsSet = assets ? new Set<UrlString>(assets) : undefined;

    // Кеш для range-ответов (LRU через Map)
    const rangeCache = new Map<RangeCacheKey, CachedRange>();
    // Кеш метаданных файлов
    const fileMetadataCache = new Map<UrlString, FileMetadata>();
    // Кеш для Cache API объектов
    let cacheInstance: Cache | null = null;
    /** URL, по которым идёт восстановление в кеш (чтобы не дублировать) */
    const restoreInProgress = new Set<UrlString>();
    /**
     * URL, по которым уже отдавали ответ из сети в этой сессии SW.
     * Не переключаемся на кэш для этих URL до перезапуска SW (обход Chromium bug 1026867).
     */
    const urlsServedFromNetwork = new Set<UrlString>();

    const { acquireRangeSlot, getOrCreateUrlState } = createRangeSlotManager({
        maxConcurrentRangesPerUrl,
        prioritizeLatestRequest,
        maxTrackedUrls,
    });

    /** Базовый контекст обработчика (без restoreOptions — они зависят от event). */
    const baseHandlerContext: Omit<RangeHandlerContext, 'restoreOptions'> = {
        getCache,
        cacheName,
        enableLogging,
        rangeResponseCacheControl,
        restoreInProgress,
        fileMetadataCache,
        restoreMissingToCache,
        assetUrls: assetUrlsSet,
        acquireRangeSlot,
        mergeAbortSignals,
        getOrCreateUrlState,
        prioritizeLatestRequest,
        matchByUrl,
        invalidateCache: () => {
            cacheInstance = null;
        },
        urlsServedFromNetwork,
        maxTrackedUrls,
    };

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
     * Ограничивает размер кеша метаданных: вытесняется запись, вставленная раньше всех (FIFO).
     * Лимит = maxCachedRanges.
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

    /**
     * Освобождает место в rangeCache при достижении лимита (FIFO — вытесняется самый старый).
     */
    function evictOneRangeCacheEntry(): void {
        if (maxCachedRanges <= 0 || rangeCache.size < maxCachedRanges) {
            return;
        }
        const firstKey = rangeCache.keys().next().value;
        if (firstKey) {
            rangeCache.delete(firstKey);
            if (enableLogging) {
                console.log(
                    `Range cache: evicted ${firstKey} (limit ${maxCachedRanges})`
                );
            }
        }
    }

    /**
     * Пытается отдать диапазон из закешированного полного файла: слот, matchByUrl, restore при промахе, serveRangeFromCachedResponse.
     * При промахе возвращает network fetch(original request), иначе TryFullCacheResult или undefined.
     */
    async function tryServeRangeFromCachedFile(
        request: Request,
        url: UrlString,
        rangeHeader: string,
        signal: AbortSignal,
        requestAbortController: AbortController,
        abortPromise: Promise<undefined>,
        ctx: RangeHandlerContext
    ): Promise<TryFullCacheResult | Response | undefined> {
        const release = await Promise.race([
            ctx.acquireRangeSlot(url),
            abortPromise.then(() => undefined),
        ]);
        if (!release) return undefined;

        const workSignal = ctx.prioritizeLatestRequest
            ? ctx.mergeAbortSignals(
                  signal,
                  requestAbortController.signal,
                  ctx.getOrCreateUrlState(url).abortController.signal
              )
            : ctx.mergeAbortSignals(signal, requestAbortController.signal);

        try {
            if (workSignal.aborted) return undefined;

            const cache = await ctx.getCache();
            if (workSignal.aborted) return undefined;

            let cachedResponse: Response | undefined;
            try {
                cachedResponse = await ctx.matchByUrl(cache, request);
            } catch (matchError) {
                ctx.invalidateCache();
                if (ctx.enableLogging) {
                    console.error(
                        'serveRangeRequests plugin: matchByUrl failed',
                        matchError
                    );
                }
                return undefined;
            }
            if (ctx.enableLogging) {
                console.log(
                    `serveRangeRequests plugin: matchByUrl cacheName=${ctx.cacheName} request.url=${request.url} result=${cachedResponse ? 'found' : 'null'}`
                );
            }

            if (!cachedResponse) {
                if (ctx.urlsServedFromNetwork.size >= ctx.maxTrackedUrls) {
                    const first = ctx.urlsServedFromNetwork.values().next().value;
                    if (first !== undefined) {
                        ctx.urlsServedFromNetwork.delete(first);
                    }
                }
                ctx.urlsServedFromNetwork.add(url);

                let urlInAssets = !ctx.assetUrls;
                if (ctx.assetUrls) {
                    try {
                        urlInAssets = ctx.assetUrls.has(new URL(url).pathname);
                    } catch {
                        urlInAssets = false;
                    }
                }
                if (ctx.restoreMissingToCache && urlInAssets) {
                    startRestore(url, ctx.restoreOptions);
                }
                if (ctx.enableLogging) {
                    console.log(
                        `serveRangeRequests plugin: skipping ${url} (file not in cache), returning passthrough response`
                    );
                }
                // На промахе не меняем параметры запроса: отдаём сетью "родной" request браузера,
                // чтобы не потерять Range и не получить 200 вместо 206.
                return await fetch(request);
            }
            if (workSignal.aborted) return undefined;

            const serveResult = serveRangeFromCachedResponse(
                cachedResponse,
                request,
                rangeHeader,
                workSignal,
                {
                    url,
                    rangeResponseCacheControl: ctx.rangeResponseCacheControl,
                    enableLogging: ctx.enableLogging,
                    fileMetadataCache: ctx.fileMetadataCache,
                }
            );
            return serveResult;
        } catch (error) {
            const isAbort =
                (error instanceof Error &&
                    error.message === 'Request aborted') ||
                (typeof DOMException !== 'undefined' &&
                    error instanceof DOMException &&
                    error.name === 'AbortError');
            if (!isAbort) {
                ctx.invalidateCache();
            }
            if (!isAbort && ctx.enableLogging) {
                console.error(
                    `serveRangeRequests plugin error for ${url} with range ${rangeHeader}:`,
                    error
                );
            }
            return undefined;
        } finally {
            release();
        }
    }

    return {
        name: 'range-requests',
        order,

        async fetch(event: FetchEvent, context: PluginContext): FetchResponse {
            const request = event.request;
            // Имя заголовка passthrough приходит из контекста фреймворка
            const passthroughHeader = context.passthroughHeader;

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

            // Ранний выход: URL уже отдавали из сети в этой сессии — не трогаем кэш и слот (обход Chromium bug 1026867).
            if (urlsServedFromNetwork.has(url)) {
                if (enableLogging) {
                    console.log(
                        `serveRangeRequests plugin: ${url} already served from network this session, passthrough (Chromium bug workaround)`
                    );
                }
                return await fetch(request);
            }

            const cacheKey: RangeCacheKey | undefined =
                maxCachedRanges > 0 ? `${url}|${rangeHeader}` : undefined;

            // Проверяем кеш range-ответов (с LRU обновлением) только при включённом кеше
            const cachedRange =
                cacheKey !== undefined ? getCachedRange(cacheKey) : undefined;

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

            const restoreOptions: RestoreOptions = {
                getCache,
                passthroughHeader,
                fetchPassthrough: context.fetchPassthrough,
                enableLogging,
                cacheName,
                restoreInProgress,
            };
            const handlerContext: RangeHandlerContext = {
                ...baseHandlerContext,
                restoreOptions,
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

                const result = await Promise.race([
                    tryServeRangeFromCachedFile(
                        request,
                        url,
                        rangeHeader,
                        signal,
                        requestAbortController,
                        abortPromise,
                        handlerContext
                    ),
                    abortPromise,
                ]);

                if (!result) {
                    if (signal.aborted) {
                        throw new DOMException(
                            'The operation was aborted.',
                            'AbortError'
                        );
                    }
                    return;
                }

                if (result instanceof Response) {
                    return result;
                }

                const { stream, headers, range } = result;
                const rangeSize = range.end - range.start + 1;

                manageMetadataCacheSize();
                fileMetadataCache.set(url, result.metadata);

                const shouldCache =
                    maxCachedRanges > 0 &&
                    shouldCacheRange(range, maxCacheableRangeSize);

                if (shouldCache && cacheKey !== undefined) {
                    evictOneRangeCacheEntry();
                    const data = await new Response(stream).arrayBuffer();
                    rangeCache.set(cacheKey, { data, headers });
                    if (enableLogging) {
                        console.log(
                            `serveRangeRequests plugin: returning 206 for ${url} range size: ${rangeSize} bytes (cached)`
                        );
                    }
                    return new Response(data, {
                        status: HTTP_STATUS_PARTIAL_CONTENT,
                        headers,
                    });
                }

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
                // Любое исключение (getCache, acquireRangeSlot и т.д.) не должно ломать цепочку:
                // возвращаем undefined, чтобы Range обработал следующий плагин/сеть.
                if (signal.aborted) {
                    throw new DOMException(
                        'The operation was aborted.',
                        'AbortError'
                    );
                }

                if (enableLogging) {
                    console.error(
                        `serveRangeRequests plugin: unexpected error for ${url}, returning undefined to allow passthrough:`,
                        err
                    );
                }
                return;
            }
        },
    };
}
