/**
 * Чистые функции для парсинга Range, проверки If-Range, glob и кеширования.
 * Вынесены для unit-тестов.
 */

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
    rangeHeader: string,
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
 * Проверяет, соответствует ли URL указанному glob-паттерну (по pathname).
 */
export function matchesGlob(url: string, pattern: string): boolean {
    const pathname = new URL(url, 'https://example.com').pathname;
    const regexPattern = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(pathname);
}

/**
 * Проверяет, должен ли файл обрабатываться на основе include/exclude масок.
 */
export function shouldProcessFile(
    url: string,
    include?: string[],
    exclude?: string[]
): boolean {
    if (exclude && exclude.length > 0) {
        for (const pattern of exclude) {
            if (matchesGlob(url, pattern)) {
                return false;
            }
        }
    }
    if (include && include.length > 0) {
        for (const pattern of include) {
            if (matchesGlob(url, pattern)) {
                return true;
            }
        }
        return false;
    }
    return true;
}
