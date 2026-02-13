import type {
    FetchResponse,
    ServiceWorkerPlugin,
} from '@budarin/pluggable-serviceworker';

import {
    HEADER_RANGE,
    HEADER_CONTENT_TYPE,
    HEADER_CONTENT_RANGE,
    HEADER_CONTENT_LENGTH,
} from '@budarin/http-constants/headers';

import { HTTP_STATUS_PARTIAL_CONTENT } from '@budarin/http-constants/statuses';
import { MIME_APPLICATION_OCTET_STREAM } from '@budarin/http-constants/mime-types';

import { addCacheHeaders } from './addCacheHeaders.js';

interface Range {
    start: number;
    end: number;
}

interface CachedRange {
    data: ArrayBuffer;
    headers: Headers;
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
     * Максимальный размер диапазона для кеширования в байтах (по умолчанию 10MB)
     * Диапазоны больше этого размера не будут кешироваться
     */
    maxCacheableRangeSize?: number;
    /**
     * Минимальный размер диапазона для кеширования в байтах (по умолчанию 1KB)
     * Диапазоны меньше этого размера не будут кешироваться
     */
    minCacheableRangeSize?: number;
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
}

/**
 * Плагин для обработки HTTP Range запросов
 *
 * Этот плагин обрабатывает запросы с заголовком Range и возвращает
 * частичное содержимое файлов из кеша Service Worker'а.
 *
 * @param options - Опции конфигурации плагина
 * @returns ServiceWorkerPlugin для обработки Range запросов
 */
/**
 * Проверяет, соответствует ли URL указанному glob паттерну
 */
function matchesGlob(url: string, pattern: string): boolean {
    // Получаем pathname из URL
    const pathname = new URL(url, 'https://example.com').pathname;

    // Преобразуем glob паттерн в регулярное выражение
    const regexPattern = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Экранируем спецсимволы regex
        .replace(/\*/g, '.*') // * -> .*
        .replace(/\?/g, '.'); // ? -> .

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(pathname);
}

/**
 * Проверяет, должен ли файл обрабатываться на основе include/exclude масок
 */
function shouldProcessFile(
    url: string,
    include?: string[],
    exclude?: string[]
): boolean {
    // Если есть exclude маски, проверяем исключения
    if (exclude && exclude.length > 0) {
        for (const pattern of exclude) {
            if (matchesGlob(url, pattern)) {
                return false; // Файл исключен
            }
        }
    }

    // Если есть include маски, файл должен соответствовать хотя бы одной
    if (include && include.length > 0) {
        for (const pattern of include) {
            if (matchesGlob(url, pattern)) {
                return true; // Файл включен
            }
        }
        return false; // Файл не соответствует ни одной include маске
    }

    // Если нет include масок, но прошел exclude проверку - обрабатываем
    return true;
}

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
        minCacheableRangeSize = 1024, // 1KB
        include,
        exclude,
    } = options;

    // Кеш для range-ответов (LRU через Map)
    const rangeCache = new Map<string, CachedRange>();
    // Кеш метаданных файлов
    const fileMetadataCache = new Map<string, { size: number; type: string }>();
    // Кеш для Cache API объектов
    let cacheInstance: Cache | null = null;

    /**
     * Парсит заголовок Range и возвращает диапазон байтов
     */
    function parseRangeHeader(rangeHeader: string, fullSize: number): Range {
        const trimmedHeader = rangeHeader.trim();

        // Поддерживаем два формата:
        // 1. bytes=start-end или bytes=start-
        // 2. bytes=-suffix (последние N байт)

        // Суффиксный range: bytes=-500
        const suffixMatch = /^bytes=-(\d+)$/.exec(trimmedHeader);
        if (suffixMatch) {
            const suffixLength = parseInt(suffixMatch[1]!, 10);
            if (isNaN(suffixLength) || suffixLength <= 0) {
                throw new Error('Invalid suffix range value');
            }

            const start = Math.max(0, fullSize - suffixLength);
            const end = fullSize - 1;

            return { start, end };
        }

        // Обычный range: bytes=start-end или bytes=start-
        const rangeMatch = /^bytes=(\d+)-(\d*)$/.exec(trimmedHeader);
        if (!rangeMatch) {
            throw new Error('Invalid or unsupported range header format');
        }

        const start = parseInt(rangeMatch[1]!, 10);
        const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : fullSize - 1;

        // Валидация диапазона
        if (isNaN(start) || isNaN(end)) {
            throw new Error('Invalid range values');
        }

        if (start < 0 || start >= fullSize) {
            throw new Error('Range start is out of bounds');
        }

        if (end < start || end >= fullSize) {
            throw new Error('Range end is out of bounds');
        }

        return { start, end };
    }

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
     * Получает метаданные файла из кеша
     */
    async function getFileMetadata(
        url: string
    ): Promise<{ size: number; type: string } | undefined> {
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

            const metadata = {
                size,
                type:
                    response.headers.get(HEADER_CONTENT_TYPE) ??
                    MIME_APPLICATION_OCTET_STREAM,
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

    /**
     * Определяет, стоит ли кешировать данный диапазон
     */
    function shouldCacheRange(range: Range): boolean {
        const rangeSize = range.end - range.start + 1;
        return (
            rangeSize >= minCacheableRangeSize &&
            rangeSize <= maxCacheableRangeSize
        );
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

            // Проверяем условные заголовки
            const ifRangeHeader = request.headers.get('If-Range');
            if (ifRangeHeader) {
                // Если есть If-Range, нужно проверить ETag/Last-Modified
                // Для упрощения пропускаем такие запросы
                if (enableLogging) {
                    console.log(
                        `serveRangeRequests plugin: skipping request with If-Range header for ${request.url}`
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
                return addCacheHeaders(response);
            }

            // Получаем метаданные файла
            const metadata = await getFileMetadata(url);
            if (!metadata) {
                return;
            }

            try {
                // Парсим Range заголовок
                const range = parseRangeHeader(rangeHeader, metadata.size);

                // Получаем файл из кеша
                const cache = await getCache();
                const cachedResponse = await cache.match(url);
                if (!cachedResponse?.body) {
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
                if (shouldCacheRange(range)) {
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
                        `serveRangeRequests plugin: skipped caching for ${url}, size: ${rangeSize} bytes (out of cache range)`
                    );
                }

                // Создаем и возвращаем ответ
                const response = new Response(data, {
                    status: HTTP_STATUS_PARTIAL_CONTENT,
                    headers,
                });

                return addCacheHeaders(response);
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
