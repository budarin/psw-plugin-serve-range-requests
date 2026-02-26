import type { GlobPattern, RangeHeaderValue, UrlString } from './types.js';

/**
 * Чистые функции для парсинга Range, проверки If-Range, glob и кеширования.
 * Вынесены для unit-тестов.
 */

/** Кеш скомпилированных RegExp по glob-паттерну (избегаем повторной компиляции). */
const globRegexCache = new Map<GlobPattern, RegExp>();

function getRegexForPattern(pattern: GlobPattern): RegExp {
    let regex = globRegexCache.get(pattern);
    if (!regex) {
        const regexPattern = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        regex = new RegExp(`^${regexPattern}$`);
        globRegexCache.set(pattern, regex);
    }
    return regex;
}

export interface Range {
    start: number;
    end: number;
}

export interface IfRangeMetadata {
    etag?: string;
    lastModified?: string;
}

/**
 * Парсит заголовок Range и возвращает диапазон байтов.
 */
export function parseRangeHeader(
    rangeHeader: RangeHeaderValue,
    fullSize: number
): Range {
    const trimmedHeader = rangeHeader.trim();

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

    const rangeMatch = /^bytes=(\d+)-(\d*)$/.exec(trimmedHeader);
    if (!rangeMatch) {
        throw new Error('Invalid or unsupported range header format');
    }

    const start = parseInt(rangeMatch[1]!, 10);
    const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : fullSize - 1;

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
 * Проверяет совпадение заголовка If-Range с метаданными (ETag или Last-Modified).
 */
export function ifRangeMatches(
    ifRangeValue: string,
    metadata: IfRangeMetadata
): boolean {
    const value = ifRangeValue.trim();
    if (!value) {
        return false;
    }
    if (metadata.lastModified) {
        const ifRangeDate = Date.parse(value);
        if (!Number.isNaN(ifRangeDate)) {
            const storedDate = Date.parse(metadata.lastModified);
            return (
                !Number.isNaN(storedDate) && ifRangeDate === storedDate
            );
        }
    }
    if (metadata.etag) {
        const normalizeEtag = (s: string) =>
            s.replace(/^\s*W\//i, '').replace(/^"|"$/g, '').trim();
        return normalizeEtag(value) === normalizeEtag(metadata.etag);
    }
    return false;
}

/**
 * Определяет, стоит ли кешировать данный диапазон (размер не превышает cap).
 */
export function shouldCacheRange(
    range: Range,
    maxCacheableRangeSize: number
): boolean {
    const rangeSize = range.end - range.start + 1;
    return rangeSize <= maxCacheableRangeSize;
}

/**
 * Проверяет, соответствует ли pathname указанному glob-паттерну.
 */
function matchesGlobByPath(pathname: string, pattern: GlobPattern): boolean {
    return getRegexForPattern(pattern).test(pathname);
}

/**
 * Проверяет, соответствует ли URL указанному glob-паттерну (по pathname).
 */
export function matchesGlob(url: UrlString, pattern: GlobPattern): boolean {
    const pathname = new URL(url, 'https://example.com').pathname;
    return matchesGlobByPath(pathname, pattern);
}

/**
 * Проверяет, должен ли файл обрабатываться на основе include/exclude масок.
 */
export function shouldProcessFile(
    url: UrlString,
    include?: GlobPattern[],
    exclude?: GlobPattern[]
): boolean {
    if (!include?.length && !exclude?.length) {
        return true;
    }
    const pathname = new URL(url, 'https://example.com').pathname;

    if (exclude && exclude.length > 0) {
        for (const pattern of exclude) {
            if (matchesGlobByPath(pathname, pattern)) {
                return false;
            }
        }
    }
    if (include && include.length > 0) {
        for (const pattern of include) {
            if (matchesGlobByPath(pathname, pattern)) {
                return true;
            }
        }
        return false;
    }
    return true;
}

/**
 * Читает указанный диапазон байтов из потока.
 * Учитывает AbortSignal — при отмене запроса прекращает чтение.
 */
export async function readRangeFromStream(
    stream: ReadableStream<Uint8Array>,
    range: Range,
    signal?: AbortSignal
): Promise<ArrayBuffer> {
    let offset = 0;
    let position = 0;

    const reader = stream.getReader();
    if (signal) {
        signal.addEventListener(
            'abort',
            () => {
                reader.cancel().catch(() => {});
            },
            { once: true }
        );
    }
    const result = new Uint8Array(range.end - range.start + 1);

    try {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        while (true) {
            if (signal?.aborted) {
                throw new Error('Request aborted');
            }

            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
                chunk = await reader.read();
            } catch (readError) {
                if (signal?.aborted) {
                    throw new Error('Request aborted');
                }
                throw readError;
            }
            const { done, value } = chunk;
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
 * Создаёт ReadableStream, отдающий только указанный диапазон байтов из исходного потока.
 * Используется для отдачи 206 без загрузки всего диапазона в память.
 */
export function createRangeStream(
    sourceStream: ReadableStream<Uint8Array>,
    range: Range,
    signal?: AbortSignal
): ReadableStream<Uint8Array> {
    const reader = sourceStream.getReader();
    let position = 0;

    if (signal) {
        signal.addEventListener(
            'abort',
            () => {
                reader.cancel().catch(() => {});
            },
            { once: true }
        );
    }

    return new ReadableStream<Uint8Array>({
        async pull(controller): Promise<void> {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            while (true) {
                if (signal?.aborted) {
                    controller.error(new Error('Request aborted'));
                    return;
                }
                let chunk: ReadableStreamReadResult<Uint8Array>;
                try {
                    chunk = await reader.read();
                } catch (readError) {
                    if (signal?.aborted) {
                        controller.error(new Error('Request aborted'));
                    } else {
                        controller.error(readError);
                    }
                    return;
                }
                const { done, value } = chunk;
                if (done) {
                    controller.close();
                    return;
                }
                const chunkStart = position;
                const chunkEnd = position + value.length;
                position = chunkEnd;

                if (chunkEnd < range.start) {
                    continue;
                }
                if (chunkStart > range.end) {
                    controller.close();
                    return;
                }
                const start = Math.max(range.start - chunkStart, 0);
                const end = Math.min(range.end - chunkStart + 1, value.length);
                if (start >= end) {
                    continue;
                }
                controller.enqueue(value.slice(start, end));
                return;
            }
        },
        cancel(): void {
            reader.cancel().catch(() => {});
        },
    });
}
