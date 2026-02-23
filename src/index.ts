import type {
    FetchResponse,
    ServiceWorkerPlugin,
} from '@budarin/pluggable-serviceworker';

import {
    HEADER_RANGE,
    HEADER_CONTENT_TYPE,
    HEADER_CONTENT_RANGE,
    HEADER_CONTENT_LENGTH,
    HEADER_ETAG,
    HEADER_LAST_MODIFIED,
} from '@budarin/http-constants/headers';

import { HTTP_STATUS_PARTIAL_CONTENT } from '@budarin/http-constants/statuses';
import { MIME_APPLICATION_OCTET_STREAM } from '@budarin/http-constants/mime-types';

import type { RangeCacheKey, UrlString } from './types.js';
import { addCacheHeaders } from './addCacheHeaders.js';
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
     * Максимальное количество закешированных range-ответов (по умолчанию 100)
     */
    maxCachedRanges?: number;
    /**
     * Максимальное количество закешированных метаданных файлов (по умолчанию 200)
     * Метаданные: размер файла (Content-Length) и тип (Content-Type) из HTTP заголовков.
     * Кешируются для ускорения - избегаем повторных обращений к Cache API.
     */
    maxCachedMetadata?: number;
    /**
     * Включить подробное логирование (по умолчанию false)
     */
    enableLogging?: boolean;
    /**
     * Максимальный размер одной кешируемой записи (диапазона) в байтах (по умолчанию 10MB).
     * Диапазоны больше этого размера не кешируются — защита от переполнения памяти.
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
        maxCachedMetadata = 200,
        enableLogging = false,
        maxCacheableRangeSize = 10 * 1024 * 1024, // 10MB
        include,
        exclude,
        rangeResponseCacheControl = 'max-age=31536000, immutable',
    } = options;

    // Кеш для range-ответов (LRU через Map)
    const rangeCache = new Map<RangeCacheKey, CachedRange>();
    // Кеш метаданных файлов
    const fileMetadataCache = new Map<UrlString, FileMetadata>();
    // Кеш для Cache API объектов
    let cacheInstance: Cache | null = null;
    // Дедупликация одновременных запросов по cacheKey (один раз читаем диапазон)
    const inFlight = new Map<
        RangeCacheKey,
        Promise<{
            data: ArrayBuffer;
            headers: Headers;
            range: Range;
        } | null>
    >();

    /**
     * Читает указанный диапазон байтов из потока
     */
    async function readRangeFromStream(
        stream: ReadableStream<Uint8Array>,
        range: Range
    ): Promise<ArrayBuffer> {
        let offset = 0;
        let position = 0;

        const reader = stream.getReader();
        const result = new Uint8Array(range.end - range.start + 1);

        try {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            while (true) {
                const { done, value } = await reader.read();
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
     * Управляет размером кеша метаданных (LRU стратегия)
     */
    function manageMetadataCacheSize(): void {
        if (maxCachedMetadata <= 0) {
            return;
        }
        if (fileMetadataCache.size >= maxCachedMetadata) {
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

            // Если нет заголовка Range, пропускаем
            if (!rangeHeader) {
                return;
            }

            // Обрабатываем только GET запросы
            if (request.method !== 'GET') {
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
                const response = new Response(data, {
                    headers,
                    status: HTTP_STATUS_PARTIAL_CONTENT,
                });
                return addCacheHeaders(response, rangeResponseCacheControl);
            }

            // Один cache.match на запрос: дедупликация по cacheKey (одновременные запросы ждут один результат)
            let workPromise = inFlight.get(cacheKey);
            if (!workPromise) {
                workPromise = (async (): Promise<{
                    data: ArrayBuffer;
                    headers: Headers;
                    range: Range;
                } | null> => {
                    try {
                        const cache = await getCache();
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
                            if (enableLogging) {
                                console.log(
                                    `serveRangeRequests plugin: skipping ${url} (file not in cache)`
                                );
                            }
                            return null;
                        }

                        const metadata =
                            extractMetadataFromResponse(cachedResponse);
                        if (!metadata) {
                            if (enableLogging) {
                                console.log(
                                    `serveRangeRequests plugin: skipping ${url} (no valid metadata)`
                                );
                            }
                            return null;
                        }

                        if (maxCachedMetadata > 0) {
                            manageMetadataCacheSize();
                            fileMetadataCache.set(url, metadata);
                            if (enableLogging) {
                                console.log(
                                    `serveRangeRequests plugin: cached metadata for ${url}, size: ${metadata.size}`
                                );
                            }
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
                            return null;
                        }

                        const data = await readRangeFromStream(
                            cachedResponse.body,
                            range
                        );

                        const headers = new Headers({
                            [HEADER_CONTENT_RANGE]: `bytes ${String(range.start)}-${String(range.end)}/${String(metadata.size)}`,
                            [HEADER_CONTENT_LENGTH]: String(data.byteLength),
                            [HEADER_CONTENT_TYPE]: metadata.type,
                        });

                        return { data, headers, range };
                    } catch (error) {
                        cacheInstance = null;
                        if (enableLogging) {
                            console.error(
                                `serveRangeRequests plugin error for ${url} with range ${rangeHeader}:`,
                                error
                            );
                        }
                        return null;
                    }
                })();
                inFlight.set(cacheKey, workPromise);
                workPromise.finally(() => inFlight.delete(cacheKey));
            }

            const result = await workPromise;
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

            const response = new Response(data, {
                status: HTTP_STATUS_PARTIAL_CONTENT,
                headers,
            });

            return addCacheHeaders(response, rangeResponseCacheControl);
        },
    };
}
