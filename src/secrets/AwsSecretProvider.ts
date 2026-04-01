import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { ISecretProvider } from "./ISecretProvider";

interface AwsSecretProviderOptions {
  region: string;
  secretId: string;
}

/**
 * `ISecretProvider` backed by AWS Secrets Manager.
 * AWS credentials are resolved from the environment automatically (env vars, ~/.aws, IAM role, etc.).
 */
export class AwsSecretProvider implements ISecretProvider {
  private readonly client: SecretsManagerClient;
  private readonly secretId: string;

  constructor({ region, secretId }: AwsSecretProviderOptions) {
    this.client = new SecretsManagerClient({ region });
    this.secretId = secretId;
  }

  async getSecret(key: string): Promise<string> {
    let secretString: string | undefined;
    try {
      const response = await this.client.send(
        new GetSecretValueCommand({ SecretId: this.secretId }),
      );
      secretString = response.SecretString;
    } catch (error) {
      throw new Error(
        `❌ Failed to retrieve AWS secret "${this.secretId}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!secretString) {
      throw new Error(`❌ AWS secret "${this.secretId}" has no SecretString value`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(secretString) as Record<string, unknown>;
    } catch {
      throw new Error(`❌ AWS secret "${this.secretId}" SecretString is not valid JSON`);
    }

    const value = parsed[key];
    if (value === undefined) {
      throw new Error(`❌ Key "${key}" not found in AWS secret "${this.secretId}"`);
    }
    return String(value);
  }
}
