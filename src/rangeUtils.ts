import type { Logger } from '@budarin/pluggable-serviceworker';

import type { GlobPattern, RangeHeaderValue, UrlString } from './types.js';

/**
 * Чистые функции для парсинга Range, проверки If-Range, glob и кеширования.
 * Вынесены для unit-тестов.
 */

/**
 * Безопасный парсинг URL: URL.parse когда доступен, иначе try/catch.
 * При полном переходе на URL.parse убрать fallback в одном месте.
 */
export function parseUrlSafely(url: string): URL | null {
    if (typeof URL.parse === 'function') {
        return URL.parse(url);
    }
    try {
        return new URL(url);
    } catch {
        return null;
    }
}

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
            return !Number.isNaN(storedDate) && ifRangeDate === storedDate;
        }
    }
    if (metadata.etag) {
        const normalizeEtag = (s: string) =>
            s
                .replace(/^\s*W\//i, '')
                .replace(/^"|"$/g, '')
                .trim();
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
 * Приводит запись include/exclude к pathname. В include/exclude часто передают URL ресурсов,
 * а не глобы — их нормализуем так, чтобы в итоге оставались pathname'ы, а не URL.
 * URL с протоколом (https://...) и protocol-relative (//host/...) → pathname; остальное — как есть.
 */
export function normalizeToPathname(entry: string): string {
    const trimmed = entry.trim();
    if (trimmed.includes('://')) {
        try {
            return new URL(trimmed).pathname;
        } catch {
            return trimmed;
        }
    }
    if (trimmed.startsWith('//')) {
        try {
            return new URL(`https:${trimmed}`).pathname;
        } catch {
            return trimmed;
        }
    }
    return trimmed;
}

/**
 * true, если паттерн содержит символы glob (* или ?).
 */
export function isGlobPattern(pattern: string): boolean {
    return pattern.includes('*') || pattern.includes('?');
}

export interface NormalizedIncludeExclude {
    include: string[];
    exclude: string[];
    /** true, если заданы include или exclude — обрабатываем только same-origin, сторонние URL отсекаем. */
    sameOriginOnly: boolean;
}

/**
 * Все не-глобы должны быть pathname (начинаться с /). Глобы оставляем как есть.
 */
function ensurePathname(entry: string): string {
    if (isGlobPattern(entry)) return entry;
    if (entry.startsWith('/')) return entry;
    return `/${entry}`;
}

function isFullUrl(entry: string): boolean {
    const t = entry.trim();
    return t.includes('://') || t.startsWith('//');
}

function getOriginOfEntry(entry: string): string | undefined {
    const t = entry.trim();
    try {
        if (t.includes('://')) return new URL(t).origin;
        if (t.startsWith('//')) return new URL(`https:${t}`).origin;
    } catch {
        return undefined;
    }
    return undefined;
}

/**
 * Нормализует элементы include/exclude. При переданном scopeOrigin полные URL
 * другого домена отбрасываются; pathname'ы, глобы и URL своего домена → pathname с ведущим /.
 * sameOriginOnly = true, если после фильтрации остались элементы.
 */
export function normalizeIncludeExclude(
    include?: string[],
    exclude?: string[],
    scopeOrigin?: string
): NormalizedIncludeExclude {
    const process = (entry: string): string | null => {
        const t = entry.trim();
        if (scopeOrigin && isFullUrl(t)) {
            const entryOrigin = getOriginOfEntry(t);
            if (entryOrigin !== undefined && entryOrigin !== scopeOrigin) return null;
        }
        return ensurePathname(normalizeToPathname(t));
    };
    const inc = (include ?? []).map(process).filter((x): x is string => x !== null);
    const exc = (exclude ?? []).map(process).filter((x): x is string => x !== null);
    const hasFilters = inc.length > 0 || exc.length > 0;
    return { include: inc, exclude: exc, sameOriginOnly: hasFilters };
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
 * @param pathnameOrUrl — pathname (например /videos/a.mp4) или полный URL; при наличии '://' парсится как URL.
 */
export function shouldProcessFile(
    pathnameOrUrl: string,
    include?: GlobPattern[],
    exclude?: GlobPattern[]
): boolean {
    if (include == null || include.length === 0) {
        return false;
    }
    const pathname = pathnameOrUrl.includes('://')
        ? new URL(pathnameOrUrl).pathname
        : pathnameOrUrl;

    if (exclude && exclude.length > 0) {
        for (const pattern of exclude) {
            if (matchesGlobByPath(pathname, pattern)) {
                return false;
            }
        }
    }
    for (const pattern of include) {
        if (matchesGlobByPath(pathname, pattern)) {
            return true;
        }
    }
    return false;
}

export interface CreateRangeStreamOptions {
    enableLogging?: boolean;
    pathname?: string;
    logger?: Logger | undefined;
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
    const { enableLogging = false, pathname = '', logger } = options ?? {};

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
                    if (enableLogging && pathname) {
                        logger?.debug?.(
                            `serveRangeRequests plugin: range stream closed (abort) for ${pathname} bytes ${range.start}-${range.end}`
                        );
                    }
                    controller.close();
                    return;
                }
                let chunk: ReadableStreamReadResult<Uint8Array>;
                try {
                    chunk = await reader.read();
                } catch (readError) {
                    if (enableLogging && pathname) {
                        logger?.warn?.(
                            `serveRangeRequests plugin: range stream closed (read error) for ${pathname} bytes ${range.start}-${range.end}:`,
                            readError
                        );
                    }
                    controller.close();
                    return;
                }
                const { done, value } = chunk;
                if (done) {
                    if (enableLogging && pathname) {
                        logger?.debug?.(
                            `serveRangeRequests plugin: range stream finished (source done) for ${pathname} bytes ${range.start}-${range.end}`
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
                    if (enableLogging && pathname) {
                        logger?.debug?.(
                            `serveRangeRequests plugin: range stream finished (range complete) for ${pathname} bytes ${range.start}-${range.end}`
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
            if (enableLogging && pathname) {
                logger?.debug?.(
                    `serveRangeRequests plugin: range stream cancelled (consumer cancelled) for ${pathname} bytes ${range.start}-${range.end}`
                );
            }
            reader.cancel().catch(() => {});
        },
    });
}
