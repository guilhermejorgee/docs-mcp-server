import type { Embeddings } from "@langchain/core/embeddings";
import type { QueryResultRow } from "pg";
import pg from "pg";
import type { ScrapeResult, ScraperOptions } from "../scraper/types";
import type { AppConfig } from "../utils/config";
import { logger } from "../utils/logger";
import { compareVersionsDescending } from "../utils/version";
import { applyMigrationsPg } from "./applyMigrations";
import { EmbeddingConfig, type EmbeddingModelConfig } from "./embeddings/EmbeddingConfig";
import {
  areCredentialsAvailable,
  createEmbeddingModel,
  ModelConfigurationError,
  UnsupportedProviderError,
} from "./embeddings/EmbeddingFactory";
import { FixedDimensionEmbeddings } from "./embeddings/FixedDimensionEmbeddings";
import { ConnectionError, DimensionError, StoreError } from "./errors";
import type { IDocumentStore } from "./IDocumentStore";
import type { DbChunkMetadata, DbChunkRank, StoredScraperOptions } from "./types";
import {
  type DbChunk,
  type DbLibraryVersion,
  type DbPage,
  type DbPageChunk,
  type DbVersion,
  type DbVersionWithLibrary,
  normalizeVersionName,
  type VersionScraperOptions,
  type VersionStatus,
} from "./types";

interface RawSearchResult extends DbChunk {
  url?: string;
  title?: string | null;
  source_content_type?: string | null;
  content_type?: string | null;
  vec_score?: number;
  fts_score?: number;
}

interface RankedResult extends RawSearchResult {
  vec_rank?: number;
  fts_rank?: number;
  rrf_score: number;
}

/**
 * Manages document storage and retrieval using PostgreSQL with pgvector and full-text search.
 * Implements the IDocumentStore interface, providing the same API as SqliteDocumentStore
 * but backed by a PostgreSQL database.
 */
export class PostgresDocumentStore implements IDocumentStore {
  private readonly config: AppConfig;
  private readonly pool: pg.Pool;

  private embeddings!: Embeddings;
  private readonly dbDimension: number;
  private readonly searchWeightVec: number;
  private readonly searchWeightFts: number;
  private readonly searchOverfetchFactor: number;
  private readonly vectorSearchMultiplier: number;
  private readonly splitterMaxChunkSize: number;
  private readonly embeddingBatchSize: number;
  private readonly embeddingBatchChars: number;
  private readonly embeddingInitTimeoutMs: number;
  private modelDimension!: number;
  private readonly embeddingConfig?: EmbeddingModelConfig | null;
  private isVectorSearchEnabled: boolean = false;

  constructor(connectionString: string, config: AppConfig) {
    if (!connectionString) {
      throw new StoreError("Missing required PostgreSQL connection string");
    }
    this.config = config;
    this.dbDimension = config.embeddings.vectorDimension;
    this.searchWeightVec = config.search.weightVec;
    this.searchWeightFts = config.search.weightFts;
    this.searchOverfetchFactor = config.search.overfetchFactor;
    this.vectorSearchMultiplier = config.search.vectorMultiplier;
    this.splitterMaxChunkSize = config.splitter.maxChunkSize;
    this.embeddingBatchSize = config.embeddings.batchSize;
    this.embeddingBatchChars = config.embeddings.batchChars;
    this.embeddingInitTimeoutMs = config.embeddings.initTimeoutMs;

    this.pool = new pg.Pool({
      connectionString,
      max: config.db.postgresql.poolSize,
      idleTimeoutMillis: config.db.postgresql.idleTimeoutMs,
      connectionTimeoutMillis: config.db.postgresql.connectionTimeoutMs,
    });

    this.embeddingConfig = this.resolveEmbeddingConfig(config.app.embeddingModel);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private resolveEmbeddingConfig(modelSpec: string): EmbeddingModelConfig | null {
    if (!modelSpec) {
      logger.debug("No embedding model specified. Embeddings are disabled.");
      return null;
    }
    try {
      logger.debug(`Resolving embedding configuration for model: ${modelSpec}`);
      return EmbeddingConfig.parseEmbeddingConfig(modelSpec);
    } catch (error) {
      logger.debug(`Failed to resolve embedding configuration: ${error}`);
      return null;
    }
  }

  /**
   * Execute a SQL query and return the result rows typed as T.
   */
  private async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    const result = await this.pool.query<T>(sql, params);
    return result.rows;
  }

  /**
   * Execute a SQL query and return a single row or null.
   */
  private async queryOne<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  /**
   * Serialize a numeric embedding vector to PostgreSQL vector literal format.
   */
  private serializeVector(vector: number[]): string {
    return `[${vector.join(",")}]`;
  }

  /**
   * Pads a vector to the fixed database dimension by appending zeros.
   */
  private padVector(vector: number[]): number[] {
    if (vector.length > this.dbDimension) {
      throw new Error(
        `Vector dimension ${vector.length} exceeds database dimension ${this.dbDimension}`,
      );
    }
    if (vector.length === this.dbDimension) {
      return vector;
    }
    return [...vector, ...new Array(this.dbDimension - vector.length).fill(0)];
  }

  // ---------------------------------------------------------------------------
  // RRF ranking helpers (identical logic to SqliteDocumentStore)
  // ---------------------------------------------------------------------------

  private calculateRRF(vecRank?: number, ftsRank?: number, k = 60): number {
    let rrf = 0;
    if (vecRank !== undefined) {
      rrf += this.searchWeightVec / (k + vecRank);
    }
    if (ftsRank !== undefined) {
      rrf += this.searchWeightFts / (k + ftsRank);
    }
    return rrf;
  }

  private assignRanks(results: RawSearchResult[]): RankedResult[] {
    const vecRanks = new Map<number, number>();
    const ftsRanks = new Map<number, number>();

    results
      .filter((r) => r.vec_score !== undefined)
      .sort((a, b) => (b.vec_score ?? 0) - (a.vec_score ?? 0))
      .forEach((result, index) => {
        vecRanks.set(Number(result.id), index + 1);
      });

    results
      .filter((r) => r.fts_score !== undefined)
      .sort((a, b) => (b.fts_score ?? 0) - (a.fts_score ?? 0))
      .forEach((result, index) => {
        ftsRanks.set(Number(result.id), index + 1);
      });

    return results.map((result) => ({
      ...result,
      vec_rank: vecRanks.get(Number(result.id)),
      fts_rank: ftsRanks.get(Number(result.id)),
      rrf_score: this.calculateRRF(
        vecRanks.get(Number(result.id)),
        ftsRanks.get(Number(result.id)),
      ),
    }));
  }

  // ---------------------------------------------------------------------------
  // Embedding helpers (same logic as SqliteDocumentStore)
  // ---------------------------------------------------------------------------

  private isInputSizeError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    return (
      message.includes("maximum context length") ||
      message.includes("too long") ||
      message.includes("token limit") ||
      message.includes("input is too large") ||
      message.includes("exceeds") ||
      (message.includes("max") && message.includes("token"))
    );
  }

  private async embedDocumentsWithRetry(
    texts: string[],
    isRetry = false,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    try {
      return await this.embeddings.embedDocuments(texts);
    } catch (error) {
      if (this.isInputSizeError(error)) {
        if (texts.length > 1) {
          const midpoint = Math.floor(texts.length / 2);
          const firstHalf = texts.slice(0, midpoint);
          const secondHalf = texts.slice(midpoint);

          if (!isRetry) {
            logger.warn(
              `⚠️  Batch of ${texts.length} texts exceeded size limit, splitting into ${firstHalf.length} + ${secondHalf.length}`,
            );
          }

          const [firstEmbeddings, secondEmbeddings] = await Promise.all([
            this.embedDocumentsWithRetry(firstHalf, true),
            this.embedDocumentsWithRetry(secondHalf, true),
          ]);
          return [...firstEmbeddings, ...secondEmbeddings];
        } else {
          const text = texts[0];
          const midpoint = Math.floor(text.length / 2);
          const firstHalf = text.substring(0, midpoint);

          if (!isRetry) {
            logger.warn(
              `⚠️  Single text exceeded embedding size limit (${text.length} chars).`,
            );
          }

          try {
            return await this.embedDocumentsWithRetry([firstHalf], true);
          } catch (retryError) {
            logger.error(
              `❌ Failed to embed even after splitting. Original length: ${text.length}`,
            );
            throw retryError;
          }
        }
      }
      throw error;
    }
  }

  private async initializeEmbeddings(): Promise<void> {
    if (this.embeddingConfig === null || this.embeddingConfig === undefined) {
      logger.debug(
        "Embedding initialization skipped (no config provided - FTS-only mode)",
      );
      return;
    }

    const config = this.embeddingConfig;

    if (!areCredentialsAvailable(config.provider)) {
      logger.warn(
        `⚠️  No credentials found for ${config.provider} embedding provider. Vector search is disabled.\n` +
          `   Only full-text search will be available. To enable vector search, please configure the required\n` +
          `   environment variables for ${config.provider} or choose a different provider.\n` +
          `   See README.md for configuration options or run with --help for more details.`,
      );
      return;
    }

    try {
      this.embeddings = createEmbeddingModel(config.modelSpec, {
        requestTimeoutMs: this.config.embeddings.requestTimeoutMs,
        vectorDimension: this.dbDimension,
      });

      if (config.dimensions !== null) {
        this.modelDimension = config.dimensions;
      } else {
        const testPromise = this.embeddings.embedQuery("test");
        let timeoutId: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new Error(
                `Embedding service connection timed out after ${this.embeddingInitTimeoutMs / 1000} seconds`,
              ),
            );
          }, this.embeddingInitTimeoutMs);
        });

        try {
          const testVector = await Promise.race([testPromise, timeoutPromise]);
          this.modelDimension = testVector.length;
        } finally {
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
          }
        }

        EmbeddingConfig.setKnownModelDimensions(config.model, this.modelDimension);
      }

      if (
        this.embeddings instanceof FixedDimensionEmbeddings &&
        this.embeddings.allowTruncate
      ) {
        this.modelDimension = Math.min(this.modelDimension, this.dbDimension);
      }

      if (this.modelDimension > this.dbDimension) {
        throw new DimensionError(config.modelSpec, this.modelDimension, this.dbDimension);
      }

      this.isVectorSearchEnabled = true;
      logger.debug(
        `Embeddings initialized: ${config.provider}:${config.model} (${this.modelDimension}d)`,
      );
    } catch (error) {
      if (error instanceof Error) {
        if (
          error.message.includes("does not exist") ||
          error.message.includes("MODEL_NOT_FOUND")
        ) {
          throw new ModelConfigurationError(
            `Invalid embedding model: ${config.model}\n` +
              `   The model "${config.model}" is not available or you don't have access to it.\n` +
              "   See README.md for supported models or run with --help for more details.",
          );
        }
        if (
          error.message.includes("API key") ||
          error.message.includes("401") ||
          error.message.includes("authentication")
        ) {
          throw new ModelConfigurationError(
            `Authentication failed for ${config.provider} embedding provider\n` +
              "   Please check your API key configuration.\n" +
              "   See README.md for configuration options or run with --help for more details.",
          );
        }
        if (
          error.message.includes("timed out") ||
          error.message.includes("ECONNREFUSED") ||
          error.message.includes("ENOTFOUND") ||
          error.message.includes("ETIMEDOUT") ||
          error.message.includes("ECONNRESET") ||
          error.message.includes("network") ||
          error.message.includes("fetch failed")
        ) {
          throw new ModelConfigurationError(
            `Failed to connect to ${config.provider} embedding service\n` +
              `   ${error.message}\n` +
              `   Please check that the embedding service is running and accessible.\n` +
              `   If using a local model (e.g., Ollama), ensure the service is started.`,
          );
        }
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // IDocumentStore public API
  // ---------------------------------------------------------------------------

  getActiveEmbeddingConfig(): EmbeddingModelConfig | null {
    if (!this.isVectorSearchEnabled || !this.embeddingConfig) {
      return null;
    }
    return this.embeddingConfig;
  }

  async initialize(): Promise<void> {
    try {
      // 1. Run database migrations
      await applyMigrationsPg(this.pool);

      // 2. Check pgvector extension is available
      const extRow = await this.queryOne(
        "SELECT * FROM pg_extension WHERE extname = 'vector'",
      );
      if (!extRow) {
        throw new StoreError(
          "pgvector extension is not installed. " +
            "Please install it with: CREATE EXTENSION IF NOT EXISTS vector;",
        );
      }

      // 3. Initialize embeddings client
      await this.initializeEmbeddings();
    } catch (error) {
      if (
        error instanceof StoreError ||
        error instanceof ModelConfigurationError ||
        error instanceof UnsupportedProviderError
      ) {
        throw error;
      }
      throw new ConnectionError("Failed to initialize PostgreSQL connection", error);
    }
  }

  async shutdown(): Promise<void> {
    await this.pool.end();
  }

  // ---------------------------------------------------------------------------
  // Library / version resolution
  // ---------------------------------------------------------------------------

  async resolveVersionId(library: string, version: string): Promise<number> {
    const normalizedLibrary = library.toLowerCase();
    const normalizedVersion = version.toLowerCase();

    // Insert library if not exists
    await this.query(
      "INSERT INTO libraries (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
      [normalizedLibrary],
    );

    // Get library id
    const libRow = await this.queryOne<{ id: number }>(
      "SELECT id FROM libraries WHERE name = $1",
      [normalizedLibrary],
    );
    if (!libRow) {
      throw new StoreError(`Failed to resolve library_id for library: ${library}`);
    }
    const libraryId = libRow.id;

    // Insert version if not exists
    await this.query(
      "INSERT INTO versions (library_id, name, status) VALUES ($1, $2, 'not_indexed') ON CONFLICT (library_id, name) DO NOTHING",
      [libraryId, normalizedVersion],
    );

    // Get version id
    const verRow = await this.queryOne<{ id: number }>(
      "SELECT id FROM versions WHERE library_id = $1 AND name = $2",
      [libraryId, normalizedVersion],
    );
    if (!verRow) {
      throw new StoreError(
        `Failed to resolve version_id for library: ${library}, version: ${version}`,
      );
    }

    return verRow.id;
  }

  async queryUniqueVersions(library: string): Promise<string[]> {
    try {
      const rows = await this.query<{ name: string | null }>(
        `SELECT DISTINCT v.name
         FROM versions v
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1
         ORDER BY v.name`,
        [library.toLowerCase()],
      );
      return rows.map((row) => normalizeVersionName(row.name));
    } catch (error) {
      throw new ConnectionError("Failed to query versions", error);
    }
  }

  async getVersionById(versionId: number): Promise<DbVersion | null> {
    try {
      const row = await this.queryOne<DbVersion>("SELECT * FROM versions WHERE id = $1", [
        versionId,
      ]);
      return row;
    } catch (error) {
      throw new StoreError(`Failed to get version by ID: ${error}`);
    }
  }

  async getLibraryById(libraryId: number): Promise<{ id: number; name: string } | null> {
    try {
      const row = await this.queryOne<{ id: number; name: string }>(
        "SELECT id, name FROM libraries WHERE id = $1",
        [libraryId],
      );
      return row;
    } catch (error) {
      throw new StoreError(`Failed to get library by ID: ${error}`);
    }
  }

  async getLibrary(name: string): Promise<{ id: number; name: string } | null> {
    try {
      const normalizedName = name.toLowerCase();
      const row = await this.queryOne<{ id: number }>(
        "SELECT id FROM libraries WHERE name = $1",
        [normalizedName],
      );
      if (!row) return null;
      return { id: row.id, name: normalizedName };
    } catch (error) {
      throw new StoreError(`Failed to get library by name: ${error}`);
    }
  }

  async deleteLibrary(libraryId: number): Promise<void> {
    try {
      await this.query("DELETE FROM libraries WHERE id = $1", [libraryId]);
    } catch (error) {
      throw new StoreError(`Failed to delete library: ${error}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Version status & progress
  // ---------------------------------------------------------------------------

  async updateVersionStatus(
    versionId: number,
    status: VersionStatus,
    errorMessage?: string,
  ): Promise<void> {
    try {
      await this.query(
        "UPDATE versions SET status = $1, error_message = $2, updated_at = now() WHERE id = $3",
        [status, errorMessage ?? null, versionId],
      );
    } catch (error) {
      throw new StoreError(`Failed to update version status: ${error}`);
    }
  }

  async updateVersionProgress(
    versionId: number,
    pages: number,
    maxPages: number,
  ): Promise<void> {
    try {
      await this.query(
        "UPDATE versions SET progress_pages = $1, progress_max_pages = $2, updated_at = now() WHERE id = $3",
        [pages, maxPages, versionId],
      );
    } catch (error) {
      throw new StoreError(`Failed to update version progress: ${error}`);
    }
  }

  async getVersionsByStatus(statuses: VersionStatus[]): Promise<DbVersionWithLibrary[]> {
    try {
      const rows = await this.query<DbVersionWithLibrary>(
        `SELECT v.*, l.name as library_name
         FROM versions v
         JOIN libraries l ON v.library_id = l.id
         WHERE v.status = ANY($1::text[])`,
        [statuses],
      );
      return rows;
    } catch (error) {
      throw new StoreError(`Failed to get versions by status: ${error}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Scraper options
  // ---------------------------------------------------------------------------

  async storeScraperOptions(versionId: number, options: ScraperOptions): Promise<void> {
    try {
      const {
        url: source_url,
        library: _library,
        version: _version,
        signal: _signal,
        initialQueue: _initialQueue,
        isRefresh: _isRefresh,
        ...scraper_options
      } = options;

      await this.query(
        "UPDATE versions SET source_url = $1, scraper_options = $2::jsonb, updated_at = now() WHERE id = $3",
        [source_url, JSON.stringify(scraper_options), versionId],
      );
    } catch (error) {
      throw new StoreError(`Failed to store scraper options: ${error}`);
    }
  }

  async getScraperOptions(versionId: number): Promise<StoredScraperOptions | null> {
    try {
      const row = await this.queryOne<DbVersion>("SELECT * FROM versions WHERE id = $1", [
        versionId,
      ]);

      if (!row?.source_url) {
        return null;
      }

      // In PostgreSQL, JSONB comes back as a parsed object, not a string
      let parsed: VersionScraperOptions = {} as VersionScraperOptions;
      if (row.scraper_options) {
        if (typeof row.scraper_options === "string") {
          try {
            parsed = JSON.parse(row.scraper_options) as VersionScraperOptions;
          } catch (e) {
            logger.warn(`⚠️  Invalid scraper_options JSON for version ${versionId}: ${e}`);
            parsed = {} as VersionScraperOptions;
          }
        } else {
          parsed = row.scraper_options as unknown as VersionScraperOptions;
        }
      }

      return { sourceUrl: row.source_url, options: parsed };
    } catch (error) {
      throw new StoreError(`Failed to get scraper options: ${error}`);
    }
  }

  async findVersionsBySourceUrl(url: string): Promise<DbVersionWithLibrary[]> {
    try {
      const rows = await this.query<DbVersionWithLibrary>(
        `SELECT v.*, l.name as library_name
         FROM versions v
         JOIN libraries l ON v.library_id = l.id
         WHERE v.source_url = $1
         ORDER BY v.created_at DESC`,
        [url],
      );
      return rows;
    } catch (error) {
      throw new StoreError(`Failed to find versions by source URL: ${error}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Document existence & listing
  // ---------------------------------------------------------------------------

  async checkDocumentExists(library: string, version: string): Promise<boolean> {
    try {
      const row = await this.queryOne(
        `SELECT d.id FROM documents d
         JOIN pages p ON d.page_id = p.id
         JOIN versions v ON p.version_id = v.id
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1 AND v.name = $2
         LIMIT 1`,
        [library.toLowerCase(), version.toLowerCase()],
      );
      return row !== null;
    } catch (error) {
      throw new ConnectionError("Failed to check document existence", error);
    }
  }

  async queryLibraryVersions(): Promise<
    Map<
      string,
      Array<{
        version: string;
        versionId: number;
        status: VersionStatus;
        progressPages: number;
        progressMaxPages: number;
        sourceUrl: string | null;
        documentCount: number;
        uniqueUrlCount: number;
        indexedAt: string | null;
      }>
    >
  > {
    try {
      const rows = await this.query<DbLibraryVersion>(
        `SELECT l.name as library,
                COALESCE(v.name, '') as version,
                v.id as "versionId",
                v.status as status,
                v.progress_pages as "progressPages",
                v.progress_max_pages as "progressMaxPages",
                v.source_url as "sourceUrl",
                MIN(p.created_at) as "indexedAt",
                COUNT(d.id) as "documentCount",
                COUNT(DISTINCT p.url) as "uniqueUrlCount"
         FROM versions v
         JOIN libraries l ON v.library_id = l.id
         LEFT JOIN pages p ON p.version_id = v.id
         LEFT JOIN documents d ON d.page_id = p.id
         GROUP BY v.id, l.name, v.name, v.status, v.progress_pages, v.progress_max_pages, v.source_url
         ORDER BY l.name, version`,
      );

      const libraryMap = new Map<
        string,
        Array<{
          version: string;
          versionId: number;
          status: VersionStatus;
          progressPages: number;
          progressMaxPages: number;
          sourceUrl: string | null;
          documentCount: number;
          uniqueUrlCount: number;
          indexedAt: string | null;
        }>
      >();

      for (const row of rows) {
        const library = row.library;
        if (!libraryMap.has(library)) {
          libraryMap.set(library, []);
        }

        const indexedAtISO = row.indexedAt ? new Date(row.indexedAt).toISOString() : null;

        libraryMap.get(library)?.push({
          version: row.version,
          versionId: Number(row.versionId),
          status: row.status,
          progressPages: Number(row.progressPages),
          progressMaxPages: Number(row.progressMaxPages),
          sourceUrl: row.sourceUrl,
          documentCount: Number(row.documentCount),
          uniqueUrlCount: Number(row.uniqueUrlCount),
          indexedAt: indexedAtISO,
        });
      }

      // Sort versions within each library: descending (latest first)
      for (const versions of libraryMap.values()) {
        versions.sort((a, b) => compareVersionsDescending(a.version, b.version));
      }

      return libraryMap;
    } catch (error) {
      throw new ConnectionError("Failed to query library versions", error);
    }
  }

  // ---------------------------------------------------------------------------
  // Document CRUD
  // ---------------------------------------------------------------------------

  async addDocuments(
    library: string,
    version: string,
    depth: number,
    result: ScrapeResult,
  ): Promise<void> {
    try {
      const { title, url, chunks } = result;
      if (chunks.length === 0) {
        return;
      }

      // Generate embeddings in batch if vector search is enabled
      let paddedEmbeddings: number[][] = [];

      if (this.isVectorSearchEnabled) {
        const texts = chunks.map((chunk) => {
          const header = `<title>${title}</title>\n<url>${url}</url>\n<path>${(chunk.section.path || []).join(" / ")}</path>\n`;
          return `${header}${chunk.content}`;
        });

        for (let i = 0; i < chunks.length; i++) {
          const bodySize = chunks[i].content.length;
          if (bodySize > this.splitterMaxChunkSize) {
            logger.warn(
              `⚠️  Chunk ${i + 1}/${chunks.length} body exceeds max size: ${bodySize} > ${this.splitterMaxChunkSize} chars (URL: ${url})`,
            );
          }
        }

        const maxBatchChars = this.embeddingBatchChars;
        const rawEmbeddings: number[][] = [];
        let currentBatch: string[] = [];
        let currentBatchSize = 0;
        let batchCount = 0;

        for (const text of texts) {
          const textSize = text.length;

          if (currentBatchSize + textSize > maxBatchChars && currentBatch.length > 0) {
            batchCount++;
            logger.debug(
              `Processing embedding batch ${batchCount}: ${currentBatch.length} texts, ${currentBatchSize} chars`,
            );
            const batchEmbeddings = await this.embedDocumentsWithRetry(currentBatch);
            rawEmbeddings.push(...batchEmbeddings);
            currentBatch = [];
            currentBatchSize = 0;
          }

          currentBatch.push(text);
          currentBatchSize += textSize;

          if (currentBatch.length >= this.embeddingBatchSize) {
            batchCount++;
            logger.debug(
              `Processing embedding batch ${batchCount}: ${currentBatch.length} texts, ${currentBatchSize} chars`,
            );
            const batchEmbeddings = await this.embedDocumentsWithRetry(currentBatch);
            rawEmbeddings.push(...batchEmbeddings);
            currentBatch = [];
            currentBatchSize = 0;
          }
        }

        if (currentBatch.length > 0) {
          batchCount++;
          logger.debug(
            `Processing final embedding batch ${batchCount}: ${currentBatch.length} texts, ${currentBatchSize} chars`,
          );
          const batchEmbeddings = await this.embedDocumentsWithRetry(currentBatch);
          rawEmbeddings.push(...batchEmbeddings);
        }

        paddedEmbeddings = rawEmbeddings.map((vector) => this.padVector(vector));
      }

      // Resolve library and version IDs
      const versionId = await this.resolveVersionId(library, version);

      const sourceContentType = result.sourceContentType || result.contentType || null;
      const contentType = result.contentType || result.sourceContentType || null;
      const etag = result.etag || null;
      const lastModified = result.lastModified || null;

      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");

        // Delete existing documents for this page (if it exists)
        const existingPageRow = await client.query<{ id: number }>(
          "SELECT id FROM pages WHERE version_id = $1 AND url = $2",
          [versionId, url],
        );
        if (existingPageRow.rows.length > 0) {
          const existingPageId = existingPageRow.rows[0].id;
          const delResult = await client.query(
            "DELETE FROM documents WHERE page_id = $1",
            [existingPageId],
          );
          if (delResult.rowCount && delResult.rowCount > 0) {
            logger.debug(
              `Deleted ${delResult.rowCount} existing documents for URL: ${url}`,
            );
          }
        }

        // Upsert page record and get its id
        const pageResult = await client.query<{ id: number }>(
          `INSERT INTO pages (version_id, url, title, etag, last_modified, source_content_type, content_type, depth)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (version_id, url) DO UPDATE
             SET title = EXCLUDED.title,
                 etag = EXCLUDED.etag,
                 last_modified = EXCLUDED.last_modified,
                 source_content_type = EXCLUDED.source_content_type,
                 content_type = EXCLUDED.content_type,
                 depth = EXCLUDED.depth
           RETURNING id`,
          [
            versionId,
            url,
            title || "",
            etag,
            lastModified,
            sourceContentType,
            contentType,
            depth,
          ],
        );

        if (pageResult.rows.length === 0) {
          throw new StoreError(`Failed to get page ID for URL: ${url}`);
        }
        const pageId = pageResult.rows[0].id;

        // Insert document chunks
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const metadataObj: DbChunkMetadata = {
            types: chunk.types,
            level: chunk.section.level,
            path: chunk.section.path,
          };
          const metadataJson = JSON.stringify(metadataObj);

          if (this.isVectorSearchEnabled && paddedEmbeddings.length > 0) {
            const vectorStr = this.serializeVector(paddedEmbeddings[i]);
            const pathStr = (chunk.section.path || []).join(" ");

            await client.query(
              `INSERT INTO documents (page_id, content, metadata, sort_order, embedding, fts_vector)
               VALUES ($1, $2, $3::jsonb, $4, $5::vector,
                 setweight(to_tsvector('multilingual', coalesce($6, '')), 'A') ||
                 setweight(to_tsvector('multilingual', coalesce($7, '')), 'B') ||
                 setweight(to_tsvector('multilingual', coalesce($8, '')), 'C'))`,
              [
                pageId,
                chunk.content,
                metadataJson,
                i,
                vectorStr,
                title || "",
                pathStr,
                chunk.content,
              ],
            );
          } else {
            const pathStr = (chunk.section.path || []).join(" ");
            await client.query(
              `INSERT INTO documents (page_id, content, metadata, sort_order, fts_vector)
               VALUES ($1, $2, $3::jsonb, $4,
                 setweight(to_tsvector('multilingual', coalesce($5, '')), 'A') ||
                 setweight(to_tsvector('multilingual', coalesce($6, '')), 'B') ||
                 setweight(to_tsvector('multilingual', coalesce($7, '')), 'C'))`,
              [
                pageId,
                chunk.content,
                metadataJson,
                i,
                title || "",
                pathStr,
                chunk.content,
              ],
            );
          }
        }

        await client.query("COMMIT");
      } catch (txError) {
        await client.query("ROLLBACK");
        throw txError;
      } finally {
        client.release();
      }
    } catch (error) {
      throw new ConnectionError("Failed to add documents to store", error);
    }
  }

  async deletePages(library: string, version: string): Promise<number> {
    try {
      const normalizedLibrary = library.toLowerCase();
      const normalizedVersion = version.toLowerCase();

      // Delete documents first
      const docResult = await this.query<{ count: string }>(
        `WITH deleted AS (
           DELETE FROM documents
           WHERE page_id IN (
             SELECT p.id FROM pages p
             JOIN versions v ON p.version_id = v.id
             JOIN libraries l ON v.library_id = l.id
             WHERE l.name = $1 AND v.name = $2
           )
           RETURNING id
         )
         SELECT COUNT(*) as count FROM deleted`,
        [normalizedLibrary, normalizedVersion],
      );

      const deletedCount = Number(docResult[0]?.count ?? 0);

      // Then delete pages
      await this.query(
        `DELETE FROM pages
         WHERE version_id IN (
           SELECT v.id FROM versions v
           JOIN libraries l ON v.library_id = l.id
           WHERE l.name = $1 AND v.name = $2
         )`,
        [normalizedLibrary, normalizedVersion],
      );

      return deletedCount;
    } catch (error) {
      throw new ConnectionError("Failed to delete documents", error);
    }
  }

  async deletePage(pageId: number): Promise<void> {
    try {
      await this.query("DELETE FROM documents WHERE page_id = $1", [pageId]);
      logger.debug(`Deleted documents for page ID ${pageId}`);

      await this.query("DELETE FROM pages WHERE id = $1", [pageId]);
      logger.debug(`Deleted page record for page ID ${pageId}`);
    } catch (error) {
      throw new ConnectionError(`Failed to delete page ${pageId}`, error);
    }
  }

  async getPagesByVersionId(versionId: number): Promise<DbPage[]> {
    try {
      const rows = await this.query<DbPage>("SELECT * FROM pages WHERE version_id = $1", [
        versionId,
      ]);
      return rows;
    } catch (error) {
      throw new ConnectionError("Failed to get pages by version ID", error);
    }
  }

  async removeVersion(
    library: string,
    version: string,
    removeLibraryIfEmpty = true,
  ): Promise<{
    documentsDeleted: number;
    versionDeleted: boolean;
    libraryDeleted: boolean;
  }> {
    try {
      const normalizedLibrary = library.toLowerCase();
      const normalizedVersion = version.toLowerCase();

      // Get version and library IDs
      const versionRow = await this.queryOne<{ id: number; library_id: number }>(
        `SELECT v.id, v.library_id FROM versions v
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1 AND v.name = $2`,
        [normalizedLibrary, normalizedVersion],
      );

      if (!versionRow) {
        return { documentsDeleted: 0, versionDeleted: false, libraryDeleted: false };
      }

      const { id: versionId, library_id: libraryId } = versionRow;

      // Delete documents and pages
      const documentsDeleted = await this.deletePages(library, version);

      // Delete the version record
      const verDelResult = await this.query("DELETE FROM versions WHERE id = $1", [
        versionId,
      ]);
      const rowCount = (verDelResult as unknown as pg.QueryResult).rowCount;
      const versionDeleted = rowCount != null ? rowCount > 0 : true;

      let libraryDeleted = false;

      if (removeLibraryIfEmpty && versionDeleted) {
        const countRow = await this.queryOne<{ count: string }>(
          "SELECT COUNT(*) as count FROM versions WHERE library_id = $1",
          [libraryId],
        );
        const remainingVersions = Number(countRow?.count ?? 0);

        if (remainingVersions === 0) {
          await this.query("DELETE FROM libraries WHERE id = $1", [libraryId]);
          libraryDeleted = true;
        }
      }

      return { documentsDeleted, versionDeleted, libraryDeleted };
    } catch (error) {
      throw new ConnectionError("Failed to remove version", error);
    }
  }

  // ---------------------------------------------------------------------------
  // Document retrieval
  // ---------------------------------------------------------------------------

  private normalizeChunkRow<T extends { id: unknown; metadata: unknown }>(row: T): T {
    return {
      ...row,
      id: String(row.id),
      metadata:
        row.metadata && typeof row.metadata === "string"
          ? (() => {
              try {
                return JSON.parse(row.metadata as string);
              } catch {
                return {};
              }
            })()
          : (row.metadata ?? {}),
    };
  }

  private normalizeChunkRows<T extends { id: unknown; metadata: unknown }>(
    rows: T[],
  ): T[] {
    return rows.map((row) => this.normalizeChunkRow(row));
  }

  async getById(id: string): Promise<DbPageChunk | null> {
    try {
      const row = await this.queryOne<DbPageChunk>(
        `SELECT d.id::text, d.page_id, d.content, d.metadata, d.sort_order, d.embedding, d.created_at,
                p.url, p.title, p.source_content_type, p.content_type
         FROM documents d
         JOIN pages p ON d.page_id = p.id
         WHERE d.id = $1::bigint`,
        [id],
      );
      if (!row) return null;
      return this.normalizeChunkRow(row);
    } catch (error) {
      throw new ConnectionError(`Failed to get document by ID ${id}`, error);
    }
  }

  async findByContent(
    library: string,
    version: string,
    query: string,
    limit: number,
  ): Promise<(DbPageChunk & DbChunkRank)[]> {
    try {
      if (!query || typeof query !== "string" || query.trim().length === 0) {
        return [];
      }

      const normalizedLibrary = library.toLowerCase();
      const normalizedVersion = version.toLowerCase();

      if (this.isVectorSearchEnabled) {
        const rawEmbedding = await this.embeddings.embedQuery(query);
        const embedding = this.padVector(rawEmbedding);
        const vectorStr = this.serializeVector(embedding);

        const overfetchLimit = Math.max(1, limit * this.searchOverfetchFactor);
        const vectorSearchK = overfetchLimit * this.vectorSearchMultiplier;

        const sql = `
          WITH vector_results AS (
            SELECT d.id, 1 - (d.embedding <=> $1::vector) as vec_score
            FROM documents d
            JOIN pages p ON d.page_id = p.id
            JOIN versions v ON p.version_id = v.id
            JOIN libraries l ON v.library_id = l.id
            WHERE l.name = $2 AND v.name = $3
              AND d.embedding IS NOT NULL
            ORDER BY d.embedding <=> $1::vector
            LIMIT $4
          ),
          fts_results AS (
            SELECT d.id, ts_rank_cd(d.fts_vector, plainto_tsquery('multilingual', $5)) as fts_score
            FROM documents d
            JOIN pages p ON d.page_id = p.id
            JOIN versions v ON p.version_id = v.id
            JOIN libraries l ON v.library_id = l.id
            WHERE l.name = $2 AND v.name = $3
              AND d.fts_vector @@ plainto_tsquery('multilingual', $5)
            LIMIT $6
          )
          SELECT d.id::text, d.page_id, d.content, d.metadata, d.sort_order, d.created_at,
                 p.url, p.title, p.source_content_type, p.content_type,
                 COALESCE(vr.vec_score, 0) as vec_score,
                 COALESCE(fr.fts_score, 0) as fts_score
          FROM documents d
          JOIN pages p ON d.page_id = p.id
          JOIN versions v ON p.version_id = v.id
          JOIN libraries l ON v.library_id = l.id
          LEFT JOIN vector_results vr ON d.id = vr.id
          LEFT JOIN fts_results fr ON d.id = fr.id
          WHERE (vr.id IS NOT NULL OR fr.id IS NOT NULL)
            AND NOT (d.metadata->'types' @> '["structural"]'::jsonb)
        `;

        const rawResults = await this.query<RawSearchResult>(sql, [
          vectorStr,
          normalizedLibrary,
          normalizedVersion,
          vectorSearchK,
          query,
          overfetchLimit,
        ]);

        // Zero out vec_score if it came back as 0 and wasn't in vector_results
        // (to distinguish it from a real result). Keep both scores as-is for RRF.
        const rankedResults = this.assignRanks(rawResults);

        const topResults = rankedResults
          .sort((a, b) => b.rrf_score - a.rrf_score)
          .slice(0, limit);

        return topResults.map((row) => {
          const chunk = this.normalizeChunkRow({
            ...row,
            url: row.url || "",
            title: row.title ?? null,
            source_content_type: row.source_content_type ?? null,
            content_type: row.content_type ?? null,
          }) as DbPageChunk;
          return Object.assign(chunk, {
            score: row.rrf_score,
            vec_rank: row.vec_rank,
            fts_rank: row.fts_rank,
          });
        });
      } else {
        // FTS-only fallback
        const sql = `
          SELECT d.id::text, d.page_id, d.content, d.metadata, d.sort_order, d.created_at,
                 p.url, p.title, p.source_content_type, p.content_type,
                 ts_rank_cd(d.fts_vector, plainto_tsquery('multilingual', $1)) as fts_score
          FROM documents d
          JOIN pages p ON d.page_id = p.id
          JOIN versions v ON p.version_id = v.id
          JOIN libraries l ON v.library_id = l.id
          WHERE l.name = $2 AND v.name = $3
            AND d.fts_vector @@ plainto_tsquery('multilingual', $1)
            AND NOT (d.metadata->'types' @> '["structural"]'::jsonb)
          ORDER BY fts_score DESC
          LIMIT $4
        `;

        const rawResults = await this.query<RawSearchResult & { fts_score: number }>(
          sql,
          [query, normalizedLibrary, normalizedVersion, limit],
        );

        return rawResults.map((row, index) => {
          const chunk = this.normalizeChunkRow({
            ...row,
            url: row.url || "",
            title: row.title ?? null,
            source_content_type: row.source_content_type ?? null,
            content_type: row.content_type ?? null,
          }) as DbPageChunk;
          return Object.assign(chunk, {
            score: row.fts_score,
            fts_rank: index + 1,
          });
        });
      }
    } catch (error) {
      throw new ConnectionError(
        `Failed to find documents by content with query "${query}"`,
        error,
      );
    }
  }

  async findChildChunks(
    library: string,
    version: string,
    id: string,
    limit: number,
  ): Promise<DbPageChunk[]> {
    try {
      const parent = await this.getById(id);
      if (!parent) return [];

      const parentPath = parent.metadata.path ?? [];
      const normalizedVersion = version.toLowerCase();

      const rows = await this.query<DbPageChunk>(
        `SELECT d.id::text, d.page_id, d.content, d.metadata, d.sort_order, d.created_at,
                p.url, p.title, p.source_content_type, p.content_type
         FROM documents d
         JOIN pages p ON d.page_id = p.id
         JOIN versions v ON p.version_id = v.id
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1 AND v.name = $2 AND p.url = $3
           AND jsonb_array_length(d.metadata->'path') = $4
           AND d.metadata->>'path' LIKE $5 || '%'
           AND d.sort_order > (SELECT sort_order FROM documents WHERE id = $6::bigint)
         ORDER BY d.sort_order
         LIMIT $7`,
        [
          library.toLowerCase(),
          normalizedVersion,
          parent.url,
          parentPath.length + 1,
          JSON.stringify(parentPath),
          id,
          limit,
        ],
      );

      return this.normalizeChunkRows(rows);
    } catch (error) {
      throw new ConnectionError(`Failed to find child chunks for ID ${id}`, error);
    }
  }

  async findPrecedingSiblingChunks(
    library: string,
    version: string,
    id: string,
    limit: number,
  ): Promise<DbPageChunk[]> {
    try {
      const reference = await this.getById(id);
      if (!reference) return [];

      const normalizedVersion = version.toLowerCase();

      const rows = await this.query<DbPageChunk>(
        `SELECT d.id::text, d.page_id, d.content, d.metadata, d.sort_order, d.created_at,
                p.url, p.title, p.source_content_type, p.content_type
         FROM documents d
         JOIN pages p ON d.page_id = p.id
         JOIN versions v ON p.version_id = v.id
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1 AND v.name = $2 AND p.url = $3
           AND d.sort_order < (SELECT sort_order FROM documents WHERE id = $4::bigint)
           AND d.metadata->'path' = $5::jsonb
         ORDER BY d.sort_order DESC
         LIMIT $6`,
        [
          library.toLowerCase(),
          normalizedVersion,
          reference.url,
          id,
          JSON.stringify(reference.metadata.path),
          limit,
        ],
      );

      return this.normalizeChunkRows(rows).reverse();
    } catch (error) {
      throw new ConnectionError(
        `Failed to find preceding sibling chunks for ID ${id}`,
        error,
      );
    }
  }

  async findSubsequentSiblingChunks(
    library: string,
    version: string,
    id: string,
    limit: number,
  ): Promise<DbPageChunk[]> {
    try {
      const reference = await this.getById(id);
      if (!reference) return [];

      const normalizedVersion = version.toLowerCase();

      const rows = await this.query<DbPageChunk>(
        `SELECT d.id::text, d.page_id, d.content, d.metadata, d.sort_order, d.created_at,
                p.url, p.title, p.source_content_type, p.content_type
         FROM documents d
         JOIN pages p ON d.page_id = p.id
         JOIN versions v ON p.version_id = v.id
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1 AND v.name = $2 AND p.url = $3
           AND d.sort_order > (SELECT sort_order FROM documents WHERE id = $4::bigint)
           AND d.metadata->'path' = $5::jsonb
         ORDER BY d.sort_order
         LIMIT $6`,
        [
          library.toLowerCase(),
          normalizedVersion,
          reference.url,
          id,
          JSON.stringify(reference.metadata.path),
          limit,
        ],
      );

      return this.normalizeChunkRows(rows);
    } catch (error) {
      throw new ConnectionError(
        `Failed to find subsequent sibling chunks for ID ${id}`,
        error,
      );
    }
  }

  async findParentChunk(
    library: string,
    version: string,
    id: string,
  ): Promise<DbPageChunk | null> {
    try {
      const child = await this.getById(id);
      if (!child) return null;

      const childPath = child.metadata.path ?? [];
      const parentPath = childPath.slice(0, -1);

      if (parentPath.length === 0) return null;

      const normalizedVersion = version.toLowerCase();

      const row = await this.queryOne<DbPageChunk>(
        `SELECT d.id::text, d.page_id, d.content, d.metadata, d.sort_order, d.created_at,
                p.url, p.title, p.source_content_type, p.content_type
         FROM documents d
         JOIN pages p ON d.page_id = p.id
         JOIN versions v ON p.version_id = v.id
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1 AND v.name = $2 AND p.url = $3
           AND d.metadata->'path' = $4::jsonb
           AND d.sort_order < (SELECT sort_order FROM documents WHERE id = $5::bigint)
         ORDER BY d.sort_order DESC
         LIMIT 1`,
        [
          library.toLowerCase(),
          normalizedVersion,
          child.url,
          JSON.stringify(parentPath),
          id,
        ],
      );

      if (!row) return null;
      return this.normalizeChunkRow(row);
    } catch (error) {
      logger.warn(`Failed to find parent chunk for ID ${id}: ${error}`);
      return null;
    }
  }

  async findChunksByIds(
    library: string,
    version: string,
    ids: string[],
  ): Promise<DbPageChunk[]> {
    if (!ids.length) return [];
    try {
      const normalizedVersion = version.toLowerCase();
      const bigintIds = ids.map((id) => BigInt(id));

      const rows = await this.query<DbPageChunk>(
        `SELECT d.id::text, d.page_id, d.content, d.metadata, d.sort_order, d.created_at,
                p.url, p.title, p.source_content_type, p.content_type
         FROM documents d
         JOIN pages p ON d.page_id = p.id
         JOIN versions v ON p.version_id = v.id
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1 AND v.name = $2
           AND d.id = ANY($3::bigint[])
         ORDER BY d.sort_order`,
        [library.toLowerCase(), normalizedVersion, bigintIds],
      );

      return this.normalizeChunkRows(rows);
    } catch (error) {
      throw new ConnectionError("Failed to fetch documents by IDs", error);
    }
  }

  async findChunksByUrl(
    library: string,
    version: string,
    url: string,
  ): Promise<DbPageChunk[]> {
    try {
      const normalizedVersion = version.toLowerCase();

      const rows = await this.query<DbPageChunk>(
        `SELECT d.id::text, d.page_id, d.content, d.metadata, d.sort_order, d.created_at,
                p.url, p.title, p.source_content_type, p.content_type
         FROM documents d
         JOIN pages p ON d.page_id = p.id
         JOIN versions v ON p.version_id = v.id
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1 AND v.name = $2 AND p.url = $3
         ORDER BY d.sort_order`,
        [library.toLowerCase(), normalizedVersion, url],
      );

      return this.normalizeChunkRows(rows);
    } catch (error) {
      throw new ConnectionError(`Failed to fetch documents by URL ${url}`, error);
    }
  }
}
