export interface VolumeMappingRow {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export function getVolumeMappingError(row: VolumeMappingRow): string | null {
  const hasHost = row.hostPath.trim().length > 0;
  const hasContainer = row.containerPath.trim().length > 0;
  if (!hasHost && !hasContainer && !row.readOnly) {
    return null;
  }
  if (!hasHost && !hasContainer) {
    return 'Host path or volume and container path are required.';
  }
  if (!hasHost) {
    return 'Host path or volume is required.';
  }
  return hasContainer ? null : 'Container path is required.';
}

/**
 * Converts Docker Engine HostConfig.Binds (['/host:/container', '/host:/container:ro'])
 * into VolumeMappingRow array.
 */
export function dockerBindsToRows(binds: unknown[] | undefined | null): VolumeMappingRow[] {
  if (!Array.isArray(binds)) {
    return [];
  }

  return binds
    .map(entry => String(entry).trim())
    .filter(entry => entry.length > 0)
    .map((entry): VolumeMappingRow | null => {
      const parts = entry.split(':');
      if (parts.length < 2) {
        return null;
      }

      // Handle Windows drive letter path (e.g., C:\host\path:/container/path)
      let hostPath: string;
      let containerPath: string;
      let mode: string;

      if (parts[0].length === 1 && /^[a-zA-Z]$/.test(parts[0]) && parts.length >= 3) {
        hostPath = `${parts[0]}:${parts[1]}`;
        containerPath = parts[2];
        mode = parts[3] ?? '';
      } else {
        hostPath = parts[0];
        containerPath = parts[1];
        mode = parts[2] ?? '';
      }

      const readOnly = mode.toLowerCase().includes('ro');
      return { hostPath, containerPath, readOnly };
    })
    .filter((row): row is VolumeMappingRow => row !== null);
}

/**
 * Converts VolumeMappingRow array to Docker HostConfig.Binds strings.
 */
export function rowsToDockerBinds(rows: VolumeMappingRow[]): string[] {
  const binds: string[] = [];
  for (const row of rows) {
    const hostPath = row.hostPath.trim();
    const containerPath = row.containerPath.trim();
    if (!hostPath || !containerPath) {
      continue;
    }
    binds.push(`${hostPath}:${containerPath}${row.readOnly ? ':ro' : ''}`);
  }
  return binds;
}

/**
 * Compares two lists of VolumeMappingRow for equality.
 */
export function areVolumeMappingsEqual(a: VolumeMappingRow[], b: VolumeMappingRow[]): boolean {
  const bindsA = rowsToDockerBinds(a).sort((x, y) => x.localeCompare(y));
  const bindsB = rowsToDockerBinds(b).sort((x, y) => x.localeCompare(y));
  if (bindsA.length !== bindsB.length) {
    return false;
  }
  return bindsA.every((bind, index) => bind === bindsB[index]);
}
