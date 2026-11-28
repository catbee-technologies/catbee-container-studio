import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger as appLogger } from '../logger';
import { getDockerCliPath } from './runtime/docker.runtime';
import { pingDockerEndpoint } from './embedded/engine-utils';
import type { DockerConnection, DockerContextInspect, ResolvedDockerConnection } from './types/connection.types';
import { CATBEE_CONTEXT_NAME } from '../../constants.docker';

const logger = appLogger.child({}, { msgPrefix: '[DockerConnection] ' });

const execFileAsync = promisify(execFile);

/**
 * Environment for Docker CLI calls. DOCKER_HOST/DOCKER_CONTEXT are dropped so the CLI reports and switches the
 * context saved in ~/.docker/config.json instead of whatever the shell that launched the app exported.
 */
export function dockerCliEnv(): NodeJS.ProcessEnv {
  // eslint-disable-next-line n/no-process-env
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (['DOCKER_HOST', 'DOCKER_CONTEXT'].includes(key.toUpperCase())) delete env[key];
  }
  return env;
}

/**
 * Resolves an active external Docker connection via:
 * 1. DOCKER_HOST environment variable
 * 2. Current Docker context inspect
 * 3. Platform default socket / named pipe
 * 4. Any other CLI context whose engine answers (e.g. rancher-desktop while catbee-desktop is current)
 */
export async function resolveExternalDockerConnection(): Promise<ResolvedDockerConnection | null> {
  logger.debug('Starting external Docker connection resolution.');

  // 1. DOCKER_HOST
  // eslint-disable-next-line n/no-process-env
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost) {
    logger.debug(`DOCKER_HOST detected: ${dockerHost}`);
    try {
      const connection = parseDockerHost(dockerHost);
      const available = await isConnectionAvailable(connection);
      if (available) {
        logger.debug(`Docker connection resolved using DOCKER_HOST: ${dockerHost}`);
        return {
          ...connection,
          source: 'docker-host'
        };
      }
    } catch (error) {
      logger.warn({ err: error }, 'Could not use DOCKER_HOST. Trying other Docker endpoints.');
    }
  }

  // 2. Current Docker context
  const contextConnection = await resolveCurrentDockerContext();
  if (contextConnection) {
    const available = await isConnectionAvailable(contextConnection);
    if (available) {
      logger.debug('Docker connection resolved using Docker context.');
      return {
        ...contextConnection,
        source: 'docker-context'
      };
    }
  }

  // 3. Platform default socket / named pipe
  const defaultConnection = getPlatformDefaultConnection();
  const defaultAvailable = await isConnectionAvailable(defaultConnection);
  if (defaultAvailable) {
    logger.debug('Docker connection resolved using platform default socket/pipe.');
    return {
      ...defaultConnection,
      source: 'platform-default'
    };
  }

  // 4. Another CLI context
  const reachableContext = await resolveReachableDockerContext();
  if (reachableContext) {
    logger.debug(`Docker connection resolved using context "${reachableContext.contextName}".`);
    return {
      ...reachableContext.connection,
      source: 'docker-context'
    };
  }

  logger.debug('No external Docker connection is currently active.');
  return null;
}

export async function resolveDockerConnection(): Promise<ResolvedDockerConnection> {
  const external = await resolveExternalDockerConnection();
  if (external) {
    return external;
  }
  throw new DockerConnectionError('No external Docker connection is available.');
}

export function parseDockerHost(value: string): DockerConnection {
  const normalized = value.trim();

  if (normalized.startsWith('unix://')) {
    const path = normalized.slice('unix://'.length);
    return { type: 'unix', path };
  }

  if (normalized.startsWith('npipe://')) {
    const path = normalized.slice('npipe://'.length);
    return { type: 'npipe', path };
  }

  if (normalized.startsWith('tcp://')) {
    const url = new URL(normalized);
    const host = url.hostname;
    const port = Number(url.port || 2375);
    return { type: 'tcp', host, port };
  }

  throw new Error(`Unsupported DOCKER_HOST: ${value}`);
}

export async function resolveCurrentDockerContext(): Promise<DockerConnection | null> {
  try {
    const dockerPath = await getDockerCliPath();
    if (!dockerPath) {
      return null;
    }
    const contextName = await getCurrentDockerContextName(dockerPath);
    if (!contextName || contextName === CATBEE_CONTEXT_NAME) {
      return null;
    }

    const { stdout } = await execFileAsync(dockerPath, ['context', 'inspect', contextName, '--format', '{{json .}}'], {
      encoding: 'utf8',
      windowsHide: true,
      env: dockerCliEnv()
    });
    const context = JSON.parse(stdout.trim()) as DockerContextInspect;
    const host = context.Endpoints?.docker?.Host;
    if (!host) {
      return null;
    }

    return parseDockerHost(host);
  } catch {
    return null;
  }
}

export async function getCurrentDockerContextName(dockerPath?: string): Promise<string | null> {
  try {
    const resolvedDockerPath = dockerPath ?? (await getDockerCliPath());
    if (!resolvedDockerPath) {
      return null;
    }
    const { stdout } = await execFileAsync(resolvedDockerPath, ['context', 'show'], {
      encoding: 'utf8',
      windowsHide: true,
      env: dockerCliEnv()
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function getPlatformDefaultConnection(): DockerConnection {
  switch (process.platform) {
    case 'win32':
      return {
        type: 'npipe',
        path: '//./pipe/docker_engine'
      };
    case 'darwin':
    case 'linux':
      return {
        type: 'unix',
        path: '/var/run/docker.sock'
      };
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

export async function isConnectionAvailable(connection: DockerConnection): Promise<boolean> {
  return await pingDockerConnection(connection);
}

/**
 * First non-CatBee CLI context (in `docker context ls` order) whose engine answers a ping. Contexts over
 * SSH or other transports are skipped.
 */
export async function resolveReachableDockerContext(): Promise<{
  contextName: string;
  connection: DockerConnection;
} | null> {
  const dockerPath = await getDockerCliPath();
  if (!dockerPath) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync(dockerPath, ['context', 'ls', '--format', '{{json .}}'], {
      encoding: 'utf8',
      windowsHide: true,
      env: dockerCliEnv()
    });
    for (const line of stdout.split(/\r?\n/)) {
      let context: { Name?: string; DockerEndpoint?: string };
      try {
        context = JSON.parse(line) as { Name?: string; DockerEndpoint?: string };
      } catch {
        continue;
      }
      const { Name: name, DockerEndpoint: endpoint } = context;
      if (!name || name === CATBEE_CONTEXT_NAME || !endpoint || !/^(unix|npipe|tcp):\/\//.test(endpoint)) {
        continue;
      }
      const connection = parseDockerHost(endpoint);
      if (await pingDockerConnection(connection)) {
        return { contextName: name, connection };
      }
    }
  } catch (err) {
    logger.debug({ err }, 'Could not scan Docker contexts.');
  }
  return null;
}

/** True when a Docker engine answers `/_ping` on the connection (a socket file alone may be stale). */
export async function pingDockerConnection(connection: DockerConnection): Promise<boolean> {
  return await pingDockerEndpoint(connection, 1500);
}

export class DockerConnectionError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'DockerConnectionError';
  }
}
