import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, type SpawnOptions } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { logger } from '../../logger';
import type { DockerConnection } from '../types/connection.types';
import type { EngineManifest } from './types/manifest.types';
import { getEngineManifestPath } from './engine-paths';

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
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line n/no-process-env
    const baseEnv = options.env ?? process.env;
    const spawnOptions: SpawnOptions = {
      env: sanitizeEnv(baseEnv),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    };
    const child = spawn(command, args, spawnOptions);
    const encoding = options.encoding ?? 'utf8';
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timer: NodeJS.Timeout | null = null;

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Command timed out after ${options.timeoutMs}ms: ${command} ${args.join(' ')}`));
      }, options.timeoutMs);
    }

    const emitLines = (chunk: Buffer): void => {
      if (!options.onOutput) return;
      for (const line of chunk.toString(encoding).replaceAll('\0', '').split(/\r?\n/)) {
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
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString(encoding).replaceAll('\0', '');
      const stderr = Buffer.concat(stderrChunks).toString(encoding).replaceAll('\0', '');
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = (stderr || stdout).trim().split(/\r?\n/).slice(-5).join('\n');
      reject(new Error(`${path.basename(command)} ${args[0] ?? ''} failed (exit ${code}): ${detail}`));
    });

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

/** Streams a download to disk, reporting progress (0..1) when the server provides a content length. */
export async function downloadFile(
  url: string,
  destination: string,
  onProgress?: (fraction: number, receivedBytes: number, totalBytes: number) => void
): Promise<void> {
  logger.info(`[EngineUtils] Downloading ${url}`);
  await mkdir(path.dirname(destination), { recursive: true });
  const response = await fetch(url, { redirect: 'follow' });
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

  const partial = `${destination}.partial`;
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
    tar = systemRoot ? path.join(systemRoot, 'System32', 'tar.exe') : 'tar.exe';
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
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
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
