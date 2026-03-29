/**
 * Ensures documents are persisted and indexed in PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { ScrapeTool } from "../src/tools/ScrapeTool";
import { createLocalDocumentManagement } from "../src/store";
import { PipelineFactory } from "../src/pipeline/PipelineFactory";
import {
  EmbeddingConfig,
  type EmbeddingModelConfig,
} from "../src/store/embeddings/EmbeddingConfig";
import { EventBusService } from "../src/events";
import { loadConfig } from "../src/utils/config";
import { createPgContainer } from "./pg-container";

const container = createPgContainer();

describe("Vector persistence", () => {
  let tempDir: string;
  let pipeline: any;
  let docService: any;
  let scrapeTool: ScrapeTool;

  let prevOpenAiApiKey: string | undefined;
  let prevOpenAiApiBase: string | undefined;

  beforeAll(async () => {
    await container.start();

    // Ensure vector search initializes in tests without requiring real credentials.
    prevOpenAiApiKey = process.env.OPENAI_API_KEY;
    prevOpenAiApiBase = process.env.OPENAI_API_BASE;

    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-key";
    delete process.env.OPENAI_API_BASE;

    tempDir = mkdtempSync(path.join(tmpdir(), "vector-persistence-e2e-"));
    const embeddingConfig: EmbeddingModelConfig = EmbeddingConfig.parseEmbeddingConfig(
      "openai:text-embedding-3-small",
    );

    const appConfig = loadConfig();
    appConfig.app.storePath = tempDir;
    appConfig.app.embeddingModel = embeddingConfig.modelSpec;
    appConfig.db.postgresql.connectionString = container.connectionString;

    const eventBus = new EventBusService();
    docService = await createLocalDocumentManagement(eventBus, appConfig);

    pipeline = await PipelineFactory.createPipeline(docService, eventBus, {
      appConfig,
    });
    await pipeline.start();

    scrapeTool = new ScrapeTool(pipeline, appConfig.scraper);
  }, 120_000);

  afterAll(async () => {
    if (pipeline) {
      await pipeline.stop();
    }
    if (docService) {
      await docService.shutdown();
    }
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }

    if (prevOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = prevOpenAiApiKey;
    }

    if (prevOpenAiApiBase === undefined) {
      delete process.env.OPENAI_API_BASE;
    } else {
      process.env.OPENAI_API_BASE = prevOpenAiApiBase;
    }

    await container.stop();
  });

  it(
    "indexes documents and exposes embedding model for semantic chunking",
    async () => {
      const readmePath = path.resolve(process.cwd(), "README.md");
      const fileUrl = `file://${readmePath}`;

      await scrapeTool.execute({
        library: "vector-persist-lib",
        version: "1.0.0",
        url: fileUrl,
        waitForCompletion: true,
      });

      const exists = await docService.exists("vector-persist-lib", "1.0.0");
      expect(exists).toBe(true);

      // Verify documents are persisted in PostgreSQL
      const versionId = await docService.store.resolveVersionId("vector-persist-lib", "1.0.0");
      const pages = await docService.store.getPagesByVersionId(versionId);
      expect(pages.length).toBeGreaterThan(0);

      // Verify the embedding model is accessible for semantic chunking
      const embeddingModel = docService.store.getEmbeddingModel();
      expect(embeddingModel).not.toBeNull();
    },
    60000,
  );
});
