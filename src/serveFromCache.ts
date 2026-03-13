import type { Logger } from '@budarin/pluggable-serviceworker';
import {
    HEADER_CONTENT_LENGTH,
    HEADER_ETAG,
    HEADER_LAST_MODIFIED,
} from '@budarin/http-constants/headers';

import type { FileMetadata, Pathname } from './types.js';
import {
    buildRangeResponseHeaders,
    extractMetadataFromResponse,
} from './rangeResponse.js';
import type { Range } from './rangeUtils.js';
import { createRangeStream, parseRangeHeader } from './rangeUtils.js';
import { SW_DEBUG_PREFIX } from './logging.js';

export interface ServeRangeFromCachedOptions {
    pathname: Pathname;
    /** Не задано — заголовок Cache-Control для 206 не выставляется. */
    rangeResponseCacheControl?: string | undefined;
    enableLogging: boolean;
    fileMetadataCache: Map<Pathname, FileMetadata>;
    /** Метаданные, уже извлечённые из cachedResponse (избегаем повторного парсинга заголовков). */
    precomputedMetadata?: FileMetadata | undefined;
    logger: Logger;
}

export interface ServeRangeResult {
    stream: ReadableStream<Uint8Array>;
    headers: Headers;
    range: Range;
    metadata: FileMetadata;
}

/**
 * Отдаёт диапазон из полного закешированного ответа: метаданные (из кеша или precomputedMetadata),
 * парсинг Range, createRangeStream, buildRangeResponseHeaders. Возвращает undefined при
 * отсутствии метаданных или тела ответа. Проверка If-Range выполняется в вызывающем коде (index).
 */
export function serveRangeFromCachedResponse(
    cachedResponse: Response,
    _request: Request,
    rangeHeader: string,
    workSignal: AbortSignal,
    options: ServeRangeFromCachedOptions
): ServeRangeResult | undefined {
    const {
        pathname,
        rangeResponseCacheControl,
        enableLogging,
        fileMetadataCache,
        precomputedMetadata,
        logger,
    } = options;

    let metadata = precomputedMetadata ?? fileMetadataCache.get(pathname);
    const fromCache = !precomputedMetadata && !!metadata;
    if (metadata && fromCache) {
        const contentLength = cachedResponse.headers.get(HEADER_CONTENT_LENGTH);
        if (contentLength !== String(metadata.size)) {
            metadata = undefined;
        }
    }
    if (!metadata) {
        metadata = extractMetadataFromResponse(cachedResponse);
    }
    // Всегда подставляем ETag/Last-Modified из текущего закешированного ответа,
    // если в metadata их нет (например, запись в fileMetadataCache от старого ответа).
    if (metadata) {
        const etag = cachedResponse.headers.get(HEADER_ETAG);
        const lastModified =
            cachedResponse.headers.get(HEADER_LAST_MODIFIED);
        if (etag || lastModified) {
            metadata = {
                ...metadata,
                ...(etag && { etag }),
                ...(lastModified && { lastModified }),
            };
        }
    }
    if (!metadata) {
        if (enableLogging) {
            logger.debug(
                `${SW_DEBUG_PREFIX} skipping ${pathname} (no valid metadata)`
            );
        }
        return undefined;
    }

    // LRU: при использовании метаданных из кеша обновляем порядок (актуальная запись в конце)
    if (fromCache && metadata) {
        fileMetadataCache.delete(pathname);
        fileMetadataCache.set(pathname, metadata);
    }

    const range = parseRangeHeader(rangeHeader, metadata.size);

    if (!cachedResponse.body) {
        if (enableLogging) {
            logger.debug(
                `${SW_DEBUG_PREFIX} skipping ${pathname} (cached response has no body)`
            );
        }
        return undefined;
    }
    if (workSignal.aborted) return undefined;

    const rangeSize = range.end - range.start + 1;
    const stream = createRangeStream(
        cachedResponse.body,
        range,
        { enableLogging, pathname, logger },
        workSignal
    );

    const headers = buildRangeResponseHeaders(
        range,
        metadata,
        rangeSize,
        rangeResponseCacheControl
    );

    return { stream, headers, range, metadata };
}
