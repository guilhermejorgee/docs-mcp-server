# Project Structure

**Root:** `/home/guilherme/Área de trabalho/Repos/docs-mcp-server`

## Directory Tree

```
docs-mcp-server/
├── src/                        # Application source code
│   ├── index.ts                # Entry point: env setup, Playwright install, CLI launch
│   ├── app/                    # Unified server composition (AppServer)
│   ├── auth/                   # OAuth2/OIDC middleware + ProxyAuthManager
│   ├── cli/                    # yargs CLI commands, output formatting
│   │   └── commands/           # Individual CLI command handlers
│   ├── events/                 # EventBusService + RemoteEventProxy + tRPC subscriptions
│   ├── mcp/                    # MCP protocol server, tool registration, stdio transport
│   ├── pipeline/               # Job queue (Manager), execution (Worker), RPC client
│   │   └── trpc/               # tRPC router + interfaces for pipeline procedures
│   ├── scraper/                # Content acquisition
│   │   ├── fetcher/            # HTTP / filesystem / auto-detect fetchers
│   │   ├── middleware/         # Content transformation middleware chain
│   │   ├── pipelines/          # Content-type-specific processing pipelines
│   │   ├── strategies/         # Source strategies (Web, GitHub, LocalFile, npm, PyPI)
│   │   └── utils/              # Scraping utilities (URL, robots.txt, etc.)
│   ├── services/               # Service factory functions (mcp, trpc, web, worker)
│   ├── splitter/               # Document chunking
│   │   ├── GreedySplitter.ts   # Universal size optimizer
│   │   ├── SemanticMarkdownSplitter.ts  # Structure-aware markdown
│   │   ├── JsonDocumentSplitter.ts      # Hierarchical JSON
│   │   ├── TextDocumentSplitter.ts      # Line-based text/code
│   │   ├── splitters/          # ContentSplitter implementations (legacy)
│   │   └── treesitter/         # Tree-sitter AST-based code splitting
    ├── store/                  # PostgreSQL persistence + FTS search
│   │   ├── assembly/           # Search result reassembly (parent/sibling chunks)
│   │   ├── embeddings/         # EmbeddingConfig, EmbeddingFactory, providers
│   │   └── trpc/               # tRPC interfaces for store procedures
│   ├── telemetry/              # PostHog client, event types, sanitizer
│   ├── tools/                  # Interface-agnostic business logic (one class per tool)
│   ├── types/                  # Shared TypeScript types + build-env declarations
│   ├── utils/                  # Cross-cutting utilities (config, logger, url, version...)
│   └── web/                    # Fastify web UI
│       ├── components/         # SSR JSX components
│       ├── routes/             # Route handlers (index, jobs, libraries, stats)
│       ├── styles/             # Tailwind CSS entry
│       └── utils/              # Web-specific utilities
├── db/
│   └── migrations-pg/      # 15 SQL migration files (000–014)
├── test/                       # E2E tests + fixtures + helpers
│   └── fixtures/               # Sample files (PDF, DOCX, PPTX, XLSX, ZIP, etc.)
├── tests/
│   └── search-eval/            # promptfoo search quality evaluation suite
├── docs/                       # Concept & infrastructure documentation
│   ├── concepts/               # Architecture deep-dives (pipeline, search, storage, etc.)
│   ├── guides/                 # User guides (usage, embeddings, MCP clients)
│   ├── infrastructure/         # Deployment, auth, telemetry docs
│   └── setup/                  # Installation + configuration docs
├── openspec/                   # OpenSpec change management (product specs)
│   ├── changes/                # Active + archived proposed changes
│   └── specs/                  # Consolidated feature specifications
├── scripts/                    # Build/validation scripts (validate-schema.ts)
├── public/                     # Static assets (favicons, manifest)
├── skills/                     # Agent skill definitions for MCP tools
├── .specs/                     # TLC spec-driven planning docs
└── .notebook/                  # codenavi knowledge base
```

## Module Organization

### src/tools/ — Business Logic Layer

**Purpose:** Interface-agnostic tool implementations. CLI, MCP, and web routes all call these.
**Key files:** `SearchTool.ts`, `ScrapeTool.ts`, `FetchUrlTool.ts`, `ListLibrariesTool.ts`, `RemoveTool.ts`, `GetJobInfoTool.ts`, etc.

### src/pipeline/ — Job Orchestration

**Purpose:** Async job queue with concurrency limits, recovery, and event emission.
**Key files:** `PipelineManager.ts` (in-process), `PipelineClient.ts` (remote tRPC), `PipelineWorker.ts` (execution), `PipelineFactory.ts` (selector)

### src/store/ — Data Layer

**Purpose:** PostgreSQL CRUD, FTS search, embedding management, migration runner.
**Key files:** `DocumentStore.ts` (primary), `DocumentManagementService.ts`, `DocumentRetrieverService.ts`, `applyMigrations.ts`

### src/scraper/ — Content Acquisition

**Purpose:** Fetch and transform content from web, local files, GitHub, npm, PyPI.
**Key files:** `ScraperService.ts` (orchestrator), `ScraperRegistry.ts` (strategy selector), strategy files in `strategies/`

### src/splitter/ — Document Chunking

**Purpose:** Segment documents into semantic chunks for embedding.
**Key files:** `SemanticMarkdownSplitter.ts`, `GreedySplitter.ts`, `TextDocumentSplitter.ts`, `JsonDocumentSplitter.ts`

## Where Things Live

**Search functionality:**
- Business logic: `src/tools/SearchTool.ts`
- Store query: `src/store/DocumentRetrieverService.ts` (FTS search + context assembly)
- Result assembly: `src/store/assembly/`
- MCP exposure: `src/mcp/mcpServer.ts`

**Scraping / indexing:**
- Entry: `src/tools/ScrapeTool.ts`
- Job queue: `src/pipeline/PipelineManager.ts`
- Execution: `src/pipeline/PipelineWorker.ts`
- Strategies: `src/scraper/strategies/`

**Configuration:**
- Schema + loader: `src/utils/config.ts`
- Default file: `~/.config/docs-mcp-server/config.yaml`
- Env var pattern: `DOCS_MCP_<SECTION>_<KEY>` (auto-generated from paths)

**Database schema:**
- Migrations: `db/migrations-pg/000-initial-schema.sql` → `014-add-fts-stemming-configs.sql`
- Migration runner: `src/store/applyMigrations.ts`

**Secrets / sensitive config:**
- Interface + implementations: `src/secrets/` — `ISecretProvider` + `EnvSecretProvider`, `VaultSecretProvider`, `AwsSecretProvider` + `SecretProviderFactory` for boot-time backend selection
