import axios from "axios";

interface OAuth2TokenProviderOptions {
  /** OAuth2 token endpoint URL */
  tokenUrl: string;
  /** OAuth2 client ID */
  clientId: string;
  /** Returns the client secret at token-fetch time (injected from `ISecretProvider`) */
  getClientSecret: () => Promise<string>;
  /**
   * When set, overrides the `expires_in` value returned by the token endpoint.
   * Useful for forcing a shorter (or longer) effective TTL. In milliseconds.
   */
  tokenCacheTtlMs?: number;
  /**
   * How many milliseconds before actual expiry the provider proactively refreshes the token.
   * Defaults to 30 000 ms (30 s).
   */
  earlyRenewalBufferMs?: number;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  token_type?: string;
}

/**
 * Fetches, caches, and proactively renews OAuth2 `client_credentials` bearer tokens.
 * Concurrent calls to `getToken()` are de-duplicated — only one in-flight refresh
 * request is ever made at a time.
 */
export class OAuth2TokenProvider {
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly getClientSecret: () => Promise<string>;
  private readonly tokenCacheTtlMs: number | undefined;
  private readonly earlyRenewalBufferMs: number;

  private cachedToken: string | undefined;
  private expiresAt = 0;
  private refreshPromise: Promise<string> | undefined;

  constructor(options: OAuth2TokenProviderOptions) {
    this.tokenUrl = options.tokenUrl;
    this.clientId = options.clientId;
    this.getClientSecret = options.getClientSecret;
    this.tokenCacheTtlMs = options.tokenCacheTtlMs;
    this.earlyRenewalBufferMs = options.earlyRenewalBufferMs ?? 30_000;
  }

  /**
   * Returns a valid bearer token, fetching or refreshing it as needed.
   * Concurrent callers share a single in-flight refresh request.
   */
  async getToken(): Promise<string> {
    // Return cached token if still fresh enough
    if (this.cachedToken && Date.now() < this.expiresAt - this.earlyRenewalBufferMs) {
      return this.cachedToken;
    }

    // Deduplicate concurrent refresh requests
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this._fetchToken();
    try {
      const token = await this.refreshPromise;
      return token;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  private async _fetchToken(): Promise<string> {
    const clientSecret = await this.getClientSecret();

    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: clientSecret,
    });

    let data: TokenResponse;
    try {
      const response = await axios.post<TokenResponse>(this.tokenUrl, params.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        validateStatus: null, // handle errors manually
      });

      if (response.status < 200 || response.status >= 300) {
        const body =
          typeof response.data === "string"
            ? response.data
            : JSON.stringify(response.data);
        throw new Error(
          `❌ OAuth2 token fetch failed: HTTP ${response.status} from ${this.tokenUrl}: ${body}`,
        );
      }

      data = response.data;
    } catch (error) {
      // Clear cached token on failure so next call retries
      this.cachedToken = undefined;
      this.expiresAt = 0;
      throw error;
    }

    const expiresInMs =
      this.tokenCacheTtlMs ??
      (data.expires_in !== undefined ? data.expires_in * 1000 : 3_600_000);

    this.cachedToken = data.access_token;
    this.expiresAt = Date.now() + expiresInMs;

    return this.cachedToken;
  }
}
