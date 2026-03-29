# External Integrations

## Embedding Providers

### OpenAI

**Purpose:** Generate vector embeddings for document chunks.
**Implementation:** `src/store/embeddings/EmbeddingFactory.ts` via `@langchain/openai`
**Configuration:** `OPENAI_API_KEY` env var; model via `DOCS_MCP_EMBEDDING_MODEL` (default: `text-embedding-3-small`)
**Authentication:** API key via env var

### Google GenAI (Gemini)

**Purpose:** Alternative embedding provider.
**Implementation:** `@langchain/google-genai`
**Configuration:** `GOOGLE_API_KEY` env var; set `DOCS_MCP_EMBEDDING_MODEL` to a Gemini embedding model
**Authentication:** API key via env var

### Google Vertex AI

**Purpose:** Enterprise-grade embedding provider (GCP).
**Implementation:** `@langchain/google-vertexai`
**Authentication:** GCP service account credentials

### AWS Bedrock

**Purpose:** AWS-hosted embedding models.
**Implementation:** `@langchain/aws`
**Authentication:** AWS credentials (standard SDK auth chain)

## Web Scraping

### Playwright

**Purpose:** Browser-based scraping of JavaScript-heavy documentation sites.
**Implementation:** `src/scraper/fetcher/` — auto-detected fetcher falls back to Playwright when needed.
**Configuration:** `scraper.browserTimeoutMs` (default: 30s), `scraper.pageTimeoutMs` (5s)
**Setup:** `ensurePlaywrightBrowsersInstalled()` called at startup in `src/index.ts`

### Axios + axios-retry

**Purpose:** HTTP fetching for standard (non-JS) pages and API calls.
**Implementation:** `src/scraper/fetcher/`
**Configuration:** `scraper.fetcher.maxRetries` (6), `scraper.fetcher.baseDelayMs` (1000ms)
**Headers:** `header-generator` library spoofs realistic browser headers

## External Documentation Sources

### GitHub API

**Purpose:** Scrape private GitHub repositories and wikis.
**Implementation:** `src/scraper/strategies/GitHubScraperStrategy.ts`, `GitHubRepoProcessor.ts`, `GitHubWikiProcessor.ts`
**Authentication:** `GITHUB_TOKEN` env var (personal access token)
**Key endpoints:** GitHub REST API for repo contents, Wiki pages

### npm Registry

**Purpose:** Discover and scrape npm package documentation.
**Implementation:** `src/scraper/strategies/NpmScraperStrategy.ts`
**Authentication:** None (public registry)
**Key endpoints:** `registry.npmjs.org` package metadata

### PyPI Registry

**Purpose:** Discover and scrape Python package documentation.
**Implementation:** `src/scraper/strategies/PyPiScraperStrategy.ts`
**Authentication:** None (public registry)
**Key endpoints:** `pypi.org/pypi/{package}/json`

## Analytics / Telemetry

### PostHog

**Purpose:** Privacy-first anonymous usage telemetry.
**Implementation:** `src/telemetry/postHogClient.ts`, `TelemetryService.ts`
**Configuration:** Opt-out via `DOCS_MCP_TELEMETRY=false` or `--no-telemetry` CLI flag
**Events:** Tool invocations, scrape jobs, errors — all sanitized by `src/telemetry/sanitizer.ts`
**Privacy:** No personal data, URLs are truncated, errors are sanitized before sending

## Authentication

### OAuth2 / OIDC

**Purpose:** Secure multi-user HTTP deployments.
**Implementation:** `src/auth/middleware.ts`, `ProxyAuthManager.ts`
**Library:** `jose` for JWT verification
**Configuration:**
  - `DOCS_MCP_AUTH_ENABLED=true`
  - `DOCS_MCP_AUTH_ISSUER_URL` — OIDC issuer URL
  - `DOCS_MCP_AUTH_AUDIENCE` — expected JWT audience
**Flow:** Bearer token in Authorization header, verified against JWKS from issuer

## Document Processing

### Kreuzberg (`@kreuzberg/node`)

**Purpose:** Extract text from binary document formats (PDF, DOCX, PPTX, XLSX, EPUB, ODT).
**Implementation:** `src/scraper/pipelines/` — document processing pipeline
**Configuration:** `scraper.document.maxSize` (default: 10MB)
**Backend:** WASM-based, no native binary dependencies

### Tree-sitter

**Purpose:** AST-based source code parsing for intelligent code splitting.
**Implementation:** `src/splitter/treesitter/`
**Languages:** JavaScript, TypeScript, Python (grammars bundled)
**Configuration:** `splitter.treeSitterSizeLimit` (default: 30KB) — files over limit use fallback splitter

## Build / Release

### GitHub Actions

**Purpose:** CI (lint, typecheck, test) and release automation.
**Implementation:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`
**Key workflows:**
  - CI: Biome check, typecheck, unit tests
  - Release: semantic-release → npm publish + GitHub release + CHANGELOG

### semantic-release

**Purpose:** Automated versioning and release from conventional commits.
**Configuration:** `.releaserc.json`
**Plugins:** `@semantic-release/changelog`, `@semantic-release/git`, `@semantic-release/github`, `@semantic-release/npm`

## tRPC (Internal IPC)

**Purpose:** Type-safe RPC between coordinator and worker processes in distributed mode.
**Implementation:** `src/pipeline/trpc/`, `src/store/trpc/`, `src/events/trpc/`
**Transport:** HTTP for commands (mutations), WebSocket for event subscriptions (queries)
**Client:** `src/pipeline/PipelineClient.ts`
**Server:** Registered in `src/services/workerService.ts`
