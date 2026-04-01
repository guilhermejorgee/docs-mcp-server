import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuth2TokenProvider } from "./OAuth2TokenProvider";

vi.mock("axios");

const mockedPost = vi.mocked(axios.post);

function makeProvider(
  overrides?: Partial<ConstructorParameters<typeof OAuth2TokenProvider>[0]>,
) {
  return new OAuth2TokenProvider({
    tokenUrl: "https://auth.example.com/token",
    clientId: "my-client",
    getClientSecret: async () => "my-secret",
    earlyRenewalBufferMs: 30_000,
    ...overrides,
  });
}

function makeTokenResponse(
  accessToken: string,
  expiresIn?: number,
): { data: { access_token: string; expires_in?: number }; status: number } {
  return {
    status: 200,
    data: {
      access_token: accessToken,
      ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
    },
  };
}

describe("OAuth2TokenProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches token from endpoint on first call and caches it", async () => {
    mockedPost.mockResolvedValueOnce(makeTokenResponse("token-1", 3600));
    const provider = makeProvider();

    const token = await provider.getToken();

    expect(token).toBe("token-1");
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledWith(
      "https://auth.example.com/token",
      expect.stringContaining("grant_type=client_credentials"),
      expect.objectContaining({
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    );
  });

  it("returns cached token on second call without making another HTTP request", async () => {
    mockedPost.mockResolvedValueOnce(makeTokenResponse("token-1", 3600));
    const provider = makeProvider();

    await provider.getToken();
    const second = await provider.getToken();

    expect(second).toBe("token-1");
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it("refreshes token when within earlyRenewalBufferMs of expiry", async () => {
    mockedPost
      .mockResolvedValueOnce(makeTokenResponse("token-1", 60)) // 60s TTL
      .mockResolvedValueOnce(makeTokenResponse("token-2", 60));
    const provider = makeProvider({ earlyRenewalBufferMs: 30_000 });

    await provider.getToken();

    // Advance time to within the 30s buffer (e.g. 35s elapsed → 25s left < 30s buffer)
    vi.advanceTimersByTime(35_000);

    const refreshed = await provider.getToken();
    expect(refreshed).toBe("token-2");
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });

  it("concurrent calls share a single in-flight refresh", async () => {
    let resolvePost!: (v: unknown) => void;
    const slowPost = new Promise((res) => {
      resolvePost = res;
    });
    mockedPost.mockReturnValueOnce(slowPost as ReturnType<typeof axios.post>);

    const provider = makeProvider();
    const p1 = provider.getToken();
    const p2 = provider.getToken();

    resolvePost(makeTokenResponse("token-shared", 3600));
    const [t1, t2] = await Promise.all([p1, p2]);

    expect(t1).toBe("token-shared");
    expect(t2).toBe("token-shared");
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it("uses tokenCacheTtlMs override, ignoring expires_in", async () => {
    // Override TTL to 10s; expires_in is 3600 but should be ignored
    mockedPost
      .mockResolvedValueOnce(makeTokenResponse("token-1", 3600))
      .mockResolvedValueOnce(makeTokenResponse("token-2", 3600));
    const provider = makeProvider({ tokenCacheTtlMs: 10_000, earlyRenewalBufferMs: 0 });

    await provider.getToken();
    vi.advanceTimersByTime(11_000);
    const second = await provider.getToken();

    expect(second).toBe("token-2");
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });

  it("defaults to expires_in * 1000 when tokenCacheTtlMs is not set", async () => {
    mockedPost
      .mockResolvedValueOnce(makeTokenResponse("token-1", 60))
      .mockResolvedValueOnce(makeTokenResponse("token-2", 60));
    const provider = makeProvider({ earlyRenewalBufferMs: 0 });

    await provider.getToken();
    vi.advanceTimersByTime(59_000);
    const still = await provider.getToken();
    expect(still).toBe("token-1"); // still within TTL

    vi.advanceTimersByTime(2_000);
    const refreshed = await provider.getToken();
    expect(refreshed).toBe("token-2");
  });

  it("defaults to 3600s TTL when neither tokenCacheTtlMs nor expires_in is present", async () => {
    mockedPost
      .mockResolvedValueOnce({ status: 200, data: { access_token: "token-1" } })
      .mockResolvedValueOnce({ status: 200, data: { access_token: "token-2" } });
    const provider = makeProvider({ earlyRenewalBufferMs: 0 });

    await provider.getToken();
    vi.advanceTimersByTime(3_599_000);
    const still = await provider.getToken();
    expect(still).toBe("token-1");

    vi.advanceTimersByTime(2_000);
    const refreshed = await provider.getToken();
    expect(refreshed).toBe("token-2");
  });

  it("throws descriptive error on 4xx from token endpoint", async () => {
    mockedPost.mockResolvedValueOnce({ status: 400, data: "invalid_client" });
    const provider = makeProvider();

    await expect(provider.getToken()).rejects.toThrow(
      /OAuth2 token fetch failed: HTTP 400/,
    );
  });

  it("throws descriptive error on 5xx from token endpoint", async () => {
    mockedPost.mockResolvedValueOnce({ status: 503, data: "Service Unavailable" });
    const provider = makeProvider();

    await expect(provider.getToken()).rejects.toThrow(
      /OAuth2 token fetch failed: HTTP 503/,
    );
  });

  it("does not cache error state — next call retries the HTTP request", async () => {
    mockedPost
      .mockResolvedValueOnce({ status: 500, data: "error" })
      .mockResolvedValueOnce(makeTokenResponse("token-ok", 3600));
    const provider = makeProvider();

    await expect(provider.getToken()).rejects.toThrow();
    const token = await provider.getToken();
    expect(token).toBe("token-ok");
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });
});
