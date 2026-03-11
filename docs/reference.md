# Project reference

## Flow and roles

**Entry point:** `serveRangeRequests(options)` in `src/index.ts`. Returns a `ServiceWorkerPlugin` with a `fetch` handler. The host is `@budarin/pluggable-serviceworker`; it calls the plugin's `fetch` on each request (order controlled by `options.order`, default `-10`).

**Request handling (high level). Вся работа по pathname; Cache API — matchByUrl + normalizeUrl из pluggable-serviceworker/utils.**

1. `context.passthroughHeader` → return undefined.
2. No Range or not GET → undefined. No `event.clientId` (e.g. request from SW) → return undefined; only browser-originated requests are processed. signal.aborted → throw AbortError.
3. sameOriginOnly (если есть include/exclude): origin ≠ scope → logger.warn(pathname), return.
4. shouldProcessFile(request.url, include, exclude) → при несовпадении logger.warn(pathname), return.
5. requestUrl = parseUrlSafely(request.url); pathname = requestUrl.pathname (invalid URL → skip). cacheKey = pathname|rangeHeader. rangeCache hit → 206 from data/headers.
6. tryServeRangeFromCachedFile(request, pathname, rangeHeader, …): Slot(pathname), workSignal; getCache(), matchByPathname(cache, pathname). Промах: getOrCreateSetForClient(…), setForClient.add(pathname); restoreMissingToCache && pathname in assetUrls → startRestore(request.url, …); return fetch(request). Попадание: pathname в urlsServedFromNetworkByClient → fetch(request); иначе getRangeRequestSource → serveRangeFromCachedResponse или fetch(request).
7. result undefined → signal.aborted ? throw : return undefined.
8. result: manageMetadataCacheSize(), fileMetadataCache.set(pathname, metadata); при необходимости evictOneRangeCacheEntry(), rangeCache.set(cacheKey, …), 206.

**Modules:**

| Module | Role |
|--------|------|
| `src/index.ts` | Plugin factory, caches by pathname (rangeCache, fileMetadataCache), restoreInProgress Set<Pathname>, urlsServedFromNetworkByClient Map<clientId, Set<Pathname>>, getOrCreateSetForClient (per-client Set + FIFO eviction), RangeHandlerContext (request-scoped deps for handler), matchByPathname, tryServeRangeFromCachedFile(request, pathname, …), fetch handler. Re-exports presets. |
| `src/rangeSlot.ts` | mergeAbortSignals, createRangeSlotManager → { acquireRangeSlot, getOrCreateUrlState }. Per-pathname semaphore, LIFO when prioritizeLatestRequest. |
| `src/serveFromCache.ts` | serveRangeFromCachedResponse(…, options with pathname, fileMetadataCache Map<Pathname, …>); parseRangeHeader, createRangeStream, buildRangeResponseHeaders. |
| `src/restore.ts` | startRestore(url, RestoreOptions): pathname from url; restoreInProgress by pathname; getCache, matchByUrl(cache, new Request(normalizeUrl(pathname))); fetch(url); cache.put(new Request(normalizeUrl(pathname)), response). |
| `src/rangeResponse.ts` | buildRangeResponseHeaders(range, metadata, dataByteLength, cacheControl), extractMetadataFromResponse(response). |
| `src/rangeUtils.ts` | parseRangeHeader, **getRangeRequestSource** (request vs cache metadata → 'cache'\|'network'; Chromium bug workaround), ifRangeMatches, shouldCacheRange, createRangeStream, matchesGlob, shouldProcessFile. Glob regex cache. |
| `src/presets.ts` | VIDEO_PRESET, AUDIO_PRESET, MAPS_PRESET, DOCS_PRESET, getAdaptivePresets(). |
| `src/types.ts` | UrlString, RangeHeaderValue, GlobPattern, RangeCacheKey, CachedRange, FileMetadata. |

**Data shapes:**

- **CachedRange:** `{ data: ArrayBuffer, headers: Headers }`. Key in rangeCache: pathname|rangeHeader.
- **FileMetadata:** Key in fileMetadataCache: pathname.
- **Range:** `{ start: number, end: number }` (inclusive bytes).

## Where things are

- **Public API:** `serveRangeRequests`, `RangePluginOptions`, presets and `getAdaptivePresets` — all from `src/index.ts` (presets re-exported from `presets.js`).
- **Types:** Semantic aliases in `src/types.ts`; not re-exported from index (internal use).
- **Tests:** `tests/rangeUtils.test.ts` — parseRangeHeader, ifRangeMatches, getRangeRequestSource, shouldCacheRange, matchesGlob, shouldProcessFile. `tests/serveRangeRequests.cache.test.ts` — cache/serve flow.
- **Build:** `tsconfig.json` — `rootDir: "./src"`, `outDir: "./dist"`. `package.json` — `main: "./dist/index.js"`, `types: "./dist/index.d.ts"`. No bundler in build; `module: "preserve"`.

## Key decisions

1. **Cache API по pathname** — matchByUrl(cache, new Request(normalizeUrl(pathname))) из pluggable-serviceworker/utils. Один lookup на запрос; метаданные по pathname.
2. **prioritizeLatestRequest** — true (video): per-URL semaphore, LIFO, abort previous waiter when new request arrives. false (maps): no semaphore, all parallel.
3. **rangeCache** — LRU Map (delete+set on read). Write: only when maxCachedRanges > 0 and shouldCacheRange; evict FIFO (first key) when at limit. **fileMetadataCache** — eviction by first key when at maxCachedRanges; on read in serveFromCache we touch (delete+set) so hot entries move to end (LRU-like).
4. **Restore only when assets set** — Option `assets` is pathnames only (e.g. `/assets/Meeting.mp4`); at build time origin is unknown. When set, startRestore runs only if the request pathname is in that list. When unset, restore does not run (no URL is restored on cache miss).
5. **Glob regex cache** — In `rangeUtils`, module-level `Map<GlobPattern, RegExp>` so each include/exclude pattern is compiled once.
6. **Cache handle reset on failure** — On getCache() or matchByPathname throw, ctx.invalidateCache().
7. **Pure logic in rangeUtils** — parseRangeHeader, ifRangeMatches, shouldCacheRange, createRangeStream, etc. unit-testable in Node.
8. **Named exports only** — No default exports; public API is named (serveRangeRequests, RangePluginOptions, presets, getAdaptivePresets).
9. **Single source (Chromium bug workaround)** — urlsServedFromNetworkByClient Map<clientId, Set<pathname>>; getOrCreateSetForClient for get/create Set + FIFO eviction per client; getRangeRequestSource(request, cachedMetadata). Chromium #1026867.
