# @budarin/psw-plugin-serve-range-requests

[Русская версия](https://github.com/budarin/psw-plugin-serve-range-requests/blob/master/README.ru.md)

Service Worker plugin for [@budarin/pluggable-serviceworker](https://www.npmjs.com/package/@budarin/pluggable-serviceworker) that serves HTTP Range requests for cached files.

[![CI](https://github.com/budarin/psw-plugin-serve-range-requests/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/budarin/psw-plugin-serve-range-requests/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@budarin/psw-plugin-serve-range-requests?color=cb0000)](https://www.npmjs.com/package/@budarin/psw-plugin-serve-range-requests)
[![npm](https://img.shields.io/npm/dt/@budarin/psw-plugin-serve-range-requests)](https://www.npmjs.com/package/@budarin/psw-plugin-serve-range-requests)
[![bundle](https://img.shields.io/bundlephobia/minzip/@budarin/psw-plugin-serve-range-requests)](https://bundlephobia.com/result?p=@budarin/psw-plugin-serve-range-requests)
[![GitHub](https://img.shields.io/github/license/budarin/psw-plugin-serve-range-requests)](https://github.com/budarin/psw-plugin-serve-range-requests)

### Why this plugin

Applications that play or display large media—video, audio, PDFs—typically request data in small chunks (HTTP Range requests) rather than loading entire files. If such files are stored in a normal cache, every request for a single chunk would cause the **entire file** to be read from cache and sent to the client. That leads to unnecessary memory and CPU usage and can make the application sluggish or unresponsive. This plugin serves cached content by range: only the requested bytes are read and delivered, so playback stays smooth and resource usage stays under control.

## Quick start

```typescript
import { serveRangeRequests } from '@budarin/psw-plugin-serve-range-requests';

// Basic usage – only the required option
serveRangeRequests({ cacheName: 'media-cache' });

// With additional options
serveRangeRequests({
    cacheName: 'media-cache',
    include: ['*.mp4', '*.mp3', '*.pdf'], // Only these file types
    maxCacheableRangeSize: 5 * 1024 * 1024, // Max 5MB per range
    maxCachedRanges: 50, // Up to 50 ranges kept in memory
    enableLogging: true, // Enable debug logging
});
```

## Options

| Option                      | Type       | Default                       | Description                                                                                        |
| --------------------------- | ---------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `cacheName`                 | `string`   | -                             | **Required.** Cache name                                                                           |
| `order`                     | `number`   | `-10`                         | Plugin execution order (optional)                                                                  |
| `maxCachedRanges`           | `number`   | `100`                         | Max number of cached ranges (see below)                                                            |
| `maxCachedMetadata`         | `number`   | `200`                         | Max number of files to keep metadata for (see below)                                               |
| `maxCacheableRangeSize`     | `number`   | `10MB`                        | Max size of a single cached range (see below)                                                      |
| `include`                   | `string[]` | -                             | File glob patterns to include                                                                      |
| `exclude`                   | `string[]` | -                             | File glob patterns to exclude                                                                      |
| `rangeResponseCacheControl` | `string`   | `max-age=31536000, immutable` | Cache-Control for 206 responses (browser cache); use e.g. `no-store` or `max-age=3600` to override |
| `enableLogging`             | `boolean`  | `false`                       | Verbose logging                                                                                    |

**Metadata cache (`maxCachedMetadata`)**
The plugin keeps metadata for files it has already served so that repeat Range requests to the same file are faster. Set this to roughly how many **different** files of this type users typically open or play in a session. If they often switch between many items (e.g. a long playlist, a large document list), use a higher value (hundreds). If they usually work with just a few files at a time, a lower value (tens) is enough. File size does not affect this limit—only the number of distinct URLs matters.

**Range cache (`maxCachedRanges`, `maxCacheableRangeSize`)**
The plugin caches every range response it serves, so that repeated requests for the same part of a file (e.g. rewind, replay) are served from memory. Eviction is LRU: when the limit is reached, the least recently used (oldest) entries are dropped. **maxCachedRanges** is how many range responses to keep—more if users often jump back to the same parts. **maxCacheableRangeSize** is only an upper cap: ranges larger than this are not cached (to avoid one huge entry using too much memory). There is no minimum size—any requested range that fits under the cap is cached.

**206 responses and browser cache**
By default, the plugin sets `Cache-Control: max-age=31536000, immutable` on 206 responses so the browser caches them. Override with **rangeResponseCacheControl** (e.g. `no-store`, `max-age=3600`, or `''` to leave the header unset).

When choosing option values, focus on the real traffic profile of your resources. You can inspect and analyze all requests to your assets in the browser DevTools `Network` panel.

## Important notes

⚠️ **Do not cache huge files and ranges** – mobile devices may not handle them well. Range data is read sequentially from the cached file stream (Cache API does not support random access), so requesting a range near the end of a very large file can be slow; prefer smaller assets.

## Usage example

```typescript
import { initServiceWorker } from '@budarin/pluggable-serviceworker';
import { serveRangeRequests } from '@budarin/psw-plugin-serve-range-requests';

initServiceWorker(
    [
        serveRangeRequests({
            cacheName: 'media-cache',
            include: ['*.mp4', '*.webm', '*.mkv'], // Video
            maxCacheableRangeSize: 20 * 1024 * 1024, // 20MB
            maxCachedRanges: 30,
        }),
        serveRangeRequests({
            cacheName: 'media-cache',
            include: ['*.mp3', '*.flac', '*.wav'], // Audio
            maxCacheableRangeSize: 8 * 1024 * 1024, // 8MB
            maxCachedRanges: 200,
        }),
    ],
    { version: '1.0.0' }
);
```

## Built‑in presets (optional)

If you don’t want to tune all the options manually, you can use ready‑made presets:

### Available presets

- **VIDEO_PRESET** – for media players: `*.mp4`, `*.webm`, `*.mkv`, `*.avi`, `*.mov`, `*.m4v`
- **AUDIO_PRESET** – for audio players: `*.mp3`, `*.flac`, `*.wav`, `*.m4a`, `*.ogg`, `*.aac`
- **MAPS_PRESET** – for maps and tiles: `*.mbtiles`, `*.pmtiles`, `/tiles/*`, `/maps/*`, `*.mvt`
- **DOCS_PRESET** – for documents: `*.pdf`, `*.epub`, `*.djvu`, `*.mobi`, `*.azw3`

```typescript
import { initServiceWorker } from '@budarin/pluggable-serviceworker';
import {
    serveRangeRequests,
    VIDEO_PRESET,
    AUDIO_PRESET,
} from '@budarin/psw-plugin-serve-range-requests';

initServiceWorker(
    [
        serveRangeRequests({ ...VIDEO_PRESET, cacheName: 'video-cache' }),
        serveRangeRequests({ ...AUDIO_PRESET, cacheName: 'audio-cache' }),
    ],
    { version: '1.0.0' }
);
```

### Adaptive presets

All the presets above can be adapted to the device capabilities. On devices with low RAM and weak CPUs, the limits are automatically decreased to keep the app responsive.

```typescript
import { initServiceWorker } from '@budarin/pluggable-serviceworker';
import {
    serveRangeRequests,
    getAdaptivePresets,
} from '@budarin/psw-plugin-serve-range-requests';

// Automatically adapts to device performance:
// - Very low-end (<2GB RAM and <2 CPU cores): minimal limits
// - Low-end (<4GB RAM or <4 CPU cores): reduced limits
// - More powerful (>=4GB RAM and >=4 CPU cores): full preset settings
const { VIDEO_ADAPTIVE, AUDIO_ADAPTIVE, MAPS_ADAPTIVE, DOCS_ADAPTIVE } =
    getAdaptivePresets();

initServiceWorker(
    [
        serveRangeRequests({ ...VIDEO_ADAPTIVE, cacheName: 'video-cache' }),
        serveRangeRequests({ ...AUDIO_ADAPTIVE, cacheName: 'audio-cache' }),
        serveRangeRequests({ ...MAPS_ADAPTIVE, cacheName: 'maps-cache' }),
        serveRangeRequests({ ...DOCS_ADAPTIVE, cacheName: 'docs-cache' }),
    ],
    { version: '1.0.0' }
);
```

## Supported Range formats

- `bytes=0-499` – first 500 bytes
- `bytes=500-999` – bytes 500 through 999
- `bytes=500-` – from byte 500 to the end
- `bytes=-500` – last 500 bytes

## How it works

1. Checks the `Range` header in the request.
2. Looks up the file in the specified cache.
3. If the request has `If-Range` (ETag or Last-Modified), serves from cache only when the stored validator matches (otherwise passes the request through).
4. Reads the requested byte range from the file.
5. Caches the ready‑to‑use partial response.
6. Returns HTTP `206 Partial Content`.

---

**Tip**: In most cases it is enough to configure `cacheName` and a few `include` patterns.

## 🤝 License

MIT © budarin
