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

| Option                        | Type       | Default                       | Description                                                                                        |
| ----------------------------- | ---------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `cacheName`                   | `string`   | -                             | **Required.** Cache name                                                                           |
| `order`                       | `number`   | `-10`                         | Plugin execution order (optional)                                                                  |
| `maxCachedRanges`             | `number`   | `100`                         | Max number of cached ranges (see below)                                                            |
| `maxCachedMetadata`           | `number`   | `200`                         | Max number of files to keep metadata for (see below)                                               |
| `maxCacheableRangeSize`       | `number`   | `10MB`                        | Max size of a single cached range (see below)                                                      |
| `maxConcurrentRangesPerUrl`   | `number`   | `4`                           | How many ranges of one file to read in parallel (see below)                                        |
| `prioritizeLatestRequest`     | `boolean`  | `true`                        | Queue mode: video/scrubbing vs maps/docs (see below)                                               |
| `include`                     | `string[]` | -                             | File glob patterns to include                                                                      |
| `exclude`                     | `string[]` | -                             | File glob patterns to exclude                                                                      |
| `rangeResponseCacheControl`   | `string`   | `max-age=31536000, immutable` | Cache-Control for 206 responses (browser cache); use e.g. `no-store` or `max-age=3600` to override |
| `enableLogging`               | `boolean`  | `false`                       | Verbose logging                                                                                    |

## When to cache what — by scenario

The plugin caches two things: **file metadata** (size, type) and **ready range responses**. Whether range caching helps depends on how users interact with the content.

### Video and audio: range cache is not used when scrubbing

When scrubbing video, each seek requests a **new** part of the file. You jump to 15 min — bytes 50–60 MB. Jump to 30 min — bytes 100–110 MB. Jump back to 15 min — that’s often a different range (different offset, different chunk). Even when you land in the same area, it’s rare. In practice, scrubbing almost never hits a previously cached range — the range cache does little for video and just wastes memory.

For video, set **maxCachedRanges** to 0 — the range cache is not used. What matters more: during scrubbing the browser sends dozens of requests and cancels the old ones. With `prioritizeLatestRequest: true`, the plugin prioritizes the latest request and aborts redundant work — scrubbing stays fast.

### Maps and tiles: cache is very useful

When panning and zooming, the same tiles are requested over and over. The same range in pmtiles/mbtiles is fetched many times — range cache gives a real boost. Use higher **maxCachedRanges** (500–1000). `prioritizeLatestRequest: false` — no queues, all requests in parallel.

### Documents (PDF, etc.): cache helps when flipping pages

Users flip back and forth — the same pages are requested again. Range cache helps. `prioritizeLatestRequest: false` — no queues, all requests in parallel.

---

**Metadata cache (`maxCachedMetadata`)**  
The plugin remembers size and type of files it has already served so it doesn’t hit Cache API unnecessarily. Set this to roughly how many **different** files users open or play in a session: a playlist of 50 tracks — tens; a catalog of hundreds of docs — hundreds. File size doesn’t affect this limit.

**Range cache (`maxCachedRanges`, `maxCacheableRangeSize`)**  
The plugin can cache ready range responses. **maxCachedRanges** — how many to keep in memory. **maxCacheableRangeSize** — upper cap; larger ranges are not cached (to avoid memory spikes). Eviction is LRU. For video and audio scrubbing, the cache is not used — don’t waste memory on it.

**Concurrency (`maxConcurrentRangesPerUrl`)**  
Only applies when `prioritizeLatestRequest: true`. For video and audio, 1 is optimal — queues slow things down. When `false`, no limit — all requests run in parallel.

**Prioritize latest request (`prioritizeLatestRequest`)**  
`true` (default) — for video and audio: semaphore, LIFO queue, abort on new request. `false` — for maps and docs: no queues, all requests run in parallel.

**206 responses and browser cache**  
By default, the plugin sets `Cache-Control: max-age=31536000, immutable` on 206 responses so the browser caches them. Override with **rangeResponseCacheControl** (e.g. `no-store`, `max-age=3600`, or `''` to leave the header unset).

When tuning options, look at real traffic — use the Network tab in DevTools.

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
            maxCachedRanges: 0,
            maxCachedMetadata: 0,
            maxConcurrentRangesPerUrl: 1,
            prioritizeLatestRequest: true,
        }),
        serveRangeRequests({
            cacheName: 'media-cache',
            include: ['*.mp3', '*.flac', '*.wav'], // Audio
            maxCacheableRangeSize: 8 * 1024 * 1024, // 8MB
            maxCachedRanges: 0,
            maxCachedMetadata: 0,
            maxConcurrentRangesPerUrl: 1,
            prioritizeLatestRequest: true,
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
