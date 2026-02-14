import { describe, it, expect } from 'vitest';
import {
    parseRangeHeader,
    ifRangeMatches,
    shouldCacheRange,
    matchesGlob,
    shouldProcessFile,
} from '../src/rangeUtils.js';

describe('parseRangeHeader', () => {
    const fullSize = 1000;

    it('парсит bytes=start-end', () => {
        expect(parseRangeHeader('bytes=0-499', fullSize)).toEqual({
            start: 0,
            end: 499,
        });
        expect(parseRangeHeader('bytes=100-200', fullSize)).toEqual({
            start: 100,
            end: 200,
        });
    });

    it('парсит bytes=start- (до конца)', () => {
        expect(parseRangeHeader('bytes=500-', fullSize)).toEqual({
            start: 500,
            end: 999,
        });
    });

    it('парсит bytes=-suffix (последние N байт)', () => {
        expect(parseRangeHeader('bytes=-500', fullSize)).toEqual({
            start: 500,
            end: 999,
        });
        expect(parseRangeHeader('bytes=-1000', fullSize)).toEqual({
            start: 0,
            end: 999,
        });
    });

    it('допускает пробелы в заголовке', () => {
        expect(parseRangeHeader('  bytes=0-99  ', fullSize)).toEqual({
            start: 0,
            end: 99,
        });
    });

    it('выбрасывает при неверном формате', () => {
        expect(() => parseRangeHeader('bytes=0', fullSize)).toThrow(
            'Invalid or unsupported range header format'
        );
        expect(() => parseRangeHeader('bytes=a-100', fullSize)).toThrow();
        expect(() => parseRangeHeader('bytes=-0', fullSize)).toThrow(
            'Invalid suffix range value'
        );
    });

    it('выбрасывает при выходе за границы', () => {
        expect(() => parseRangeHeader('bytes=0-1000', fullSize)).toThrow(
            'Range end is out of bounds'
        );
        expect(() => parseRangeHeader('bytes=1000-1001', fullSize)).toThrow(
            'Range start is out of bounds'
        );
        expect(() => parseRangeHeader('bytes=500-400', fullSize)).toThrow(
            'Range end is out of bounds'
        );
    });

    it('пустой файл (fullSize=0)', () => {
        expect(() => parseRangeHeader('bytes=0-0', 0)).toThrow(
            'Range end is out of bounds'
        );
    });
});

describe('ifRangeMatches', () => {
    it('совпадает ETag (без W/)', () => {
        expect(
            ifRangeMatches('"abc123"', { etag: '"abc123"' })
        ).toBe(true);
        expect(ifRangeMatches('"abc123"', { etag: 'abc123' })).toBe(true);
    });

    it('совпадает weak ETag', () => {
        expect(ifRangeMatches('W/"x"', { etag: '"x"' })).toBe(true);
        expect(ifRangeMatches('W/"x"', { etag: 'x' })).toBe(true);
    });

    it('не совпадает ETag', () => {
        expect(ifRangeMatches('"other"', { etag: '"abc123"' })).toBe(false);
        expect(ifRangeMatches('"a"', { etag: '"b"' })).toBe(false);
    });

    it('совпадает Last-Modified (HTTP-date)', () => {
        const date = 'Wed, 21 Oct 2015 07:28:00 GMT';
        expect(
            ifRangeMatches(date, { lastModified: date })
        ).toBe(true);
    });

    it('не совпадает Last-Modified', () => {
        expect(
            ifRangeMatches('Wed, 21 Oct 2015 07:28:00 GMT', {
                lastModified: 'Thu, 22 Oct 2015 08:00:00 GMT',
            })
        ).toBe(false);
    });

    it('пустое значение If-Range', () => {
        expect(ifRangeMatches('  ', { etag: '"x"' })).toBe(false);
    });

    it('нет etag и lastModified — false', () => {
        expect(ifRangeMatches('"x"', {})).toBe(false);
    });
});

describe('shouldCacheRange', () => {
    const max = 100;

    it('размер в пределах лимита — true', () => {
        expect(shouldCacheRange({ start: 0, end: 99 }, max)).toBe(true);
        expect(shouldCacheRange({ start: 0, end: 100 }, max)).toBe(true);
    });

    it('размер больше лимита — false', () => {
        expect(shouldCacheRange({ start: 0, end: 100 }, max)).toBe(true);
        expect(shouldCacheRange({ start: 0, end: 101 }, max)).toBe(false);
    });
});

describe('matchesGlob', () => {
    it('* совпадает с любым pathname', () => {
        expect(matchesGlob('https://example.com/foo/bar.mp4', '*')).toBe(
            true
        );
        expect(matchesGlob('https://example.com/bar', '/bar')).toBe(true);
    });

    it('*.mp4 совпадает с pathname, оканчивающимся на .mp4', () => {
        expect(
            matchesGlob('https://example.com/video.mp4', '*.mp4')
        ).toBe(true);
        expect(
            matchesGlob('https://example.com/path/video.mp4', '*.mp4')
        ).toBe(true);
    });

    it('/tiles/* совпадает с path /tiles/...', () => {
        expect(
            matchesGlob('https://example.com/tiles/1/2/3', '/tiles/*')
        ).toBe(true);
        expect(
            matchesGlob('https://example.com/tiles', '/tiles/*')
        ).toBe(false);
    });

    it('pathname с ведущим слэшем для паттерна /videos/*.mp4', () => {
        expect(
            matchesGlob('https://example.com/videos/a.mp4', '/videos/*.mp4')
        ).toBe(true);
    });
});

describe('shouldProcessFile', () => {
    const url = 'https://example.com/media/video.mp4';

    it('без include и exclude — true', () => {
        expect(shouldProcessFile(url)).toBe(true);
    });

    it('include: совпадение — true', () => {
        expect(
            shouldProcessFile(url, ['*.mp4', '*.webm'])
        ).toBe(true);
    });

    it('include: нет совпадения — false', () => {
        expect(shouldProcessFile(url, ['*.mp3'])).toBe(false);
    });

    it('exclude: совпадение — false', () => {
        expect(
            shouldProcessFile(url, undefined, ['*.mp4'])
        ).toBe(false);
    });

    it('exclude: нет совпадения — true', () => {
        expect(
            shouldProcessFile(url, undefined, ['*.mp3'])
        ).toBe(true);
    });

    it('сначала exclude, потом include', () => {
        expect(
            shouldProcessFile(url, ['*.mp4'], ['*.mp4'])
        ).toBe(false);
    });
});
