import { matchByUrl } from '@budarin/pluggable-serviceworker/utils';

import type { UrlString } from './types.js';

export interface RestoreOptions {
    getCache: () => Promise<Cache>;
    passthroughHeader: string;
    fetchPassthrough: (request: Request) => Promise<Response>;
    enableLogging: boolean;
    cacheName: string;
    restoreInProgress: Set<UrlString>;
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
    } = options;

    if (restoreInProgress.has(url)) {
        return;
    }

    restoreInProgress.add(url);

    void (async (): Promise<void> => {
        try {
            const cache = await getCache();

            if (await matchByUrl(cache, new Request(url))) {
                if (enableLogging) {
                    console.log(
                        `serveRangeRequests plugin: restore skipped for ${url} (already in cache)`
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
                console.log(
                    `serveRangeRequests plugin: restore fetch for ${url} (full file, no Range)`
                );
            }

            const response = await fetchPassthrough(fullRequest);

            if (response.ok) {
                await cache.put(fullRequest, response);
                if (enableLogging) {
                    console.log(
                        `serveRangeRequests plugin: cache put done for ${url} cacheName=${cacheName}`
                    );
                }
            }
        } catch {
            // Игнорируем ошибки restore — следующий запрос попробует снова
        } finally {
            restoreInProgress.delete(url);
            if (enableLogging) {
                console.log(
                    `serveRangeRequests plugin: restore finished for ${url}`
                );
            }
        }
    })();
}
