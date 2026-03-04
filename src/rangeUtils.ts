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
 * Определяет источник предыдущего ответа для клиента по заголовкам запроса и метаданным кэша.
 * Бизнес-логика обхода Chromium bug 1026867: не переключать источник (сеть → кэш) в середине воспроизведения.
 *
 * Если в запросе есть If-Range и он не совпадает с метаданными закэшированного ответа — клиент
 * держит валидатор от сетевого ответа, значит предыдущий ответ был с сети; отдавать из кэша нельзя.
 * Если If-Range совпадает или отсутствует — можно отдавать из кэша.
 *
 * @see https://bugs.chromium.org/p/chromium/issues/detail?id=1026867
 */
export function getRangeRequestSource(
    request: Request,
    cachedMetadata: IfRangeMetadata
): 'cache' | 'network' {
    const ifRangeHeader = request.headers.get('If-Range');
    if (!ifRangeHeader?.trim()) {
        return 'cache';
    }
    if (ifRangeMatches(ifRangeHeader, cachedMetadata)) {
        return 'cache';
    }
    return 'network';
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

export interface CreateRangeStreamOptions {
    enableLogging?: boolean;
    url?: string;
}

/**
 * Создаёт ReadableStream, отдающий только указанный диапазон байтов из исходного потока.
 * Используется для отдачи 206 без загрузки всего диапазона в память.
 * При abort/ошибке чтения стрим завершается через close(), а не error(), чтобы не вызывать
 * PIPELINE_ERROR_READ у медиа-плеера (FFmpegDemuxer: data source error).
 */
export function createRangeStream(
    sourceStream: ReadableStream<Uint8Array>,
    range: Range,
    signal?: AbortSignal,
    options?: CreateRangeStreamOptions
): ReadableStream<Uint8Array> {
    const reader = sourceStream.getReader();
    let position = 0;
    const { enableLogging = false, url = '' } = options ?? {};

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
                    if (enableLogging && url) {
                        console.log(
                            `serveRangeRequests plugin: range stream closed (abort) for ${url} bytes ${range.start}-${range.end}`
                        );
                    }
                    controller.close();
                    return;
                }
                let chunk: ReadableStreamReadResult<Uint8Array>;
                try {
                    chunk = await reader.read();
                } catch (readError) {
                    if (enableLogging && url) {
                        console.warn(
                            `serveRangeRequests plugin: range stream closed (read error) for ${url} bytes ${range.start}-${range.end}:`,
                            readError
                        );
                    }
                    controller.close();
                    return;
                }
                const { done, value } = chunk;
                if (done) {
                    if (enableLogging && url) {
                        console.log(
                            `serveRangeRequests plugin: range stream finished (source done) for ${url} bytes ${range.start}-${range.end}`
                        );
                    }
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
                    if (enableLogging && url) {
                        console.log(
                            `serveRangeRequests plugin: range stream finished (range complete) for ${url} bytes ${range.start}-${range.end}`
                        );
                    }
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
            if (enableLogging && url) {
                console.log(
                    `serveRangeRequests plugin: range stream cancelled (consumer cancelled) for ${url} bytes ${range.start}-${range.end}`
                );
            }
            reader.cancel().catch(() => {});
        },
    });
}
