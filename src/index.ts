import type {
    FetchResponse,
    Logger,
    PluginContext,
    ServiceWorkerPlugin,
} from '@budarin/pluggable-serviceworker';
import {
    matchByUrl,
    normalizeUrl,
} from '@budarin/pluggable-serviceworker/utils';

import { HEADER_RANGE } from '@budarin/http-constants/headers';
import { HTTP_STATUS_PARTIAL_CONTENT } from '@budarin/http-constants/statuses';

import type {
    CachedRange,
    FileMetadata,
    Pathname,
    RangeCacheKey,
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
    getRangeRequestSource,
    normalizeIncludeExclude,
    parseUrlSafely,
    shouldCacheRange,
    shouldProcessFile,
} from './rangeUtils.js';
import { extractMetadataFromResponse } from './rangeResponse.js';

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
    /**
     * Опциональный логгер на уровне фабрики (инициализации). Используется только для init-логов
     * (например, предупреждение при пустом include после фильтрации cross-origin URL).
     * Runtime-логирование запросов — только через context.logger.
     */
    logger?: Logger;
}

/**
 * Все зависимости для обработки одного range-запроса (request-scoped).
 * Передаётся в tryServeRangeFromCachedFile, чтобы не раздувать сигнатуру; поля — кэш, слоты, restore, учёт клиента, конфиг.
 */
interface RangeHandlerContext {
    getCache: () => Promise<Cache>;
    cacheName: string;
    enableLogging: boolean;
    rangeResponseCacheControl: string | undefined;
    restoreInProgress: Set<Pathname>;
    fileMetadataCache: Map<Pathname, FileMetadata>;
    restoreMissingToCache: boolean;
    /** Если задан — restore только для запросов, чей pathname есть в списке. */
    assetUrls: Set<Pathname> | undefined;
    restoreOptions: RestoreOptions;
    acquireRangeSlot: (pathname: Pathname) => Promise<(() => void) | null>;
    mergeAbortSignals: (...s: AbortSignal[]) => AbortSignal;
    getOrCreateUrlState: (pathname: Pathname) => UrlState;
    prioritizeLatestRequest: boolean;
    /** Поиск в кэше по pathname (через normalizeUrl — origin текущего scope). */
    matchByPathname: (
        cache: Cache,
        pathname: Pathname
    ) => Promise<Response | undefined>;
    invalidateCache: () => void;
    /**
     * По clientId — pathname'ы, по которым уже отдавали из сети в этой вкладке.
     */
    urlsServedFromNetworkByClient: Map<string, Set<Pathname>>;
    clientId: string;
    maxTrackedUrls: number;
    /** Логгер из контракта плагина (context.logger). */
    logger?: Logger | undefined;
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
 * Сначала всегда проверяется кэш. Чтобы не переключать источник в середине воспроизведения
 * (обход Chromium bug 1026867), при попадании в кэш делаем passthrough, если: (1) для этого
 * клиента (clientId) мы уже отдавали этот URL из сети в этой вкладке — после restore ETag
 * в кэше совпадает с сетевым, getRangeRequestSource не отличит; (2) иначе — getRangeRequestSource()
 * по If-Range и ETag/Last-Modified кэша вернул 'network'. После перезагрузки clientId новый — кэш используется.
 *
 * Обрабатываются только запросы из браузера (вкладка, контролируемый контекст). Запросы без clientId
 * (например инициированные самим SW) пропускаются — возвращаем undefined, дальше по цепочке.
 *
 * @param options - Опции конфигурации плагина
 * @returns ServiceWorkerPlugin для обработки Range запросов
 * @see https://bugs.chromium.org/p/chromium/issues/detail?id=1026867
 * @see https://phoboslab.org/files/bugs/chrome-serviceworker-video/
 */

/** Origin SW (один на весь модуль, кешируется при первом обращении). */
let cachedScopeOrigin: string | null = null;

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
    }
}

/**
 * Возвращает Set pathname'ов для clientId; при переполнении (size >= maxSize) вытесняет один элемент (FIFO).
 */
function getOrCreateSetForClient(
    map: Map<string, Set<Pathname>>,
    clientId: string,
    maxSize: number
): Set<Pathname> {
    let set = map.get(clientId);
    if (!set) {
        set = new Set<Pathname>();
        map.set(clientId, set);
    }
    if (maxSize > 0 && set.size >= maxSize) {
        const first = set.values().next().value;
        if (first !== undefined) set.delete(first);
    }
    return set;
}

export function serveRangeRequests(
    options: RangePluginOptions
): ServiceWorkerPlugin {
    const {
        cacheName,
        order = -10,
        maxCachedRanges = 100,
        maxCacheableRangeSize = 10 * 1024 * 1024, // 10MB
        enableLogging = false,
        include: rawInclude,
        exclude: rawExclude,
        rangeResponseCacheControl,
        maxConcurrentRangesPerUrl = 4,
        prioritizeLatestRequest = true,
        restoreMissingToCache = true,
        maxTrackedUrls = 512,
        assets,
        logger = console,
    } = options;

    if (
        rawInclude == null ||
        !Array.isArray(rawInclude) ||
        rawInclude.length === 0
    ) {
        throw new Error(
            'serveRangeRequests: include is required and must be a non-empty array'
        );
    }

    // Нормализуем include/exclude сразу при инициализации SW (фабрика).
    if (cachedScopeOrigin === null) {
        cachedScopeOrigin = new URL(self.registration.scope).origin;
    }
    const scopeOrigin = cachedScopeOrigin;
    const normalizedIncludeExclude = normalizeIncludeExclude(
        rawInclude,
        rawExclude,
        scopeOrigin
    );
    const disabledByEmptyInclude = normalizedIncludeExclude.include.length === 0;
    if (disabledByEmptyInclude) {
        logger.warn(
            'serveRangeRequests: include is empty after filtering (all cross-origin), plugin will not process range requests'
        );
    }

    const assetUrlsSet = assets ? new Set<Pathname>(assets) : undefined;

    // Кеш для range-ответов (LRU через Map). Ключ — pathname|rangeHeader.
    const rangeCache = new Map<RangeCacheKey, CachedRange>();
    // Кеш метаданных файлов по pathname
    const fileMetadataCache = new Map<Pathname, FileMetadata>();
    // Кеш для Cache API объектов
    let cacheInstance: Cache | null = null;
    /** Pathname'ы, по которым идёт восстановление в кеш (чтобы не дублировать) */
    const restoreInProgress = new Set<Pathname>();
    /**
     * По clientId — pathname'ы, по которым этому клиенту уже отдавали ответ из сети (passthrough).
     * Чтобы не переключать источник на кеш для последующих range-запросов (обход бага Chromium).
     * Ключи при закрытии вкладки не удаляются — число ключей может расти.
     */
    const urlsServedFromNetworkByClient = new Map<string, Set<Pathname>>();

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
        matchByPathname: (cache: Cache, pathname: Pathname) =>
            matchByUrl(cache, new Request(normalizeUrl(pathname))),
        invalidateCache: () => {
            cacheInstance = null;
        },
        urlsServedFromNetworkByClient,
        clientId: '', // задаётся при построении handlerContext из event.clientId
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
    function manageMetadataCacheSize(logger?: Logger): void {
        if (maxCachedRanges <= 0) {
            return;
        }
        if (fileMetadataCache.size >= maxCachedRanges) {
            const firstKey = fileMetadataCache.keys().next().value;
            if (firstKey) {
                fileMetadataCache.delete(firstKey);
                if (enableLogging) {
                    logger?.debug?.(`Metadata cache: removed old entry ${firstKey}`);
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
    function evictOneRangeCacheEntry(logger?: Logger): void {
        if (maxCachedRanges <= 0 || rangeCache.size < maxCachedRanges) {
            return;
        }
        const firstKey = rangeCache.keys().next().value;
        if (firstKey) {
            rangeCache.delete(firstKey);
            if (enableLogging) {
                logger?.debug?.(
                    `Range cache: evicted ${firstKey} (limit ${maxCachedRanges})`
                );
            }
        }
    }

    /**
     * Пытается отдать диапазон из закешированного полного файла: слот, matchByPathname (по pathname через normalizeUrl), restore при промахе, serveRangeFromCachedResponse.
     * Внутри работа по pathname; request — только для fetch при промахе.
     */
    async function tryServeRangeFromCachedFile(
        request: Request,
        pathname: Pathname,
        rangeHeader: string,
        signal: AbortSignal,
        requestAbortController: AbortController,
        abortPromise: Promise<undefined>,
        ctx: RangeHandlerContext
    ): Promise<TryFullCacheResult | Response | undefined> {
        const release = await Promise.race([
            ctx.acquireRangeSlot(pathname),
            abortPromise.then(() => undefined),
        ]);
        if (!release) return undefined;

        const workSignal = ctx.prioritizeLatestRequest
            ? ctx.mergeAbortSignals(
                  signal,
                  requestAbortController.signal,
                  ctx.getOrCreateUrlState(pathname).abortController.signal
              )
            : ctx.mergeAbortSignals(signal, requestAbortController.signal);

        try {
            if (workSignal.aborted) return undefined;

            const cache = await ctx.getCache();
            if (workSignal.aborted) return undefined;

            let cachedResponse: Response | undefined;
            try {
                cachedResponse = await Promise.race([
                    ctx.matchByPathname(cache, pathname),
                    new Promise<never>((_, reject) => {
                        workSignal.addEventListener(
                            'abort',
                            () =>
                                reject(
                                    new DOMException(
                                        'Aborted',
                                        'AbortError'
                                    )
                                ),
                            { once: true }
                        );
                    }),
                ]);
            } catch (matchError) {
                if (
                    matchError instanceof DOMException &&
                    matchError.name === 'AbortError'
                ) {
                    return undefined;
                }
                ctx.invalidateCache();
                ctx.logger?.error?.(
                    'serveRangeRequests plugin: matchByPathname failed',
                    matchError
                );
                return undefined;
            }
            if (ctx.enableLogging) {
                ctx.logger?.debug?.(
                    `serveRangeRequests plugin: matchByPathname cacheName=${ctx.cacheName} pathname=${pathname} result=${cachedResponse ? 'found' : 'null'}`
                );
            }

            if (!cachedResponse) {
                const setForClient = getOrCreateSetForClient(
                    ctx.urlsServedFromNetworkByClient,
                    ctx.clientId,
                    ctx.maxTrackedUrls
                );
                setForClient.add(pathname);

                const urlInAssets = ctx.assetUrls?.has(pathname) ?? false;
                if (ctx.restoreMissingToCache && urlInAssets) {
                    startRestore(request.url, ctx.restoreOptions);
                }
                if (ctx.enableLogging) {
                    ctx.logger?.debug?.(
                        `serveRangeRequests plugin: skipping ${pathname} (file not in cache), returning passthrough response`
                    );
                }
                return await fetch(request);
            }
            if (workSignal.aborted) return undefined;

            const setForClient = ctx.urlsServedFromNetworkByClient.get(ctx.clientId);
            if (setForClient?.has(pathname)) {
                if (ctx.enableLogging) {
                    ctx.logger?.debug?.(
                        `serveRangeRequests plugin: ${pathname} already served from network for this client, passthrough (Chromium bug workaround)`
                    );
                }
                return await fetch(request);
            }

            const cachedMetadata = extractMetadataFromResponse(cachedResponse);
            if (cachedMetadata && getRangeRequestSource(request, cachedMetadata) === 'network') {
                if (ctx.enableLogging) {
                    ctx.logger?.debug?.(
                        `serveRangeRequests plugin: ${pathname} client has network validator (If-Range), passthrough (Chromium bug workaround)`
                    );
                }
                return await fetch(request);
            }

            const serveResult = serveRangeFromCachedResponse(
                cachedResponse,
                request,
                rangeHeader,
                workSignal,
                {
                    pathname,
                    rangeResponseCacheControl: ctx.rangeResponseCacheControl,
                    enableLogging: ctx.enableLogging,
                    fileMetadataCache: ctx.fileMetadataCache,
                    precomputedMetadata: cachedMetadata ?? undefined,
                    logger: ctx.logger,
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
            if (!isAbort) {
                ctx.logger?.error?.(
                    `serveRangeRequests plugin error for ${pathname} with range ${rangeHeader}:`,
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

            // Только запросы из браузера (clientId есть); запросы из SW или без клиента не обрабатываем
            if (!event.clientId) {
                context.logger?.warn?.(
                    'serveRangeRequests plugin: skipping request without clientId (not from browser)',
                    request.url
                );
                return;
            }

            const signal = request.signal;

            if (signal.aborted) {
                if (enableLogging) {
                    context.logger?.debug?.(
                        `serveRangeRequests plugin: abort handling for ${request.url} (signal already aborted)`
                    );
                }
                throwIfAborted(signal);
            }

            const { include, exclude, sameOriginOnly } = normalizedIncludeExclude;
            if (disabledByEmptyInclude) {
                return;
            }

            const requestUrl = parseUrlSafely(request.url);
            if (requestUrl === null) {
                context.logger?.warn?.(
                    'serveRangeRequests plugin: invalid request URL, skipping',
                    request.url
                );
                return;
            }
            // При заданных include/exclude обрабатываем только same-origin; сторонние URL — варнинг и пропуск
            if (sameOriginOnly && requestUrl.origin !== scopeOrigin) {
                context.logger?.warn?.(
                    `serveRangeRequests plugin: skipping third-party resource (include/exclude set, same-origin only): ${requestUrl.pathname}`
                );
                return;
            }

            if (!shouldProcessFile(requestUrl.pathname, include, exclude)) {
                context.logger?.warn?.(
                    `serveRangeRequests plugin: skipping (filtered out by include/exclude): ${requestUrl.pathname}`
                );
                return;
            }

            const pathname: Pathname = requestUrl.pathname;

            const cacheKey: RangeCacheKey | undefined =
                maxCachedRanges > 0 ? `${pathname}|${rangeHeader}` : undefined;

            // Проверяем кеш range-ответов (с LRU обновлением) только при включённом кеше
            const cachedRange =
                cacheKey !== undefined ? getCachedRange(cacheKey) : undefined;

            if (cachedRange) {
                const { data, headers } = cachedRange;

                if (enableLogging) {
                    context.logger?.debug?.(
                        `serveRangeRequests plugin: returning 206 from range cache for ${pathname} data.byteLength=${data.byteLength}`
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
                logger: context.logger,
            };
            const clientId = event.clientId ?? '';
            const handlerContext: RangeHandlerContext = {
                ...baseHandlerContext,
                restoreOptions,
                clientId,
                logger: context.logger,
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
                        pathname,
                        rangeHeader,
                        signal,
                        requestAbortController,
                        abortPromise,
                        handlerContext
                    ),
                    abortPromise,
                ]);

                if (!result) {
                    throwIfAborted(signal);
                    return;
                }

                if (result instanceof Response) {
                    return result;
                }

                const { stream, headers, range } = result;
                const rangeSize = range.end - range.start + 1;

                manageMetadataCacheSize(context.logger);
                fileMetadataCache.set(pathname, result.metadata);

                const shouldCache =
                    maxCachedRanges > 0 &&
                    shouldCacheRange(range, maxCacheableRangeSize);

                if (shouldCache && cacheKey !== undefined) {
                    evictOneRangeCacheEntry(context.logger);
                    const data = await new Response(stream).arrayBuffer();
                    rangeCache.set(cacheKey, { data, headers });
                    if (enableLogging) {
                        context.logger?.debug?.(
                            `serveRangeRequests plugin: returning 206 for ${pathname} range size: ${rangeSize} bytes (cached)`
                        );
                    }
                    return new Response(data, {
                        status: HTTP_STATUS_PARTIAL_CONTENT,
                        headers,
                    });
                }

                if (enableLogging) {
                    context.logger?.debug?.(
                        `serveRangeRequests plugin: returning 206 for ${pathname} range size: ${rangeSize} bytes`
                    );
                }
                return new Response(stream, {
                    status: HTTP_STATUS_PARTIAL_CONTENT,
                    headers,
                });
            } catch (err) {
                // Любое исключение (getCache, acquireRangeSlot и т.д.) не должно ломать цепочку:
                // возвращаем undefined, чтобы Range обработал следующий плагин/сеть.
                throwIfAborted(signal);

                if (enableLogging) {
                    context.logger?.error?.(
                        `serveRangeRequests plugin: unexpected error for ${pathname}, returning undefined to allow passthrough:`,
                        err
                    );
                }
                return;
            }
        },
    };
}
