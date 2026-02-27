import type { UrlString } from './types.js';

/** Единственный ожидающий слот. При новом запросе предыдущий отменяется через resolve(null). */
export interface NextWaiter {
    resolve: (release: (() => void) | null) => void;
    wake: () => void;
}

export interface UrlState {
    count: number;
    nextWaiter: NextWaiter | null;
    abortController: AbortController;
}

export interface RangeSlotManagerOptions {
    maxConcurrentRangesPerUrl: number;
    prioritizeLatestRequest: boolean;
    maxTrackedUrls: number;
}

export interface RangeSlotManager {
    acquireRangeSlot: (url: UrlString) => Promise<(() => void) | null>;
    getOrCreateUrlState: (url: UrlString) => UrlState;
}

/**
 * Объединяет несколько AbortSignal — при отмене любого работа останавливается.
 */
export function mergeAbortSignals(...signals: AbortSignal[]): AbortSignal {
    const aborted = signals.find((s) => s.aborted);
    if (aborted) {
        return aborted;
    }
    if (typeof AbortSignal.any === 'function') {
        return AbortSignal.any(signals);
    }
    const ac = new AbortController();
    const abort = () => ac.abort();
    for (const s of signals) {
        s.addEventListener('abort', abort, { once: true });
    }
    return ac.signal;
}

/**
 * Создаёт менеджер слотов по URL: ограничение одновременных range-чтений на один URL, LIFO при prioritizeLatestRequest.
 */
export function createRangeSlotManager(
    options: RangeSlotManagerOptions
): RangeSlotManager {
    const {
        maxConcurrentRangesPerUrl,
        prioritizeLatestRequest,
        maxTrackedUrls: maxUrlStates,
    } = options;

    let urlSemaphore: Map<UrlString, UrlState> | null = null;

    function getOrCreateUrlState(url: UrlString): UrlState {
        if (!urlSemaphore) {
            urlSemaphore = new Map();
        }
        let state = urlSemaphore.get(url);
        if (!state) {
            if (maxUrlStates > 0 && urlSemaphore.size >= maxUrlStates) {
                for (const [key, s] of urlSemaphore) {
                    if (s.count === 0 && !s.nextWaiter) {
                        urlSemaphore.delete(key);
                        break;
                    }
                }
            }
            state = {
                count: 0,
                nextWaiter: null,
                abortController: new AbortController(),
            };
            urlSemaphore.set(url, state);
        }
        return state;
    }

    function acquireRangeSlot(url: UrlString): Promise<(() => void) | null> {
        if (!prioritizeLatestRequest) {
            return Promise.resolve(() => {});
        }

        const state = getOrCreateUrlState(url);

        return new Promise<(() => void) | null>((resolve) => {
            const release = () => {
                state.count--;
                const waiter = state.nextWaiter;
                state.nextWaiter = null;
                if (waiter) {
                    waiter.wake();
                }
            };

            const wake = () => {
                state.count++;
                resolve(release);
            };

            if (state.count < maxConcurrentRangesPerUrl) {
                state.count++;
                resolve(release);
                return;
            }

            state.abortController.abort();
            state.abortController = new AbortController();
            const prev = state.nextWaiter;
            state.nextWaiter = null;
            if (prev) {
                prev.resolve(null);
            }

            state.nextWaiter = { resolve, wake };
        });
    }

    return { acquireRangeSlot, getOrCreateUrlState };
}
