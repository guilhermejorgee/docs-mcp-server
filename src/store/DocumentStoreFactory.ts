import type { AppConfig } from "../utils/config";
import { StoreError } from "./errors";
import type { IDocumentStore } from "./IDocumentStore";
import { PostgresDocumentStore } from "./PostgresDocumentStore";
import { SqliteDocumentStore } from "./SqliteDocumentStore";

/**
 * Creates the appropriate IDocumentStore implementation based on the configured backend.
 */
export function createDocumentStore(dbPath: string, config: AppConfig): IDocumentStore {
  const backend = config.db.backend ?? "sqlite";

  if (backend === "sqlite") {
    return new SqliteDocumentStore(dbPath, config);
  }

  if (backend === "postgresql") {
    const { connectionString } = config.db.postgresql;
    if (!connectionString) {
      throw new StoreError(
        "PostgreSQL backend requires db.postgresql.connectionString or DATABASE_URL",
      );
    }
    return new PostgresDocumentStore(connectionString, config);
  }

  throw new StoreError(`Unknown database backend: ${backend}`);
}

/** @deprecated Use createDocumentStore() instead */
export const DocumentStoreFactory = {
  create: createDocumentStore,
};
