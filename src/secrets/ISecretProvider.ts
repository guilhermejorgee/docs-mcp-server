/**
 * Abstraction over secret backends (env vars, Vault, AWS Secrets Manager, etc.).
 * Consumers call `getSecret(key)` and are decoupled from where secrets live.
 */
export interface ISecretProvider {
  /**
   * Retrieve a secret by key.
   * @param key - The secret identifier (e.g. an environment variable name or AWS secret key).
   * @returns The secret value as a plain string.
   * @throws {Error} When the secret is not found or an I/O error occurs.
   */
  getSecret(key: string): Promise<string>;
}
