# PostgreSQL Backend

**PostgreSQL** is the required backend for Docs MCP Server, providing:

- Concurrent write access from multiple server processes
- Standard managed-database tooling (backups, monitoring, connection pooling)
- Language-agnostic full-text search via `tsvector` with `unaccent` extension

---

## Requirements

| Requirement | Version |
|---|---|
| PostgreSQL | 14+ (16 recommended) |

> **Note:** Both managed services (Supabase, Neon, RDS, Cloud SQL) and self-hosted PostgreSQL
> work out of the box.

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

For language-specific stemming, configure `ftsLanguages`:

```yaml
search:
  ftsLanguages: ["english", "portuguese"]
```

When set, each document chunk is indexed with the `multilingual` base configuration **plus** an
additional tsvector for each configured language using its built-in PostgreSQL stemmer. At query
time all configured tsqueries are OR-combined, so a search for `"install"` will match documents
containing `"installation"` (English stem) and `"configurar"` will match `"configuração"` (Portuguese stem).

**How it works:**

| Layer | Config | Weights | Purpose |
|---|---|---|---|
| Base | `multilingual` (simple + unaccent) | A / B / C | Exact & accent-insensitive match (always present) |
| Stemmed | e.g. `english`, `portuguese` | D | Morphological variants (optional, per language) |

**Built-in languages supported:** Any PostgreSQL text search configuration name — `english`,
`portuguese`, `french`, `german`, `spanish`, `italian`, `dutch`, `russian`, and more.
Custom configurations (e.g. `pt_unaccent`, `en_unaccent`) are also accepted.

**Trade-offs:**

- Index size grows proportionally to the number of configured languages (≈ +1× per language for content field)
- Existing documents must be re-indexed (run a refresh) for new language configs to take effect
- Morphological variants are found; cross-language queries (Portuguese query → English content) still require semantic search (embeddings)

**Default:** `["pt_unaccent", "en_unaccent"]` — bilingual stemming with accent normalisation for Portuguese and English is enabled by default.

---

## Hybrid Search: Trigram Similarity on Title (migration 003)

Migration `003` enables the `pg_trgm` PostgreSQL extension and creates a GIN trigram
index on `pages.title`. This powers typo-tolerant title matching:

- Queries with minor typos (e.g., `useEfect`) will still surface pages whose titles
  closely match (similarity > 0.25).
- Search scores become a blend: **80% FTS relevance + 20% title similarity**.
- If FTS finds no token match but the title is similar enough, results are still returned.

### Re-indexing after `ftsLanguages` change

The `fts_vector` column is computed at document INSERT time. If you change
`search.ftsLanguages` in your config (e.g., to activate bilingual stemming), documents
already in the database will not be updated automatically. To apply the new stemming
configuration to existing data, remove and re-scrape the affected libraries.

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
    image: postgres:16-alpine
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

### `missing required db.postgresql.connectionString`

The `DATABASE_URL` or `db.postgresql.connectionString` config key is not set.

### Connection refused

Verify that the PostgreSQL host is reachable and the credentials are correct:

```bash
psql "$DATABASE_URL" -c "SELECT version();"
```
