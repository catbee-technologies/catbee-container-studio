import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../logger';
import { getDockerCliPath } from '../runtime/docker.runtime';
import type { DockerConnection, DockerContextInspect } from '../types/connection.types';
import { getPlatformDefaultConnection, parseDockerHost } from '../docker.connection';

const execFileAsync = promisify(execFile);

export interface DockerContextItem {
  name: string;
  description: string;
  dockerEndpoint: string;
  current: boolean;
}

export interface DockerContextDetails {
  cliAvailable: boolean;
  currentContext: string | null;
  contexts: DockerContextItem[];
  catbeeContextExists: boolean;
  isCatBeeActive: boolean;
  defaultEndpoint: string;
}

export const CATBEE_CONTEXT_NAME = 'catbee-desktop';

export function getDefaultCatBeeEndpoint(): string {
  if (process.platform === 'win32') {
    return 'npipe:////./pipe/catbee-desktop';
  }
  return 'unix:///var/run/docker.sock';
}

export async function getDockerContextInfo(): Promise<DockerContextDetails> {
  const defaultEndpoint = getDefaultCatBeeEndpoint();
  const dockerPath = await getDockerCliPath();

  if (!dockerPath) {
    return {
      cliAvailable: false,
      currentContext: null,
      contexts: [],
      catbeeContextExists: false,
      isCatBeeActive: false,
      defaultEndpoint
    };
  }

  try {
    const { stdout } = await execFileAsync(dockerPath, ['context', 'ls', '--format', '{{json .}}'], {
      encoding: 'utf8',
      windowsHide: true
    });

    const lines = stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    const contexts: DockerContextItem[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as {
          Current?: boolean | string;
          Description?: string;
          DockerEndpoint?: string;
          Name?: string;
        };

        if (parsed.Name) {
          const isCurrent = parsed.Current === true || parsed.Current === 'true' || parsed.Current === '*';
          contexts.push({
            name: parsed.Name,
            description: parsed.Description ?? '',
            dockerEndpoint: parsed.DockerEndpoint ?? '',
            current: isCurrent
          });
        }
      } catch {
        // Skip malformed JSON line
      }
    }

    const currentItem = contexts.find(c => c.current);
    const currentContext = currentItem?.name ?? null;
    const catbeeContextExists = contexts.some(c => c.name === CATBEE_CONTEXT_NAME);
    const isCatBeeActive = currentContext === CATBEE_CONTEXT_NAME;

    return {
      cliAvailable: true,
      currentContext,
      contexts,
      catbeeContextExists,
      isCatBeeActive,
      defaultEndpoint
    };
  } catch (err) {
    logger.warn({ err }, '[DockerContextManager] Failed to list docker contexts.');
    return {
      cliAvailable: true,
      currentContext: null,
      contexts: [],
      catbeeContextExists: false,
      isCatBeeActive: false,
      defaultEndpoint
    };
  }
}

export async function useDockerContext(contextName: string): Promise<DockerContextDetails> {
  const dockerPath = await getDockerCliPath();
  if (!dockerPath) {
    throw new Error('Docker CLI is not found on your system.');
  }

  logger.info(`[DockerContextManager] Switching docker context to: ${contextName}`);
  await execFileAsync(dockerPath, ['context', 'use', contextName], {
    encoding: 'utf8',
    windowsHide: true
  });

  return getDockerContextInfo();
}

export async function resolveDockerContextConnection(contextName: string): Promise<DockerConnection | null> {
  if (contextName === CATBEE_CONTEXT_NAME) {
    if (process.platform === 'win32') {
      return { type: 'npipe', path: '//./pipe/catbee-desktop' };
    }
    return { type: 'unix', path: '/var/run/docker.sock' };
  }

  const dockerPath = await getDockerCliPath();
  if (!dockerPath) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(dockerPath, ['context', 'inspect', contextName, '--format', '{{json .}}'], {
      encoding: 'utf8',
      windowsHide: true
    });
    const context = JSON.parse(stdout.trim()) as DockerContextInspect;
    const host = context.Endpoints?.docker?.Host;
    if (host) {
      return parseDockerHost(host);
    }
    return getPlatformDefaultConnection();
  } catch {
    return getPlatformDefaultConnection();
  }
}

export async function setupCatBeeContext(setAsActive = false, customEndpoint?: string): Promise<DockerContextDetails> {
  const dockerPath = await getDockerCliPath();
  if (!dockerPath) {
    throw new Error('Docker CLI is not found on your system.');
  }

  const endpoint = customEndpoint ?? getDefaultCatBeeEndpoint();
  const info = await getDockerContextInfo();

  if (info.catbeeContextExists) {
    logger.info(`[DockerContextManager] Updating ${CATBEE_CONTEXT_NAME} context with endpoint: ${endpoint}`);
    try {
      await execFileAsync(
        dockerPath,
        [
          'context',
          'update',
          CATBEE_CONTEXT_NAME,
          '--description',
          'CatBee Container Studio Engine',
          '--docker',
          `host=${endpoint}`
        ],
        {
          encoding: 'utf8',
          windowsHide: true
        }
      );
    } catch {
      // If update fails, recreate
      try {
        await execFileAsync(dockerPath, ['context', 'rm', CATBEE_CONTEXT_NAME], {
          encoding: 'utf8',
          windowsHide: true
        });
        await execFileAsync(
          dockerPath,
          [
            'context',
            'create',
            CATBEE_CONTEXT_NAME,
            '--description',
            'CatBee Container Studio Engine',
            '--docker',
            `host=${endpoint}`
          ],
          {
            encoding: 'utf8',
            windowsHide: true
          }
        );
      } catch (err) {
        logger.error({ err }, '[DockerContextManager] Failed to update/recreate context.');
      }
    }
  } else {
    logger.info(`[DockerContextManager] Creating ${CATBEE_CONTEXT_NAME} context with endpoint: ${endpoint}`);
    await execFileAsync(
      dockerPath,
      [
        'context',
        'create',
        CATBEE_CONTEXT_NAME,
        '--description',
        'CatBee Container Studio Engine',
        '--docker',
        `host=${endpoint}`
      ],
      {
        encoding: 'utf8',
        windowsHide: true
      }
    );
  }

  if (setAsActive) {
    await useDockerContext(CATBEE_CONTEXT_NAME);
  }

  return getDockerContextInfo();
}
