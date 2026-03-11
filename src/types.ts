/**
 * Семантические алиасы для строковых типов (URL, заголовки, ключи кеша).
 */

/** URL ресурса (request.url, fetch/cache). */
export type UrlString = string;

/** Pathname ресурса (путь без origin); вся внутренняя работа плагина — по pathname. */
export type Pathname = string;

/** Значение заголовка Range (например, "bytes=0-1023"). */
export type RangeHeaderValue = string;

/** Glob-паттерн для include/exclude (например, "*.mp4", "/tiles/*"). */
export type GlobPattern = string;

/** Ключ записи в кеше range-ответов (url + range header). */
export type RangeCacheKey = string;

/** Один закешированный range-ответ (данные + заголовки для 206). */
export interface CachedRange {
    data: ArrayBuffer;
    headers: Headers;
}

/** Метаданные файла из Response (размер, тип, валидаторы). */
export interface FileMetadata {
    size: number;
    type: string;
    etag?: string;
    lastModified?: string;
}
