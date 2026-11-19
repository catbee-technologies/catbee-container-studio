import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../../logger';
import { getDockerCliPath } from '../runtime/docker.runtime';
import type { DockerConnection, DockerContextInspect } from '../types/connection.types';
import {
  dockerCliEnv,
  getPlatformDefaultConnection,
  parseDockerHost,
  resolveReachableDockerContext
} from '../docker.connection';
import {
  CATBEE_LIMA_INSTANCE,
  CATBEE_WINDOWS_PIPE_PATH,
  getLimaHomeDir,
  getLinuxRuntimeDir
} from '../embedded/engine-paths';
import { connectionToUri } from '../embedded/engine-utils';
import { resolveContainersProxy, type ResolvedProxy } from '../embedded/daemon-config';
import { getEngineSettings } from '../embedded/engine-settings';
import { detectSystemProxy } from '../embedded/system-proxy';
import { engineManager } from '../embedded/engine.manager';

const execFileAsync = promisify(execFile);

export interface DockerContextItem {
  name: string;
  description: string;
  dockerEndpoint: string;
  current: boolean;
  error?: string;
}

/** An environment variable that makes the Docker CLI ignore the selected context. */
export interface DockerContextOverride {
  variable: 'DOCKER_HOST' | 'DOCKER_CONTEXT';
  value: string;
  /** Shell profile that exports it (with line number), when found. */
  source: string | null;
}

export interface DockerContextDetails {
  cliAvailable: boolean;
  /** Set when an exported DOCKER_HOST/DOCKER_CONTEXT sends terminal `docker` commands away from `currentContext`. */
  envOverride: DockerContextOverride | null;
  currentContext: string | null;
  contexts: DockerContextItem[];
  catbeeContextExists: boolean;
  isCatBeeActive: boolean;
  defaultEndpoint: string;
}

export const CATBEE_CONTEXT_NAME = 'catbee-desktop';

const OVERRIDE_VARIABLES = ['DOCKER_HOST', 'DOCKER_CONTEXT'] as const;
const SHELL_PROFILES = [
  '.zshenv',
  '.zprofile',
  '.zshrc',
  '.bash_profile',
  '.bashrc',
  '.profile',
  '.config/fish/config.fish'
];

/** Finds an exported DOCKER_HOST/DOCKER_CONTEXT in the app environment or the user's shell profiles. */
async function detectContextOverride(): Promise<DockerContextOverride | null> {
  const fromProfiles = process.platform === 'win32' ? null : await findOverrideInShellProfiles();
  for (const variable of OVERRIDE_VARIABLES) {
    // eslint-disable-next-line n/no-process-env
    const value = process.env[variable]?.trim();
    if (value) {
      const source = fromProfiles?.variable === variable ? fromProfiles.source : null;
      return { variable, value, source };
    }
  }
  return fromProfiles;
}

async function findOverrideInShellProfiles(): Promise<DockerContextOverride | null> {
  const pattern = /^\s*(?:export\s+|set\s+-gx\s+)?(DOCKER_HOST|DOCKER_CONTEXT)[=\s]\s*["']?([^"'#\s]+)/;
  for (const profile of SHELL_PROFILES) {
    const content = await readFile(path.join(os.homedir(), profile), 'utf8').catch(() => null);
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const match = pattern.exec(lines[index]);
      if (match) {
        return {
          variable: match[1] as DockerContextOverride['variable'],
          value: match[2].replace(/\$\{HOME\}|\$HOME(?!\w)/g, () => os.homedir()),
          source: `~/${profile}:${index + 1}`
        };
      }
    }
  }
  return null;
}

/** False when the override reaches the selected context's engine anyway (e.g. DOCKER_HOST set to its socket). */
function overrideRedirects(override: DockerContextOverride, contexts: DockerContextItem[]): boolean {
  const current = contexts.find(c => c.current);
  const target =
    override.variable === 'DOCKER_HOST'
      ? override.value
      : contexts.find(c => c.name === override.value)?.dockerEndpoint;
  return !current || !target || normalizeEndpoint(target) !== normalizeEndpoint(current.dockerEndpoint);
}

/** Endpoint of the built-in engine: the live one when running, otherwise the well-known per-OS address. */
export function getDefaultCatBeeEndpoint(): string {
  const active = engineManager.activeConnection;
  if (active) {
    return connectionToUri(active);
  }
  switch (process.platform) {
    case 'win32':
      return `npipe://${CATBEE_WINDOWS_PIPE_PATH}`;
    case 'darwin':
      return `unix://${path.join(getLimaHomeDir(), CATBEE_LIMA_INSTANCE, 'sock', 'docker.sock')}`;
    default:
      return `unix://${path.join(getLinuxRuntimeDir(), 'docker.sock')}`;
  }
}

export async function getDockerContextInfo(): Promise<DockerContextDetails> {
  const defaultEndpoint = getDefaultCatBeeEndpoint();
  const [dockerPath, envOverride] = await Promise.all([getDockerCliPath(), detectContextOverride()]);

  if (!dockerPath) {
    return {
      cliAvailable: false,
      envOverride,
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
      windowsHide: true,
      env: dockerCliEnv()
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
          Error?: string;
        };

        if (parsed.Name) {
          const isCurrent = parsed.Current === true || parsed.Current === 'true' || parsed.Current === '*';
          contexts.push({
            name: parsed.Name,
            description: parsed.Description ?? '',
            dockerEndpoint: parsed.DockerEndpoint ?? '',
            current: isCurrent,
            error: parsed.Error ? String(parsed.Error) : undefined
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
      envOverride: envOverride && overrideRedirects(envOverride, contexts) ? envOverride : null,
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
      envOverride,
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
    windowsHide: true,
    env: dockerCliEnv()
  });

  return getDockerContextInfo();
}

export async function resolveDockerContextConnection(contextName: string): Promise<DockerConnection | null> {
  if (contextName === CATBEE_CONTEXT_NAME) {
    return engineManager.activeConnection ?? parseDockerHost(getDefaultCatBeeEndpoint());
  }

  const dockerPath = await getDockerCliPath();
  if (!dockerPath) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(dockerPath, ['context', 'inspect', contextName, '--format', '{{json .}}'], {
      encoding: 'utf8',
      windowsHide: true,
      env: dockerCliEnv()
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
          windowsHide: true,
          env: dockerCliEnv()
        }
      );
    } catch {
      // If update fails, recreate
      try {
        await execFileAsync(dockerPath, ['context', 'rm', CATBEE_CONTEXT_NAME], {
          encoding: 'utf8',
          windowsHide: true,
          env: dockerCliEnv()
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
            windowsHide: true,
            env: dockerCliEnv()
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
        windowsHide: true,
        env: dockerCliEnv()
      }
    );
  }

  if (setAsActive) {
    await useDockerContext(CATBEE_CONTEXT_NAME);
  }

  return getDockerContextInfo();
}

/**
 * Writes the containers proxy into the Docker CLI config (~/.docker/config.json "proxies"), keyed by the
 * CatBee endpoint so `docker run`/`docker build` against CatBee get HTTP(S)_PROXY without affecting other contexts.
 */
export async function syncCatBeeCliProxies(endpoint: string, proxy: ResolvedProxy | null): Promise<void> {
  // eslint-disable-next-line n/no-process-env
  const configDir = process.env.DOCKER_CONFIG ?? path.join(os.homedir(), '.docker');
  const configPath = path.join(configDir, 'config.json');

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err }, '[DockerContextManager] Docker CLI config is unreadable; leaving proxies untouched.');
      return;
    }
  }

  const proxies = { ...(config.proxies as Record<string, unknown> | undefined) };
  const entry: Record<string, string> = {};
  if (proxy?.httpProxy) entry.httpProxy = proxy.httpProxy;
  if (proxy?.httpsProxy) entry.httpsProxy = proxy.httpsProxy;
  if (proxy?.noProxy && (proxy.httpProxy || proxy.httpsProxy)) entry.noProxy = proxy.noProxy;

  const previous = JSON.stringify(proxies[endpoint] ?? null);
  if (Object.keys(entry).length) {
    proxies[endpoint] = entry;
  } else {
    delete proxies[endpoint];
  }
  if (JSON.stringify(proxies[endpoint] ?? null) === previous) {
    return;
  }

  if (Object.keys(proxies).length) {
    config.proxies = proxies;
  } else {
    delete config.proxies;
  }
  await mkdir(configDir, { recursive: true });
  const tempPath = `${configPath}.catbee.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
  await rename(tempPath, configPath);
  logger.info(`[DockerContextManager] Updated Docker CLI proxy configuration for ${endpoint}.`);
}

/**
 * Points the global Docker CLI at the running built-in engine (the catbee-desktop context) and
 * publishes the containers proxy for it. Best effort: a missing Docker CLI is not an error.
 */
export async function activateCatBeeEngineContext(connection: DockerConnection): Promise<void> {
  const endpoint = connectionToUri(connection);
  try {
    if (!(await getDockerCliPath())) {
      logger.info('[DockerContextManager] Docker CLI not found; skipping catbee-desktop context setup.');
      return;
    }
    await setupCatBeeContext(true, endpoint);
    const settings = await getEngineSettings();
    await syncCatBeeCliProxies(endpoint, resolveContainersProxy(settings, await detectSystemProxy()));
  } catch (err) {
    logger.warn({ err }, '[DockerContextManager] Failed to activate the catbee-desktop context.');
  }
}

/**
 * Moves the global Docker CLI off catbee-desktop when CatBee runs on another engine, so `docker` in a terminal
 * talks to the same engine as the app. Other contexts the user picked are left alone. Best effort.
 */
export async function releaseCatBeeContext(connection: DockerConnection): Promise<void> {
  try {
    if (!(await getDockerCliPath())) return;
    const info = await getDockerContextInfo();
    if (!info.isCatBeeActive) return;
    const target = await pickNonCatBeeContext(info, connection);
    logger.info(`[DockerContextManager] CatBee is using an external engine; switching the Docker CLI to "${target}".`);
    await useDockerContext(target);
  } catch (err) {
    logger.warn({ err }, '[DockerContextManager] Failed to switch the Docker CLI away from catbee-desktop.');
  }
}

/**
 * The context to fall back to from catbee-desktop: the one pointing at `connection`, else the first other context
 * whose engine answers, else "default".
 */
async function pickNonCatBeeContext(info: DockerContextDetails, connection?: DockerConnection): Promise<string> {
  if (connection) {
    const endpoint = normalizeEndpoint(connectionToUri(connection));
    const match = info.contexts.find(
      c => c.name !== CATBEE_CONTEXT_NAME && normalizeEndpoint(c.dockerEndpoint) === endpoint
    );
    if (match) return match.name;
  }
  return (await resolveReachableDockerContext())?.contextName ?? 'default';
}

export interface BuilderInstanceDetails {
  name: string;
  driver: string;
  status: 'running' | 'stopped' | 'error';
  endpoint?: string;
  isCurrent: boolean;
  storageLimit?: string;
  usedBytes?: number;
  sharedBytes?: number;
  platforms?: string[];
}

export interface DockerBuilderInfo {
  currentBuilder: string;
  builders: BuilderInstanceDetails[];
}

/** Compares endpoints across spellings such as `npipe:////./pipe/x` and `npipe://\\.\pipe\x`. */
function normalizeEndpoint(endpoint: string): string {
  let normalized = endpoint.trim().replaceAll('\\', '/');
  normalized = normalized.replace(/^([a-z]+):\/+/i, '$1://');
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.toLowerCase();
}

/** Removes the catbee-desktop context (moving the CLI to another context first if it was active). */
export async function removeCatBeeContext(): Promise<void> {
  const dockerPath = await getDockerCliPath();
  if (!dockerPath) return;
  const info = await getDockerContextInfo();
  if (!info.catbeeContextExists) return;
  const endpoint = info.contexts.find(c => c.name === CATBEE_CONTEXT_NAME)?.dockerEndpoint;
  if (info.isCatBeeActive) {
    await execFileAsync(dockerPath, ['context', 'use', await pickNonCatBeeContext(info)], {
      encoding: 'utf8',
      windowsHide: true,
      env: dockerCliEnv()
    });
  }
  await execFileAsync(dockerPath, ['context', 'rm', '--force', CATBEE_CONTEXT_NAME], {
    encoding: 'utf8',
    windowsHide: true,
    env: dockerCliEnv()
  });
  if (endpoint) {
    await syncCatBeeCliProxies(endpoint, null);
  }
}

async function resolveContextStatus(
  ctx: { name: string; error?: string; dockerEndpoint?: string },
  isCurrent: boolean,
  dockerManager: { system?: { ping: () => Promise<boolean> } } | null,
  parseDockerHost: (endpoint: string) => DockerConnection,
  pingDockerConnection: (connection: DockerConnection) => Promise<boolean>
): Promise<{ status: 'running' | 'stopped' | 'error'; errorMsg?: string }> {
  if (ctx.error) {
    return { status: 'error', errorMsg: ctx.error };
  }
  if (isCurrent && dockerManager?.system) {
    try {
      const alive = await dockerManager.system.ping();
      return { status: alive ? 'running' : 'stopped' };
    } catch {
      return { status: 'stopped' };
    }
  }
  if (!ctx.dockerEndpoint) {
    return { status: 'stopped' };
  }

  try {
    const connection = parseDockerHost(ctx.dockerEndpoint);
    const alive = await pingDockerConnection(connection);
    if (alive) {
      return { status: 'running' };
    }
    if (ctx.name === CATBEE_CONTEXT_NAME) {
      return { status: 'stopped' };
    }
    return {
      status: 'error',
      errorMsg: `Cannot connect to the Docker daemon at ${ctx.dockerEndpoint}. Is the container engine running?`
    };
  } catch (err) {
    if (ctx.name === CATBEE_CONTEXT_NAME) {
      return { status: 'stopped' };
    }
    return {
      status: 'error',
      errorMsg: err instanceof Error ? err.message : `Failed to parse or connect to ${ctx.dockerEndpoint}`
    };
  }
}

/** Queries build cache from docker df and combines with context & daemon builder info. */
export async function getDockerBuilderInfo(): Promise<DockerBuilderInfo> {
  const contextInfo = await getDockerContextInfo();
  const currentContextName = contextInfo.currentContext ?? CATBEE_CONTEXT_NAME;

  let usedBytes = 0;
  let sharedBytes = 0;

  try {
    const { dockerManager } = await import('../services/docker.manager.js');
    if (dockerManager?.system) {
      const df = (await dockerManager.system.diskUsage()) as {
        BuildCache?: Array<{ Size?: number; Shared?: boolean }>;
      };
      if (Array.isArray(df?.BuildCache)) {
        for (const item of df.BuildCache) {
          const sz = item.Size ?? 0;
          usedBytes += sz;
          if (item.Shared) {
            sharedBytes += sz;
          }
        }
      }
    }
  } catch (err) {
    logger.debug({ err }, '[DockerContextManager] Could not read BuildCache via docker df.');
  }

  // Common multi-platform emulations supported by contemporary BuildKit & Linux engines
  const defaultPlatforms = [
    'linux/amd64',
    'linux/arm64',
    'linux/riscv64',
    'linux/ppc64le',
    'linux/s390x',
    'linux/arm/v7',
    'linux/arm/v6'
  ];

  const { parseDockerHost, pingDockerConnection } = await import('../docker.connection.js');
  const { dockerManager } = await import('../services/docker.manager.js').catch(() => ({ dockerManager: null }));

  const builders: BuilderInstanceDetails[] = await Promise.all(
    contextInfo.contexts.map(async ctx => {
      const isCurrent = ctx.name === currentContextName;
      const { status, errorMsg } = await resolveContextStatus(
        ctx,
        isCurrent,
        dockerManager,
        parseDockerHost,
        pingDockerConnection
      );

      return {
        name: ctx.name,
        driver: 'docker',
        status,
        error: errorMsg,
        endpoint: ctx.dockerEndpoint,
        isCurrent,
        storageLimit: '20 GB',
        usedBytes: isCurrent ? usedBytes : 0,
        sharedBytes: isCurrent ? sharedBytes : 0,
        platforms: defaultPlatforms
      };
    })
  );

  if (builders.length === 0) {
    let alive = false;
    try {
      alive = (await dockerManager?.system?.ping()) ?? false;
    } catch {
      alive = false;
    }
    builders.push({
      name: CATBEE_CONTEXT_NAME,
      driver: 'docker',
      status: alive ? 'running' : 'stopped',
      endpoint: contextInfo.defaultEndpoint,
      isCurrent: true,
      storageLimit: '20 GB',
      usedBytes,
      sharedBytes,
      platforms: defaultPlatforms
    });
  }

  return {
    currentBuilder: currentContextName,
    builders
  };
}
