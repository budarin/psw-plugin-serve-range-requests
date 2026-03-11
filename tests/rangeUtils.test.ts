import { describe, it, expect } from 'vitest';
import {
    parseRangeHeader,
    ifRangeMatches,
    getRangeRequestSource,
    shouldCacheRange,
    matchesGlob,
    shouldProcessFile,
    normalizeToPathname,
    isGlobPattern,
    normalizeIncludeExclude,
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
            'Range start is out of bounds'
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

describe('getRangeRequestSource', () => {
    const cachedMetadata = { etag: '"cache-etag"', lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' };

    it('нет If-Range — cache (первый запрос или можно отдавать из кэша)', () => {
        const request = new Request('https://example.com/video.mp4', {
            headers: { Range: 'bytes=0-1023' },
        });
        expect(getRangeRequestSource(request, cachedMetadata)).toBe('cache');
    });

    it('If-Range совпадает с кэшем — cache', () => {
        const request = new Request('https://example.com/video.mp4', {
            headers: { Range: 'bytes=0-1023', 'If-Range': '"cache-etag"' },
        });
        expect(getRangeRequestSource(request, cachedMetadata)).toBe('cache');
    });

    it('If-Range не совпадает с кэшем — network (клиент от сетевого ответа)', () => {
        const request = new Request('https://example.com/video.mp4', {
            headers: { Range: 'bytes=1024-2047', 'If-Range': '"server-etag"' },
        });
        expect(getRangeRequestSource(request, cachedMetadata)).toBe('network');
    });

    it('If-Range пустой — cache', () => {
        const request = new Request('https://example.com/video.mp4', {
            headers: { Range: 'bytes=0-', 'If-Range': '   ' },
        });
        expect(getRangeRequestSource(request, cachedMetadata)).toBe('cache');
    });
});

describe('shouldCacheRange', () => {
    const max = 100;

    it('размер в пределах лимита — true', () => {
        expect(shouldCacheRange({ start: 0, end: 99 }, max)).toBe(true);
        // (0, 99) = 100 байт — в лимите; (0, 100) = 101 байт — уже выше max
    });

    it('размер больше лимита — false', () => {
        expect(shouldCacheRange({ start: 0, end: 100 }, max)).toBe(false);
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

    it('без include или пустой include — false', () => {
        expect(shouldProcessFile(url)).toBe(false);
        expect(shouldProcessFile(url, [])).toBe(false);
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

    it('exclude: нет совпадения, есть include — true', () => {
        expect(
            shouldProcessFile(url, ['*.mp4'], ['*.mp3'])
        ).toBe(true);
    });

    it('сначала exclude, потом include', () => {
        expect(
            shouldProcessFile(url, ['*.mp4'], ['*.mp4'])
        ).toBe(false);
    });
});

describe('normalizeToPathname', () => {
    it('URL с протоколом → pathname', () => {
        expect(normalizeToPathname('https://example.com/videos/a.mp4')).toBe(
            '/videos/a.mp4'
        );
        expect(normalizeToPathname('http://cdn.org/asset.mp4')).toBe('/asset.mp4');
    });
    it('protocol-relative URL (//host/path) → pathname', () => {
        expect(normalizeToPathname('//cdn.example.com/assets/video.mp4')).toBe(
            '/assets/video.mp4'
        );
    });
    it('path или glob без :// — без изменений', () => {
        expect(normalizeToPathname('/videos/a.mp4')).toBe('/videos/a.mp4');
        expect(normalizeToPathname('*.mp4')).toBe('*.mp4');
        expect(normalizeToPathname('/tiles/*')).toBe('/tiles/*');
    });
});

describe('isGlobPattern', () => {
    it('* или ? — true', () => {
        expect(isGlobPattern('*.mp4')).toBe(true);
        expect(isGlobPattern('/tiles/*')).toBe(true);
        expect(isGlobPattern('file?.mp4')).toBe(true);
    });
    it('литеральный path — false', () => {
        expect(isGlobPattern('/videos/intro.mp4')).toBe(false);
        expect(isGlobPattern('/asset')).toBe(false);
    });
});

describe('normalizeIncludeExclude', () => {
    it('приводит URL к pathname', () => {
        const r = normalizeIncludeExclude(
            ['https://example.com/videos/*.mp4'],
            ['https://cdn.com/static/*']
        );
        expect(r.include).toEqual(['/videos/*.mp4']);
        expect(r.exclude).toEqual(['/static/*']);
    });
    it('не-глобы без ведущего / получают ведущий /', () => {
        const r = normalizeIncludeExclude(
            ['videos/intro.mp4', '*.mp4'],
            ['static/skip']
        );
        expect(r.include).toEqual(['/videos/intro.mp4', '*.mp4']);
        expect(r.exclude).toEqual(['/static/skip']);
    });
    it('sameOriginOnly при любых include/exclude (глобы или нет)', () => {
        expect(
            normalizeIncludeExclude(['/videos/intro.mp4'], []).sameOriginOnly
        ).toBe(true);
        expect(
            normalizeIncludeExclude(['*.mp4'], ['/skip/this']).sameOriginOnly
        ).toBe(true);
        expect(
            normalizeIncludeExclude(['*.mp4'], ['*.json']).sameOriginOnly
        ).toBe(true);
        expect(normalizeIncludeExclude(undefined, undefined).sameOriginOnly).toBe(
            false
        );
    });
    it('при scopeOrigin отбрасывает URL другого домена', () => {
        const scopeOrigin = 'https://example.com';
        const r = normalizeIncludeExclude(
            ['https://example.com/videos/a.mp4', 'https://other.com/left.mp4', '/local'],
            ['https://example.com/skip', 'https://cdn.evil.com/exclude'],
            scopeOrigin
        );
        expect(r.include).toEqual(['/videos/a.mp4', '/local']);
        expect(r.exclude).toEqual(['/skip']);
    });
});
