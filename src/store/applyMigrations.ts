import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { logger } from "../utils/logger";
import { getProjectRoot } from "../utils/paths";
import { StoreError } from "./errors";

// Construct the absolute path to the PostgreSQL migrations directory
const PG_MIGRATIONS_DIR = path.join(getProjectRoot(), "db", "migrations-pg");
const MIGRATIONS_TABLE = "_schema_migrations";

/**
 * Applies pending PostgreSQL migrations from the db/migrations-pg directory.
 * Each migration is executed in its own transaction for atomicity.
 * Migration history is tracked in the _schema_migrations table.
 *
 * @param pool The pg.Pool instance connected to the target database.
 * @throws {StoreError} If any migration fails or pgvector is not installed.
 */
export async function applyMigrationsPg(pool: pg.Pool): Promise<void> {
  const migrationsDir = PG_MIGRATIONS_DIR;

  if (!fs.existsSync(migrationsDir)) {
    throw new StoreError(`PostgreSQL migrations directory not found: ${migrationsDir}`);
  }

  const client = await pool.connect();
  try {
    // Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    // Get already applied migrations
    const { rows: appliedRows } = await client.query<{ id: string }>(
      `SELECT id FROM ${MIGRATIONS_TABLE}`,
    );
    const appliedMigrations = new Set(appliedRows.map((r) => r.id));

    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    const pendingMigrations = migrationFiles.filter(
      (filename) => !appliedMigrations.has(filename),
    );

    if (pendingMigrations.length > 0) {
      logger.info(`🔄 Applying ${pendingMigrations.length} PostgreSQL migration(s)...`);
    }

    for (const filename of pendingMigrations) {
      logger.debug(`Applying PostgreSQL migration: ${filename}`);
      const filePath = path.join(migrationsDir, filename);
      const sql = fs.readFileSync(filePath, "utf8");

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (id) VALUES ($1)`, [
          filename,
        ]);
        await client.query("COMMIT");
        logger.debug(`Applied PostgreSQL migration: ${filename}`);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        logger.error(`❌ Failed to apply PostgreSQL migration: ${filename} - ${error}`);
        throw new StoreError(`PostgreSQL migration failed: ${filename}`, error);
      }
    }

    if (pendingMigrations.length > 0) {
      logger.info(
        `✅ Successfully applied ${pendingMigrations.length} PostgreSQL migration(s)`,
      );

      // Validate pgvector extension after migrations
      const { rows: extRows } = await client.query(
        "SELECT * FROM pg_extension WHERE extname = 'vector'",
      );
      if (extRows.length === 0) {
        throw new StoreError(
          "pgvector extension not found. Install it and run: CREATE EXTENSION vector;",
        );
      }
    } else {
      logger.debug("PostgreSQL schema is up to date");
    }
  } finally {
    client.release();
  }
}
