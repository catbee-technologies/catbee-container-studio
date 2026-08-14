import { DockerPortInfo } from '@shared/types/docker-api.types';

export function formatDockerPort(port: DockerPortInfo): string {
  const privatePort = `${port.PrivatePort}/${port.Type}`;
  if (port.PublicPort === undefined) {
    return privatePort;
  }

  return `${port.PublicPort}:${privatePort}`;
}

export function resolveDockerPortHref(port: DockerPortInfo, containerState: string): string | null {
  if (containerState !== 'running' || port.PublicPort === undefined) {
    return null;
  }

  const host = port.IP && port.IP !== '0.0.0.0' && port.IP !== '::' ? port.IP : 'localhost';
  return `http://${host}:${port.PublicPort}`;
}

export function normalizeDockerPorts(ports: DockerPortInfo[]): DockerPortInfo[] {
  if (!Array.isArray(ports)) {
    return [];
  }
  const unique = new Map<string, DockerPortInfo>();

  for (const port of ports) {
    const key = `${port.PublicPort ?? ''}|${port.PrivatePort}|${port.Type}`;
    if (!unique.has(key)) {
      unique.set(key, port);
    }
  }

  return Array.from(unique.values()).sort((a, b) => {
    const aPub = a.PublicPort ?? Number.MAX_SAFE_INTEGER;
    const bPub = b.PublicPort ?? Number.MAX_SAFE_INTEGER;
    if (aPub !== bPub) {
      return aPub - bPub;
    }

    if (a.PrivatePort !== b.PrivatePort) {
      return a.PrivatePort - b.PrivatePort;
    }

    return a.Type.localeCompare(b.Type);
  });
}
