# PostgreSQL Backend

**PostgreSQL** is the required backend for Docs MCP Server, providing:

- Concurrent write access from multiple server processes
- Standard managed-database tooling (backups, monitoring, connection pooling)
- Native vector search via [pgvector](https://github.com/pgvector/pgvector)
- Language-agnostic full-text search via `tsvector` with `unaccent` extension

---

## Requirements

| Requirement | Version |
|---|---|
| PostgreSQL | 14+ (16 recommended) |
| pgvector extension | 0.5+ |

> **Note:** Both managed services (Supabase, Neon, RDS, Cloud SQL) and self-hosted PostgreSQL
> work as long as pgvector is available.

---

## Install pgvector

### Docker (recommended for development)

```bash
docker run -d \
  --name docs-pg \
  -e POSTGRES_PASSWORD=secret \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

### Ubuntu / Debian

```bash
sudo apt install postgresql-16-pgvector
```

Then enable it in your database:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### Homebrew (macOS)

```bash
brew install pgvector
```

### Supabase / Neon / Managed Services

pgvector is typically pre-installed. Enable it via the SQL editor:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

---

## Configuration

### Environment variables (simplest)

```bash
DATABASE_URL=postgresql://user:pass@host:5432/dbname
DOCS_MCP_BACKEND=postgresql
```

### Config file (`config.yaml`)

```yaml
db:
  backend: postgresql
  postgresql:
    connectionString: "postgresql://user:pass@host:5432/dbname"
    poolSize: 10            # max connections in pool (default: 10)
    idleTimeoutMs: 30000    # close idle connections after 30s
    connectionTimeoutMs: 5000
```

### All configuration options

| Config key | Environment variable | Default | Description |
|---|---|---|---|
| `db.backend` | `DOCS_MCP_BACKEND` | `postgresql` | `postgresql` |
| `db.postgresql.connectionString` | `DATABASE_URL` | _(empty)_ | Full PostgreSQL connection string |
| `db.postgresql.poolSize` | `DOCS_MCP_DB_POSTGRESQL_POOL_SIZE` | `10` | Max connections in pool |
| `db.postgresql.idleTimeoutMs` | `DOCS_MCP_DB_POSTGRESQL_IDLE_TIMEOUT_MS` | `30000` | Idle connection timeout |
| `db.postgresql.connectionTimeoutMs` | `DOCS_MCP_DB_POSTGRESQL_CONNECTION_TIMEOUT_MS` | `5000` | Connection acquisition timeout |

---

## Schema Migrations

Migrations run automatically on startup. The server creates and tracks all required tables
in the target database. No manual migration step is needed.

The migration runner uses a `_schema_migrations` table to track applied migrations.
All migrations are idempotent — safe to run multiple times.

---

## Full-Text Search

The PostgreSQL backend defaults to a **multilingual, language-agnostic** FTS configuration using:

- `simple` dictionary (no language-specific stemming)
- `unaccent` extension (normalises accented characters: `ã→a`, `ç→c`, etc.)

This works correctly for both Portuguese and English content.

### Optional: bilingual stemming

For advanced users who want language-specific stemming, configure `ftsLanguages`:

```yaml
search:
  ftsLanguages: ["english", "portuguese"]
```

This indexes each document with two tsvectors (one per language), applying the correct stemmer
for each. The index size doubles, but prefix search and stemming quality improve for both languages.

---

## Docker Compose Example

```yaml
version: "3.8"
services:
  docs:
    image: ghcr.io/arabold/docs-mcp-server:latest
    environment:
      DATABASE_URL: postgresql://docs:secret@postgres:5432/docs
      DOCS_MCP_BACKEND: postgresql
      OPENAI_API_KEY: ${OPENAI_API_KEY}
    depends_on:
      postgres:
        condition: service_healthy

  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: docs
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: docs
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U docs"]
      interval: 5s
      retries: 10

volumes:
  pg_data:
```

---

## Connection Pooling

The server maintains an internal `pg.Pool`. For high-concurrency workloads with many concurrent
indexing jobs, you may also place [pgBouncer](https://www.pgbouncer.org/) or a managed pooler
(e.g., Supabase's PgBouncer, Neon's connection pooler) in front of PostgreSQL.

The server's internal pool should be sized to match what your external pooler allows per process.

---

## Troubleshooting

### `pgvector extension not found`

The `vector` extension is not installed or not enabled for the target database.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### `missing required db.postgresql.connectionString`

The `DATABASE_URL` or `db.postgresql.connectionString` config key is not set.

### Connection refused

Verify that the PostgreSQL host is reachable and the credentials are correct:

```bash
psql "$DATABASE_URL" -c "SELECT version();"
```
