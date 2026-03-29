/**
 * End-to-end search tests that verify the full pipeline:
 * scraping -> chunking -> FTS indexing -> searching
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ScrapeTool } from "../src/tools/ScrapeTool";
import { SearchTool } from "../src/tools/SearchTool";
import { createLocalDocumentManagement } from "../src/store";
import { PipelineFactory } from "../src/pipeline/PipelineFactory";
import { EventBusService } from "../src/events";
import { loadConfig } from "../src/utils/config";
import { createPgContainer } from "./pg-container";

const container = createPgContainer();

describe("Search End-to-End Tests", () => {
  let docService: any;
  let scrapeTool: ScrapeTool;
  let searchTool: SearchTool;
  let pipeline: any;
  let tempDir: string;

  beforeAll(async () => {
    await container.start();

    tempDir = mkdtempSync(path.join(tmpdir(), "search-e2e-"));

    const appConfig = loadConfig();
    appConfig.app.storePath = tempDir;
    appConfig.db.postgresql.connectionString = container.connectionString;

    const eventBus = new EventBusService();
    docService = await createLocalDocumentManagement(eventBus, appConfig);

    pipeline = await PipelineFactory.createPipeline(docService, eventBus, { appConfig });
    await pipeline.start();

    scrapeTool = new ScrapeTool(pipeline, appConfig.scraper);
    searchTool = new SearchTool(docService);

    // Scrape the local README.md once — all tests share this indexed data
    const readmePath = path.resolve(process.cwd(), "README.md");
    await scrapeTool.execute({
      library: "test-library",
      version: "1.0.0",
      url: `file://${readmePath}`,
      waitForCompletion: true,
    });
  }, 120_000);

  afterAll(async () => {
    if (pipeline) await pipeline.stop();
    if (docService) await docService.shutdown();
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    await container.stop();
  });

  it("should scrape local README.md and make it searchable", async () => {
    const exists = await docService.exists("test-library", "1.0.0");
    expect(exists).toBe(true);

    const result = await searchTool.execute({
      library: "test-library",
      version: "1.0.0",
      query: "MCP server documentation",
      limit: 5,
    });

    expect(result.results).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("should return results matching search terms", async () => {
    // README.md contains the word "scrape" in several places
    const result = await searchTool.execute({
      library: "test-library",
      version: "1.0.0",
      query: "scrape documentation",
      limit: 5,
    });

    expect(result.results.length).toBeGreaterThan(0);
    const hasMatch = result.results.some((r) =>
      r.content.toLowerCase().includes("scrape") ||
      r.content.toLowerCase().includes("documentation"),
    );
    expect(hasMatch).toBe(true);
  });

  it("should handle version-specific searches with exactMatch", async () => {
    const result = await searchTool.execute({
      library: "test-library",
      version: "1.0.0",
      query: "MCP server",
      exactMatch: true,
      limit: 3,
    });

    expect(result.results).toBeDefined();
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("should return empty results for a non-existent version with exactMatch", async () => {
    const result = await searchTool.execute({
      library: "test-library",
      version: "999.999.999",
      query: "test query",
      exactMatch: true,
    });

    expect(result.results).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBe(0);
  });

  it("should throw for a non-existent library", async () => {
    await expect(
      searchTool.execute({
        library: "non-existent-library",
        version: "1.0.0",
        query: "test query",
      }),
    ).rejects.toThrow("non-existent-library");
  });
});
