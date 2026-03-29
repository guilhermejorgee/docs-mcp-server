# Testing Infrastructure

## Test Frameworks

**Unit/Integration:** Vitest 3 (`vitest`)
**E2E:** Vitest 3 (same runner, separate suite)
**HTTP mocking:** msw 2 (service workers) + nock 14 (HTTP interceptors)
**Filesystem mocking:** memfs 4
**Search quality eval:** promptfoo 0.120 (LLM-as-judge evaluation)

## Test Organization

**Location:**
- Unit/integration tests: Colocated with source — `src/**/*.test.ts`
- E2E tests: `test/*.test.ts` (with `-e2e` suffix convention)
- Search quality: `tests/search-eval/`

**Naming:** `[FileName].test.ts` alongside source file. E2E: `[feature]-e2e.test.ts`.

**Structure:**
```
src/
├── tools/
│   ├── SearchTool.ts
│   └── SearchTool.test.ts    ← colocated unit test
test/
├── cli-e2e.test.ts
├── mcp-stdio-e2e.test.ts
├── html-pipeline-basic-e2e.test.ts
├── vector-search-e2e.test.ts
└── fixtures/                  ← binary test fixtures (PDF, DOCX, ZIP, etc.)
```

## Testing Patterns

### Unit Tests

**Approach:** Mock all external dependencies with `vi.fn()`. Test public `execute()` API behavior.
**Location:** `src/**/*.test.ts`

Pattern from `SearchTool.test.ts`:
```ts
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

describe("SearchTool", () => {
  let mockDocService: Partial<DocumentManagementService>;
  let searchTool: SearchTool;

  beforeEach(() => {
    vi.resetAllMocks();
    mockDocService = {
      validateLibraryExists: vi.fn(),
      findBestVersion: vi.fn(),
      searchStore: vi.fn(),
    };
    searchTool = new SearchTool(mockDocService as DocumentManagementService);
  });

  it("should search with exact version when exactMatch is true", async () => {
    (mockDocService.searchStore as Mock).mockResolvedValue(mockResults);
    const result = await searchTool.execute(options);
    expect(result.results).toEqual(mockResults);
  });
});
```

**Key conventions:**
- `vi.resetAllMocks()` in `beforeEach`
- Type cast mocks as partial: `Partial<ServiceType>`
- Test one behavior per `it()` block
- Descriptive test names: "should [verb] when [condition]"

### Integration Tests

**Approach:** Real SQLite in-memory DB, mock HTTP calls with nock/msw.
**Location:** `src/**/*.test.ts` (same suite, uses real implementations)

### E2E Tests

**Approach:** Build the full application (`npm run build` via `pretest:e2e`), spin up real server processes.
**Location:** `test/`

Key E2E files:
- `cli-e2e.test.ts` — full CLI invocations
- `mcp-stdio-e2e.test.ts` — MCP protocol via stdio
- `mcp-http-e2e.test.ts` — MCP over HTTP
- `html-pipeline-basic-e2e.test.ts` — web scraping pipeline
- `vector-search-e2e.test.ts` — embedding + search round-trip
- `auth-e2e.test.ts` — OAuth2 authentication flow
- `archive-integration.test.ts` — ZIP/tar processing

Helpers:
- `test/setup-e2e.ts` — server startup/teardown
- `test/test-helpers.ts` — shared assertions and utilities
- `test/mock-server.ts` — local HTTP mock server for scraping tests

## Test Execution

**Commands:**
```bash
npm test                    # All unit tests (src/)
npm run test:unit           # Unit tests only (src/)
npm run test:e2e            # E2E tests (requires build)
npm run test:coverage       # Unit tests + coverage report
npm run test:watch          # Watch mode
npm run evaluate:search     # promptfoo search quality eval
```

**Configuration:** `vite.config.ts` — Vitest config inline.

**Test setup files:**
- `test/setup.ts` — global test setup
- `test/setup-env.ts` — environment variable setup for tests
- `test/setup-e2e.ts` — E2E server lifecycle

## Coverage Targets

**Current:** Not enforced in CI (no coverage threshold configured).
**Goals:** Not explicitly documented.
**Enforcement:** Not automated — manual runs only.

## Notes

- E2E tests require a real build (`pretest:e2e` script handles this automatically).
- Live scraping tests (`html-pipeline-live-e2e.test.ts`) are excluded from default E2E run — require external network.
- Search eval requires a running server and OpenAI credentials.
