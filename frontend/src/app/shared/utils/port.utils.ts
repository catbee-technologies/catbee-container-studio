export interface PortBinding {
  HostIp?: string;
  HostPort?: string;
}

export interface PortMappingRow {
  containerPort: string;
  protocol: 'tcp' | 'udp' | 'sctp';
  hostPort: string;
  hostIp?: string;
}

export interface MinimalPortInfo {
  PrivatePort: number;
  PublicPort?: number;
  Type?: string;
  IP?: string;
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
  portBindings?: Record<string, PortBinding[] | null> | null,
  networkPorts?: Record<string, PortBinding[] | null> | null,
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

    const protocol = rawProtocol?.toLowerCase() ?? 'tcp';
    if (protocol !== 'tcp' && protocol !== 'udp' && protocol !== 'sctp') {
      throw new Error(`Unsupported port protocol: ${protocol}`);
    }
    const key = `${containerPort}/${protocol}`;
    const configured = portBindings?.[entry] ?? portBindings?.[key];
    const network = networkPorts?.[entry] ?? networkPorts?.[key] ?? [];
    const listed = (containerPorts ?? [])
      .filter(p => p.PrivatePort === Number(containerPort) && (p.Type || 'tcp').toLowerCase() === protocol)
      .filter(p => p.PublicPort !== undefined)
      .map(p => ({ HostIp: p.IP, HostPort: String(p.PublicPort) }));
    const bindings = configured?.length ? configured : network.length ? network : listed;

    if (!bindings.length) {
      rows.push({ containerPort, protocol, hostPort: '' });
      continue;
    }

    bindings.forEach((binding, index) => {
      const runtime =
        network.find(item => item.HostIp === binding.HostIp) ??
        network[index] ??
        listed.find(item => item.HostIp === binding.HostIp) ??
        listed[index];
      const hostPort = binding.HostPort && binding.HostPort !== '0' ? binding.HostPort : runtime?.HostPort || '0';
      rows.push({
        containerPort,
        protocol,
        hostPort,
        ...(binding.HostIp !== undefined ? { hostIp: binding.HostIp } : {})
      });
    });
  }

  return rows.sort((left, right) => Number(left.containerPort) - Number(right.containerPort));
}

/**
 * Converts PortMappingRow array to Docker ExposedPorts and PortBindings structures.
 */
export function rowsToDockerPortBindings(rows: PortMappingRow[]): {
  exposedPorts: Record<string, object>;
  portBindings: Record<string, { HostPort: string; HostIp?: string }[]>;
} {
  const exposedPorts: Record<string, object> = {};
  const portBindings: Record<string, { HostPort: string; HostIp?: string }[]> = {};

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
    (portBindings[containerKey] ??= []).push({
      HostPort: hostPort === '0' ? '' : hostPort,
      ...(port.hostIp !== undefined ? { HostIp: port.hostIp } : {})
    });
  }

  return { exposedPorts, portBindings };
}

/**
 * Detects conflicting publications while allowing the same port on distinct host addresses.
 */
export function findDuplicateHostPorts(rows: PortMappingRow[]): Set<string> {
  const duplicates = new Set<string>();
  for (let left = 0; left < rows.length; left++) {
    for (let right = left + 1; right < rows.length; right++) {
      if (hostPortsConflict(rows[left], rows[right])) {
        duplicates.add(hostPortKey(rows[left]));
        duplicates.add(hostPortKey(rows[right]));
      }
    }
  }
  return duplicates;
}

export function hostPortKey(row: PortMappingRow): string {
  return `${row.hostIp ?? ''}/${Number(row.hostPort)}/${row.protocol}`;
}

export function hostPortsConflict(left: PortMappingRow, right: PortMappingRow): boolean {
  if (
    !left.hostPort.trim() ||
    !right.hostPort.trim() ||
    Number(left.hostPort) === 0 ||
    Number(right.hostPort) === 0 ||
    Number(left.hostPort) !== Number(right.hostPort) ||
    left.protocol !== right.protocol
  ) {
    return false;
  }

  const leftIp = left.hostIp ?? '';
  const rightIp = right.hostIp ?? '';
  if (!leftIp || !rightIp || leftIp === rightIp) {
    return true;
  }
  const sameFamily = leftIp.includes(':') === rightIp.includes(':');
  return sameFamily && [leftIp, rightIp].some(ip => ip === '0.0.0.0' || ip === '::');
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
        hostPort: r.hostPort.trim(),
        hostIp: r.hostIp ?? ''
      }))
      .filter(r => r.containerPort.length > 0)
      .sort((x, y) =>
        `${x.containerPort}/${x.protocol}/${x.hostIp}/${x.hostPort}`.localeCompare(
          `${y.containerPort}/${y.protocol}/${y.hostIp}/${y.hostPort}`
        )
      );

  const cleanA = sanitize(a);
  const cleanB = sanitize(b);

  if (cleanA.length !== cleanB.length) {
    return false;
  }

  return cleanA.every(
    (row, idx) =>
      row.containerPort === cleanB[idx].containerPort &&
      row.protocol === cleanB[idx].protocol &&
      row.hostIp === cleanB[idx].hostIp &&
      row.hostPort === cleanB[idx].hostPort
  );
}
