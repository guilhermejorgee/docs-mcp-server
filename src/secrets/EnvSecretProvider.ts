import { normalizeEnvValue } from "../utils/env";
import type { ISecretProvider } from "./ISecretProvider";

/**
 * Default `ISecretProvider` backed by `process.env`.
 * Injects `env` for testability.
 */
export class EnvSecretProvider implements ISecretProvider {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  async getSecret(key: string): Promise<string> {
    const raw = this.env[key];
    if (raw === undefined) {
      throw new Error(`❌ Secret "${key}" not found in environment variables`);
    }
    return normalizeEnvValue(raw);
  }
}
