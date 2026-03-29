# Tech Stack

**Analyzed:** 2026-03-28

## Core

- Language: TypeScript 5.9 (strict mode, ESM modules)
- Runtime: Node.js 22+ (`"type": "module"`)
- Package manager: npm (with `package-lock.json`)
- Build system: Vite 7 + vite-node (dev), vite-plugin-dts (types)
- Version: 2.1.1

## Backend

- HTTP server: Fastify 5
- RPC layer: tRPC 11 (HTTP commands + WebSocket event subscriptions)
- CLI: yargs 18
- Database: better-sqlite3 12 + sqlite-vec 0.1.7 (vector extension)
- Schema validation: Zod 4
- Config format: YAML (via `yaml` library), auto-saves defaults to `~/.config/docs-mcp-server/config.yaml`
- Auth: OAuth2/OIDC via `jose` JWT library

## Frontend (Web UI)

- Rendering: Server-side JSX via `@kitajs/html` (no React, no hydration)
- Interactivity: HTMX 2 (partial page updates) + AlpineJS 3 (client-side state)
- Styling: TailwindCSS 4 + Flowbite 4 component library
- UI pattern: HTML-over-the-wire (HTMX), no SPA framework

## Embeddings / AI

- Framework: LangChain.js (`langchain`, `@langchain/core`, `@langchain/textsplitters`)
- Providers: `@langchain/openai`, `@langchain/google-genai`, `@langchain/google-vertexai`, `@langchain/aws`
- Default model: `text-embedding-3-small` (OpenAI), 1536-dimensional vectors

## Web Scraping

- Browser automation: Playwright 1.58
- HTML parsing: Cheerio 1, jsdom 27
- HTML → Markdown: Turndown 7 + GFM plugin
- HTTP client: Axios 1 + axios-retry
- Browser headers spoofing: header-generator

## Document Processing

- PDF/Office/EPUB extraction: `@kreuzberg/node` 4.4 (WASM-based)
- Source code AST parsing: tree-sitter 0.21 + grammars for JS/TS/Python
- Archive extraction: yauzl (ZIP), tar

## MCP Protocol

- SDK: `@modelcontextprotocol/sdk` 1.27
- Transports: stdio (AI tools) + Streamable HTTP + SSE (web)

## Testing

- Unit/Integration: Vitest 3
- HTTP mocking: msw 2 + nock 14
- Filesystem mocking: memfs 4
- Search quality eval: promptfoo 0.120

## Development Tools

- Linting + Formatting: Biome 2 (replaces ESLint + Prettier)
- Git hooks: Husky 9 + lint-staged 16
- Commit convention: commitlint (conventional commits)
- Release automation: semantic-release 25
- CI/CD: GitHub Actions (`.github/workflows/ci.yml`, `release.yml`)

## External Services

- Telemetry: PostHog (opt-out via `DOCS_MCP_TELEMETRY=false`)
- npm registry: package discovery scraping
- PyPI registry: package discovery scraping
- GitHub API: private repo scraping (via `GITHUB_TOKEN`)
