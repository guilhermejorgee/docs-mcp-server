# Architecture

**Pattern:** Modular monolith with optional distributed mode (Hub & Spoke)

## High-Level Structure

```
┌──────────────────────────────────────────────────────┐
│                   Interfaces                         │
│  CLI (yargs)  │  MCP Protocol  │  Web UI (Fastify)  │
└───────────────┬────────────────┬────────────────────┘
                │                │
                ▼                ▼
┌──────────────────────────────────────────────────────┐
│                  Tools Layer (src/tools/)             │
│  SearchTool │ ScrapeTool │ FetchUrlTool │ RemoveTool  │
│  ListLibrariesTool │ GetJobInfoTool │ CancelJobTool  │
└───────────┬─────────────────────────────────────────┘
            │
    ┌───────┴───────┐
    ▼               ▼
┌──────────┐  ┌──────────────────────────────────────┐
│ Pipeline │  │  Store (DocumentManagementService)    │
│ Manager  │  │  PostgreSQL + pgvector + tsvector FTS   │
│ Worker   │  │  FTS search (tsvector + unaccent)       │
└────┬─────┘  └──────────────────────────────────────┘
     │
     ▼
┌──────────────────────────────────────────────┐
│  Content Processing                          │
│  Scraper → Splitter → Embedder → Store       │
│  (strategy-based, middleware-chained)        │
└──────────────────────────────────────────────┘
```

## Identified Patterns

### Tools Layer Pattern

**Location:** `src/tools/`
**Purpose:** Business logic lives here, not in interface adapters. All three interfaces (CLI, MCP, Web) call the same tool classes.
**Implementation:** Each tool is a class with a single `execute(options)` method. Injected with `IDocumentManagement` and `IPipeline` interfaces.
**Example:** `src/tools/SearchTool.ts` — accepts `{library, version, query, limit}`, calls `docService.searchStore()`, returns typed results.

### Write-Through Architecture

**Location:** `src/pipeline/PipelineManager.ts`
**Purpose:** In-memory job state and PostgreSQL version status stay in sync at all times.
**Implementation:** Every `updateJobStatus()` call writes to both `jobMap` (in-memory) and PostgreSQL via `store.updateVersionStatus()`.
**Example:** PipelineManager lines 696–751 — `updateJobStatus()` updates in-memory, writes DB, emits event.

### Strategy Pattern (Scraper)

**Location:** `src/scraper/strategies/`
**Purpose:** Different source types (web, GitHub, local, npm, PyPI) share a common interface.
**Implementation:** `BaseScraperStrategy` extended by `WebScraperStrategy`, `GitHubScraperStrategy`, `LocalFileStrategy`, `NpmScraperStrategy`, `PyPiScraperStrategy`. `ScraperRegistry` selects strategy by URL pattern.
**Example:** `src/scraper/strategies/WebScraperStrategy.ts`

### Middleware Chain (Content Processing)

**Location:** `src/scraper/middleware/`
**Purpose:** Content transformations (HTML cleaning, markdown conversion, etc.) applied as composable pipeline stages.
**Implementation:** Each middleware receives content and passes transformed result to next. Chained in `src/scraper/pipelines/`.

### Two-Phase Splitting

**Location:** `src/splitter/`
**Purpose:** Preserve semantic document structure while optimizing chunk sizes for embeddings.
**Implementation:**
  1. Semantic splitters (`SemanticMarkdownSplitter`, `JsonDocumentSplitter`, `TextDocumentSplitter`) preserve structure.
  2. `GreedySplitter` post-processes to enforce size constraints (500–5000 chars).
**Example:** See `docs/concepts/splitter-hierarchy.md`

### EventBus (Pub/Sub)

**Location:** `src/events/EventBusService.ts`
**Purpose:** Decouples producers (PipelineManager) from consumers (CLI, Web, MCP).
**Implementation:** Thin wrapper over Node.js `EventEmitter` with typed event payloads. Returns unsubscribe function.
**Example:** `EventBusService.on(EventType.JOB_PROGRESS, listener)` → returns `() => void`

### tRPC Interface Compatibility

**Location:** `src/pipeline/trpc/interfaces.ts`, `src/store/trpc/interfaces.ts`
**Purpose:** `PipelineManager` (local) and `PipelineClient` (remote) implement the same `IPipeline` interface. Web/MCP are unaware of which is used.
**Implementation:** `PipelineFactory.ts` chooses implementation based on `serverUrl` presence in config.

## Data Flow

### Scrape / Index Flow

```
ScrapeTool.execute()
  → PipelineManager.enqueueScrapeJob()
    → [job persisted to PostgreSQL as QUEUED]
    → PipelineWorker.executeJob()
      → ScraperService.scrape()
        → Strategy selects fetcher (HTTP/Playwright/file)
        → Middleware chain transforms content
        → Content-type pipeline extracts text
      → Splitter segments into chunks
      → EmbeddingFactory generates vectors
      → DocumentStore stores chunks + vectors
    → [status → COMPLETED, events emitted]

Boot sequence:
  loadConfig()
    → createSecretProvider(config.secrets)
      → PostgresDocumentStore(conn, config, secretProvider)
        → EmbeddingFactory(config, secretProvider)
```

### Search Flow

```
SearchTool.execute()
  → docService.validateLibraryExists()
  → docService.findBestVersion()  (semver resolution)
  → docService.searchStore()
    → DocumentRetrieverService
      → Full-text search (PostgreSQL tsvector FTS)
        → tsquery built dynamically by buildFtsTsquerySql(config.search.ftsLanguages):
           always includes plainto_tsquery('multilingual', $1); non-simple languages
           add OR-combined plainto_tsquery(lang, $1) terms
        → Default ftsLanguages=["simple"] produces identical SQL to previous behaviour
      → Assembly: enrich with parent/sibling chunks
  → returns StoreSearchResult[]
```

### Refresh Flow

```
RefreshVersionTool → PipelineManager.enqueueRefreshJob()
  → load stored scraper options from DB
  → build initialQueue from existing pages + ETags
  → enqueueScrapeJob() with isRefresh=true
    → scraper checks ETags, skips unchanged pages
```

## Code Organization

**Approach:** Feature-based modules + shared tools layer
**Module boundaries:** Each `src/` subdirectory is a module with `index.ts` barrel exports and `errors.ts` for module-specific error classes. tRPC interfaces isolated in `trpc/` subdirectories.

## Deployment Modes

### Unified Mode (default)

Single process. PipelineManager runs in-process. EventBus propagates locally.
Entry: `src/app/AppServer.ts` wires all services together.

### Distributed Mode

Worker process exposes tRPC over HTTP + WebSocket.
Coordinator processes use `PipelineClient` to issue commands and receive events via `RemoteEventProxy` → local EventBus.
Activated by setting `serverUrl` in config.

### Protocol Auto-Detection

`src/index.ts` checks `process.stdin.isTTY`:
- No TTY → stdio MCP transport (AI tool integration)
- TTY → HTTP transport with web UI

Override: `--protocol stdio|http` or `DOCS_MCP_PROTOCOL` env var.
