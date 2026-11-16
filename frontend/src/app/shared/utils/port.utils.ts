export interface PortMappingRow {
  containerPort: string;
  protocol: 'tcp' | 'udp';
  hostPort: string;
}

/**
 * Converts Docker exposed ports & port bindings into PortMappingRow array.
 */
export function dockerPortsToRows(
  exposedPorts?: Record<string, unknown> | null,
  portBindings?: Record<string, { HostPort?: string }[]> | null
): PortMappingRow[] {
  const allKeys = new Set<string>();
  if (exposedPorts) {
    Object.keys(exposedPorts).forEach(key => allKeys.add(key));
  }
  if (portBindings) {
    Object.keys(portBindings).forEach(key => allKeys.add(key));
  }

  const rows: PortMappingRow[] = [];
  for (const entry of allKeys) {
    const [containerPort, rawProtocol] = entry.split('/');
    if (!containerPort) {
      continue;
    }

    const protocol: 'tcp' | 'udp' = rawProtocol?.toLowerCase() === 'udp' ? 'udp' : 'tcp';
    const bindings = portBindings?.[entry] ?? portBindings?.[`${containerPort}/${protocol}`];
    const hostPort = bindings?.[0]?.HostPort ?? '';

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
