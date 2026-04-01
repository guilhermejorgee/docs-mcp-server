import axios from "axios";
import type { ISecretProvider } from "./ISecretProvider";

interface VaultSecretProviderOptions {
  url: string;
  token: string;
  mountPath: string;
}

/**
 * `ISecretProvider` backed by HashiCorp Vault KV v2.
 * Each `getSecret` call fetches directly from Vault (no local cache).
 */
export class VaultSecretProvider implements ISecretProvider {
  private readonly url: string;
  private readonly token: string;
  private readonly mountPath: string;

  constructor({ url, token, mountPath }: VaultSecretProviderOptions) {
    this.url = url;
    this.token = token;
    this.mountPath = mountPath;
  }

  async getSecret(key: string): Promise<string> {
    const endpoint = `${this.url}/v1/${this.mountPath}/data/${key}`;
    try {
      const response = await axios.get<{ data: { data: Record<string, string> } }>(
        endpoint,
        { headers: { "X-Vault-Token": this.token } },
      );
      const value = response.data?.data?.data?.[key];
      if (value === undefined) {
        throw new Error(
          `❌ Vault secret "${key}" not found in mount "${this.mountPath}"`,
        );
      }
      return value;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        throw new Error(
          `❌ Vault secret "${key}" not found: HTTP ${error.response.status} from ${endpoint}`,
        );
      }
      throw error;
    }
  }
}
