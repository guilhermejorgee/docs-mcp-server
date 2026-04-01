import { createSecretProvider } from "../secrets";
import type { AppConfig } from "../utils/config";
import { StoreError } from "./errors";
import type { IDocumentStore } from "./IDocumentStore";
import { PostgresDocumentStore } from "./PostgresDocumentStore";

/**
 * Creates the PostgreSQL-backed IDocumentStore implementation.
 */
export function createDocumentStore(config: AppConfig): IDocumentStore {
  const { connectionString } = config.db.postgresql;
  if (!connectionString) {
    throw new StoreError(
      "PostgreSQL backend requires db.postgresql.connectionString or DATABASE_URL",
    );
  }
  const secretProvider = createSecretProvider(config.secrets);
  return new PostgresDocumentStore(connectionString, config, secretProvider);
}

/** @deprecated Use createDocumentStore() instead */
export const DocumentStoreFactory = {
  create: createDocumentStore,
};
