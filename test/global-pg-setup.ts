/**
 * Vitest globalSetup: starts a single shared PostgreSQL container before all
 * test workers and tears it down after all workers finish.
 *
 * Each test file that needs a PostgreSQL database calls createPgContainer(),
 * which detects the SHARED_PG_* env vars and creates an isolated database
 * inside this shared instance instead of spinning up a separate container.
 *
 * This avoids running 8+ containers simultaneously on memory-constrained hosts.
 */

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

let container: StartedPostgreSqlContainer | null = null;

export async function setup(): Promise<void> {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withDatabase("postgres")
    .withUsername("test")
    .withPassword("test")
    .start();

  // Env vars set here are inherited by worker processes spawned after this
  // point (Vitest globalSetup runs before workers are created).
  process.env.SHARED_PG_HOST = container.getHost();
  process.env.SHARED_PG_PORT = String(container.getMappedPort(5432));
  process.env.SHARED_PG_USER = "test";
  process.env.SHARED_PG_PASSWORD = "test";
}

export async function teardown(): Promise<void> {
  await container?.stop().catch(() => {});
  container = null;
}
