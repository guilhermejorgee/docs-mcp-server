# Embedding Model Configuration

This guide details how to configure the embedding models used for semantic chunking during indexing. You can set the embedding model using the `app.embeddingModel` configuration key, the `DOCS_MCP_EMBEDDING_MODEL` environment variable, or the `--embedding-model` CLI flag.

> **Note:** Embeddings are used transiently during indexing for semantic chunking. They are not stored and do not affect search ranking. Search is powered by PostgreSQL full-text search (FTS).

## Model Selection

If you leave the model empty but provide `OPENAI_API_KEY`, the server defaults to `text-embedding-3-small`.

**Supported Options:**

- `text-embedding-3-small` (default, OpenAI)
- `openai:snowflake-arctic-embed2` (OpenAI-compatible, e.g., Ollama)
- `vertex:text-embedding-004` (Google Vertex AI)
- `gemini:embedding-001` (Google Gemini)
- `aws:amazon.titan-embed-text-v1` (AWS Bedrock)
- `microsoft:text-embedding-ada-002` (Azure OpenAI)
- Or any OpenAI-compatible model name

## Provider Configuration

Provider credentials use the provider-specific environment variables listed below.

| Variable                           | Description                                           |
| ---------------------------------- | ----------------------------------------------------- |
| `DOCS_MCP_EMBEDDING_MODEL`         | Embedding model to use.                               |
| `OPENAI_API_KEY`                   | OpenAI API key for embeddings.                        |
| `OPENAI_API_BASE`                  | Custom OpenAI-compatible API endpoint (e.g., Ollama). |
| `GOOGLE_API_KEY`                   | Google API key for Gemini embeddings.                 |
| `GOOGLE_APPLICATION_CREDENTIALS`   | Path to Google service account JSON for Vertex AI.    |
| `AWS_ACCESS_KEY_ID`                | AWS key for Bedrock embeddings.                       |
| `AWS_SECRET_ACCESS_KEY`            | AWS secret for Bedrock embeddings.                    |
| `AWS_REGION`                       | AWS region for Bedrock.                               |
| `AZURE_OPENAI_API_KEY`             | Azure OpenAI API key.                                 |
| `AZURE_OPENAI_API_INSTANCE_NAME`   | Azure OpenAI instance name.                           |
| `AZURE_OPENAI_API_DEPLOYMENT_NAME` | Azure OpenAI deployment name.                         |
| `AZURE_OPENAI_API_VERSION`         | Azure OpenAI API version.                             |
| `DOCS_MCP_EMBEDDINGS_TOKEN_URL`    | OAuth2 token endpoint URL. Required when using `client_credentials` authentication instead of an API key. |
| `DOCS_MCP_EMBEDDINGS_CLIENT_ID`    | OAuth2 client ID. Required when `DOCS_MCP_EMBEDDINGS_TOKEN_URL` is set. |
| `DOCS_MCP_EMBEDDINGS_CLIENT_SECRET_KEY` | Key name to resolve the client secret via the configured secret provider (default: `DOCS_MCP_EMBEDDING_CLIENT_SECRET`). |
| `DOCS_MCP_EMBEDDINGS_TOKEN_CACHE_TTL_MS` | Override `expires_in` from the token response (ms); omit to rely on the server-provided TTL. |

### Examples

Here are complete configuration examples for different embedding providers.

#### OpenAI (Default)

```bash
OPENAI_API_KEY="sk-proj-your-openai-api-key" \
DOCS_MCP_EMBEDDING_MODEL="text-embedding-3-small" \
npx @arabold/docs-mcp-server@latest
```

#### Ollama (Local)

Run local models compatible with the OpenAI API format.

```bash
OPENAI_API_KEY="ollama" \
OPENAI_API_BASE="http://localhost:11434/v1" \
DOCS_MCP_EMBEDDING_MODEL="openai:nomic-embed-text" \
npx @arabold/docs-mcp-server@latest
```

#### LM Studio (Local)

Connect to LM Studio's local inference server.

```bash
OPENAI_API_KEY="lmstudio" \
OPENAI_API_BASE="http://localhost:1234/v1" \
DOCS_MCP_EMBEDDING_MODEL="text-embedding-qwen3-embedding-4b" \
npx @arabold/docs-mcp-server@latest
```

#### Google Gemini

Use Google's Gemini API directly.

```bash
GOOGLE_API_KEY="your-google-api-key" \
DOCS_MCP_EMBEDDING_MODEL="gemini:embedding-001" \
npx @arabold/docs-mcp-server@latest
```

#### Google Vertex AI

For enterprise GCP deployments.

```bash
GOOGLE_APPLICATION_CREDENTIALS="/path/to/your/gcp-service-account.json" \
DOCS_MCP_EMBEDDING_MODEL="vertex:text-embedding-004" \
npx @arabold/docs-mcp-server@latest
```

#### AWS Bedrock

Use Amazon Titan or other Bedrock-hosted models.

```bash
AWS_ACCESS_KEY_ID="your-aws-access-key-id" \
AWS_SECRET_ACCESS_KEY="your-aws-secret-access-key" \
AWS_REGION="us-east-1" \
DOCS_MCP_EMBEDDING_MODEL="aws:amazon.titan-embed-text-v1" \
npx @arabold/docs-mcp-server@latest
```

#### Azure OpenAI

Connect to your private Azure OpenAI deployment.

```bash
AZURE_OPENAI_API_KEY="your-azure-openai-api-key" \
AZURE_OPENAI_API_INSTANCE_NAME="your-instance-name" \
AZURE_OPENAI_API_DEPLOYMENT_NAME="your-deployment-name" \
AZURE_OPENAI_API_VERSION="2024-02-01" \
DOCS_MCP_EMBEDDING_MODEL="microsoft:text-embedding-ada-002" \
npx @arabold/docs-mcp-server@latest
```

## OAuth2 Authentication (OpenAI-Compatible Providers)

Internal or enterprise OpenAI-compatible embedding providers hosted behind an SSO gateway can authenticate using the OAuth2 `client_credentials` flow. Configure `tokenUrl` and `clientId` in your `config.yaml`:

```yaml
embeddings:
  tokenUrl: "https://auth.example.com/oauth2/token"
  clientId: "docs-mcp-service"
  clientSecretKey: "DOCS_MCP_EMBEDDING_CLIENT_SECRET"
  tokenCacheTtlMs: 3600000
```

When `tokenUrl` is absent, behavior is unchanged — the standard API key flow applies.

> **Note:** OAuth2 here authenticates _this server_ against the **embedding provider**. This is distinct from OAuth2 for protecting the MCP server's own HTTP endpoints — see [Authentication](../infrastructure/authentication.md).

For secrets configuration (resolving `clientSecretKey` from HashiCorp Vault or AWS Secrets Manager), see [Configuration Reference](../setup/configuration.md#secrets-secrets).

## See Also

- **[Semantic Chunking](../concepts/semantic-chunking.md)**: How embeddings are used during indexing to detect topic boundaries.
- **[Configuration Reference](../setup/configuration.md)**: `chunkingStrategy` and `splitter` settings.
