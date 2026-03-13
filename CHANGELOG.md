# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.41] - 2026-03-13

### Changed

- **Debug logging prefixes**: Introduced `logging.ts` with `PLUGIN_LOG_PREFIX` (`[cache-range]`) and `SW_DEBUG_PREFIX` / `CLIENT_DEBUG_PREFIX`. All debug logs in the Service Worker now use `[cache-range][sw] ...`, while warn/error messages keep their existing human-readable text without prefixes.
- **URL matching helper**: `matchesGlob` now uses `parseUrlSafely` for URL parsing instead of hardcoded `'https://example.com'` as a base, removing test-only URL assumptions from production code while preserving existing behavior.

## [1.0.40] - 2026-03-13

### Changed

- **PluginContext logger**: Updated for the new `PluginContext` contract where `logger` is required: removed optional chaining (`logger?.debug?.`) and made internal contexts require `logger`.

## [1.0.39] - 2026-03-11

### Changed

- **Error logging**: Plugin errors are now always logged regardless of the `enableLogging` option: unexpected errors in the fetch handler and range stream read errors in `createRangeStream` are always written via `logger.error` / `logger.warn`. The option continues to control only debug/verbose output.

## [1.0.38] - 2026-03-11

### Changed

- **Dev dependency**: Bump `@budarin/pluggable-serviceworker` to `1.17.5` (no runtime/API changes in this plugin).

## [1.0.37] - 2026-03-11

### Changed

- **getOrCreateSetForClient**: Extracted helper for per-client "served from network" tracking: get-or-create Set for clientId, FIFO eviction when size ≥ maxTrackedUrls, used on cache miss before adding pathname. Removes duplicated logic in the handler.
- **RangeHandlerContext**: JSDoc clarified — request-scoped dependencies for the range handler (cache, slots, restore, client tracking, config); explains why the context object is passed instead of many parameters.

## [1.0.36] - 2026-03-11

### Changed

- **Init normalization in factory**: `normalizeIncludeExclude(include, exclude, scopeOrigin)` now runs during plugin factory initialization (SW init), not on first fetch; the normalized result is stored in closure.
- **Factory logger default**: `RangePluginOptions.logger` now defaults to `console`, mirroring `initServiceWorker` default logger behavior. Init-only warnings use this logger at factory time.

## [1.0.35] - 2026-03-11

### Added

- **include required**: Plugin factory throws if `include` is null, not an array, or empty. After normalization (with scopeOrigin), if `include` is empty (all cross-origin filtered out), plugin logs a one-time warning and skips range handling instead of throwing.
- **parseUrlSafely** in `rangeUtils`: safe URL parsing (URL.parse when available, else try/catch); returns URL or null. Used in fetch to avoid throwing on invalid request URL; invalid URL is logged and request is skipped.
- **Module-level cachedScopeOrigin**: Origin from `self.registration.scope` is cached once per module (not per fetch), reused by all plugin instances.
- **Requests without clientId skipped**: Fetch handler returns early when `event.clientId` is missing (e.g. requests from the SW itself); only browser-originated requests are processed. Warn logged; documented in JSDoc and reference.mdc.
- **throwIfAborted(signal)**: Shared helper for abort handling; used in fetch instead of duplicating DOMException throw.
- **Restore logging**: On restore failure (!response.ok) or catch, plugin logs via logger.warn (pathname, status or error).

### Changed

- **normalizeIncludeExclude**: Optional scopeOrigin; when provided, full URLs from other origins are filtered out. Normalization runs on first fetch (origin unknown at factory); result cached.
- **shouldProcessFile**: First argument can be pathname or URL (pathname when no '://'); when called with pathname from handler, no URL parsing inside. Returns false when include is null or empty.
- **Fetch handler**: Single requestUrl = parseUrlSafely(request.url); single scopeOrigin (cached); early exits for passthrough header, no Range, non-GET, no clientId, invalid URL, same-origin and include/exclude filters.
- **urlsServedFromNetworkByClient**: Comment clarified — per-client pathnames already served from network; purpose (Chromium workaround); keys not removed when client closes.

## [1.0.34] - 2026-03-06

### Changed

- **Restore when `assets` is unset**: Restore on cache miss now runs only when `assets` is set and the request pathname is in the list. When `assets` is not set, the plugin no longer restores any URL to cache. Aligns with the agreed behavior; documented in README and README.ru.
- **Documentation**: Added a short paragraph (after the quick start example) in README and README.ru describing what the plugin handles (GET + Range + filters → 206 or network response) and what it passes through to the next plugins. Removed passthrough-header implementation detail from that paragraph.
- **Compatibility**: Relies on `context.passthroughHeader` being required in `PluginContext` from `@budarin/pluggable-serviceworker`; removed type assertion.

## [1.0.33] - 2026-03-06

### Performance

- When a request holding the slot is aborted (e.g. new range request during seek), it exits immediately via `Promise.race(matchByUrl, workSignal abort)` instead of waiting for matchByUrl to complete. Cancelled requests no longer block for hundreds of ms.

## [1.0.32] - 2026-03-05

### Added

- **getRangeRequestSource(request, cachedMetadata)** in `rangeUtils.ts`: determines from request headers (If-Range vs cache ETag/Last-Modified) whether the client is continuing a network response; used to avoid switching to cache mid-playback (Chromium #1026867).
- **Per-client tracking (urlsServedFromNetworkByClient)**: URLs served from network (passthrough) are recorded per client (tab). After restore, cache ETag equals server ETag so getRangeRequestSource cannot tell; the per-client set ensures we keep passthrough in that tab. After reload, new clientId → cache is used.

### Changed

- **Single-source workaround**: Now uses both per-client Set and getRangeRequestSource. Cache is always checked first; on hit we passthrough if URL is in the client’s “served from network” set or if getRangeRequestSource returns `'network'`. Fixes playback error when reloading with file not in cache and restore fills cache during playback.
- **Documentation**: README and README.ru updated — “one source per URL per tab”, If-Range check, and “after reload cache is used”. reference.mdc updated with urlsServedFromNetworkByClient and two-step check.
- **Range caching**: When caching a range, the plugin reads the full range into a buffer, stores it in range cache, and returns it (single read). Streaming while populating cache was reverted due to observed slowdown.

### Performance

- **precomputedMetadata**: Passed from handler to serveRangeFromCachedResponse to avoid double extraction of metadata from the cached response.
- **Metadata cache**: LRU touch on read so hot URLs keep their metadata entries.
- **serveRangeFromCachedResponse**: Redundant If-Range check removed (source decision is made in the handler via getRangeRequestSource).

## [1.0.31] - 2026-03-04

### Added

- **Single source per URL (Chromium bug workaround)**: Once the first request for a URL was served from the network (cache miss), all further requests for that URL in the same SW session are also served from the network, even after the file has been restored to cache. Background restore still runs for the next page load. Avoids `PIPELINE_ERROR_READ` when the media pipeline would ignore cache responses after the first chunk came from network. See [Chromium #1026867](https://bugs.chromium.org/p/chromium/issues/detail?id=1026867), [phoboslab test case](https://phoboslab.org/files/bugs/chrome-serviceworker-video/). Documented in README, JSDoc, and reference.mdc.

### Changed

- **Cache miss behavior**: On cache miss the plugin now returns the network response directly (`fetch(request)`) instead of returning `undefined`, so the request is handled by the plugin and the browser's Range header is preserved. Required for the single-source workaround and correct 206 responses from the network.
- **Documentation**: Option `restoreMissingToCache` description updated — on cache miss the plugin serves the request from the network and starts background restore; no longer "returns undefined". README.ru: `assets` described as pathnames only, not "URL ресурсов".

### Performance

- Early exit in fetch handler when URL was already served from network in this session (avoids slot acquisition and cache lookup).
- Shared noop release in rangeSlot when `prioritizeLatestRequest` is false (avoids allocating a new function per request).

## [1.0.30] - 2026-03-03

### Fixed

- **Restore on cache miss**: When `assets` is set, the plugin now correctly treats it as pathnames (e.g. `/assets/Meeting.mp4`) and compares the request URL via `new URL(url).pathname`. Previously it compared the full request URL, so restore never ran when assets contained pathnames. Origin is unknown at build time, so assets are pathnames only.

### Changed

- **Documentation**: JSDoc, README, and reference.mdc now state explicitly that `assets` must be pathnames only, not full URLs.
- **Internals**: Restore-on-miss check uses pathname comparison; `RangeHandlerContext.assetUrls` comment clarified.

## [1.0.29] - 2026-03-02

### Changed

- **Performance**: In the fetch handler, `cacheKey` is built and range cache is consulted only when `maxCachedRanges > 0`, avoiding unnecessary work when range caching is disabled.

### Removed

- **Dead code**: Removed unused `readRangeFromStream` from `rangeUtils.ts`; range responses use `createRangeStream` only.

## [1.0.28] - 2026-02-27

### Changed

- **Documentation**: Clarified the English and Russian README about caching large media files without Range support, potential memory issues on low-end devices, and playback/seek limitations. No changes to the public API or runtime behavior.

## [1.0.27] - 2026-02-27

### Changed

- **Compatibility**: Updated devDependency `@budarin/pluggable-serviceworker` to `^1.17.1`. No changes in the public API or runtime behavior of the plugin.

## [1.0.26] - 2026-02-27

### Added

- **Option `assets`**: When set, background restore runs only for URLs in this list (precache/assets). When unset, restore may run for any URL on cache miss.
- **Presets**: Built-in presets now include `rangeResponseCacheControl` for consistent 206 caching behavior out of the box.

### Changed

- **Cache miss behavior**: On cache miss the plugin returns `undefined` (passes the request to the next plugin / network). If `restoreMissingToCache` is enabled, it starts a background restore that fetches the **full file** into Cache API for subsequent range requests.
- **Internals**: `serveRangeRequests` handler flow was refactored (typed context, range slot manager integration, clearer cache/restore boundaries) without changing the public API (except the cache miss behavior above).
- **Tests**: Cache mock now returns a fresh `Response` per `cache.match` call (Response bodies are streams and cannot be reused).

### Removed

- **Internal network fallback**: Removed the internal passthrough Range fallback path and its helper module (`src/fallback.ts`). Upstream passthrough for Range requests is expected to handle cache misses.

## [1.0.25] - 2026-02-25

### Removed

- **Option `restoreWaitTimeout`**: Removed; only `restoreDelay` (agreed) remains.

## [1.0.24] - 2026-02-25

### Added

- **Option `restoreDelay`** (default `2500`): Delay in ms before starting restore on cache miss. Lets initial requests go to network without competing with restore, reducing ERR_FAILED and avoiding black screen on large files.

## [1.0.23] - 2026-02-25

### Added

- **Option `restoreWaitTimeout`** (later removed): Was added to wait for in-progress restore; removed per user feedback.

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
