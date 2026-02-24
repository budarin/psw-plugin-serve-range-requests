# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
