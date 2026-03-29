# Codebase Concerns

## High Priority

### sqlite-vec Alpha Dependency

**Evidence:** `"sqlite-vec": "^0.1.7-alpha.2"` in `package.json`
**Risk:** The vector search extension is still in alpha. API may break on minor updates; performance and stability guarantees are limited.
**Impact:** Core feature — all semantic search depends on this extension.
**Fix approach:** Monitor sqlite-vec releases; pin to a specific version; test vector operations thoroughly before upgrading. Consider abstracting the vector interface to allow swapping implementations.

### Playwright Browser Auto-Install at Startup

**Evidence:** `ensurePlaywrightBrowsersInstalled()` called unconditionally in `src/index.ts:16`
**Risk:** On cold starts in restricted environments (CI, Docker without browser deps), this adds significant startup latency and may fail silently.
**Impact:** Scraping of JS-heavy sites breaks; startup time is unpredictable.
**Fix approach:** Make browser install lazy (only when a scrape job requiring Playwright is queued), or add explicit health check. Document Docker setup requirements more clearly.

### In-Memory Job State Not Shared in Multi-Process Deployments

**Evidence:** `PipelineManager.jobMap` is an in-memory `Map` (`src/pipeline/PipelineManager.ts:29`). In unified mode, job state is in-process only.
**Risk:** If the server restarts mid-job or multiple instances run (e.g., behind a load balancer without sticky sessions), the in-memory state is lost. Recovery exists for the DB-persisted `VersionStatus`, but the in-memory `PipelineJob` objects (including `completionPromise`) are gone.
**Impact:** Clients waiting for job completion via `waitForJobCompletion` lose their handle after restart.
**Fix approach:** The write-through architecture means DB is the source of truth — `recoverPendingJobs` handles this. Ensure `recoverJobs: true` is the default in production deployments.

## Medium Priority

### No Embedding Dimension Migration Guard

**Evidence:** `db/migrations/003-normalize-vector-table.sql` creates vector columns; `src/store/DocumentStore.ts` uses `FixedDimensionEmbeddings` wrapper to handle dimension mismatches.
**Risk:** If the embedding model is changed after indexing, the stored vector dimension (e.g., 1536 for OpenAI `text-embedding-3-small`) won't match the new model's dimension. The `FixedDimensionEmbeddings` wrapper pads/truncates, which silently degrades search quality.
**Impact:** Silent search quality regression when embedding model is changed.
**Fix approach:** Add a startup check that validates the configured model's dimension matches the DB's vector column dimension. Warn or refuse to start if mismatched without explicit migration.

### postinstall Script Suppresses Playwright Install

**Evidence:** `"postinstall": "echo 'Skipping Playwright browser install...'"` in `package.json`
**Risk:** Developers who run `npm install` won't have Playwright browsers installed, leading to confusing failures the first time scraping is attempted.
**Impact:** New contributor onboarding friction.
**Fix approach:** Document the manual step (`npx playwright install`) clearly in README/CONTRIBUTING; or provide a setup script.

### No Test Coverage Enforcement

**Evidence:** No coverage thresholds in `vite.config.ts` or CI configuration.
**Risk:** Coverage can silently regress as the codebase grows.
**Impact:** Low confidence in test safety net for new contributors.
**Fix approach:** Add `coverage.thresholds` to Vitest config (e.g., 70% minimum); enforce in CI.

### ClearCompletedJobsTool Commented Out

**Evidence:** `// clearCompletedJobs: new ClearCompletedJobsTool(pipeline),` in `src/mcp/tools.ts:61`
**Risk:** The tool exists (`ClearCompletedJobsTool.ts`) but is not exposed via MCP. The functionality is available in the class but unreachable by MCP clients.
**Impact:** MCP users can't clean up completed jobs from their client.
**Fix approach:** Uncomment the registration — or document the intentional omission with reasoning.

## Low Priority

### `splitters/` Subdirectory Marked as Deprecated

**Evidence:** ARCHITECTURE.md notes `src/splitter/splitters/` is deprecated. The directory still exists in the codebase.
**Risk:** Maintainers may continue adding to the deprecated path by mistake.
**Impact:** Maintenance confusion.
**Fix approach:** Remove deprecated code or add `// @deprecated` comments with migration notes pointing to the new splitter classes.

### `setCallbacks` No-Op Method for Backward Compatibility

**Evidence:** `PipelineManager.setCallbacks(_callbacks: unknown): void { // No-op: callbacks are no longer used }` (`src/pipeline/PipelineManager.ts:59`)
**Risk:** Dead code; can confuse new contributors about the callback mechanism.
**Impact:** Code noise.
**Fix approach:** Remove `setCallbacks` from the `IPipeline` interface and all implementations if no consumers use it.

### Search Evaluation Not Part of CI

**Evidence:** `npm run evaluate:search` requires a running server and OpenAI credentials — not wired into `.github/workflows/ci.yml`.
**Risk:** Search quality regressions go undetected until noticed manually.
**Impact:** Potential silent degradation of core search feature.
**Fix approach:** Run search eval in a separate scheduled workflow (nightly/weekly) with appropriate secrets configured.
