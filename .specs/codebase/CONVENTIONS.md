# Code Conventions

## Naming Conventions

**Files:**
- PascalCase for classes: `SearchTool.ts`, `PipelineManager.ts`, `EventBusService.ts`
- camelCase for utilities/modules: `config.ts`, `logger.ts`, `mimeTypeUtils.ts`
- kebab-case for non-class files: `search-provider.ts`, `build-env.d.ts`
- Test files: `[FileName].test.ts` colocated with source
- E2E tests: `[feature]-e2e.test.ts` in `test/` directory

**Classes:**
- PascalCase: `DocumentManagementService`, `PipelineWorker`, `WebScraperStrategy`
- Suffix `Service` for stateful singletons: `ScraperService`, `EventBusService`
- Suffix `Tool` for interface-agnostic business logic: `SearchTool`, `ScrapeTool`
- Suffix `Strategy` for strategy pattern: `WebScraperStrategy`, `LocalFileStrategy`
- Suffix `Error` for error classes: `ValidationError`, `ConnectionError`

**Interfaces / Types:**
- Prefix `I` for injected interfaces: `IPipeline`, `IDocumentManagement`
- Suffix `Options` for input parameters: `SearchToolOptions`, `ScraperOptions`
- Suffix `Result` for outputs: `SearchToolResult`, `ScrapeResult`
- Suffix `Config` for configuration objects: `AppConfig`, `EmbeddingModelConfig`

**Constants:**
- UPPER_SNAKE_CASE: `DEFAULT_CONFIG`, `EventType.JOB_PROGRESS`

**Functions/Methods:**
- camelCase: `enqueueScrapeJob()`, `findBestVersion()`, `loadConfig()`
- Private methods prefixed `_` for internal async operations: `_processQueue()`, `_runJob()`

## Code Organization

**Import ordering:**
1. Node built-ins (`node:fs`, `node:path`, `node:events`)
2. External packages
3. Internal modules (relative paths)

Example from `config.ts`:
```ts
import fs from "node:fs";
import path from "node:path";
import envPaths from "env-paths";
import yaml from "yaml";
import { z } from "zod";
import { normalizeEnvValue } from "./env";
```

**File structure:**
1. Imports
2. Local interfaces/types
3. Class or exported functions
4. Private helpers at bottom

**Module barrel exports:** Each module has `index.ts` re-exporting public API.
Example: `src/store/index.ts` exports `DocumentManagementService`, `DocumentStore`, error types.

## Type Safety

**Approach:** TypeScript strict mode. Zod schemas for external/config boundaries, TypeScript interfaces for internal contracts.
- Config: `AppConfigSchema` (Zod) in `src/utils/config.ts`
- API inputs/outputs: Typed interfaces in `types.ts` per module
- tRPC procedures: Type-safe over the wire

**No `any`:** Internal code uses proper types. `unknown` used for error catches.

## Error Handling

**Pattern:** Typed error classes per module, propagated to interface layer.
Each module has `errors.ts`:
- `src/tools/errors.ts` → `ValidationError`
- `src/store/errors.ts` → `StoreError`, `ConnectionError`, `DimensionError`
- `src/pipeline/errors.ts` → `CancellationError`, `PipelineStateError`

**Pattern in tools:**
```ts
try {
  const results = await this.docService.searchStore(...);
  return { results };
} catch (error) {
  logger.error(`❌ Search failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  throw error; // propagate to interface layer
}
```

**DB operations:** Errors logged but not thrown to avoid breaking the pipeline:
```ts
} catch (error) {
  logger.error(`❌ Failed to update database progress: ${error}`);
  // Don't throw - we don't want to break the pipeline for database issues
}
```

## Comments / Documentation

**Style:** JSDoc on public classes and methods, inline comments for non-obvious logic.
```ts
/**
 * PipelineManager orchestrates a queue of scraping/indexing jobs.
 * - Controls concurrency, recovery, and job lifecycle
 * - Bridges in-memory job state with the persistent store
 */
```

**Logging:** Emoji prefixes for log levels (informational convention):
- `✅` Success
- `❌` Error
- `⚠️` Warning
- `📝` Job enqueued
- `🔍` Search operation
- `🔄` Refresh/recovery

**Direct user output:** `console.*` for user-facing CLI messages.
**Application events:** `logger.*` (from `src/utils/logger.ts`) for operational logging.

## Validation

**Zod for config boundaries:**
```ts
export const AppConfigSchema = z.object({ ... });
export type AppConfig = z.infer<typeof AppConfigSchema>;
```

**Tool-level validation:** Manual checks with `ValidationError` throws at the start of `execute()`.
**No over-validation:** Internal calls between services use TypeScript types, not runtime checks.
