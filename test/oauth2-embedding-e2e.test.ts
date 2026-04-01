/**
 * End-to-end test for OAuth2 client_credentials embedding authentication.
 *
 * Covers:
 * - OAUTH-01: Bearer token is injected into every embedding API call when
 *   `tokenUrl` + `clientId` are configured (PATH B of EmbeddingFactory).
 * - OAUTH-03: Token is cached — a single token request serves all embedding
 *   calls across multiple scrapes within the same pipeline instance.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { http, HttpResponse } from "msw";
import { ScrapeTool } from "../src/tools/ScrapeTool";
import { createLocalDocumentManagement } from "../src/store";
import { PipelineFactory } from "../src/pipeline/PipelineFactory";
import { PipelineManager } from "../src/pipeline/PipelineManager";
import { EventBusService } from "../src/events";
import { loadConfig } from "../src/utils/config";
import { createPgContainer } from "./pg-container";
import { server } from "./mock-server";

const container = createPgContainer();

describe("OAuth2 client_credentials embedding authentication (E2E)", () => {
  let tempDir: string;
  let pipeline: PipelineManager;
  let docService: Awaited<ReturnType<typeof createLocalDocumentManagement>>;
  let scrapeTool: ScrapeTool;

  let prevClientSecret: string | undefined;

  beforeAll(async () => {
    await container.start();

    // Provide the client secret via the default EnvSecretProvider key so that
    // EmbeddingFactory PATH B can resolve it without an explicit secretProvider.
    prevClientSecret = process.env.DOCS_MCP_EMBEDDING_CLIENT_SECRET;
    process.env.DOCS_MCP_EMBEDDING_CLIENT_SECRET = "test-client-secret";

    tempDir = mkdtempSync(path.join(tmpdir(), "oauth2-embedding-e2e-"));

    const appConfig = loadConfig();
    appConfig.app.storePath = tempDir;
    appConfig.app.embeddingModel = "openai:text-embedding-3-small";
    appConfig.db.postgresql.connectionString = container.connectionString;

    // PATH B activation: set tokenUrl + clientId. No OPENAI_API_KEY needed.
    appConfig.embeddings.tokenUrl = "https://oauth2.test.example/token";
    appConfig.embeddings.clientId = "test-client-id";
    appConfig.embeddings.clientSecretKey = "DOCS_MCP_EMBEDDING_CLIENT_SECRET";

    const eventBus = new EventBusService();
    docService = await createLocalDocumentManagement(eventBus, appConfig);

    pipeline = await PipelineFactory.createPipeline(docService, eventBus, {
      appConfig,
    });
    await pipeline.start();

    scrapeTool = new ScrapeTool(pipeline, appConfig.scraper);
  }, 120_000);

  afterAll(async () => {
    await pipeline?.stop();
    await docService?.shutdown();

    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }

    if (prevClientSecret === undefined) {
      delete process.env.DOCS_MCP_EMBEDDING_CLIENT_SECRET;
    } else {
      process.env.DOCS_MCP_EMBEDDING_CLIENT_SECRET = prevClientSecret;
    }

    await container.stop();
  });

  it(
    "injects Bearer token into all embedding API calls and caches it across multiple scrapes (OAUTH-01 + OAUTH-03)",
    async () => {
      let tokenCallCount = 0;
      let capturedTokenBody: string | null = null;
      const capturedAuthHeaders: string[] = [];

      // Override handlers for this test only.
      // setup-e2e.ts afterEach resets these after the test completes.
      server.use(
        // Mock OAuth2 token endpoint — captures call count and request body.
        http.post("https://oauth2.test.example/token", async ({ request }) => {
          tokenCallCount++;
          capturedTokenBody = await request.text();
          return HttpResponse.json({
            access_token: "test-bearer-token",
            expires_in: 3600,
          });
        }),

        // Override embedding endpoint to capture the Authorization header
        // sent by the custom fetch wrapper installed by EmbeddingFactory PATH B.
        http.post("https://api.openai.com/v1/embeddings", async ({ request }) => {
          capturedAuthHeaders.push(request.headers.get("Authorization") ?? "");

          const body = (await request.json()) as {
            input?: string | string[];
            model?: string;
          };
          const inputs = Array.isArray(body?.input)
            ? body.input
            : typeof body?.input === "string"
              ? [body.input]
              : [];

          const vector = Array(1536).fill(0);
          return HttpResponse.json({
            data: inputs.map((_, index) => ({
              object: "embedding",
              embedding: vector,
              index,
            })),
            model: body?.model ?? "text-embedding-3-small",
            object: "list",
            usage: { prompt_tokens: 0, total_tokens: 0 },
          });
        }),
      );

      // Scrape two separate documents using semantic chunking so that
      // embedDocuments() is called, triggering the OAuth2 Bearer token flow.
      const readmePath = path.resolve(process.cwd(), "README.md");
      await scrapeTool.execute({
        library: "oauth2-e2e-lib-1",
        version: "1.0.0",
        url: `file://${readmePath}`,
        options: { chunkingStrategy: "semantic" },
        waitForCompletion: true,
      });

      const architecturePath = path.resolve(process.cwd(), "ARCHITECTURE.md");
      await scrapeTool.execute({
        library: "oauth2-e2e-lib-2",
        version: "1.0.0",
        url: `file://${architecturePath}`,
        options: { chunkingStrategy: "semantic" },
        waitForCompletion: true,
      });

      // OAUTH-01: every embedding request must carry the Bearer token.
      expect(capturedAuthHeaders.length).toBeGreaterThan(0);
      expect(capturedAuthHeaders.every((h) => h === "Bearer test-bearer-token")).toBe(true);

      // Token endpoint must have been called with the standard client_credentials body.
      expect(capturedTokenBody).toContain("grant_type=client_credentials");
      expect(capturedTokenBody).toContain("client_id=test-client-id");

      // OAUTH-03: despite multiple scrapes (and many embedding calls), the token
      // was fetched only once — the OAuth2TokenProvider cache is working.
      expect(tokenCallCount).toBe(1);
    },
    120_000,
  );
});
