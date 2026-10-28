import { DockerContainerInfo, DockerContainerInspectInfo, DockerPortInfo } from '@shared/types/docker-api.types';

export function containerInfoFromInspect(
  inspect: DockerContainerInspectInfo,
  fallbackId?: string,
  endpointName?: string
): DockerContainerInfo {
  const id = inspect.Id ?? fallbackId ?? '';
  const createdMs = inspect.Created ? new Date(inspect.Created).getTime() : Date.now();

  const stateStr = inspect.State?.Status ?? (inspect.State?.Running ? 'running' : 'stopped');
  let status = stateStr;
  if (inspect.State?.Health?.Status) {
    status += ` (${inspect.State.Health.Status})`;
  }
  if (inspect.State?.Paused) {
    status += ' (paused)';
  }

  const name = inspect.Name ?? (endpointName ? `/${endpointName}` : id);
  const names = name ? [name] : [];

  const ports: DockerPortInfo[] = [];
  const networkPorts = inspect.NetworkSettings?.Ports;
  if (networkPorts && typeof networkPorts === 'object') {
    for (const [key, bindings] of Object.entries(networkPorts)) {
      const [privatePortStr, type = 'tcp'] = key.split('/');
      const privatePort = Number.parseInt(privatePortStr, 10);
      if (Array.isArray(bindings) && bindings.length > 0) {
        for (const b of bindings) {
          ports.push({
            IP: b?.HostIp,
            PrivatePort: Number.isNaN(privatePort) ? 0 : privatePort,
            PublicPort: b?.HostPort ? Number.parseInt(b.HostPort, 10) : undefined,
            Type: type
          });
        }
      } else if (!Number.isNaN(privatePort)) {
        ports.push({
          PrivatePort: privatePort,
          Type: type
        });
      }
    }
  }

  const labels = inspect.Config?.Labels ?? {};
  const cmd = inspect.Config?.Cmd;
  const command = Array.isArray(cmd) ? cmd.join(' ') : (typeof cmd === 'string' ? cmd : '');

  return {
    Id: id,
    Names: names,
    Image: inspect.Config?.Image ?? inspect.Image ?? '--',
    ImageID: inspect.Image,
    Command: command,
    Created: Number.isNaN(createdMs) ? Math.floor(Date.now() / 1000) : Math.floor(createdMs / 1000),
    State: stateStr,
    Status: status,
    Labels: labels,
    Ports: ports
  };
}

export function fallbackContainerFromEndpoint(
  attachedId: string,
  endpoint?: { Name?: string }
): DockerContainerInfo {
  return {
    Id: attachedId,
    Names: [endpoint?.Name ? `/${endpoint.Name}` : attachedId],
    Image: '--',
    Command: '',
    Created: Math.floor(Date.now() / 1000),
    State: 'unknown',
    Status: 'connected',
    Labels: {},
    Ports: []
  };
}
