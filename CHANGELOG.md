# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
