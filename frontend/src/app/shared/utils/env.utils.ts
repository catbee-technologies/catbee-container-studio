export interface EnvVarRow {
  key: string;
  value: string;
}

export function getEnvVarError(row: EnvVarRow): string | null {
  return !row.key.trim() && row.value.length > 0 ? 'Variable name is required when a value is provided.' : null;
}

/**
 * Parses multi-line .env content into key-value rows.
 * Handles quoted values, strips comments (#), and trims whitespace.
 */
export function parseEnvFileContent(content: string): EnvVarRow[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .map((line): EnvVarRow | null => {
      const eqIndex = line.indexOf('=');
      if (eqIndex === -1) {
        return null;
      }
      const key = line.slice(0, eqIndex).trim();
      if (!key) {
        return null;
      }
      let value = line.slice(eqIndex + 1).trim();
      const isQuoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
      if (isQuoted && value.length >= 2) {
        value = value.slice(1, -1);
      }
      return { key, value };
    })
    .filter((row): row is EnvVarRow => row !== null);
}

/**
 * Converts Docker Env array (["KEY=VALUE", ...]) to sorted EnvVarRow array.
 */
export function dockerEnvToRows(env: unknown[] | undefined | null): EnvVarRow[] {
  if (!Array.isArray(env)) {
    return [];
  }
  return env
    .map(value => String(value))
    .map(entry => {
      const separator = entry.indexOf('=');
      if (separator < 0) {
        return { key: entry, value: '' };
      }
      return {
        key: entry.slice(0, separator),
        value: entry.slice(separator + 1)
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Converts EnvVarRow array to Docker Env strings ("KEY=VALUE"), omitting empty keys.
 */
export function rowsToDockerEnv(rows: EnvVarRow[]): string[] {
  return rows.filter(row => row.key.trim().length > 0).map(row => `${row.key.trim()}=${row.value}`);
}

/**
 * Compares two lists of EnvVarRow for equality.
 */
export function areEnvVarsEqual(a: EnvVarRow[], b: EnvVarRow[]): boolean {
  const envA = rowsToDockerEnv(a).sort((x, y) => x.localeCompare(y));
  const envB = rowsToDockerEnv(b).sort((x, y) => x.localeCompare(y));
  if (envA.length !== envB.length) {
    return false;
  }
  return envA.every((entry, i) => entry === envB[i]);
}
