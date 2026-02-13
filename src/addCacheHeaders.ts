import {
    HEADER_ETAG,
    HEADER_PRAGMA,
    HEADER_EXPIRES,
    HEADER_CACHE_CONTROL,
    HEADER_LAST_MODIFIED,
} from '@budarin/http-constants/headers';

export function addCacheHeaders(response: Response): Response {
    const headers = new Headers(response.headers);

    headers.set(HEADER_CACHE_CONTROL, 'max-age=31536000, immutable');
    headers.delete(HEADER_EXPIRES);
    headers.delete(HEADER_PRAGMA);
    headers.delete(HEADER_ETAG);
    headers.delete(HEADER_LAST_MODIFIED);

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers,
    });
}
