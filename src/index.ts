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
    const rangeCache = new Map<string, CachedRange>();
    // Кеш метаданных файлов
    const fileMetadataCache = new Map<string, FileMetadata>();
    // Кеш для Cache API объектов
    let cacheInstance: Cache | null = null;

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
     * Получает кеш инстанс (с кешированием)
     */
    async function getCache(): Promise<Cache> {
        if (!cacheInstance) {
            cacheInstance = await caches.open(cacheName);
        }
        return cacheInstance;
    }

    /**
     * Получает метаданные файла из кеша (размер, тип, ETag, Last-Modified при наличии)
     */
    async function getFileMetadata(
        url: string
    ): Promise<FileMetadata | undefined> {
        if (fileMetadataCache.has(url)) {
            return fileMetadataCache.get(url);
        }

        try {
            const cache = await getCache();
            const response = await cache.match(url);
            if (!response) {
                return;
            }

            const contentLengthHeader = response.headers.get(
                HEADER_CONTENT_LENGTH
            );
            if (!contentLengthHeader) {
                return; // Нет информации о размере файла
            }

            const size = parseInt(contentLengthHeader, 10);
            if (isNaN(size) || size <= 0) {
                return; // Некорректный размер файла
            }

            const etag = response.headers.get(HEADER_ETAG) ?? undefined;
            const lastModified =
                response.headers.get(HEADER_LAST_MODIFIED) ?? undefined;

            const metadata: FileMetadata = {
                size,
                type:
                    response.headers.get(HEADER_CONTENT_TYPE) ??
                    MIME_APPLICATION_OCTET_STREAM,
                ...(etag && { etag }),
                ...(lastModified && { lastModified }),
            };

            manageMetadataCacheSize();
            fileMetadataCache.set(url, metadata);

            if (enableLogging) {
                console.log(
                    `serveRangeRequests plugin: cached metadata for ${url}, size: ${size}`
                );
            }

            return metadata;
        } catch (error) {
            console.error('Error getting file metadata:', error);
            return;
        }
    }

    /**
     * Управляет размером кеша range-ответов (LRU стратегия)
     */
    function manageCacheSize(): void {
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
    function getCachedRange(cacheKey: string): CachedRange | undefined {
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

            const url = request.url;
            const cacheKey = `${url}|${rangeHeader}`;

            // Проверяем кеш range-ответов (с LRU обновлением)
            const cachedRange = getCachedRange(cacheKey);
            if (cachedRange) {
                const { data, headers } = cachedRange;
                const response = new Response(data, {
                    headers,
                    status: HTTP_STATUS_PARTIAL_CONTENT,
                });
                return addCacheHeaders(response, rangeResponseCacheControl);
            }

            // Получаем метаданные файла
            const metadata = await getFileMetadata(url);
            if (!metadata) {
                if (enableLogging) {
                    console.log(
                        `serveRangeRequests plugin: skipping ${url} (file not in cache or no metadata)`
                    );
                }
                return;
            }

            // If-Range: отдаём из кеша только если валидатор совпадает с сохранённым
            const ifRangeHeader = request.headers.get('If-Range');
            if (ifRangeHeader && !ifRangeMatches(ifRangeHeader, metadata)) {
                if (enableLogging) {
                    console.log(
                        `serveRangeRequests plugin: skipping ${url} (If-Range does not match cached validator)`
                    );
                }
                return;
            }

            try {
                // Парсим Range заголовок
                const range = parseRangeHeader(rangeHeader, metadata.size);

                // Получаем файл из кеша
                const cache = await getCache();
                const cachedResponse = await cache.match(url);
                if (!cachedResponse?.body) {
                    if (enableLogging) {
                        console.log(
                            `serveRangeRequests plugin: skipping ${url} (cached response has no body)`
                        );
                    }
                    return;
                }

                // Читаем нужный диапазон
                const data = await readRangeFromStream(
                    cachedResponse.body,
                    range
                );

                // Создаем заголовки ответа
                const headers = new Headers({
                    [HEADER_CONTENT_RANGE]: `bytes ${String(range.start)}-${String(range.end)}/${String(metadata.size)}`,
                    [HEADER_CONTENT_LENGTH]: String(data.byteLength),
                    [HEADER_CONTENT_TYPE]: metadata.type,
                });

                // Кешируем range-ответ только если он подходящего размера
                if (shouldCacheRange(range, maxCacheableRangeSize)) {
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

                // Создаем и возвращаем ответ
                const response = new Response(data, {
                    status: HTTP_STATUS_PARTIAL_CONTENT,
                    headers,
                });

                return addCacheHeaders(response, rangeResponseCacheControl);
            } catch (error) {
                // Логируем ошибку и возвращаем undefined, чтобы передать управление следующему плагину
                if (enableLogging) {
                    console.error(
                        `serveRangeRequests plugin error for ${url} with range ${rangeHeader}:`,
                        error
                    );
                }
                return;
            }
        },
    };
}
