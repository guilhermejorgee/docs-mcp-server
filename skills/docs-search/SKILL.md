---
name: docs-search
description: >-
  Search and query the Grounded Docs MCP Server documentation index.
  Covers listing indexed libraries, searching documentation content,
  and resolving library versions. Use when you need to look up API
  references, find code examples, or check which documentation is
  available in the local index.
compatibility: Requires Node.js 22+ and npx
metadata:
  author: grounded.tools
---

# Docs Search

Search the local Grounded Docs index for library documentation. These commands
return structured data (JSON by default in non-interactive sessions) and never
modify the index.

## When to use

- You need to answer a question about a library's API or behaviour.
- You want to check which libraries and versions are already indexed.
- You need to resolve which documentation version best matches a constraint.

Use `find-library` to discover whether a library is indexed when you only know a partial name or description.
Use `list` if you want to enumerate all indexed libraries at once.
If nothing is indexed yet, use the **docs-manage** skill to scrape documentation before searching.

## Commands

### list

List every indexed library and its available versions.

```bash
npx @arabold/docs-mcp-server@latest list [--output yaml]
```

| Flag | Description |
|------|-------------|
| `--output json\|yaml\|toon` | Structured output format (default: JSON in non-interactive) |
| `--server-url <url>` | Connect to a remote pipeline worker instead of the local store |
| `--quiet` | Suppress non-error diagnostics |
| `--verbose` | Enable debug logging |

Example output (YAML):

```yaml
- library: react
  versions:
    - "19.0.0"
    - "18.3.1"
  description: "React documentation for building user interfaces"
- library: typescript
  versions:
    - "5.7.0"
```

### search

Search documents in an indexed library by natural-language query.

```bash
npx @arabold/docs-mcp-server@latest search <library> "<query>" [options]
```

| Flag | Alias | Default | Description |
|------|-------|---------|-------------|
| `--version <ver>` | `-v` | latest | Version constraint (exact or range, e.g. `18.x`, `5.2.x`) |
| `--limit <n>` | `-l` | `5` | Maximum number of results |
| `--exact-match` | `-e` | `false` | Only match the exact version, no fallback |
| `--embedding-model <model>` | | | Embedding model (e.g. `openai:text-embedding-3-small`) |
| `--server-url <url>` | | | Remote pipeline worker URL |
| `--output json\|yaml\|toon` | | JSON | Structured output format |
| `--quiet` | | | Suppress non-error diagnostics |
| `--verbose` | | | Enable debug logging |

Example:

```bash
npx @arabold/docs-mcp-server@latest search react "useEffect cleanup" --version 18.x --limit 3 --output yaml
```

Each result contains a content snippet, source URL, and relevance score.

### find-version

Resolve the best matching documentation version for a library.

```bash
npx @arabold/docs-mcp-server@latest find-version <library> [--version <pattern>]
```

| Flag | Alias | Description |
|------|-------|-------------|
| `--version <pattern>` | `-v` | Version pattern to match (supports ranges) |
| `--server-url <url>` | | Remote pipeline worker URL |
| `--output json\|yaml\|toon` | | Structured output format |
| `--quiet` | | Suppress non-error diagnostics |
| `--verbose` | | Enable debug logging |

Example:

```bash
npx @arabold/docs-mcp-server@latest find-version react --version "18.x" --output yaml
```

Returns the resolved version string and library metadata.

### find-library

Discover indexed libraries by searching across names and descriptions.

```bash
npx @arabold/docs-mcp-server@latest find-library "<query>" [options]
```

| Flag | Alias | Default | Description |
|------|-------|---------|-------------|
| `--limit <n>` | `-l` | `5` | Maximum number of results |
| `--server-url <url>` | | | Remote pipeline worker URL |
| `--output json\|yaml\|toon` | | JSON | Structured output format |
| `--quiet` | | | Suppress non-error diagnostics |
| `--verbose` | | | Enable debug logging |

Example:

```bash
npx @arabold/docs-mcp-server@latest find-library "react state management" --output yaml
```

Returns a ranked list of matching libraries with name, version(s), and description.

## Interpreting output

All three commands emit structured data to **stdout**. Diagnostics and progress
messages go to **stderr** and are suppressed by default in non-interactive
sessions. Use `--verbose` (or set `LOG_LEVEL=INFO`) to re-enable them.
Use `--quiet` to suppress all non-error diagnostics regardless of session type.

To capture results programmatically, parse stdout as JSON (the default) or
request `--output yaml` for a more readable format.

## Typical workflow

```bash
# 1. Discover if the library is indexed (by partial name or description)
npx @arabold/docs-mcp-server@latest find-library "react" --output yaml

# 2. Search for relevant docs
npx @arabold/docs-mcp-server@latest search react "server components" --version 19.x --output yaml

# 3. If no results, index the docs first (see docs-manage skill), then retry
```
