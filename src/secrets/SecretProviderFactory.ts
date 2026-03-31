import type { AppConfig } from "../utils/config";
import { AwsSecretProvider } from "./AwsSecretProvider";
import { EnvSecretProvider } from "./EnvSecretProvider";
import type { ISecretProvider } from "./ISecretProvider";
import { VaultSecretProvider } from "./VaultSecretProvider";

/**
 * Creates the appropriate `ISecretProvider` based on the `secrets` config block.
 * Throws at call-time (startup) when required provider fields are missing.
 *
 * @param config - The `AppConfig["secrets"]` block (optional — defaults to env provider).
 * @returns A configured `ISecretProvider` instance.
 */
export function createSecretProvider(config?: AppConfig["secrets"]): ISecretProvider {
  if (!config || config.provider === "env") {
    return new EnvSecretProvider();
  }

  if (config.provider === "vault") {
    const { url, token, mountPath } = config.vault ?? {};
    if (!url || !token || !mountPath) {
      throw new Error(
        "❌ Vault secret provider requires secrets.vault.url, secrets.vault.token, and secrets.vault.mountPath",
      );
    }
    return new VaultSecretProvider({ url, token, mountPath });
  }

  if (config.provider === "aws") {
    const { region, secretId } = config.aws ?? {};
    if (!region || !secretId) {
      throw new Error(
        "❌ AWS secret provider requires secrets.aws.region and secrets.aws.secretId",
      );
    }
    return new AwsSecretProvider({ region, secretId });
  }

  // TypeScript exhaustiveness — unreachable at runtime with Zod-validated config
  throw new Error(
    `❌ Unknown secret provider: ${String((config as { provider: string }).provider)}`,
  );
}
