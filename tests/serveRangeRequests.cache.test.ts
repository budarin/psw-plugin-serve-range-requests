import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
    Logger,
    ServiceWorkerPlugin,
} from '@budarin/pluggable-serviceworker';
import { serveRangeRequests } from '../src/index.js';

function createFetchEvent(request: Request): FetchEvent {
    return {
        request,
    } as unknown as FetchEvent;
}

describe('serveRangeRequests — cache limits', () => {
    const url = 'https://example.com/video.mp4';
    const body = new Uint8Array(1000);
    const headers = new Headers({
        'Content-Length': '1000',
        'Content-Type': 'video/mp4',
    });

    const logger: Logger = {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };

    let cachesOpenSpy: ReturnType<typeof vi.spyOn>;
    let cacheMatchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        cacheMatchSpy = vi.fn().mockResolvedValue(
            new Response(body, {
                headers,
            })
        );

        const fakeCache = {
            match: cacheMatchSpy,
        } as unknown as Cache;

        globalThis.caches = {
            open: vi.fn().mockResolvedValue(fakeCache),
        } as unknown as CacheStorage;

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        cachesOpenSpy = vi.spyOn(globalThis.caches!, 'open');
    });

    it('не кеширует диапазоны при maxCachedRanges = 0', async () => {
        const plugin: ServiceWorkerPlugin = serveRangeRequests({
            cacheName: 'test-cache',
            maxCachedRanges: 0,
            maxCachedMetadata: 0,
        });

        const fetchEvent = createFetchEvent(
            new Request(url, {
                headers: {
                    Range: 'bytes=0-99',
                },
            })
        );

        const first = await plugin.fetch?.(fetchEvent, logger);
        const second = await plugin.fetch?.(fetchEvent, logger);

        expect(first).toBeDefined();
        expect(second).toBeDefined();

        // Оба раза диапазон читается из Cache API, а не из внутреннего rangeCache
        expect(cacheMatchSpy).toHaveBeenCalledTimes(2);
    });

    it('не кеширует метаданные при maxCachedMetadata = 0 (повторные вызовы не ломаются)', async () => {
        const plugin: ServiceWorkerPlugin = serveRangeRequests({
            cacheName: 'test-cache',
            maxCachedRanges: 0,
            maxCachedMetadata: 0,
        });

        const fetchEvent = createFetchEvent(
            new Request(url, {
                headers: {
                    Range: 'bytes=100-199',
                },
            })
        );

        const first = await plugin.fetch?.(fetchEvent, logger);
        const second = await plugin.fetch?.(fetchEvent, logger);

        expect(first).toBeDefined();
        expect(second).toBeDefined();

        // Cache API вызывается дважды, но ошибок из-за внутреннего кеша метаданных нет
        expect(cacheMatchSpy).toHaveBeenCalledTimes(2);
    });
});
