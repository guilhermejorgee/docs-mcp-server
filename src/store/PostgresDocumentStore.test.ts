/**
 * Integration tests for PostgresDocumentStore.
 *
 * These tests require a running PostgreSQL instance with pgvector installed.
 * Set POSTGRES_TEST_URL to run them, e.g.:
 *   POSTGRES_TEST_URL=postgresql://test:test@localhost:5433/docs_mcp_test npx vitest PostgresDocumentStore
 *
 * To start a local test database:
 *   docker compose -f docker/docker-compose.test.yml up -d
 */

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrapeResult } from "../scraper/types";
import type { Chunk } from "../splitter/types";
import { loadConfig } from "../utils/config";
import { PostgresDocumentStore } from "./PostgresDocumentStore";
import { VersionStatus } from "./types";

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

if (!POSTGRES_TEST_URL) {
  describe.skip("PostgresDocumentStore (skip: POSTGRES_TEST_URL not set)", () => {
    it("skipped", () => {});
  });
} else {
  // Mock embedding factory for deterministic test embeddings
  vi.mock("./embeddings/EmbeddingFactory", async () => {
    const actual = await vi.importActual<typeof import("./embeddings/EmbeddingFactory")>(
      "./embeddings/EmbeddingFactory",
    );
    return {
      ...actual,
      createEmbeddingModel: () => ({
        embedQuery: vi.fn(async (text: string) => {
          return generateTestEmbedding(text);
        }),
        embedDocuments: vi.fn(async (texts: string[]) => {
          return texts.map(generateTestEmbedding);
        }),
      }),
    };
  });

  function generateTestEmbedding(text: string): number[] {
    const words = text.toLowerCase().split(/\s+/);
    const embedding = new Array(1536).fill(0);
    words.forEach((word, wordIndex) => {
      const wordHash = Array.from(word).reduce(
        (acc, char) => acc + char.charCodeAt(0),
        0,
      );
      const baseIndex = (wordHash % 100) * 15;
      for (let i = 0; i < 15; i++) {
        const index = (baseIndex + i) % 1536;
        embedding[index] += 1.0 / (wordIndex + 1);
      }
    });
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    return magnitude > 0 ? embedding.map((val) => val / magnitude) : embedding;
  }

  function createScrapeResult(
    title: string,
    url: string,
    content: string,
    path: string[] = [],
  ): ScrapeResult {
    const chunk: Chunk = {
      content,
      types: ["text"],
      section: { path, level: path.length },
    };
    return {
      title,
      url,
      chunks: [chunk],
      contentType: "text/html",
      sourceContentType: "text/html",
      textContent: content,
      links: [],
      errors: [],
    };
  }

  const appConfig = loadConfig();
  const pgConfig = {
    ...appConfig,
    db: {
      ...appConfig.db,
      backend: "postgresql" as const,
      postgresql: {
        ...appConfig.db.postgresql,
        connectionString: POSTGRES_TEST_URL,
      },
    },
  };

  let store: PostgresDocumentStore;
  let adminPool: pg.Pool;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: POSTGRES_TEST_URL });
    // Clean up any leftover test data
    await adminPool
      .query(`
      DROP TABLE IF EXISTS _schema_migrations, documents, pages, versions, libraries CASCADE
    `)
      .catch(() => {});
  });

  afterAll(async () => {
    await store?.shutdown();
    await adminPool.end().catch(() => {});
  });

  beforeEach(async () => {
    if (store) {
      await store.shutdown();
    }
    // Drop all tables to get a clean state for each test group
    await adminPool
      .query(`
      DROP TABLE IF EXISTS _schema_migrations, documents, pages, versions, libraries CASCADE
    `)
      .catch(() => {});
    // Also drop text search config
    await adminPool
      .query(`DROP TEXT SEARCH CONFIGURATION IF EXISTS multilingual CASCADE`)
      .catch(() => {});

    store = new PostgresDocumentStore(POSTGRES_TEST_URL!, pgConfig);
    await store.initialize();
  });

  describe("PostgresDocumentStore", () => {
    describe("initialize and shutdown", () => {
      it("initializes without error", async () => {
        // Already initialized in beforeEach
        expect(store).toBeDefined();
      });

      it("shuts down gracefully", async () => {
        await expect(store.shutdown()).resolves.not.toThrow();
        // Re-create for afterAll cleanup
        store = new PostgresDocumentStore(POSTGRES_TEST_URL!, pgConfig);
        await store.initialize();
      });
    });

    describe("library and version management", () => {
      it("resolves version ID, creating library and version if needed", async () => {
        const versionId = await store.resolveVersionId("test-lib", "1.0.0");
        expect(typeof versionId).toBe("number");
        expect(versionId).toBeGreaterThan(0);
      });

      it("resolves same version ID on second call", async () => {
        const id1 = await store.resolveVersionId("test-lib", "1.0.0");
        const id2 = await store.resolveVersionId("test-lib", "1.0.0");
        expect(id1).toBe(id2);
      });

      it("queries unique versions for a library", async () => {
        await store.resolveVersionId("my-lib", "1.0.0");
        await store.resolveVersionId("my-lib", "2.0.0");
        const versions = await store.queryUniqueVersions("my-lib");
        expect(versions).toContain("1.0.0");
        expect(versions).toContain("2.0.0");
      });

      it("returns empty array for unknown library versions", async () => {
        const versions = await store.queryUniqueVersions("unknown-lib");
        expect(versions).toEqual([]);
      });

      it("gets library by name", async () => {
        await store.resolveVersionId("findable-lib", "1.0");
        const lib = await store.getLibrary("findable-lib");
        expect(lib).not.toBeNull();
        expect(lib?.name).toBe("findable-lib");
      });

      it("returns null for unknown library", async () => {
        const lib = await store.getLibrary("nonexistent");
        expect(lib).toBeNull();
      });

      it("deletes a library", async () => {
        await store.resolveVersionId("deletable-lib", "1.0");
        const lib = await store.getLibrary("deletable-lib");
        expect(lib).not.toBeNull();
        await store.deleteLibrary(lib!.id);
        const libAfter = await store.getLibrary("deletable-lib");
        expect(libAfter).toBeNull();
      });
    });

    describe("version status tracking", () => {
      it("updates version status", async () => {
        const versionId = await store.resolveVersionId("status-lib", "1.0");
        await store.updateVersionStatus(versionId, VersionStatus.RUNNING);
        const versions = await store.getVersionsByStatus([VersionStatus.RUNNING]);
        expect(versions.some((v) => v.id === versionId)).toBe(true);
      });

      it("updates version progress", async () => {
        const versionId = await store.resolveVersionId("progress-lib", "1.0");
        await store.updateVersionProgress(versionId, 50, 100);
        const versions = await store.getVersionsByStatus([VersionStatus.NOT_INDEXED]);
        const v = versions.find((v) => v.id === versionId);
        expect(v?.progress_pages).toBe(50);
        expect(v?.progress_max_pages).toBe(100);
      });

      it("gets version by ID", async () => {
        const versionId = await store.resolveVersionId("getversion-lib", "1.0");
        const version = await store.getVersionById(versionId);
        expect(version).not.toBeNull();
        expect(version?.id).toBe(versionId);
      });
    });

    describe("document CRUD", () => {
      it("adds documents and checks existence", async () => {
        const result = createScrapeResult(
          "Test Page",
          "https://example.com/test",
          "Hello world",
        );
        await store.addDocuments("crud-lib", "1.0", 0, result);
        const exists = await store.checkDocumentExists("crud-lib", "1.0");
        expect(exists).toBe(true);
      });

      it("returns false for non-existent documents", async () => {
        const exists = await store.checkDocumentExists("nonexistent-lib", "1.0");
        expect(exists).toBe(false);
      });

      it("deletes documents via deletePages", async () => {
        const result = createScrapeResult("Page", "https://example.com/page", "content");
        await store.addDocuments("delete-lib", "1.0", 0, result);
        const deleted = await store.deletePages("delete-lib", "1.0");
        expect(deleted).toBeGreaterThan(0);
        const exists = await store.checkDocumentExists("delete-lib", "1.0");
        expect(exists).toBe(false);
      });

      it("deletes a single page", async () => {
        const result = createScrapeResult(
          "Page",
          "https://example.com/single",
          "content",
        );
        await store.addDocuments("single-lib", "1.0", 0, result);
        const pages = await store.getPagesByVersionId(
          await store.resolveVersionId("single-lib", "1.0"),
        );
        expect(pages.length).toBeGreaterThan(0);
        await store.deletePage(pages[0].id);
        const pagesAfter = await store.getPagesByVersionId(
          await store.resolveVersionId("single-lib", "1.0"),
        );
        expect(pagesAfter.length).toBe(0);
      });

      it("lists pages by version ID", async () => {
        const result = createScrapeResult(
          "MyPage",
          "https://example.com/mypage",
          "content",
        );
        await store.addDocuments("pages-lib", "1.0", 0, result);
        const versionId = await store.resolveVersionId("pages-lib", "1.0");
        const pages = await store.getPagesByVersionId(versionId);
        expect(pages.length).toBe(1);
        expect(pages[0].url).toBe("https://example.com/mypage");
      });
    });

    describe("FTS search (no embeddings)", () => {
      it("finds documents by full-text search", async () => {
        const result = createScrapeResult(
          "Vitest Guide",
          "https://example.com/vitest",
          "Vitest is a fast unit test framework powered by Vite",
        );
        await store.addDocuments("fts-lib", "1.0", 0, result);

        const results = await store.findByContent(
          "fts-lib",
          "1.0",
          "vitest unit test",
          5,
        );
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].content).toContain("Vitest");
      });

      it("returns empty array for unmatched query", async () => {
        const result = createScrapeResult(
          "Page",
          "https://example.com/page",
          "Some content about stuff",
        );
        await store.addDocuments("fts-lib2", "1.0", 0, result);
        const results = await store.findByContent("fts-lib2", "1.0", "xyzzy nonsense", 5);
        expect(results).toEqual([]);
      });
    });

    describe("queryLibraryVersions", () => {
      it("returns all libraries and their versions", async () => {
        await store.addDocuments(
          "lib-a",
          "1.0",
          0,
          createScrapeResult("A", "https://a.com", "content a"),
        );
        await store.addDocuments(
          "lib-b",
          "2.0",
          0,
          createScrapeResult("B", "https://b.com", "content b"),
        );

        const map = await store.queryLibraryVersions();
        expect(map.has("lib-a")).toBe(true);
        expect(map.has("lib-b")).toBe(true);
        const aVersions = map.get("lib-a");
        expect(aVersions?.some((v) => v.version === "1.0")).toBe(true);
      });
    });

    describe("removeVersion", () => {
      it("removes a version and its documents", async () => {
        await store.addDocuments(
          "remove-lib",
          "1.0",
          0,
          createScrapeResult("Remove", "https://rm.com", "content"),
        );
        const result = await store.removeVersion("remove-lib", "1.0");
        expect(result.versionDeleted).toBe(true);
        expect(result.documentsDeleted).toBeGreaterThanOrEqual(0);
      });

      it("removes library when last version deleted", async () => {
        await store.addDocuments(
          "last-lib",
          "1.0",
          0,
          createScrapeResult("Last", "https://last.com", "content"),
        );
        const result = await store.removeVersion("last-lib", "1.0", true);
        expect(result.libraryDeleted).toBe(true);
        const lib = await store.getLibrary("last-lib");
        expect(lib).toBeNull();
      });
    });

    describe("chunk retrieval", () => {
      it("gets document by ID", async () => {
        const result = createScrapeResult(
          "Chunk",
          "https://example.com/chunk",
          "Get by ID test",
        );
        await store.addDocuments("chunk-lib", "1.0", 0, result);
        const chunks = await store.findChunksByUrl(
          "chunk-lib",
          "1.0",
          "https://example.com/chunk",
        );
        expect(chunks.length).toBeGreaterThan(0);
        const chunk = await store.getById(chunks[0].id);
        expect(chunk).not.toBeNull();
        expect(chunk?.content).toBe("Get by ID test");
      });

      it("finds chunks by URL", async () => {
        const result = createScrapeResult(
          "URL",
          "https://example.com/byurl",
          "content for URL test",
        );
        await store.addDocuments("url-lib", "1.0", 0, result);
        const chunks = await store.findChunksByUrl(
          "url-lib",
          "1.0",
          "https://example.com/byurl",
        );
        expect(chunks.length).toBeGreaterThan(0);
      });

      it("finds chunks by IDs", async () => {
        const result = createScrapeResult(
          "IDs",
          "https://example.com/ids",
          "content for IDs test",
        );
        await store.addDocuments("ids-lib", "1.0", 0, result);
        const chunks = await store.findChunksByUrl(
          "ids-lib",
          "1.0",
          "https://example.com/ids",
        );
        expect(chunks.length).toBeGreaterThan(0);
        const ids = chunks.map((c) => c.id);
        const fetched = await store.findChunksByIds("ids-lib", "1.0", ids);
        expect(fetched.length).toBe(chunks.length);
      });
    });

    describe("scraper options", () => {
      it("stores and retrieves scraper options", async () => {
        const versionId = await store.resolveVersionId("scraper-lib", "1.0");
        const options = {
          url: "https://docs.example.com",
          library: "scraper-lib",
          version: "1.0",
          maxPages: 100,
          maxDepth: 3,
        };
        await store.storeScraperOptions(versionId, options as any);
        const retrieved = await store.getScraperOptions(versionId);
        expect(retrieved).not.toBeNull();
        expect(retrieved?.sourceUrl).toBe("https://docs.example.com");
        expect(retrieved?.options.maxPages).toBe(100);
      });

      it("finds versions by source URL", async () => {
        const versionId = await store.resolveVersionId("srcurl-lib", "1.0");
        const options = {
          url: "https://unique-source.example.com",
          library: "srcurl-lib",
          version: "1.0",
        };
        await store.storeScraperOptions(versionId, options as any);
        const versions = await store.findVersionsBySourceUrl(
          "https://unique-source.example.com",
        );
        expect(versions.some((v) => v.id === versionId)).toBe(true);
      });
    });
  });
}
