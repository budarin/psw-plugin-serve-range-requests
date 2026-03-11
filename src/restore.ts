import type { Logger } from '@budarin/pluggable-serviceworker';
import {
    matchByUrl,
    normalizeUrl,
} from '@budarin/pluggable-serviceworker/utils';

import type { Pathname, UrlString } from './types.js';

export interface RestoreOptions {
    getCache: () => Promise<Cache>;
    passthroughHeader: string;
    fetchPassthrough: (request: Request) => Promise<Response>;
    enableLogging: boolean;
    cacheName: string;
    restoreInProgress: Set<Pathname>;
    logger?: Logger | undefined;
}

/**
 * Запускает фоновое восстановление полного файла в кэш (fire-and-forget).
 * Не ждёт завершения; при успехе следующий запрос получит файл из кэша.
 */
export function startRestore(url: UrlString, options: RestoreOptions): void {
    const {
        getCache,
        passthroughHeader,
        fetchPassthrough,
        enableLogging,
        cacheName,
        restoreInProgress,
        logger,
    } = options;

    const pathname: Pathname = new URL(url).pathname;
    if (restoreInProgress.has(pathname)) {
        return;
    }

    restoreInProgress.add(pathname);

    void (async (): Promise<void> => {
        try {
            const cache = await getCache();

            const cacheRequestUrl = normalizeUrl(pathname);
            if (await matchByUrl(cache, new Request(cacheRequestUrl))) {
                if (enableLogging) {
                    logger?.debug?.(
                        `serveRangeRequests plugin: restore skipped for ${pathname} (already in cache)`
                    );
                }
                return;
            }

            const fullRequest = new Request(url, {
                method: 'GET',
                headers: {
                    [passthroughHeader]: '1',
                },
            });

            if (enableLogging) {
                logger?.debug?.(
                    `serveRangeRequests plugin: restore fetch for ${pathname} (full file, no Range)`
                );
            }

            const response = await fetchPassthrough(fullRequest);

            if (response.ok) {
                await cache.put(new Request(cacheRequestUrl), response);
                if (enableLogging) {
                    logger?.debug?.(
                        `serveRangeRequests plugin: cache put done for ${pathname} cacheName=${cacheName}`
                    );
                }
            } else {
                logger?.warn?.(
                    `serveRangeRequests plugin: restore failed for ${pathname} (response not ok) status=${response.status}`
                );
            }
        } catch (error) {
            logger?.warn?.(
                `serveRangeRequests plugin: restore error for ${pathname}`,
                error
            );
        } finally {
            restoreInProgress.delete(pathname);
            if (enableLogging) {
                logger?.debug?.(
                    `serveRangeRequests plugin: restore finished for ${pathname}`
                );
            }
        }
    })();
}
