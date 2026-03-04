# @budarin/psw-plugin-serve-range-requests

[Русская версия](https://github.com/budarin/psw-plugin-serve-range-requests/blob/master/README.ru.md)

Service Worker plugin for [@budarin/pluggable-serviceworker](https://www.npmjs.com/package/@budarin/pluggable-serviceworker) that serves HTTP Range requests for cached files.

If you cache media without serving Range requests, the browser has to load the whole file into memory and play it from start to finish. There is no way to seek to a different position, and for large files the memory footprint can be huge. On low-end or memory-constrained devices that often means stuttering, failed playback, or even crashes. This plugin adds proper Range support for cached content: only the requested byte ranges are read and sent, so playback can seek freely and memory use stays under control.

[![CI](https://github.com/budarin/psw-plugin-serve-range-requests/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/budarin/psw-plugin-serve-range-requests/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@budarin/psw-plugin-serve-range-requests?color=cb0000)](https://www.npmjs.com/package/@budarin/psw-plugin-serve-range-requests)
[![npm](https://img.shields.io/npm/dt/@budarin/psw-plugin-serve-range-requests)](https://www.npmjs.com/package/@budarin/psw-plugin-serve-range-requests)
[![bundle](https://img.shields.io/bundlephobia/minzip/@budarin/psw-plugin-serve-range-requests)](https://bundlephobia.com/result?p=@budarin/psw-plugin-serve-range-requests)
[![GitHub](https://img.shields.io/github/license/budarin/psw-plugin-serve-range-requests)](https://github.com/budarin/psw-plugin-serve-range-requests)

### Why this plugin

Applications that play or display large media—video, audio, PDFs—typically request data in small chunks (HTTP Range requests) rather than loading entire files. If such files are stored in a normal cache, every request for a single chunk would cause the **entire file** to be read from cache and sent to the client. That leads to unnecessary memory and CPU usage and can make the application sluggish or unresponsive. This plugin serves cached content by range: only the requested bytes are read and delivered, so playback stays smooth and resource usage stays under control.

## Quick start

In most cases you only need to pick a [built‑in preset](#built-in-presets-optional) and set the cache name. You can ignore the rest of the options.

```typescript
import { initServiceWorker } from '@budarin/pluggable-serviceworker';
import { serveRangeRequests, VIDEO_PRESET } from '@budarin/psw-plugin-serve-range-requests';

initServiceWorker(
    [serveRangeRequests({ ...VIDEO_PRESET, cacheName: 'video-cache' })],
    { version: '1.0.0' }
);
```

Minimal setup without a preset — only the required option:

```typescript
serveRangeRequests({ cacheName: 'media-cache' });
```

More on scenarios (video, maps, documents) below. [All options](#all-options) are at the end of this section.

The plugin only handles GET requests with a Range header that match the include/exclude filters (when set). For each such range request it returns a response itself: either 206 from cache (from the full file or from the range cache), or a response from the network — on cache miss, for the Chromium workaround (this URL was already served from the network in this tab), or when the client sends If-Range. All other requests — without Range, not GET, or not matching the filters — the plugin does not handle and passes to the next plugins in the chain.

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

**Range cache (`maxCachedRanges`, `maxCacheableRangeSize`)**  
The plugin caches ready range responses and file metadata (size, type) for the same URLs. **maxCachedRanges** limits how many range responses and metadata entries to keep. **maxCacheableRangeSize** is the upper cap per range; larger ranges are not cached (to avoid memory spikes). For video and audio scrubbing, set **maxCachedRanges** to 0 — the cache is not used.

**Concurrency (`maxConcurrentRangesPerUrl`)**  
Only applies when `prioritizeLatestRequest: true`. For video and audio, 1 is optimal — queues slow things down. When `false`, no limit — all requests run in parallel.

**Prioritize latest request (`prioritizeLatestRequest`)**  
`true` (default) — for video and audio: prioritize the latest request, abort others on new request. `false` — for maps and docs: no queues, all requests run in parallel.

**206 responses and browser cache**  
The plugin does not set `Cache-Control` on 206 responses by default. To allow the browser to cache them, set **rangeResponseCacheControl** (e.g. `'max-age=31536000, immutable'`). Use `'no-store'` to forbid caching, or omit the option to leave the header unset.

When tuning options, look at real traffic — use the Network tab in DevTools.

## All options

Options are grouped by purpose. Defaults work for most scenarios.

### Core

| Option        | Type     | Default | Description                    |
| ------------- | -------- | ------- | ------------------------------ |
| `cacheName`   | `string` | —       | **Required.** Cache name.      |
| `order`       | `number` | `-10`   | Plugin execution order.        |

### Range cache and memory

| Option                  | Type     | Default | Description                                                                                                                                 |
| ----------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxCachedRanges`       | `number` | `100`   | Max number of cached range responses (and metadata entries). For video scrubbing use 0. For maps/docs use 500–1000.                           |
| `maxCacheableRangeSize` | `number` | `10MB`  | Max size of a single cached range; larger ranges are not cached.                                                                            |
| `maxTrackedUrls`        | `number` | `512`   | Max number of different files (URLs) the plugin tracks for limiting concurrent requests per file. Caps memory when many different files are requested. |

### Concurrency and priority

| Option                      | Type      | Default | Description                                                                 |
| --------------------------- | --------- | ------- | --------------------------------------------------------------------------- |
| `maxConcurrentRangesPerUrl` | `number`  | `4`     | How many ranges of one file to read in parallel. For video often 1.        |
| `prioritizeLatestRequest`  | `boolean` | `true`  | Prioritize latest request (video/audio). `false` for maps/docs.              |

### Filters

| Option    | Type       | Default | Description                          |
| --------- | ---------- | ------- | ------------------------------------ |
| `include` | `string[]` | —       | File glob patterns to process only.  |
| `exclude` | `string[]` | —       | File glob patterns to exclude.       |

### Restore and delivery

| Option                    | Type       | Default                       | Description                                                                                                                                 |
| ------------------------- | ---------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `restoreMissingToCache`   | `boolean`  | `true`                        | On cache miss: serve the request from the network and start a background restore that fetches the full file into cache for subsequent requests. |
| `assets`                  | `string[]` | —                             | **Pathnames only** (e.g. `/assets/Meeting.mp4`), not full URLs — origin is unknown at build time. When set, restore on cache miss runs only for requests whose pathname is in this list. |
| `rangeResponseCacheControl` | `string` | — | Optional Cache-Control for 206 responses (e.g. `'max-age=31536000, immutable'` for browser caching). If not set, the header is not sent. |

### Debug

| Option         | Type      | Default | Description    |
| -------------- | --------- | ------- | -------------- |
| `enableLogging` | `boolean` | `false` | Verbose logs.  |

## Important notes

⚠️ **Do not cache huge files and ranges** – mobile devices may not handle them well. Range data is read sequentially from the cached file stream (Cache API does not support random access), so requesting a range near the end of a very large file can be slow; prefer smaller assets.

**Single source per URL, per tab (Chromium bug workaround)** – In Chromium, if a video starts loading from the network and later range requests are served from the service worker cache, the media pipeline ignores the cached response and playback fails with `PIPELINE_ERROR_READ`. To avoid this, the plugin keeps **one source per URL per tab**: once a URL was served from the network in that tab (e.g. because the file was not in cache), further requests for that URL in the same tab stay on the network until the page is reloaded, even if the file has since been restored to cache. After a reload, the cache is used when the file is present. See [Chromium bug #1026867](https://bugs.chromium.org/p/chromium/issues/detail?id=1026867) and [phoboslab test case](https://phoboslab.org/files/bugs/chrome-serviceworker-video/).

## Usage example

With presets (recommended):

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

Manual config (when you need to tune):

```typescript
serveRangeRequests({
    cacheName: 'media-cache',
    include: ['*.mp4', '*.webm', '*.mkv'],
    maxCachedRanges: 0,
    maxConcurrentRangesPerUrl: 1,
    prioritizeLatestRequest: true,
});
```

## Built‑in presets (optional)

If you don’t want to tune options manually, use ready‑made presets:

### Available presets

- **VIDEO_PRESET** – for media players: `*.mp4`, `*.webm`, `*.mkv`, `*.avi`, `*.mov`, `*.m4v`
- **AUDIO_PRESET** – for audio players: `*.mp3`, `*.flac`, `*.wav`, `*.m4a`, `*.ogg`, `*.aac`
- **MAPS_PRESET** – for maps and tiles: `*.mbtiles`, `*.pmtiles`, `/tiles/*`, `/maps/*`, `*.mvt`
- **DOCS_PRESET** – for documents: `*.pdf`, `*.epub`, `*.djvu`, `*.mobi`, `*.azw3`

### Adaptive presets

All presets can be adapted to device capabilities. On devices with low RAM and weak CPUs, limits are automatically reduced.

```typescript
import { getAdaptivePresets } from '@budarin/psw-plugin-serve-range-requests';

const { VIDEO_ADAPTIVE, AUDIO_ADAPTIVE, MAPS_ADAPTIVE, DOCS_ADAPTIVE } =
    getAdaptivePresets();
// Use the same way: { ...VIDEO_ADAPTIVE, cacheName: 'video-cache' }
```

## Supported Range formats

- `bytes=0-499` – first 500 bytes
- `bytes=500-999` – bytes 500 through 999
- `bytes=500-` – from byte 500 to the end
- `bytes=-500` – last 500 bytes

## How it works

1. Checks the `Range` header in the request.
2. Looks up the file in the specified cache.
3. If the file is in cache: the plugin only serves from cache when it can keep the same source for that tab and URL; otherwise it passes the request through to the network ([Chromium bug #1026867](https://bugs.chromium.org/p/chromium/issues/detail?id=1026867) workaround).
4. If the file is missing, the plugin serves the request from the network and, if `restoreMissingToCache` is true and the request pathname is in the `assets` list, starts a background restore that fetches the full file into cache for subsequent requests. `assets` must be pathnames only (e.g. `/assets/Meeting.mp4`), not full URLs. In that tab, later requests for that URL keep using the network until the page is reloaded.
5. Reads the requested byte range from the file and returns HTTP `206 Partial Content`. When range caching is enabled, the response is cached for reuse.

## 🤝 License

MIT © budarin
