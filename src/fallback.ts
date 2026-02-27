import { HEADER_RANGE } from '@budarin/http-constants/headers';

import type { UrlString } from './types.js';

export interface FallbackFetchOptions {
    url: UrlString;
    rangeHeader: string;
    passthroughHeader: string;
    fetchPassthrough: (request: Request) => Promise<Response>;
    enableLogging: boolean;
}

/**
 * Выполняет passthrough fetch к серверу с заголовком Range (fallback при промахе кэша).
 */
export function doFallbackFetch(
    request: Request,
    options: FallbackFetchOptions
): Promise<Response> {
    const {
        url,
        rangeHeader,
        passthroughHeader,
        fetchPassthrough,
        enableLogging,
    } = options;

    const headerRecord: Record<string, string> = {
        ...Object.fromEntries(request.headers.entries()),
        [passthroughHeader]: '1',
        [HEADER_RANGE]: rangeHeader,
    };

    const fallbackRequest = new Request(request.url, {
        method: request.method,
        mode: 'cors',
        credentials: request.credentials,
        headers: headerRecord,
        signal: request.signal,
    });

    if (enableLogging) {
        const keys = [...fallbackRequest.headers.keys()];
        console.log(
            `serveRangeRequests plugin: fallback fetch for ${url}, passthroughHeader: '${String(passthroughHeader)}', has passthrough: ${passthroughHeader ? fallbackRequest.headers.has(passthroughHeader) : false}, request header keys: ${keys.join(', ')}`
        );
    }

    return fetchPassthrough(fallbackRequest);
}
