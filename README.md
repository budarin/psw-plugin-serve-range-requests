# @budarin/psw-plugin-serve-range-requests

[Русская версия](https://github.com/budarin/psw-plugin-serve-root-from-asset/blob/master/README.ru.md)

Service Worker plugin for `@budarin/pluggable-serviceworker` that serves HTTP Range requests for cached files.

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

| Option                  | Type       | Default | Description                           |
| ----------------------- | ---------- | ------- | ------------------------------------- |
| `cacheName`             | `string`   | -       | **Required.** Cache name              |
| `order`                 | `number`   | `-10`   | Plugin execution order (optional)     |
| `maxCachedRanges`       | `number`   | `100`   | Max number of cached ranges           |
| `maxCachedMetadata`     | `number`   | `200`   | Max number of cached metadata entries |
| `maxCacheableRangeSize` | `number`   | `10MB`  | Maximum size of a single cached range |
| `minCacheableRangeSize` | `number`   | `1KB`   | Minimum size of a range to be cached  |
| `include`               | `string[]` | -       | File glob patterns to include         |
| `exclude`               | `string[]` | -       | File glob patterns to exclude         |
| `enableLogging`         | `boolean`  | `false` | Verbose logging                       |

When choosing option values, focus on the real traffic profile of your resources. You can inspect and analyze all requests to your assets in the browser DevTools `Network` panel.

## Important notes

⚠️ **Do not cache huge files and ranges** – mobile devices may not handle them well.

## Usage example

```typescript
import { initServiceWorker } from '@budarin/pluggable-serviceworker';
import { serveRangeRequests } from '@budarin/psw-plugin-serve-range-requests';

initServiceWorker({
    plugins: [
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
});
```

## Built‑in presets (optional)

If you don’t want to tune all the options manually, you can use ready‑made presets:

### Available presets

- **VIDEO_PRESET** – for media players: `*.mp4`, `*.webm`, `*.mkv`, `*.avi`, `*.mov`, `*.m4v`
- **AUDIO_PRESET** – for audio players: `*.mp3`, `*.flac`, `*.wav`, `*.m4a`, `*.ogg`, `*.aac`
- **MAPS_PRESET** – for maps and tiles: `*.mbtiles`, `*.pmtiles`, `/tiles/*`, `/maps/*`, `*.mvt`
- **DOCS_PRESET** – for documents: `*.pdf`, `*.epub`, `*.djvu`, `*.mobi`, `*.azw3`

```typescript
import {
    VIDEO_PRESET,
    AUDIO_PRESET,
} from '@budarin/psw-plugin-serve-range-requests';

initServiceWorker({
    plugins: [
        serveRangeRequests({ ...VIDEO_PRESET, cacheName: 'video-cache' }),
        serveRangeRequests({ ...AUDIO_PRESET, cacheName: 'audio-cache' }),
    ],
});
```

### Adaptive presets

All the presets above can be adapted to the device capabilities. On devices with low RAM and weak CPUs, the limits are automatically decreased to keep the app responsive.

```typescript
import { getAdaptivePresets } from '@budarin/psw-plugin-serve-range-requests';

// Automatically adapts to device performance:
// - Low-end devices (<4GB RAM or <4 CPU cores): reduced limits
// - More powerful devices (>=4GB RAM and >=4 CPU cores): full limits
const { VIDEO_ADAPTIVE, AUDIO_ADAPTIVE } = getAdaptivePresets();

initServiceWorker({
    plugins: [
        serveRangeRequests({ ...VIDEO_ADAPTIVE, cacheName: 'video-cache' }),
        serveRangeRequests({ ...AUDIO_ADAPTIVE, cacheName: 'audio-cache' }),
    ],
});
```

## Supported Range formats

- `bytes=0-499` – first 500 bytes
- `bytes=500-999` – bytes 500 through 999
- `bytes=500-` – from byte 500 to the end
- `bytes=-500` – last 500 bytes

## How it works

1. Checks the `Range` header in the request.
2. Looks up the file in the specified cache.
3. Reads the requested byte range from the file.
4. Caches the ready‑to‑use partial response.
5. Returns HTTP `206 Partial Content`.

---

**Tip**: In most cases it is enough to configure `cacheName` and a few `include` patterns.
