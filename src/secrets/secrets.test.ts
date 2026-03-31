import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../utils/config";
import { AwsSecretProvider } from "./AwsSecretProvider";
import { EnvSecretProvider } from "./EnvSecretProvider";
import { createSecretProvider } from "./SecretProviderFactory";
import { VaultSecretProvider } from "./VaultSecretProvider";

vi.mock("axios");
vi.mock("@aws-sdk/client-secrets-manager");

const mockedGet = vi.mocked(axios.get);
const MockedSecretsManagerClient = vi.mocked(SecretsManagerClient);
const MockedGetSecretValueCommand = vi.mocked(GetSecretValueCommand);

// ---------------------------------------------------------------------------
// EnvSecretProvider
// ---------------------------------------------------------------------------

describe("EnvSecretProvider", () => {
  it("returns value for existing key", async () => {
    const provider = new EnvSecretProvider({ MY_KEY: "my-value" });
    await expect(provider.getSecret("MY_KEY")).resolves.toBe("my-value");
  });

  it("throws descriptive error for missing key", async () => {
    const provider = new EnvSecretProvider({});
    await expect(provider.getSecret("MISSING")).rejects.toThrow(
      /Secret "MISSING" not found in environment variables/,
    );
  });

  it("strips surrounding quotes via normalizeEnvValue", async () => {
    const provider = new EnvSecretProvider({ QUOTED: '"quoted-value"' });
    await expect(provider.getSecret("QUOTED")).resolves.toBe("quoted-value");
  });
});

// ---------------------------------------------------------------------------
// VaultSecretProvider
// ---------------------------------------------------------------------------

describe("VaultSecretProvider", () => {
  const provider = new VaultSecretProvider({
    url: "https://vault.example.com",
    token: "s.token",
    mountPath: "secret",
  });

  afterEach(() => vi.clearAllMocks());

  it("returns correct value from KV v2 response structure", async () => {
    mockedGet.mockResolvedValueOnce({
      data: { data: { data: { MY_KEY: "vault-value" } } },
    });
    await expect(provider.getSecret("MY_KEY")).resolves.toBe("vault-value");
  });

  it("throws on 403 response", async () => {
    mockedGet.mockRejectedValueOnce(
      Object.assign(new Error("Forbidden"), {
        isAxiosError: true,
        response: { status: 403 },
      }),
    );
    // Make axios.isAxiosError return true for this error
    vi.spyOn(axios, "isAxiosError").mockReturnValueOnce(true);
    await expect(provider.getSecret("MY_KEY")).rejects.toThrow(/HTTP 403/);
  });

  it("throws on 404 response", async () => {
    mockedGet.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), {
        isAxiosError: true,
        response: { status: 404 },
      }),
    );
    vi.spyOn(axios, "isAxiosError").mockReturnValueOnce(true);
    await expect(provider.getSecret("MY_KEY")).rejects.toThrow(/HTTP 404/);
  });

  it("throws when key absent from returned data.data", async () => {
    mockedGet.mockResolvedValueOnce({
      data: { data: { data: { OTHER_KEY: "val" } } },
    });
    await expect(provider.getSecret("MY_KEY")).rejects.toThrow(
      /Vault secret "MY_KEY" not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// AwsSecretProvider
// ---------------------------------------------------------------------------

describe("AwsSecretProvider", () => {
  afterEach(() => vi.clearAllMocks());

  function makeMockSend(resolveWith: unknown) {
    const mockSend = vi.fn().mockResolvedValueOnce(resolveWith);
    MockedSecretsManagerClient.mockImplementationOnce(
      () => ({ send: mockSend }) as unknown as SecretsManagerClient,
    );
    return mockSend;
  }

  it("returns correct value from JSON-parsed SecretString", async () => {
    makeMockSend({ SecretString: JSON.stringify({ MY_KEY: "aws-value" }) });
    const provider = new AwsSecretProvider({
      region: "us-east-1",
      secretId: "my-secret",
    });
    await expect(provider.getSecret("MY_KEY")).resolves.toBe("aws-value");
  });

  it("throws when SecretString is not valid JSON", async () => {
    makeMockSend({ SecretString: "not-json" });
    const provider = new AwsSecretProvider({
      region: "us-east-1",
      secretId: "my-secret",
    });
    await expect(provider.getSecret("MY_KEY")).rejects.toThrow(/not valid JSON/);
  });

  it("throws when key absent from parsed JSON", async () => {
    makeMockSend({ SecretString: JSON.stringify({ OTHER_KEY: "val" }) });
    const provider = new AwsSecretProvider({
      region: "us-east-1",
      secretId: "my-secret",
    });
    await expect(provider.getSecret("MY_KEY")).rejects.toThrow(/Key "MY_KEY" not found/);
  });

  it("throws on ResourceNotFoundException from SDK", async () => {
    const mockSend = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error("Secrets Manager can't find the specified secret."), {
        name: "ResourceNotFoundException",
      }),
    );
    MockedSecretsManagerClient.mockImplementationOnce(
      () => ({ send: mockSend }) as unknown as SecretsManagerClient,
    );
    const provider = new AwsSecretProvider({
      region: "us-east-1",
      secretId: "my-secret",
    });
    await expect(provider.getSecret("MY_KEY")).rejects.toThrow(
      /Failed to retrieve AWS secret/,
    );
  });
});

// ---------------------------------------------------------------------------
// SecretProviderFactory
// ---------------------------------------------------------------------------

describe("createSecretProvider", () => {
  it("returns EnvSecretProvider when provider is 'env'", () => {
    const provider = createSecretProvider({
      provider: "env",
      vault: {},
      aws: {},
    } as AppConfig["secrets"]);
    expect(provider).toBeInstanceOf(EnvSecretProvider);
  });

  it("returns EnvSecretProvider when config is undefined", () => {
    const provider = createSecretProvider(undefined);
    expect(provider).toBeInstanceOf(EnvSecretProvider);
  });

  it("returns VaultSecretProvider when provider is 'vault' with all required fields", () => {
    const provider = createSecretProvider({
      provider: "vault",
      vault: { url: "https://vault", token: "tok", mountPath: "secret" },
      aws: {},
    } as AppConfig["secrets"]);
    expect(provider).toBeInstanceOf(VaultSecretProvider);
  });

  it("throws when provider is 'vault' and vault.url is missing", () => {
    expect(() =>
      createSecretProvider({
        provider: "vault",
        vault: { token: "tok", mountPath: "secret" },
        aws: {},
      } as AppConfig["secrets"]),
    ).toThrow(/Vault secret provider requires/);
  });

  it("returns AwsSecretProvider when provider is 'aws' with all required fields", () => {
    const provider = createSecretProvider({
      provider: "aws",
      vault: {},
      aws: { region: "us-east-1", secretId: "my-secret" },
    } as AppConfig["secrets"]);
    expect(provider).toBeInstanceOf(AwsSecretProvider);
  });

  it("throws when provider is 'aws' and aws.region is missing", () => {
    expect(() =>
      createSecretProvider({
        provider: "aws",
        vault: {},
        aws: { secretId: "my-secret" },
      } as AppConfig["secrets"]),
    ).toThrow(/AWS secret provider requires/);
  });
});
