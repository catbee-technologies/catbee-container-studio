import { createWriteStream } from 'node:fs';
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, type SpawnOptions } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { net, session } from 'electron';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { isDeepStrictEqual } from 'node:util';
import { logger as appLogger } from '../../logger';
import { DOCKER_CLI_RELEASE_VERSION } from '../../../constants.docker';
import type { DockerConnection } from '../types/connection.types';
import { getEngineSettings } from './engine-settings';
import type { EngineManifest } from './types/manifest.types';
import {
  getEngineBinDir,
  getEngineDownloadsDir,
  getEngineManifestPath,
  homeDir,
  SHELL_PROFILE_TARGETS
} from './engine-paths';

const logger = appLogger.child({}, { msgPrefix: '[EngineUtils] ' });

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  encoding?: BufferEncoding;
  onOutput?: (line: string) => void;
  signal?: AbortSignal;
}

/**
 * Environment variable names that can be used for shell injection or dynamic linker hijacking.
 * We strip these from every spawned process environment unless the caller explicitly re-adds them.
 */
const UNSAFE_ENV_KEYS = [
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'ELECTRON_RUN_AS_NODE'
];

/**
 * Returns a sanitized copy of an environment object with known code-injection
 * vectors removed. Callers may add back specific keys they control.
 */
function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of UNSAFE_ENV_KEYS) {
    delete result[key];
  }
  return result;
}

/** Runs a command without a shell, optionally feeding stdin, and rejects with stderr on failure. */
export function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  if (!command || typeof command !== 'string' || command.includes('\0')) {
    return Promise.reject(new Error('Invalid command executable.'));
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.includes('\0')) {
      return Promise.reject(new Error('Invalid command argument.'));
    }
  }
  if (options.signal?.aborted) {
    return Promise.reject(new Error('Command aborted'));
  }
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line n/no-process-env
    const baseEnv = options.env ?? process.env;
    const spawnOptions: SpawnOptions = {
      env: sanitizeEnv(baseEnv),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    };
    const child = spawn(command, args, spawnOptions);
    const encoding = options.encoding ?? 'utf8';
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timer: NodeJS.Timeout | null = null;
    let settled = false;
    let terminationError: Error | null = null;

    const doReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      reject(err);
    };

    const doResolve = (res: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve(res);
    };

    const signalChild = (signal: NodeJS.Signals): void => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            logger.warn({ err: error }, 'Could not signal command process group.');
            child.kill(signal);
          }
        }
      } else {
        child.kill(signal);
      }
    };

    const terminate = (error: Error): void => {
      if (terminationError || settled) return;
      terminationError = error;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => signalChild('SIGKILL'), 5_000);
      if (process.platform === 'win32' && child.pid) {
        // eslint-disable-next-line n/no-process-env
        const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '';
        const windowsDir = path.win32.isAbsolute(systemRoot) ? systemRoot : String.raw`C:\Windows`;
        const taskkillBin = path.win32.join(windowsDir, 'System32', 'taskkill.exe');
        const killer = spawn(taskkillBin, ['/pid', String(child.pid), '/f', '/t'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore'
        });
        killer.on('error', () => signalChild('SIGTERM'));
        killer.on('exit', code => {
          if (code !== 0) signalChild('SIGTERM');
        });
      } else {
        signalChild('SIGTERM');
      }
    };
    const abort = (): void => terminate(new Error('Command aborted'));
    if (options.timeoutMs) {
      timer = setTimeout(
        () => terminate(new Error(`Command timed out after ${options.timeoutMs}ms: ${command} ${args.join(' ')}`)),
        options.timeoutMs
      );
    }
    options.signal?.addEventListener('abort', abort, { once: true });

    const emitLines = (chunk: Buffer): void => {
      if (!options.onOutput) return;
      const text = chunk.toString(encoding).replaceAll('\0', '');
      for (const line of text.split(/[\r\n]+/)) {
        if (line.trim()) options.onOutput(line.trim());
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      emitLines(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      emitLines(chunk);
    });
    child.on('error', err => {
      doReject(err);
    });
    child.on('close', code => {
      if (terminationError || options.signal?.aborted) {
        doReject(terminationError ?? new Error('Command aborted'));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString(encoding).replaceAll('\0', '');
      const stderr = Buffer.concat(stderrChunks).toString(encoding).replaceAll('\0', '');
      if (code === 0) {
        doResolve({ stdout, stderr });
        return;
      }
      const lines = (stderr || stdout)
        .trim()
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean);
      const errorIndex = lines.findIndex(l => /^error:\s/i.test(l));
      let detail: string;
      if (errorIndex >= 0) {
        detail = lines.slice(errorIndex, errorIndex + 5).join('\n');
      } else {
        detail = lines.slice(-5).join('\n');
      }
      doReject(new Error(`${path.basename(command)} ${args[0] ?? ''} failed (exit ${code}): ${detail}`));
    });

    child.stdin?.on('error', terminate);
    if (options.signal?.aborted) abort();
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

export async function commandExists(command: string): Promise<boolean> {
  if (!command || typeof command !== 'string' || command.includes('\0')) {
    return false;
  }
  // eslint-disable-next-line n/no-process-env
  const envPath = process.env.PATH ?? '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const dirs = envPath.split(delimiter);

  // eslint-disable-next-line n/no-process-env
  const pathext = process.env.PATHEXT;
  const extensions = process.platform === 'win32' ? (pathext?.split(';') ?? ['.exe', '.cmd', '.bat']) : [''];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of extensions) {
      try {
        await stat(path.join(dir, command + ext));
        return true;
      } catch {
        // Continue checking next PATH directory
      }
    }
  }
  return false;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** e.g. "Downloading Lima 2.0.1 (12.4 MB of 45.1 MB)". */
export function describeDownload(label: string, receivedBytes: number, totalBytes: number): string {
  const size =
    totalBytes > 0
      ? `${formatMegabytes(receivedBytes)} of ${formatMegabytes(totalBytes)}`
      : formatMegabytes(receivedBytes);
  return `Downloading ${label} (${size})`;
}

/** Uses Chromium's proxy resolution and certificate trust for engine assets and release metadata. */
export async function fetchEngineResource(
  url: string,
  options?: Pick<RequestInit, 'headers' | 'redirect' | 'signal'>
): Promise<Response> {
  const proxy = (await getEngineSettings()).desktopProxy;
  if (proxy.mode === 'system') return net.fetch(url, options);

  const proxies = new Map<string, URL>();
  if (proxy.mode === 'manual') {
    if (proxy.httpProxy?.trim()) proxies.set('http', new URL(proxy.httpProxy.trim().replace(/^socks5h:/i, 'socks5:')));
    if (proxy.httpsProxy?.trim())
      proxies.set('https', new URL(proxy.httpsProxy.trim().replace(/^socks5h:/i, 'socks5:')));
  }
  const proxyRules = Array.from(proxies, ([scheme, server]) => `${scheme}=${server.protocol}//${server.host}`).join(
    ';'
  );
  const proxyBypassRules = proxy.mode === 'manual' ? proxy.noProxy : undefined;
  const key = createHash('sha256')
    .update(JSON.stringify([Array.from(proxies), proxyBypassRules]))
    .digest('hex');
  let configuredSession = downloadSessions.get(key);
  if (!configuredSession) {
    const downloadSession = session.fromPartition(`catbee-engine-download-${key}`);
    configuredSession = downloadSession
      .setProxy(proxyRules ? { mode: 'fixed_servers', proxyRules, proxyBypassRules } : { mode: 'direct' })
      .then(() => downloadSession)
      .catch(error => {
        downloadSessions.delete(key);
        throw error;
      });
    downloadSessions.set(key, configuredSession);
  }
  const downloadSession = await configuredSession;
  const authenticatedProxies = Array.from(proxies.values()).filter(server => server.username || server.password);
  if (!authenticatedProxies.length) return downloadSession.fetch(url, options);
  return fetchWithProxyCredentials(downloadSession, authenticatedProxies, url, options);
}

const downloadSessions = new Map<string, Promise<Electron.Session>>();

function fetchWithProxyCredentials(
  downloadSession: Electron.Session,
  proxies: URL[],
  url: string,
  options?: Pick<RequestInit, 'headers' | 'redirect' | 'signal'>
): Promise<Response> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = net.request({ url, session: downloadSession, redirect: options?.redirect ?? 'follow' });
    for (const [name, value] of new Headers(options?.headers)) request.setHeader(name, value);
    const abort = () => request.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const attempted = new Set<URL>();
    request.on('login', (auth, reply) => {
      const proxy = proxies.find(
        server =>
          server.hostname === auth.host &&
          Number(server.port || (server.protocol === 'https:' ? 443 : 80)) === auth.port
      );
      if (!auth.isProxy || !proxy || attempted.has(proxy)) return reply();
      attempted.add(proxy);
      try {
        reply(decodeURIComponent(proxy.username), decodeURIComponent(proxy.password));
      } catch (error) {
        reply();
        reject(error);
      }
    });
    request.on('response', incoming => {
      if (!(incoming instanceof Readable)) {
        reject(new Error('Engine download did not return a readable response.'));
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
      }
      const status = incoming.statusCode;
      const body = status === 204 || status === 205 || status === 304 ? null : Readable.toWeb(incoming);
      resolve(
        new Response(body as ReadableStream<Uint8Array> | null, { status, statusText: incoming.statusMessage, headers })
      );
    });
    request.on('error', reject);
    request.on('abort', () => reject(signal?.reason ?? new Error('Engine download aborted.')));
    request.on('close', () => signal?.removeEventListener('abort', abort));
    request.end();
  });
}

/** Streams a download to disk, reporting progress (0..1) when the server provides a content length. */
export async function downloadFile(
  url: string,
  destination: string,
  onProgress?: (fraction: number, receivedBytes: number, totalBytes: number) => void
): Promise<void> {
  logger.info(`Downloading ${url}`);
  await mkdir(path.dirname(destination), { recursive: true });
  const response = await fetchEngineResource(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  }

  const total = Number(response.headers.get('content-length') ?? 0);
  let received = 0;
  const source = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (onProgress) {
      onProgress(total > 0 ? Math.min(1, received / total) : 0, received, total);
    }
  });

  const partial = `${destination}.${randomUUID()}.partial`;
  try {
    await pipeline(source, createWriteStream(partial));
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/** Extracts a .tar.gz/.tgz/.zip archive using the system tar (bsdtar on macOS/Windows 10+, GNU tar on Linux). */
export async function extractArchive(archive: string, destination: string, stripComponents = 0): Promise<void> {
  await mkdir(destination, { recursive: true });
  const args = ['-xf', archive, '-C', destination];
  if (stripComponents > 0) {
    args.push(`--strip-components=${stripComponents}`);
  }

  // eslint-disable-next-line n/no-process-env
  const systemRoot = process.env.SystemRoot;
  let tar = 'tar';
  if (process.platform === 'win32') {
    tar = systemRoot && path.isAbsolute(systemRoot) ? path.join(systemRoot, 'System32', 'tar.exe') : 'tar.exe';
  }
  await runCommand(tar, args, { timeoutMs: 10 * 60_000 });
}

/** Performs GET /_ping against a Docker endpoint (unix socket, named pipe, or TCP). */
export function pingDockerEndpoint(connection: DockerConnection, timeoutMs = 2_000): Promise<boolean> {
  return new Promise(resolve => {
    const options: http.RequestOptions =
      connection.type === 'tcp'
        ? { host: connection.host, port: connection.port, path: '/_ping', method: 'GET', timeout: timeoutMs }
        : { socketPath: toNodeSocketPath(connection), path: '/_ping', method: 'GET', timeout: timeoutMs };

    const req = http.request(options, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve(res.statusCode === 200 && body.trim() === 'OK'));
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

export function toNodeSocketPath(connection: DockerConnection): string {
  if (connection.type === 'npipe') {
    return connection.path.replaceAll('/', '\\');
  }
  if (connection.type === 'unix') {
    return connection.path;
  }
  throw new Error('TCP connections do not have a socket path.');
}

export async function waitForDockerEndpoint(
  connection: DockerConnection,
  timeoutMs: number,
  isAborted?: () => string | null
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await pingDockerEndpoint(connection)) {
      return;
    }
    const abortReason = isAborted?.();
    if (abortReason) {
      throw new Error(abortReason);
    }
    await sleep(1_000);
  }
  throw new Error(`Container engine did not respond to /_ping within ${Math.round(timeoutMs / 1000)} seconds.`);
}

export function connectionToUri(connection: DockerConnection): string {
  switch (connection.type) {
    case 'unix':
      return `unix://${connection.path}`;
    case 'npipe':
      return `npipe://${connection.path}`;
    case 'tcp':
      return `tcp://${connection.host}:${connection.port}`;
  }
}

/** Compares JSON without treating formatting or object key order as configuration changes. */
export function sameJson(a: string, b: string): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(a), JSON.parse(b));
  } catch {
    return false;
  }
}

/** Single-quotes a value for POSIX shells. */
export function shellQuote(value: string): string {
  const escaped = value.replaceAll("'", String.raw`'\''`);
  return `'${escaped}'`;
}

/** GETs a JSON document from the Docker API of the given endpoint. */
export function dockerApiGetJson<T>(connection: DockerConnection, apiPath: string, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions =
      connection.type === 'tcp'
        ? { host: connection.host, port: connection.port, path: apiPath, method: 'GET', timeout: timeoutMs }
        : { socketPath: toNodeSocketPath(connection), path: apiPath, method: 'GET', timeout: timeoutMs };
    const req = http.request(options, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (body += chunk));
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Docker API ${apiPath} returned ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body) as T);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Docker API ${apiPath} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

export async function getDockerServerVersion(connection: DockerConnection): Promise<string | null> {
  try {
    const version = await dockerApiGetJson<{ Version?: string }>(connection, '/version');
    return version.Version ?? null;
  } catch {
    return null;
  }
}

export async function readEngineManifest(): Promise<EngineManifest | null> {
  try {
    return JSON.parse(await readFile(getEngineManifestPath(), 'utf8')) as EngineManifest;
  } catch {
    return null;
  }
}

export async function writeEngineManifest(manifest: EngineManifest): Promise<void> {
  const manifestPath = getEngineManifestPath();
  const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(manifestPath), { recursive: true });
  try {
    await writeFile(temporaryPath, JSON.stringify(manifest, null, 2), 'utf8');
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function updateEngineManifest(patch: Partial<EngineManifest>): Promise<void> {
  const manifest = await readEngineManifest();
  if (!manifest) return;
  await writeEngineManifest({ ...manifest, ...patch, updatedAt: new Date().toISOString() });
}

/** Returns the last lines of a log file, for surfacing daemon start failures to the user. */
export async function tailFile(filePath: string, lines = 8): Promise<string> {
  try {
    const content = await readFile(filePath, 'utf8');
    return content.trim().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

export function hostArch(): 'x64' | 'arm64' {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Resolves the download URL and archive filename for the official standalone host Docker CLI. */
export function getDockerCliDownloadInfo(version = DOCKER_CLI_RELEASE_VERSION): { url: string; archiveName: string } {
  switch (process.platform) {
    case 'win32': {
      const archiveName = `docker-${version}.zip`;
      return {
        url: `https://download.docker.com/win/static/stable/x86_64/${archiveName}`,
        archiveName
      };
    }
    case 'darwin': {
      const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      const archiveName = `docker-${version}.tgz`;
      return {
        url: `https://download.docker.com/mac/static/stable/${arch}/${archiveName}`,
        archiveName
      };
    }
    default: {
      const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      const archiveName = `docker-${version}.tgz`;
      return {
        url: `https://download.docker.com/linux/static/stable/${arch}/${archiveName}`,
        archiveName
      };
    }
  }
}

function runBinDirPowerShell(script: string, binDir: string, failureContext: string): Promise<void> {
  const command = Buffer.from(script.trim(), 'utf16le').toString('base64');
  return runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
    // Pass binDir via an environment variable so PowerShell never parses user paths inside the script string.
    // eslint-disable-next-line n/no-process-env
    env: { ...process.env, CATBEE_BIN_DIR: binDir },
    timeoutMs: 10_000
  })
    .then(() => undefined)
    .catch(err => {
      logger.debug(`${failureContext}:`, err);
    });
}

/**
 * Configures the Windows User PATH environment variable to include CatBee's bin directory (~/.catbee/bin),
 * matching tools like Rancher Desktop and Docker Desktop without requiring administrator privileges.
 */
function ensureWindowsUserPath(binDir: string): Promise<void> {
  const script = `
    $target = $env:CATBEE_BIN_DIR;
    $current = [Environment]::GetEnvironmentVariable("Path", "User");
    if (($current -split ';') -notcontains $target) {
      $new = if ($current) { "$target;$current" } else { $target };
      [Environment]::SetEnvironmentVariable("Path", $new, "User");
    }
  `;
  return runBinDirPowerShell(script, binDir, 'Could not update Windows user PATH');
}

/**
 * Configures PowerShell user profiles on Windows to prepend ~/.catbee/bin to $env:PATH.
 */
function ensureWindowsPowerShellProfile(binDir: string): Promise<void> {
  const script = `
    $target = $env:CATBEE_BIN_DIR;
    $quotedTarget = [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($target);
    $targetPattern = '*' + [WildcardPattern]::Escape($target) + '*';
    $quotedTargetPattern = '*' + [WildcardPattern]::Escape($quotedTarget) + '*';
    $profileDirs = @(
      (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)) "PowerShell"),
      (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)) "WindowsPowerShell")
    );
    foreach ($dir in $profileDirs) {
      $p = Join-Path $dir "profile.ps1";
      try {
        [IO.Directory]::CreateDirectory($dir) | Out-Null;
        $content = if (Test-Path -LiteralPath $p) { Get-Content -LiteralPath $p -Raw -ErrorAction SilentlyContinue } else { "" };
        if ($content -notlike $targetPattern -and $content -notlike $quotedTargetPattern) {
          $line = [Environment]::NewLine + '# Added by CatBee Container Studio' + [Environment]::NewLine + 'if (($env:PATH -split '';'') -notcontains ''' + $quotedTarget + ''') { $env:PATH = ''' + $quotedTarget + ';'' + $env:PATH }' + [Environment]::NewLine;
          Add-Content -LiteralPath $p -Value $line -Force -ErrorAction SilentlyContinue;
        }
      } catch {}
    }
  `;
  return runBinDirPowerShell(script, binDir, 'Could not update PowerShell profiles');
}

/**
 * Removes CatBee's bin directory from PowerShell user profiles on Windows.
 */
function removeWindowsPowerShellProfile(binDir: string): Promise<void> {
  const script = `
    $target = $env:CATBEE_BIN_DIR;
    $quotedTarget = [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($target);
    $targetPattern = '*' + [WildcardPattern]::Escape($target) + '*';
    $quotedTargetPattern = '*' + [WildcardPattern]::Escape($quotedTarget) + '*';
    $profileDirs = @(
      (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)) "PowerShell"),
      (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)) "WindowsPowerShell")
    );
    foreach ($dir in $profileDirs) {
      $p = Join-Path $dir "profile.ps1";
      if (Test-Path -LiteralPath $p) {
        try {
          $lines = (Get-Content -LiteralPath $p -ErrorAction SilentlyContinue) | Where-Object {
            $_ -notlike "*Added by CatBee Container Studio*" -and $_ -notlike $targetPattern -and $_ -notlike $quotedTargetPattern
          };
          Set-Content -LiteralPath $p -Value $lines -Force -ErrorAction SilentlyContinue;
        } catch {}
      }
    }
  `;
  return runBinDirPowerShell(script, binDir, 'Could not clean PowerShell profiles');
}

/**
 * Configures the user's shell profiles (.zshrc, .bashrc, PowerShell profiles)
 * and User PATH on Windows to include CatBee's bin directory (~/.catbee/bin) in $PATH.
 */
export async function ensureShellPath(): Promise<void> {
  const binDir = getEngineBinDir();
  if (process.platform === 'win32') {
    await ensureWindowsUserPath(binDir);
    await ensureWindowsPowerShellProfile(binDir);
  }

  const pathEntry = process.platform === 'win32' ? '"$HOME/.catbee/bin"' : shellQuote(binDir);
  const exportLine = `export PATH=${pathEntry}:"$PATH"`;
  const comment = '# Added by CatBee Container Studio';

  const home = homeDir();
  let configuredShell = false;

  for (const file of SHELL_PROFILE_TARGETS) {
    const filePath = path.join(home, file);
    try {
      if (await pathExists(filePath)) {
        const content = await readFile(filePath, 'utf8');
        if (!content.includes('.catbee/bin')) {
          const addition = `\n${comment}\n${exportLine}\n`;
          await appendFile(filePath, addition, 'utf8');
          logger.debug(`Added CatBee bin dir to ${filePath}`);
        }
        configuredShell ||= process.platform !== 'darwin' || file === '.zshrc' || file === '.zprofile';
      }
    } catch (err) {
      logger.debug(`Could not update shell profile ${file}:`, err);
    }
  }

  if (process.platform !== 'win32' && !configuredShell) {
    const defaultProfile = process.platform === 'darwin' ? '.zshrc' : '.bashrc';
    const profilePath = path.join(home, defaultProfile);
    try {
      await appendFile(profilePath, `\n${comment}\n${exportLine}\n`, 'utf8');
      logger.debug(`Configured ${profilePath} with CatBee PATH`);
    } catch {
      // ignore
    }
  }
}

/**
 * Removes CatBee's bin directory (~/.catbee/bin) from the Windows User PATH environment variable.
 */
function removeWindowsUserPath(binDir: string): Promise<void> {
  const script = `
    $target = $env:CATBEE_BIN_DIR;
    $current = [Environment]::GetEnvironmentVariable("Path", "User");
    if (($current -split ';') -contains $target) {
      $parts = ($current -split ';') | Where-Object { $_ -ne $target -and $_ -ne "" };
      [Environment]::SetEnvironmentVariable("Path", ($parts -join ';'), "User");
    }
  `;
  return runBinDirPowerShell(script, binDir, 'Could not remove from Windows user PATH');
}

/**
 * Removes CatBee's bin directory (~/.catbee/bin) from shell profiles (.zshrc, .bashrc, PowerShell profiles)
 * or User PATH on Windows during uninstallation and teardown.
 */
export async function removeShellPath(): Promise<void> {
  const binDir = getEngineBinDir();
  if (process.platform === 'win32') {
    await removeWindowsUserPath(binDir);
    await removeWindowsPowerShellProfile(binDir);
  }

  const home = homeDir();

  for (const file of SHELL_PROFILE_TARGETS) {
    const filePath = path.join(home, file);
    try {
      if (await pathExists(filePath)) {
        const content = await readFile(filePath, 'utf8');
        if (content.includes('.catbee/bin') || content.includes('# Added by CatBee Container Studio')) {
          const cleaned = content
            .split('\n')
            .filter(line => !line.includes('# Added by CatBee Container Studio') && !line.includes('.catbee/bin'))
            .join('\n');
          await writeFile(filePath, cleaned, 'utf8');
          logger.debug(`Removed CatBee bin dir from ${filePath}`);
        }
      }
    } catch (err) {
      logger.debug(`Could not clean shell profile ${file}:`, err);
    }
  }
}

/**
 * Reads the version from a Docker CLI executable by invoking `--version`.
 * Returns the parsed semantic version (e.g. "29.10.0") or null if failed.
 */
export async function getCliVersion(cliPath: string): Promise<string | null> {
  try {
    const { stdout } = await runCommand(cliPath, ['--version'], { timeoutMs: 3_000 });
    const match = /Docker version (\d+\.\d+(?:\.\d+)?)/i.exec(stdout);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Ensures CatBee's own standalone official Docker CLI binary is installed in
 * the engine bin directory (~/.catbee/bin) matching DOCKER_CLI_RELEASE_VERSION.
 * Returns the absolute path to the binary.
 */
let hostDockerCliInstall: Promise<string> | null = null;

export function ensureHostDockerCli(onProgress?: (progress: number, stage: string) => void): Promise<string> {
  hostDockerCliInstall ??= installHostDockerCli(onProgress).finally(() => {
    hostDockerCliInstall = null;
  });
  return hostDockerCliInstall;
}

/** Waits for an in-flight CLI install before teardown removes its files. */
export async function waitForHostDockerCliInstall(): Promise<void> {
  await hostDockerCliInstall?.catch(error => {
    logger.warn({ err: error }, 'Host Docker CLI installation failed before teardown.');
  });
}

async function installHostDockerCli(onProgress?: (progress: number, stage: string) => void): Promise<string> {
  const binDir = getEngineBinDir();
  const binaryName = process.platform === 'win32' ? 'docker.exe' : 'docker';
  const target = path.join(binDir, binaryName);

  await mkdir(binDir, { recursive: true });
  await ensureShellPath();

  if (await pathExists(target)) {
    const currentVersion = await getCliVersion(target);
    if (currentVersion === DOCKER_CLI_RELEASE_VERSION) {
      return target;
    }
    logger.debug(
      `Current CatBee Docker CLI is ${currentVersion ?? 'unknown'} (target: ${DOCKER_CLI_RELEASE_VERSION}). Updating...`
    );
  }

  const { url, archiveName } = getDockerCliDownloadInfo();
  const downloadsDir = path.join(getEngineDownloadsDir(), 'host-cli');
  await mkdir(downloadsDir, { recursive: true });
  const archivePath = path.join(downloadsDir, archiveName);

  if (!(await pathExists(archivePath))) {
    onProgress?.(10, `Downloading Docker CLI (${DOCKER_CLI_RELEASE_VERSION})...`);
    await downloadFile(url, archivePath, (fraction, received, total) => {
      onProgress?.(
        10 + Math.round(fraction * 70),
        describeDownload(`Docker CLI ${DOCKER_CLI_RELEASE_VERSION}`, received, total)
      );
    });
  }

  onProgress?.(85, 'Extracting Docker CLI...');
  const staging = await mkdtemp(path.join(downloadsDir, 'extract-'));
  const temporaryBinary = path.join(binDir, `.${binaryName}.${randomUUID()}.tmp`);
  try {
    // Linux and Windows archives also contain daemon binaries; never extract them over a live engine.
    await extractArchive(archivePath, staging, 1);
    const binary = path.join(staging, binaryName);
    if (!(await pathExists(binary))) {
      throw new Error(`The Docker CLI archive does not contain ${binaryName}.`);
    }
    if (process.platform !== 'win32') await chmod(binary, 0o755);
    if ((await getCliVersion(binary)) !== DOCKER_CLI_RELEASE_VERSION) {
      throw new Error('The downloaded Docker CLI did not report the expected version.');
    }
    await copyFile(binary, temporaryBinary);
    await rename(temporaryBinary, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(temporaryBinary, { force: true });
  }
  onProgress?.(100, 'Docker CLI ready.');
  logger.debug(`Successfully prepared host Docker CLI at: ${target}`);
  return target;
}
