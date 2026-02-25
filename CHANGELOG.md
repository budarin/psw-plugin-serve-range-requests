# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.24] - 2026-02-25

### Added

- **Option `restoreDelay`** (default `2500`): Delay in ms before starting restore on cache miss. Lets initial requests go to network without competing with restore, reducing ERR_FAILED and avoiding black screen on large files.

## [1.0.23] - 2026-02-25

### Fixed

- **ERR_FAILED on cache miss during restore**: When a range request hit cache miss while restore was already running, the request fell through to the network. Two heavy requests (restore + page) competed; the network request often failed with ERR_FAILED (headers only, no body). Now the plugin waits for the in-progress restore (up to `restoreWaitTimeout`) and serves from cache instead of letting the request go to the network.

### Added

- **Option `restoreWaitTimeout`** (default `120000`): When cache miss and restore is in progress, wait up to this many ms for restore to complete before falling through. Prevents ERR_FAILED from network contention.

## [1.0.22] - 2026-02-25

### Added

- **Option `restoreMissingToCache`** (default `true`): When a file is missing from cache, returns `undefined` (next plugin handles the request) and starts a background fetch to restore the full file into cache for future requests. Restores evicted or damaged cache, similar to `restoreAssetToCache` in pluggable-serviceworker. Use `restoreMissingToCache: false` to disable.

## [1.0.21] - 2026-02-25

### Changed

- **Compatibility**: Updated for `@budarin/pluggable-serviceworker` 1.11.0 — plugin handlers now receive `PluginContext` (with `logger?`, `base?`) instead of `Logger` directly.
- **Performance**: Removed `addCacheHeaders` — 206 responses now use `buildRangeResponseHeaders` with Cache-Control set inline, avoiding one Response clone per request.
- **Performance**: `mergeAbortSignals` now accepts multiple signals in a single call; when `prioritizeLatestRequest` is true, one merge instead of two.

### Removed

- **`addCacheHeaders` module**: Logic inlined into `buildRangeResponseHeaders`; module deleted.

## [1.0.20] - 2026-02-24

### Removed

- **Option `maxCachedMetadata`**: Metadata cache now uses the same limit as range cache (`maxCachedRanges`). One less option to configure.

## [1.0.19] - 2026-02-24

### Fixed

- **`fileMetadataCache`**: Restored read path — metadata is now read from cache when available (with Content-Length validation). Write only when writing to range cache (data cache).

### Changed

- **Queue → single `nextWaiter`**: When `prioritizeLatestRequest: true`, one waiting request instead of array; new request cancels previous via `resolve(null)`.
- **Early exits**: Reordered fetch handler — `!rangeHeader` and `method` checked before `signal.aborted` for faster skip of non-range requests.
- **Optimizations**: Removed redundant `prioritizeLatestRequest` check in `acquireRangeSlot`.

## [1.0.18] - 2026-02-24

### Changed

- **`prioritizeLatestRequest: false`**: No queues, no semaphore — all requests run in parallel. `maxConcurrentRangesPerUrl` applies only when `true`.
- **Optimizations**: Removed dead FIFO branch in release; `shouldProcessFile` parses URL once; lazy `urlSemaphore` init when `prioritizeLatestRequest` is false.

## [1.0.17] - 2026-02-24

### Added

- **Option `prioritizeLatestRequest`** (default `true`): For video/audio — LIFO queue, abort current work when a new request queues. For maps/docs — no queues, all requests run in parallel.
- **Per-request AbortController**: When the browser cancels a request, the plugin aborts the work immediately so orphaned reads do not block slots.

### Changed

- **VIDEO_PRESET, AUDIO_PRESET**: `maxCachedRanges: 0` — range cache is not used when scrubbing; each seek requests a new byte range.
- **Queue**: LIFO when `prioritizeLatestRequest: true`; no queue when `false`. Abort current work on new queue entry only when `true`.
- **Documentation**: Section "Когда что кешировать" — when to cache by scenario (video/audio vs maps vs docs).

## [1.0.16] - 2026-02-23

### Added

- **Option `maxConcurrentRangesPerUrl`** (default 4): Limits concurrent range reads per URL. Enables parallel tile loading for maps while preventing 20+ simultaneous reads during video seek from blocking the active request.

### Changed

- **Concurrency control**: Semaphore per URL instead of unbounded parallelism; aborted requests release slots quickly so the active one gets through.

## [1.0.15] - 2026-02-23

### Fixed

- **Abort handling (stream cancel)**: On request cancel, the plugin now calls `reader.cancel()` via an abort listener so the pending `read()` rejects immediately instead of waiting for the next chunk. This prevents cancelled requests from blocking the active one (e.g. video seek no longer delays the final 206 response by 10+ seconds).

## [1.0.14] - 2026-02-23

### Fixed

- **Abort handling**: When a fetch request is canceled (e.g. during video seek), the plugin now stops processing immediately instead of continuing to read and serve the range. Early `signal.aborted` checks added throughout the work pipeline; `readRangeFromStream` cancels the reader and throws when aborted; `Promise.race` with abort ensures the handler returns as soon as the client cancels.

## [1.0.13] - 2026-02-23

### Fixed

- **Caching**: `maxCachedRanges: 0` and `maxCachedMetadata: 0` now fully disable the in-memory caches instead of keeping a single entry that is constantly overwritten.

### Added

- **Tests**: New tests covering cache behavior when limits are set to zero, ensuring no entries are stored and all requests go through the underlying Cache API.

## [1.0.11] - 2026-02-19

### Changed

- **Performance**: Single Cache API lookup per request (metadata and body from one response); concurrent requests for the same URL and range are deduplicated; glob patterns for `include`/`exclude` compiled once per pattern and reused.
- **Resilience**: On cache access failure the plugin clears its cache handle and re-opens the cache on the next request.
- **Code**: Semantic type aliases (`UrlString`, `RangeHeaderValue`, `GlobPattern`, `RangeCacheKey`) used in signatures and caches.

## [1.0.10] - 2026-02-16

### Changed

- **Documentation**: Expanded README and README.ru guidance for using the plugin with large cached resources, explaining cache quota issues, recommended precache strategies, and behavior when a file is missing from the cache.

## [1.0.9] - 2026-02-16

### Added

- **Documentation**: Introductory section in README and README.ru explaining why range requests matter when caching large media—whole-file retrieval per chunk wastes memory and CPU; the plugin serves only the requested byte range for smooth playback and controlled resource usage.

## [1.0.8] - 2026-02-16

### Fixed

- **Documentation**: All examples now use the correct `@budarin/pluggable-serviceworker` API — `initServiceWorker(plugins, options)` with plugins array as first argument and options (including required `version`) as second. Previously docs incorrectly showed `initServiceWorker({ plugins: [...] })`.
- **README.ru.md**: Corrected package name from `plug-in-serviceworker` to `pluggable-serviceworker`; added link to English README; aligned preset list formatting.

### Changed

- **Documentation**: Adaptive presets section now shows all four presets (VIDEO_ADAPTIVE, AUDIO_ADAPTIVE, MAPS_ADAPTIVE, DOCS_ADAPTIVE) and describes three device tiers (very low-end / low-end / full). Preset and adaptive examples include required `initServiceWorker` and `serveRangeRequests` imports.

## [1.0.7] - (previous)

Initial or previous release.
