import {
    HEADER_CACHE_CONTROL,
    HEADER_CONTENT_LENGTH,
    HEADER_CONTENT_RANGE,
    HEADER_CONTENT_TYPE,
    HEADER_ETAG,
    HEADER_LAST_MODIFIED,
} from '@budarin/http-constants/headers';
import { MIME_APPLICATION_OCTET_STREAM } from '@budarin/http-constants/mime-types';

import type { FileMetadata } from './types.js';
import type { Range } from './rangeUtils.js';

/**
 * Создаёт заголовки для 206-ответа с опциональным Cache-Control.
 */
/** Заголовок, сообщающий клиенту, что сервер поддерживает range-запросы (нужен плееру для перемотки). */
const HEADER_ACCEPT_RANGES = 'Accept-Ranges';

export function buildRangeResponseHeaders(
    range: Range,
    metadata: FileMetadata,
    dataByteLength: number,
    cacheControl?: string
): Headers {
    const headers = new Headers({
        [HEADER_ACCEPT_RANGES]: 'bytes',
        [HEADER_CONTENT_RANGE]: `bytes ${range.start}-${range.end}/${metadata.size}`,
        [HEADER_CONTENT_LENGTH]: String(dataByteLength),
        [HEADER_CONTENT_TYPE]: metadata.type,
    });
    if (cacheControl) {
        headers.set(HEADER_CACHE_CONTROL, cacheControl);
    }
    return headers;
}

/**
 * Извлекает метаданные файла из Response (размер, тип, ETag, Last-Modified).
 */
export function extractMetadataFromResponse(
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
