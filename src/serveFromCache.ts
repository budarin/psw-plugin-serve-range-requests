import { HEADER_CONTENT_LENGTH } from '@budarin/http-constants/headers';

import type { FileMetadata, UrlString } from './types.js';
import {
    buildRangeResponseHeaders,
    extractMetadataFromResponse,
} from './rangeResponse.js';
import type { Range } from './rangeUtils.js';
import {
    createRangeStream,
    ifRangeMatches,
    parseRangeHeader,
} from './rangeUtils.js';

export interface ServeRangeFromCachedOptions {
    url: UrlString;
    /** Не задано — заголовок Cache-Control для 206 не выставляется. */
    rangeResponseCacheControl?: string | undefined;
    enableLogging: boolean;
    fileMetadataCache: Map<UrlString, FileMetadata>;
}

export interface ServeRangeResult {
    stream: ReadableStream<Uint8Array>;
    headers: Headers;
    range: Range;
    metadata: FileMetadata;
}

/**
 * Отдаёт диапазон из полного закешированного ответа: метаданные, If-Range, парсинг Range,
 * createRangeStream, buildRangeResponseHeaders. Возвращает undefined при несовпадении If-Range,
 * отсутствии метаданных или тела ответа.
 */
export function serveRangeFromCachedResponse(
    cachedResponse: Response,
    request: Request,
    rangeHeader: string,
    workSignal: AbortSignal,
    options: ServeRangeFromCachedOptions
): ServeRangeResult | undefined {
    const { url, rangeResponseCacheControl, enableLogging, fileMetadataCache } =
        options;

    let metadata = fileMetadataCache.get(url);
    if (metadata) {
        const contentLength = cachedResponse.headers.get(HEADER_CONTENT_LENGTH);
        if (contentLength !== String(metadata.size)) {
            metadata = undefined;
        }
    }
    if (!metadata) {
        metadata = extractMetadataFromResponse(cachedResponse);
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
    if (ifRangeHeader && !ifRangeMatches(ifRangeHeader, metadata)) {
        if (enableLogging) {
            console.log(
                `serveRangeRequests plugin: skipping ${url} (If-Range does not match)`
            );
        }
        return undefined;
    }

    const range = parseRangeHeader(rangeHeader, metadata.size);

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
}
