import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger';

const execFileAsync = promisify(execFile);

export type DockerConnection = DockerUnixConnection | DockerNpipeConnection | DockerTcpConnection;

export type DockerUnixConnection = {
  type: 'unix';
  path: string;
};

export type DockerNpipeConnection = {
  type: 'npipe';
  path: string;
};

export type DockerTcpConnection = {
  type: 'tcp';
  host: string;
  port: number;
};

export type DockerConnectionSource = 'docker-host' | 'docker-context' | 'platform-default';

export type ResolvedDockerConnection = DockerConnection & {
  source: DockerConnectionSource;
};

type DockerContextInspect = {
  Endpoints?: {
    docker?: {
      Host?: string;
    };
  };
};

export async function resolveDockerConnection(): Promise<ResolvedDockerConnection> {
  logger.debug('[DockerConnection] Starting Docker connection resolution.');

  // 1. DOCKER_HOST
  // eslint-disable-next-line n/no-process-env
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost) {
    logger.debug(`[DockerConnection] DOCKER_HOST detected: ${dockerHost}`);

    try {
      logger.debug('[DockerConnection] Parsing DOCKER_HOST connection.');

      const connection = parseDockerHost(dockerHost);

      logger.debug(`[DockerConnection] DOCKER_HOST resolved to: ${JSON.stringify(connection)}`);
      logger.debug('[DockerConnection] Checking DOCKER_HOST availability.');

      const available = await isConnectionAvailable(connection);
      if (available) {
        logger.info(`[DockerConnection] Docker connection resolved using DOCKER_HOST: ${dockerHost}`);
        return {
          ...connection,
          source: 'docker-host'
        };
      }
      logger.debug('[DockerConnection] DOCKER_HOST endpoint is not available. Continuing with Docker context.');
    } catch (error) {
      logger.debug(
        `[DockerConnection] Failed to resolve DOCKER_HOST. Continuing with Docker context. Error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    logger.debug('[DockerConnection] DOCKER_HOST is not set. Continuing with Docker context.');
  }

  // 2. Current Docker context
  logger.debug('[DockerConnection] Resolving current Docker context.');
  const contextName = await getCurrentDockerContextName();
  if (contextName) {
    logger.debug(`[DockerConnection] Current Docker context: ${contextName}`);
  } else {
    logger.debug('[DockerConnection] No active Docker context could be determined.');
  }

  const contextConnection = await resolveCurrentDockerContext();
  if (contextConnection) {
    logger.debug(`[DockerConnection] Docker context endpoint resolved: ${JSON.stringify(contextConnection)}`);
    logger.debug('[DockerConnection] Checking Docker context endpoint availability.');

    const available = await isConnectionAvailable(contextConnection);
    if (available) {
      logger.info(`[DockerConnection] Docker connection resolved using Docker context: ${contextName ?? 'unknown'}`);

      return {
        ...contextConnection,
        source: 'docker-context'
      };
    }
    logger.debug('[DockerConnection] Docker context endpoint is not available. Continuing with platform default.');
  } else {
    logger.debug('[DockerConnection] Could not resolve a Docker endpoint from the current context.');
  }

  // 3. Platform default
  logger.debug(`[DockerConnection] Resolving platform default for platform: ${process.platform}`);

  const defaultConnection = getPlatformDefaultConnection();
  logger.debug(`[DockerConnection] Platform default Docker endpoint: ${JSON.stringify(defaultConnection)}`);
  logger.debug('[DockerConnection] Checking platform default endpoint availability.');

  const defaultAvailable = await isConnectionAvailable(defaultConnection);
  if (defaultAvailable) {
    logger.info(`[DockerConnection] Docker connection resolved using platform default.`);
    return {
      ...defaultConnection,
      source: 'platform-default'
    };
  }

  logger.debug('[DockerConnection] Platform default Docker endpoint is not available.');
  logger.debug('[DockerConnection] No Docker endpoint available yet.');
  throw new DockerConnectionError('Docker engine is not available.', {
    dockerHost,
    context: contextName,
    defaultConnection
  });
}

function parseDockerHost(value: string): DockerConnection {
  logger.debug(`[DockerConnection] Parsing Docker host: ${value}`);
  const normalized = value.trim();

  if (normalized.startsWith('unix://')) {
    const path = normalized.slice('unix://'.length);
    logger.debug(`[DockerConnection] Detected Unix socket: ${path}`);
    return {
      type: 'unix',
      path
    };
  }

  if (normalized.startsWith('npipe://')) {
    const path = normalized.slice('npipe://'.length);
    logger.debug(`[DockerConnection] Detected Windows named pipe: ${path}`);
    return {
      type: 'npipe',
      path
    };
  }

  if (normalized.startsWith('tcp://')) {
    const url = new URL(normalized);
    const host = url.hostname;
    const port = Number(url.port || 2375);
    logger.debug(`[DockerConnection] Detected TCP endpoint: ${host}:${port}`);
    return {
      type: 'tcp',
      host,
      port
    };
  }

  logger.error(`[DockerConnection] Unsupported Docker host format: ${value}`);
  throw new Error(`Unsupported DOCKER_HOST: ${value}`);
}

async function resolveCurrentDockerContext(): Promise<DockerConnection | null> {
  try {
    const contextName = await getCurrentDockerContextName();
    if (!contextName) {
      logger.debug('[DockerConnection] No current Docker context.');
      return null;
    }

    logger.debug(`[DockerConnection] Inspecting Docker context: ${contextName}`);
    const { stdout } = await execFileAsync('docker', ['context', 'inspect', contextName, '--format', '{{json .}}'], {
      encoding: 'utf8',
      windowsHide: true
    });
    const context = JSON.parse(stdout.trim()) as DockerContextInspect;
    const host = context.Endpoints?.docker?.Host;
    if (!host) {
      logger.debug(`[DockerConnection] Docker context '${contextName}' has no Docker endpoint.`);
      return null;
    }

    logger.debug(`[DockerConnection] Docker context '${contextName}' endpoint: ${host}`);
    return parseDockerHost(host);
  } catch (error) {
    logger.debug(
      `[DockerConnection] Failed to resolve Docker context: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

async function getCurrentDockerContextName(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('docker', ['context', 'show'], {
      encoding: 'utf8',
      windowsHide: true
    });
    const context = stdout.trim();
    return context || null;
  } catch {
    return null;
  }
}

function getPlatformDefaultConnection(): DockerConnection {
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

async function isConnectionAvailable(connection: DockerConnection): Promise<boolean> {
  logger.debug(`[DockerConnection] Checking connection: ${JSON.stringify(connection)}`);

  switch (connection.type) {
    case 'unix': {
      const available = await socketExists(connection.path);
      logger.debug(`[DockerConnection] Unix socket ${connection.path}: ${available ? 'available' : 'not available'}`);
      return available;
    }
    case 'npipe': {
      const available = await socketExists(connection.path);
      logger.debug(
        `[DockerConnection] Windows named pipe ${connection.path}: ${available ? 'available' : 'not available'}`
      );
      return available;
    }
    case 'tcp': {
      logger.debug(
        `[DockerConnection] TCP endpoint ${connection.host}:${connection.port} accepted as a candidate endpoint.`
      );
      return true;
    }
  }
}

async function socketExists(socketPath: string): Promise<boolean> {
  try {
    await access(socketPath);
    return true;
  } catch {
    return false;
  }
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
