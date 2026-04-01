import type { Embeddings } from "@langchain/core/embeddings";
import type { ScrapeResult, ScraperOptions } from "../scraper/types";
import type { EmbeddingModelConfig } from "./embeddings/EmbeddingConfig";
import type {
  DbChunkRank,
  DbPage,
  DbPageChunk,
  DbVersion,
  DbVersionWithLibrary,
  LibrarySuggestion,
  StoredScraperOptions,
  VersionStatus,
} from "./types";

/**
 * Public interface for a document store backend.
 * Implemented by PostgresDocumentStore.
 */
export interface IDocumentStore {
  getActiveEmbeddingConfig(): EmbeddingModelConfig | null;
  getEmbeddingModel(): Embeddings | null;

  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  // Library / version resolution
  resolveVersionId(
    library: string,
    version: string,
    description?: string | null,
  ): Promise<number>;
  queryUniqueVersions(library: string): Promise<string[]>;
  getVersionById(versionId: number): Promise<DbVersion | null>;
  getLibraryById(libraryId: number): Promise<{ id: number; name: string } | null>;
  getLibrary(
    name: string,
  ): Promise<{ id: number; name: string; description: string | null } | null>;
  findLibraries(query: string, limit: number): Promise<LibrarySuggestion[]>;
  deleteLibrary(libraryId: number): Promise<void>;

  // Version status & progress
  updateVersionStatus(
    versionId: number,
    status: VersionStatus,
    errorMessage?: string,
  ): Promise<void>;
  updateVersionProgress(
    versionId: number,
    pages: number,
    maxPages: number,
  ): Promise<void>;
  getVersionsByStatus(statuses: VersionStatus[]): Promise<DbVersionWithLibrary[]>;

  // Scraper options
  storeScraperOptions(versionId: number, options: ScraperOptions): Promise<void>;
  getScraperOptions(versionId: number): Promise<StoredScraperOptions | null>;
  findVersionsBySourceUrl(url: string): Promise<DbVersionWithLibrary[]>;

  // Document existence & listing
  checkDocumentExists(library: string, version: string): Promise<boolean>;
  queryLibraryVersions(): Promise<
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
        description: string | null;
      }>
    >
  >;

  // Document CRUD
  addDocuments(
    library: string,
    version: string,
    depth: number,
    result: ScrapeResult,
  ): Promise<void>;
  deletePages(library: string, version: string): Promise<number>;
  deletePage(pageId: number): Promise<void>;
  getPagesByVersionId(versionId: number): Promise<DbPage[]>;
  removeVersion(
    library: string,
    version: string,
    removeLibraryIfEmpty?: boolean,
  ): Promise<{
    documentsDeleted: number;
    versionDeleted: boolean;
    libraryDeleted: boolean;
  }>;

  // Document retrieval
  getById(id: string): Promise<DbPageChunk | null>;
  findByContent(
    library: string,
    version: string,
    query: string,
    limit: number,
  ): Promise<(DbPageChunk & DbChunkRank)[]>;
  findChildChunks(
    library: string,
    version: string,
    id: string,
    limit: number,
  ): Promise<DbPageChunk[]>;
  findPrecedingSiblingChunks(
    library: string,
    version: string,
    id: string,
    limit: number,
  ): Promise<DbPageChunk[]>;
  findSubsequentSiblingChunks(
    library: string,
    version: string,
    id: string,
    limit: number,
  ): Promise<DbPageChunk[]>;
  findParentChunk(
    library: string,
    version: string,
    id: string,
  ): Promise<DbPageChunk | null>;
  findChunksByIds(
    library: string,
    version: string,
    ids: string[],
  ): Promise<DbPageChunk[]>;
  findChunksByUrl(library: string, version: string, url: string): Promise<DbPageChunk[]>;
}
