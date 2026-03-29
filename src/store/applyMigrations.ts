import fs from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import type pg from "pg";
import { logger } from "../utils/logger";
import { getProjectRoot } from "../utils/paths";
import { StoreError } from "./errors";

// Construct the absolute path to the migrations directory using the project root
const SQLITE_MIGRATIONS_DIR = path.join(getProjectRoot(), "db", "migrations");
const PG_MIGRATIONS_DIR = path.join(getProjectRoot(), "db", "migrations-pg");
const MIGRATIONS_TABLE = "_schema_migrations";

// Keep backward-compat alias
const MIGRATIONS_DIR = SQLITE_MIGRATIONS_DIR;

/**
 * Ensures the migration tracking table exists in the database.
 * @param db The database instance.
 */
function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id TEXT PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/**
 * Retrieves the set of already applied migration IDs (filenames) from the tracking table.
 * @param db The database instance.
 * @returns A Set containing the IDs of applied migrations.
 */
function getAppliedMigrations(db: Database): Set<string> {
  const stmt = db.prepare(`SELECT id FROM ${MIGRATIONS_TABLE}`);
  const rows = stmt.all() as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/**
 * Applies pending database migrations found in the migrations directory.
 * Migrations are expected to be .sql files with sequential prefixes (e.g., 001-, 002-).
 * It tracks applied migrations in the _schema_migrations table.
 *
 * @param db The better-sqlite3 database instance.
 * @param options Optional runtime configuration.
 * @throws {StoreError} If any migration fails.
 */
export async function applyMigrations(
  db: Database,
  options?: {
    maxRetries?: number;
    retryDelayMs?: number;
  },
): Promise<void> {
  const maxRetries = options?.maxRetries ?? 5;
  const retryDelayMs = options?.retryDelayMs ?? 300;
  // Apply performance optimizations for large dataset migrations
  try {
    db.pragma("journal_mode = OFF");
    db.pragma("synchronous = OFF");
    db.pragma("mmap_size = 268435456"); // 256MB memory mapping
    db.pragma("cache_size = -64000"); // 64MB cache (default is ~2MB)
    db.pragma("temp_store = MEMORY"); // Store temporary data in memory
    logger.debug("Applied performance optimizations for migration");
  } catch (_error) {
    logger.warn("⚠️  Could not apply all performance optimizations for migration");
  }

  const overallTransaction = db.transaction(() => {
    logger.debug("Checking database migrations...");
    ensureMigrationsTable(db);
    const appliedMigrations = getAppliedMigrations(db);

    if (!fs.existsSync(MIGRATIONS_DIR)) {
      throw new StoreError("Migrations directory not found");
    }

    const migrationFiles = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql"))
      .sort(); // Sort alphabetically, relying on naming convention (001-, 002-)

    const pendingMigrations = migrationFiles.filter(
      (filename) => !appliedMigrations.has(filename),
    );

    if (pendingMigrations.length > 0) {
      logger.info(`🔄 Applying ${pendingMigrations.length} database migration(s)...`);
    }

    let appliedCount = 0;
    for (const filename of pendingMigrations) {
      logger.debug(`Applying migration: ${filename}`);
      const filePath = path.join(MIGRATIONS_DIR, filename);
      const sql = fs.readFileSync(filePath, "utf8");

      // Execute migration and record it directly within the overall transaction
      try {
        db.exec(sql);
        const insertStmt = db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (id) VALUES (?)`);
        insertStmt.run(filename);
        logger.debug(`Applied migration: ${filename}`);
        appliedCount++;
      } catch (error) {
        logger.error(`❌ Failed to apply migration: ${filename} - ${error}`);
        // Re-throw to ensure the overall transaction rolls back
        throw new StoreError(`Migration failed: ${filename}`, error);
      }
    }

    if (appliedCount > 0) {
      logger.info(`✅ Successfully applied ${appliedCount} migration(s)`);
    } else {
      logger.debug("Database schema is up to date");
    }

    // Return the count of applied migrations so we know if VACUUM is needed
    return appliedCount;
  });

  let retries = 0;
  let appliedMigrationsCount = 0;

  while (true) {
    try {
      // Start a single IMMEDIATE transaction for the entire migration process
      appliedMigrationsCount = overallTransaction.immediate(); // Execute the encompassing transaction
      logger.debug("Database migrations completed successfully");

      // Only run VACUUM if migrations were actually applied
      if (appliedMigrationsCount > 0) {
        try {
          logger.debug(
            `Running VACUUM after applying ${appliedMigrationsCount} migration(s)...`,
          );
          db.exec("VACUUM");
          logger.debug("Database vacuum completed successfully");
        } catch (error) {
          logger.warn(`⚠️  Could not vacuum database after migrations: ${error}`);
          // Don't fail the migration process if vacuum fails
        }
      } else {
        logger.debug("Skipping VACUUM - no migrations were applied");
      }

      break; // Success
    } catch (error) {
      // biome-ignore lint/suspicious/noExplicitAny: error can be any
      if ((error as any)?.code === "SQLITE_BUSY" && retries < maxRetries) {
        retries++;
        logger.warn(
          `⚠️  Migrations busy (SQLITE_BUSY), retrying attempt ${retries}/${maxRetries} in ${retryDelayMs}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: error can be any
        if ((error as any)?.code === "SQLITE_BUSY") {
          logger.error(
            `❌ Migrations still busy after ${maxRetries} retries. Giving up: ${error}`,
          );
        }
        // Ensure StoreError is thrown for consistent handling
        if (error instanceof StoreError) {
          throw error;
        }
        throw new StoreError("Failed during migration process", error);
      }
    }
  }

  // Configure production-ready settings after migrations
  try {
    // Enable WAL mode for better concurrency (allows readers while writing)
    db.pragma("journal_mode = WAL");

    // Configure WAL autocheckpoint to prevent unbounded growth
    db.pragma("wal_autocheckpoint = 1000"); // Checkpoint every 1000 pages (~4MB)

    // Set busy timeout for better handling of concurrent access
    db.pragma("busy_timeout = 30000"); // 30 seconds

    // Enable foreign key constraints for data integrity
    db.pragma("foreign_keys = ON");

    // Set synchronous to NORMAL for good balance of safety and performance
    db.pragma("synchronous = NORMAL");

    logger.debug(
      "Applied production database configuration (WAL mode, autocheckpoint, foreign keys, busy timeout)",
    );
  } catch (_error) {
    logger.warn("⚠️  Could not apply all production database settings");
  }
}

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
