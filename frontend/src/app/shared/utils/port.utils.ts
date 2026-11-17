export interface PortMappingRow {
  containerPort: string;
  protocol: 'tcp' | 'udp';
  hostPort: string;
}

export interface MinimalPortInfo {
  PrivatePort: number;
  PublicPort?: number;
  Type?: string;
}

export function isValidPort(value: string, minimum = 1): boolean {
  const port = value.trim();
  return /^\d+$/.test(port) && Number(port) >= minimum && Number(port) <= 65535;
}

export function isValidHostPort(value: string): boolean {
  return value.trim() === '' || isValidPort(value, 0);
}

/**
 * Converts Docker exposed ports & port bindings into PortMappingRow array.
 * Checks HostConfig.PortBindings, NetworkSettings.Ports, and container.Ports
 * so dynamically assigned/random host ports (e.g. 7737) are populated accurately.
 */
export function dockerPortsToRows(
  exposedPorts?: Record<string, unknown> | null,
  portBindings?: Record<string, { HostPort?: string }[]> | null,
  networkPorts?: Record<string, { HostPort?: string }[]> | null,
  containerPorts?: MinimalPortInfo[] | null
): PortMappingRow[] {
  const allKeys = new Set<string>();
  if (exposedPorts) {
    Object.keys(exposedPorts).forEach(key => allKeys.add(key));
  }
  if (portBindings) {
    Object.keys(portBindings).forEach(key => allKeys.add(key));
  }
  if (networkPorts) {
    Object.keys(networkPorts).forEach(key => allKeys.add(key));
  }
  if (containerPorts) {
    containerPorts.forEach(p => {
      if (p.PrivatePort) {
        allKeys.add(`${p.PrivatePort}/${p.Type || 'tcp'}`);
      }
    });
  }

  const rows: PortMappingRow[] = [];
  for (const entry of allKeys) {
    const [containerPort, rawProtocol] = entry.split('/');
    if (!containerPort) {
      continue;
    }

    const protocol: 'tcp' | 'udp' = rawProtocol?.toLowerCase() === 'udp' ? 'udp' : 'tcp';
    const key = `${containerPort}/${protocol}`;

    // 1. Check HostConfig.PortBindings
    const binding = portBindings?.[entry] ?? portBindings?.[key];
    let hostPort = binding?.[0]?.HostPort ?? '';

    // 2. If HostPort is empty (e.g. dynamic port or started with -P / 0:port), check NetworkSettings.Ports
    if (!hostPort) {
      const netBinding = networkPorts?.[entry] ?? networkPorts?.[key];
      hostPort = netBinding?.[0]?.HostPort ?? '';
    }

    // 3. If still empty, check containerPorts (DockerContainerInfo.Ports)
    if (!hostPort && containerPorts) {
      const matched = containerPorts.find(
        p => p.PrivatePort === Number(containerPort) && (p.Type || 'tcp').toLowerCase() === protocol
      );
      if (matched?.PublicPort) {
        hostPort = String(matched.PublicPort);
      }
    }

    rows.push({
      containerPort,
      protocol,
      hostPort
    });
  }

  return rows.sort((left, right) => Number(left.containerPort) - Number(right.containerPort));
}

/**
 * Converts PortMappingRow array to Docker ExposedPorts and PortBindings structures.
 */
export function rowsToDockerPortBindings(rows: PortMappingRow[]): {
  exposedPorts: Record<string, object>;
  portBindings: Record<string, { HostPort: string }[]>;
} {
  const exposedPorts: Record<string, object> = {};
  const portBindings: Record<string, { HostPort: string }[]> = {};

  for (const port of rows) {
    const containerPort = port.containerPort.trim();
    if (!containerPort) {
      continue;
    }

    const containerKey = `${containerPort}/${port.protocol}`;
    exposedPorts[containerKey] = {};

    const hostPort = port.hostPort.trim();
    if (!hostPort) {
      continue;
    }
    portBindings[containerKey] = [{ HostPort: hostPort === '0' ? '' : hostPort }];
  }

  return { exposedPorts, portBindings };
}

/**
 * Detects duplicate non-zero host ports across port mappings with the same protocol.
 * Returns a Set of keys formatted as `${hostPort}/${protocol}` that appear more than once.
 */
export function findDuplicateHostPorts(rows: PortMappingRow[]): Set<string> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const h = r.hostPort.trim();
    if (h && h !== '0') {
      const key = `${h}/${r.protocol}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const duplicates = new Set<string>();
  for (const [key, count] of counts.entries()) {
    if (count > 1) {
      duplicates.add(key);
    }
  }

  return duplicates;
}

/**
 * Compares two lists of PortMappingRow for equality.
 * Trims hostPort and containerPort and compares normalized sets.
 */
export function arePortMappingsEqual(a: PortMappingRow[], b: PortMappingRow[]): boolean {
  const sanitize = (rows: PortMappingRow[]) =>
    rows
      .map(r => ({
        containerPort: r.containerPort.trim(),
        protocol: r.protocol,
        hostPort: r.hostPort.trim()
      }))
      .filter(r => r.containerPort.length > 0)
      .sort((x, y) => `${x.containerPort}/${x.protocol}`.localeCompare(`${y.containerPort}/${y.protocol}`));

  const cleanA = sanitize(a);
  const cleanB = sanitize(b);

  if (cleanA.length !== cleanB.length) {
    return false;
  }

  return cleanA.every(
    (row, idx) =>
      row.containerPort === cleanB[idx].containerPort &&
      row.protocol === cleanB[idx].protocol &&
      row.hostPort === cleanB[idx].hostPort
  );
}
