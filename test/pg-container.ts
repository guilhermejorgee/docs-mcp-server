/**
 * Shared helper for PostgreSQL database handles used in tests.
 *
 * When the SHARED_PG_* environment variables are set (by the Vitest
 * globalSetup in test/global-pg-setup.ts), each call to createPgContainer()
 * returns a handle that creates an isolated database inside the globally
 * shared PostgreSQL container instead of starting a separate container.
 * This avoids spinning up 8+ containers simultaneously on memory-constrained
 * hosts while keeping full test isolation via separate databases.
 *
 * When the env vars are absent (e.g. running a single test file directly
 * without the global setup), a standalone container is started as before.
 *
 * Usage:
 *   const container = createPgContainer();
 *
 *   beforeAll(async () => { await container.start(); }, 120_000);
 *   afterAll(async  () => { await container.stop(); });
 *
 *   // Inside tests:
 *   const url = container.connectionString;
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { applyMigrationsPg } from "../src/store/applyMigrations";

export interface PgTestContainer {
  /** Full postgresql:// connection string */
  connectionString: string;
  /** Start the container / create the database and run migrations. Call in beforeAll. */
  start(): Promise<void>;
  /** Truncate all tables so each test starts clean. */
  truncate(): Promise<void>;
  /** Stop and remove the container / drop the database. Call in afterAll. */
  stop(): Promise<void>;
}

/**
 * Creates a PgTestContainer handle. The container is not started until
 * `start()` is called.
 *
 * If SHARED_PG_HOST is set (by globalSetup), a per-test-file database is
 * created inside the shared PostgreSQL instance.  Otherwise a standalone
 * Docker container is spun up.
 */
export function createPgContainer(): PgTestContainer {
  if (process.env.SHARED_PG_HOST) {
    return createSharedDbContainer();
  }
  return createStandaloneContainer();
}

// ---------------------------------------------------------------------------
// Shared-container path (used when globalSetup has already started Postgres)
// ---------------------------------------------------------------------------

function createSharedDbContainer(): PgTestContainer {
  // Unique DB name per test-file worker so there are no cross-file data races.
  const dbName = `test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  const adminConnConfig = {
    host: process.env.SHARED_PG_HOST,
    port: Number(process.env.SHARED_PG_PORT),
    user: process.env.SHARED_PG_USER,
    database: "postgres", // admin database always present
    password: process.env.SHARED_PG_PASSWORD,
  };

  let pool: pg.Pool | null = null;

  const handle: PgTestContainer = {
    get connectionString() {
      if (!pool) throw new Error("Database not started yet");
      return `postgresql://${adminConnConfig.user}:${adminConnConfig.password}@${adminConnConfig.host}:${adminConnConfig.port}/${dbName}`;
    },

    async start() {
      // Create the per-test database inside the shared Postgres instance.
      const adminPool = new pg.Pool({ ...adminConnConfig, max: 1 });
      try {
        await adminPool.query(`CREATE DATABASE "${dbName}"`);
      } finally {
        await adminPool.end().catch(() => {});
      }

      pool = new pg.Pool({
        host: adminConnConfig.host,
        port: adminConnConfig.port,
        user: adminConnConfig.user,
        password: adminConnConfig.password,
        database: dbName,
      });
      await applyMigrationsPg(pool);
    },

    async truncate() {
      if (!pool) throw new Error("Database not started yet");
      await pool.query(
        "TRUNCATE TABLE documents, pages, versions, libraries RESTART IDENTITY CASCADE",
      );
    },

    async stop() {
      await pool?.end().catch(() => {});
      pool = null;

      // Drop the isolated test database to free resources.
      const adminPool = new pg.Pool({ ...adminConnConfig, max: 1 });
      try {
        // Terminate any lingering connections before dropping.
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [dbName],
        );
        await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } catch {
        // Best-effort cleanup — don't fail the test run on cleanup errors.
      } finally {
        await adminPool.end().catch(() => {});
      }
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Standalone path (fallback when no globalSetup has run)
// ---------------------------------------------------------------------------

function createStandaloneContainer(): PgTestContainer {
  let started: StartedPostgreSqlContainer | null = null;
  let pool: pg.Pool | null = null;

  const handle: PgTestContainer = {
    get connectionString() {
      if (!started) throw new Error("Container not started yet");
      return started.getConnectionUri();
    },

    async start() {
      started = await new PostgreSqlContainer("pgvector/pgvector:pg16")
        .withDatabase("docs_mcp_test")
        .withUsername("test")
        .withPassword("test")
        .start();

      pool = new pg.Pool({ connectionString: started.getConnectionUri() });
      await applyMigrationsPg(pool);
    },

    async truncate() {
      if (!pool) throw new Error("Container not started yet");
      await pool.query(
        "TRUNCATE TABLE documents, pages, versions, libraries RESTART IDENTITY CASCADE",
      );
    },

    async stop() {
      await pool?.end().catch(() => {});
      await started?.stop().catch(() => {});
      pool = null;
      started = null;
    },
  };

  return handle;
}
