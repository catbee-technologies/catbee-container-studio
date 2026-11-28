import { writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { get as httpsGet } from 'node:https';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type Docker from 'dockerode';
import jsyaml from 'js-yaml';
import { logger as appLogger } from '../logger';
import { getEngineBinDir, getWslEngineDiskPath, homeDir } from '../docker/embedded/engine-paths';
import {
  describeDownload,
  downloadFile,
  fetchEngineResource,
  ensureHostDockerCli,
  pathExists,
  pingDockerEndpoint,
  runCommand,
  type RunOptions,
  type RunResult
} from '../docker/embedded/engine-utils';
import { getEngineSettings, type KubernetesSettingsConfig } from '../docker/embedded/engine-settings';
import { dockerManager } from '../docker/services/docker.manager';
import { getDockerCliPath } from '../docker/runtime/docker.runtime';
import type { SelectedDockerRuntime } from '../docker/types/runtime.types';
import { connectionToUri } from '../docker/embedded/engine-utils';
import { windowsToWslPath } from '../docker/embedded/windows-path-rewriter';

const logger = appLogger.child({}, { msgPrefix: '[K8sManager] ' });
const kindLogger = appLogger.child({}, { msgPrefix: '[K8sManager:kind] ' });

import {
  CATBEE_K8S_CLUSTER_NAME,
  CATBEE_WSL_DISTRO,
  DEFAULT_K8S_VERSIONS,
  KIND_RELEASE_VERSION,
  KIND_CLOUD_PROVIDER_IMAGE,
  KIND_CLOUD_PROVIDER_CONTAINER
} from '../../constants.docker';

const KIND_CLUSTER_LABEL = 'io.x-k8s.kind.cluster';
const KIND_ROLE_LABEL = 'io.x-k8s.kind.role';
const KUBERNETES_NAMESPACE_LABEL = 'io.kubernetes.pod.namespace';
const EMBEDDED_ENGINE_REQUIRED = 'Start and connect to the CatBee built-in engine to use Kubernetes.';
const WSL_KIND_BINARY = '/usr/local/bin/kind';
const CLOUD_PROVIDER_DOCKER_SOCKET = '/var/run/docker.sock';
const API_START_TIMEOUT_MS = 60_000;
const KIND_CREATE_TIMEOUT_MS = 15 * 60_000;

// Killing wsl.exe leaves its Linux processes running. Wait for the guest process group before cleaning up nodes.
const WSL_KIND_CREATE_SCRIPT = `set -eu
cancel_file=$1
timeout=$2
deadline=$(($(date +%s) + timeout))
shift 2
if [ -f "$cancel_file" ]; then exit 130; fi
setsid "$@" </dev/null &
pid=$!
while kill -0 "$pid" 2>/dev/null; do
  result=0
  if [ -f "$cancel_file" ]; then
    result=130
  elif [ "$(date +%s)" -ge "$deadline" ]; then
    result=124
  fi
  if [ "$result" -ne 0 ]; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    sleep 1
    kill -KILL -- "-$pid" 2>/dev/null || true
    wait "$pid" || true
    exit "$result"
  fi
  sleep 1
done
wait "$pid"
`;

type ClusterEngine = Pick<typeof dockerManager, 'containers' | 'images' | 'networks'> & {
  runtime: SelectedDockerRuntime;
};

interface KubeconfigDoc {
  contexts?: { name: string; context: { cluster: string; user: string; [key: string]: unknown } }[];
  clusters?: { name: string; cluster: Record<string, unknown> }[];
  users?: { name: string; user: Record<string, unknown> }[];
  'current-context'?: string;
  [key: string]: unknown;
}

interface ApiTarget {
  server: URL;
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
}

function isClusterNode(container: Docker.ContainerInfo): boolean {
  return (
    container.Labels?.[KIND_CLUSTER_LABEL] === CATBEE_K8S_CLUSTER_NAME && Boolean(container.Labels[KIND_ROLE_LABEL])
  );
}

function isCloudProvider(container: Docker.ContainerInfo): boolean {
  return (
    container.Labels?.[KIND_CLUSTER_LABEL] === CATBEE_K8S_CLUSTER_NAME &&
    container.Labels[KUBERNETES_NAMESPACE_LABEL] === 'kube-system' &&
    Boolean(
      container.Names?.some(name => name === `/${KIND_CLOUD_PROVIDER_CONTAINER}` || name === '/kind-cloud-provider')
    )
  );
}

export interface K8sOperationProgress {
  operation: 'install' | 'start' | 'stop' | 'reset' | 'uninstall';
  stage: string;
  progress?: number;
  detail?: string;
}

export interface K8sClusterInfo {
  status: 'unavailable' | 'stopped' | 'starting' | 'running' | 'degraded' | 'stopping' | 'error';
  name: string;
  provisioner: 'kind' | 'kubeadm';
  version: string;
  nodeCount: number;
  isKindInstalled: boolean | null;
  runtimeVersion?: string;
  operation?: K8sOperationProgress | null;
  startedAt?: number;
  error?: string;
  warning?: string;
  apiEndpoint?: string;
  kubeconfigPath?: string;
}

export interface K8sStartResult {
  success: boolean;
  cancelled?: true;
  settings?: KubernetesSettingsConfig;
}

class K8sManager {
  private isStarting = false;
  private isStopping = false;
  private isResetting = false;
  private suspensions = 0;
  private operationsResumed: PromiseWithResolvers<void> | null = null;
  private pendingOperation: Promise<void> | null = null;
  private apiReadinessController: AbortController | null = null;
  private settingsQueue = Promise.resolve();
  private activeCreation: {
    controller: AbortController;
    completion: Promise<boolean>;
    cancelFile?: string;
  } | null = null;
  private readonly kindInstalls = new Map<boolean, Promise<string>>();
  private lastError: { runtime: SelectedDockerRuntime | null; message: string } | null = null;
  private cachedVersions: string[] | null = null;
  private cachedVersionsTimestamp = 0;
  private readonly CACHE_TTL_MS = 60 * 60 * 1000;

  private currentProgress: K8sOperationProgress | null = null;
  private readonly progressListeners = new Set<(progress: K8sOperationProgress | null) => void>();

  getCurrentProgress(): K8sOperationProgress | null {
    return this.currentProgress;
  }

  onProgress(listener: (progress: K8sOperationProgress | null) => void): () => void {
    this.progressListeners.add(listener);
    listener(this.currentProgress);
    return () => this.progressListeners.delete(listener);
  }

  private emitProgress(progress: K8sOperationProgress | null): void {
    this.currentProgress = progress;
    for (const listener of this.progressListeners) {
      try {
        listener(progress);
      } catch (err) {
        logger.error({ err }, 'Error in progress listener.');
      }
    }
  }

  async getAvailableVersions(): Promise<string[]> {
    const now = Date.now();
    if (this.cachedVersions && now - this.cachedVersionsTimestamp < this.CACHE_TTL_MS) {
      return this.cachedVersions;
    }

    const semverRegex = /^v?(\d+)\.(\d+)\.(\d+)(-[a-zA-Z0-9.]+)?$/;
    try {
      const res = await fetchEngineResource(
        'https://registry.hub.docker.com/v2/repositories/kindest/node/tags?page_size=100',
        {
          signal: AbortSignal.timeout(5000)
        }
      );

      if (res.ok) {
        const data = (await res.json()) as { results?: { name: string }[] };
        const tags = data.results?.map(r => r.name) ?? [];
        const validVersions = tags.filter(t => semverRegex.test(t)).map(t => (t.startsWith('v') ? t : `v${t}`));

        const merged = Array.from(new Set([...validVersions, ...DEFAULT_K8S_VERSIONS]));

        merged.sort((a, b) => {
          const parseSemver = (v: string): [number, number, number, string] => {
            const m = semverRegex.exec(v);
            if (!m) return [0, 0, 0, ''];
            return [Number.parseInt(m[1], 10), Number.parseInt(m[2], 10), Number.parseInt(m[3], 10), m[4] ?? ''];
          };
          const [majA, minA, patchA, preA] = parseSemver(a);
          const [majB, minB, patchB, preB] = parseSemver(b);

          if (majA !== majB) return majB - majA;
          if (minA !== minB) return minB - minA;
          if (patchA !== patchB) return patchB - patchA;
          if (!preA && preB) return -1;
          if (preA && !preB) return 1;
          return preB.localeCompare(preA);
        });

        this.cachedVersions = merged;
        this.cachedVersionsTimestamp = now;
        return merged;
      }
    } catch (err) {
      logger.debug(`Could not fetch remote kindest/node tags: ${err instanceof Error ? err.message : String(err)}`);
    }

    return [...DEFAULT_K8S_VERSIONS];
  }

  private getClusterEngine(): ClusterEngine | null {
    const { currentRuntime: runtime, containers, images, networks } = dockerManager;
    return runtime?.source === 'embedded' ? { runtime, containers, images, networks } : null;
  }

  private assertEngineAvailable(): void {
    if (this.suspensions || !dockerManager.isEmbeddedEngineReady) throw new Error(EMBEDDED_ENGINE_REQUIRED);
  }

  async checkEngineAvailable(): Promise<void> {
    await this.requireReachableEngine(dockerManager.currentRuntime);
  }

  private async requireReachableEngine(runtime: SelectedDockerRuntime | null): Promise<void> {
    this.assertEngineAvailable();
    if (
      !runtime ||
      runtime.source !== 'embedded' ||
      runtime !== dockerManager.currentRuntime ||
      !(await pingDockerEndpoint(runtime.connection))
    ) {
      throw new Error(EMBEDDED_ENGINE_REQUIRED);
    }
    this.assertEngineAvailable();
    if (runtime !== dockerManager.currentRuntime) throw new Error(EMBEDDED_ENGINE_REQUIRED);
  }

  private isWslEngine(runtime = dockerManager.currentRuntime): boolean {
    return process.platform === 'win32' && runtime?.source === 'embedded';
  }

  async getKindBinaryPath(): Promise<string | null> {
    const binDir = getEngineBinDir();
    const exeName = process.platform === 'win32' ? 'kind.exe' : 'kind';
    const localBin = path.join(binDir, exeName);

    if (await pathExists(localBin)) {
      return localBin;
    }

    return null;
  }

  async isKindInstalled(runtime = dockerManager.currentRuntime): Promise<boolean> {
    if (
      runtime?.source !== 'embedded' ||
      runtime !== dockerManager.currentRuntime ||
      !dockerManager.isEmbeddedEngineReady
    )
      return false;
    if (this.isWslEngine(runtime)) {
      if (this.suspensions) return false;
      try {
        await this.runInWsl([WSL_KIND_BINARY, 'version'], {
          timeoutMs: 5000
        });
        return true;
      } catch {
        return false;
      }
    }
    return (await this.getKindBinaryPath()) !== null;
  }

  private getWslKindStatePath(): string {
    return path.join(path.dirname(getWslEngineDiskPath()), 'kind-installation');
  }

  private async rememberWslKindInstallation(installed: boolean): Promise<void> {
    const statePath = this.getWslKindStatePath();
    const state = String(installed);
    try {
      if ((await readFile(statePath, 'utf8').catch(() => null)) !== state) {
        await writeFile(statePath, state);
      }
    } catch (error) {
      logger.warn({ err: error }, 'Could not save WSL kind installation status.');
    }
  }

  private async getKindInstallationStatus(runtime: SelectedDockerRuntime | undefined): Promise<boolean | null> {
    if (process.platform !== 'win32') return (await this.getKindBinaryPath()) !== null;
    if (!(await pathExists(getWslEngineDiskPath()))) return false;

    const canProbe = () =>
      runtime &&
      runtime === dockerManager.currentRuntime &&
      dockerManager.isEmbeddedEngineReady &&
      !this.suspensions &&
      !this.kindInstalls.size &&
      !this.isStopping;
    if (canProbe()) {
      // Distinguish a missing or broken executable from an unavailable WSL session.
      const result = await this.runInWsl(['sh', '-s'], {
        input: `if "${WSL_KIND_BINARY}" version >/dev/null 2>&1; then printf true; else printf false; fi\n`,
        timeoutMs: 5_000
      }).catch(() => null);
      const state = result?.stdout.trim();
      if ((state === 'true' || state === 'false') && canProbe()) {
        await this.rememberWslKindInstallation(state === 'true');
        return state === 'true';
      }
    }

    const savedState = await readFile(this.getWslKindStatePath(), 'utf8').catch(() => null);
    if (savedState === 'true') return true;
    if (savedState === 'false') return false;
    return null;
  }

  private async installKindInWsl(): Promise<string> {
    const binDir = getEngineBinDir();
    await mkdir(binDir, { recursive: true });
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const cachedLinuxBin = path.join(binDir, `kind-linux-${arch}`);
    const downloadUrl = `https://github.com/kubernetes-sigs/kind/releases/download/${KIND_RELEASE_VERSION}/kind-linux-${arch}`;

    if (!(await pathExists(cachedLinuxBin))) {
      logger.debug(`Downloading kind Linux binary from ${downloadUrl} to ${cachedLinuxBin}`);
      this.emitProgress({
        operation: 'install',
        stage: 'Downloading kind runtime CLI...',
        progress: 0,
        detail: KIND_RELEASE_VERSION
      });

      try {
        await downloadFile(downloadUrl, cachedLinuxBin, (fraction, received, total) => {
          const pct = Math.round(fraction * 100);
          this.emitProgress({
            operation: 'install',
            stage: describeDownload(`kind CLI ${KIND_RELEASE_VERSION}`, received, total),
            progress: pct,
            detail: total > 0 ? `${(received / 1048576).toFixed(1)} MB / ${(total / 1048576).toFixed(1)} MB` : undefined
          });
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to download kind Linux binary: ${msg}`);
        throw new Error(`Failed to obtain kind binary: ${msg}`);
      }
    }

    const wslSource = windowsToWslPath(cachedLinuxBin);
    if (!wslSource) {
      throw new Error(`Could not translate Windows path to WSL: ${cachedLinuxBin}`);
    }

    try {
      await this.runInWsl(['install', '-D', '-m', '0755', '--', wslSource, WSL_KIND_BINARY], { timeoutMs: 30_000 });
      await this.runInWsl([WSL_KIND_BINARY, 'version'], { timeoutMs: 5_000 });
      await this.rememberWslKindInstallation(true);
      logger.info('Kubernetes runtime installed in WSL.');
      return WSL_KIND_BINARY;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to copy kind binary into WSL: ${msg}`);
      throw new Error(`Failed to install kind in WSL: ${msg}`);
    }
  }

  private async installKindOnHost(): Promise<string> {
    const binDir = getEngineBinDir();
    await mkdir(binDir, { recursive: true });
    const exeName = process.platform === 'win32' ? 'kind.exe' : 'kind';
    const target = path.join(binDir, exeName);

    let platform: 'windows' | 'darwin' | 'linux' = 'linux';
    if (process.platform === 'win32') {
      platform = 'windows';
    } else if (process.platform === 'darwin') {
      platform = 'darwin';
    }
    const arch = process.platform !== 'win32' && process.arch === 'arm64' ? 'arm64' : 'amd64';
    const downloadUrl = `https://github.com/kubernetes-sigs/kind/releases/download/${KIND_RELEASE_VERSION}/kind-${platform}-${arch}`;

    logger.debug(`Downloading kind binary from ${downloadUrl} to ${target}`);
    this.emitProgress({
      operation: 'install',
      stage: 'Downloading kind runtime CLI...',
      progress: 0,
      detail: KIND_RELEASE_VERSION
    });

    try {
      await downloadFile(downloadUrl, target, (fraction, received, total) => {
        const pct = Math.round(fraction * 100);
        this.emitProgress({
          operation: 'install',
          stage: describeDownload(`kind CLI ${KIND_RELEASE_VERSION}`, received, total),
          progress: pct,
          detail: total > 0 ? `${(received / 1048576).toFixed(1)} MB / ${(total / 1048576).toFixed(1)} MB` : undefined
        });
      });
      if (process.platform !== 'win32') {
        await chmod(target, 0o755);
      }
      logger.info('Kubernetes runtime installed.');
      return target;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to download kind binary: ${msg}`);
      throw new Error(`Failed to obtain kind binary: ${msg}`);
    }
  }

  async installKind(runtime = dockerManager.currentRuntime): Promise<string> {
    if (this.suspensions || this.isStopping)
      throw new Error('Wait for the engine operation to finish before installing kind.');
    const wsl = this.isWslEngine(runtime);
    const existing = this.kindInstalls.get(wsl);
    if (existing) return existing;

    const install = this.requireReachableEngine(runtime)
      .then(() => (wsl ? this.installKindInWsl() : this.installKindOnHost()))
      .finally(() => {
        this.kindInstalls.delete(wsl);
        if (!this.kindInstalls.size) this.emitProgress(null);
      });
    this.kindInstalls.set(wsl, install);
    return install;
  }

  private async ensureKindBinary(runtime: SelectedDockerRuntime): Promise<string> {
    await ensureHostDockerCli().catch(err => {
      logger.debug('Could not ensure standalone Docker CLI in background:', err);
    });
    if (this.isWslEngine(runtime)) {
      const isInstalled = await this.isKindInstalled(runtime);
      if (!isInstalled) {
        return this.installKind(runtime);
      }
      return WSL_KIND_BINARY;
    }
    const existing = await this.getKindBinaryPath();
    if (existing) {
      return existing;
    }
    return this.installKind(runtime);
  }

  private async executeKind(
    runtime: SelectedDockerRuntime,
    args: string[],
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onOutput?: (line: string) => void;
      cancelFile?: string;
    }
  ): Promise<RunResult> {
    const kindBin = await this.ensureKindBinary(runtime);
    options?.signal?.throwIfAborted();
    if (this.isWslEngine(runtime)) {
      const wslArgs = args.map(arg => {
        if (typeof arg === 'string' && /^[a-zA-Z]:[/\\]/.test(arg)) {
          return windowsToWslPath(arg) ?? arg;
        }
        return arg;
      });
      const { cancelFile, ...commandOptions } = options ?? {};
      let command = [kindBin, ...wslArgs];
      let input: string | undefined;
      if (cancelFile) {
        const wslCancelFile = windowsToWslPath(cancelFile);
        if (!wslCancelFile) throw new Error('The Kubernetes temporary directory is not accessible from WSL.');
        command = ['sh', '-s', '--', wslCancelFile, String(KIND_CREATE_TIMEOUT_MS / 1000), ...command];
        input = WSL_KIND_CREATE_SCRIPT;
        commandOptions.signal = undefined;
        commandOptions.timeoutMs = KIND_CREATE_TIMEOUT_MS + 15_000;
      }
      return this.runInWsl(
        [
          'env',
          '-u',
          'DOCKER_CONTEXT',
          '-u',
          'DOCKER_TLS',
          '-u',
          'DOCKER_TLS_VERIFY',
          '-u',
          'DOCKER_CERT_PATH',
          'DOCKER_HOST=unix:///var/run/docker.sock',
          'KIND_EXPERIMENTAL_PROVIDER=docker',
          ...command
        ],
        { ...commandOptions, input }
      );
    }

    const env = await this.getDockerEnv(runtime);
    options?.signal?.throwIfAborted();
    return runCommand(kindBin, args, { env, ...options });
  }

  private runInWsl(args: string[], options: RunOptions): Promise<RunResult> {
    return runCommand('wsl.exe', ['-d', CATBEE_WSL_DISTRO, '-u', 'root', '--exec', ...args], options);
  }

  private async getDockerEnv(runtime: SelectedDockerRuntime): Promise<NodeJS.ProcessEnv> {
    // eslint-disable-next-line n/no-process-env
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Drop DOCKER_CONTEXT so Docker CLI does not direct commands to a third-party context (e.g. Rancher Desktop)
    for (const key of Object.keys(env)) {
      if (['DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].includes(key.toUpperCase())) {
        delete env[key];
      }
    }
    env.DOCKER_HOST = connectionToUri(runtime.connection);
    env.KIND_EXPERIMENTAL_PROVIDER = 'docker';

    // Isolate Docker CLI from ~/.docker/config.json plugin hooks (such as "debug": {"hooks": "exec"}
    // or credential helper prompts) that break non-interactive docker exec streams in Kind.
    const configDir = path.join(homeDir(), '.catbee', 'k8s', 'docker-config');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(configDir, 'config.json'), '{}', { encoding: 'utf8', mode: 0o600 });
    env.DOCKER_CONFIG = configDir;

    // Prepend CatBee's own engine bin dir and host Docker CLI directories to PATH
    const binDir = getEngineBinDir();
    const pathDirs: string[] = [binDir];

    try {
      const dockerCli = await getDockerCliPath();
      if (dockerCli) {
        pathDirs.push(path.dirname(dockerCli));
      }
    } catch {
      // ignore
    }

    if (process.platform === 'win32') {
      // Prepend official Docker CLI installations to PATH as fallbacks
      const localAppData = env.LOCALAPPDATA ?? path.join(homeDir(), 'AppData', 'Local');
      const programFiles = env.ProgramFiles ?? String.raw`C:\Program Files`;
      pathDirs.push(
        path.join(localAppData, 'Programs', 'DockerDesktop', 'resources', 'bin'),
        path.join(programFiles, 'Docker', 'Docker', 'resources', 'bin')
      );
    } else if (process.platform === 'darwin') {
      pathDirs.push(
        path.join(homeDir(), '.local', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        path.join(homeDir(), '.docker', 'bin'),
        path.join(homeDir(), '.rd', 'bin'),
        '/Applications/Docker.app/Contents/Resources/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin'
      );
    } else {
      pathDirs.push(
        path.join(homeDir(), '.local', 'bin'),
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        path.join(homeDir(), '.docker', 'bin')
      );
    }

    const existingPath = env.PATH ? env.PATH.split(path.delimiter) : [];
    const combined = Array.from(new Set([...pathDirs, ...existingPath])).filter(Boolean);
    env.PATH = combined.join(path.delimiter);

    return env;
  }

  async getStatus(): Promise<K8sClusterInfo> {
    const candidate = dockerManager.isEmbeddedEngineReady ? this.getClusterEngine() : null;
    const engine = candidate && (await pingDockerEndpoint(candidate.runtime.connection)) ? candidate : null;
    const settings = await getEngineSettings();
    const k8sConfig = settings.kubernetes;
    const isKindInstalled = await this.getKindInstallationStatus(engine?.runtime);
    const lastError = this.lastError?.runtime === (engine?.runtime ?? null) ? this.lastError?.message : undefined;

    const baseInfo: Omit<K8sClusterInfo, 'status'> = {
      name: CATBEE_K8S_CLUSTER_NAME,
      provisioner: k8sConfig.provisioner,
      version: k8sConfig.version,
      nodeCount: k8sConfig.nodeCount,
      isKindInstalled,
      runtimeVersion: KIND_RELEASE_VERSION,
      operation: this.currentProgress,
      error: lastError
    };

    if (!engine || engine.runtime !== dockerManager.currentRuntime || !dockerManager.isEmbeddedEngineReady) {
      return { ...baseInfo, status: 'unavailable', operation: null, error: undefined };
    }
    if (this.kindInstalls.size) {
      return { ...baseInfo, status: 'starting' };
    }
    if (this.isStarting) {
      return { ...baseInfo, status: 'starting' };
    }
    if (this.isStopping) {
      return { ...baseInfo, status: 'stopping' };
    }
    if (this.isResetting) {
      return { ...baseInfo, status: this.isStarting ? 'starting' : 'stopping' };
    }

    try {
      const containers = await engine.containers.listContainers({ all: true });
      const clusterContainers = containers.filter(isClusterNode);

      if (clusterContainers.length === 0) {
        return { ...baseInfo, status: lastError ? 'error' : 'stopped' };
      }

      const clusterInfo = { ...baseInfo, nodeCount: clusterContainers.length };
      if (lastError) return { ...clusterInfo, status: 'error' };

      const controlPlane = clusterContainers.find(c => c.Labels[KIND_ROLE_LABEL] === 'control-plane');
      if (!controlPlane) {
        return {
          ...clusterInfo,
          status: 'error',
          error: 'The Kubernetes cluster is missing its control-plane container.'
        };
      }

      const version = /kindest\/node:v?(\d+\.\d+\.\d+)/.exec(controlPlane.Image)?.[1];
      if (version) clusterInfo.version = `v${version}`;
      if (controlPlane.State === 'restarting' || controlPlane.State === 'created') {
        return { ...clusterInfo, status: 'starting' };
      }
      if (controlPlane.State !== 'running') {
        return { ...clusterInfo, status: 'stopped' };
      }
      if (clusterContainers.some(container => container.State !== 'running')) {
        return { ...clusterInfo, status: 'error', error: 'One or more Kubernetes node containers are not running.' };
      }
      const raw = await readFile(this.getKubeconfigPath(), 'utf8').catch(() => {
        throw new Error('Could not read the CatBee kubeconfig.');
      });
      const target = this.getApiTarget(jsyaml.load(raw) as KubeconfigDoc | null);
      const port = Number(target.server.port || 443);
      if (!controlPlane.Ports?.some(binding => binding.PrivatePort === 6443 && binding.PublicPort === port)) {
        return { ...clusterInfo, status: 'error', error: 'The CatBee kubeconfig does not match this Docker engine.' };
      }
      if (!(await this.isApiReady(target))) {
        return { ...clusterInfo, status: 'error', error: 'The CatBee Kubernetes API is not reachable or ready.' };
      }

      if (engine.runtime !== dockerManager.currentRuntime || !dockerManager.isEmbeddedEngineReady) {
        return { ...baseInfo, status: 'unavailable', operation: null, error: undefined };
      }
      const cloudProviderRunning = containers.some(
        container => isCloudProvider(container) && container.State === 'running'
      );
      return {
        ...clusterInfo,
        status: cloudProviderRunning ? 'running' : 'degraded',
        warning: cloudProviderRunning
          ? undefined
          : 'The Kubernetes API is ready, but the cloud provider is unavailable. LoadBalancer services may not work.',
        startedAt: controlPlane.Created ? controlPlane.Created * 1000 : undefined,
        apiEndpoint: target.server.origin,
        kubeconfigPath: this.getKubeconfigPath()
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        status: 'error',
        name: CATBEE_K8S_CLUSTER_NAME,
        provisioner: k8sConfig.provisioner,
        version: k8sConfig.version,
        nodeCount: k8sConfig.nodeCount,
        isKindInstalled,
        runtimeVersion: KIND_RELEASE_VERSION,
        operation: this.currentProgress,
        error: msg
      };
    }
  }

  private getApiTarget(doc: KubeconfigDoc | null): ApiTarget {
    const context =
      doc?.contexts?.find(c => c.name === CATBEE_K8S_CLUSTER_NAME) ??
      doc?.contexts?.find(c => c.name === `kind-${CATBEE_K8S_CLUSTER_NAME}`);
    const cluster = doc?.clusters?.find(entry => entry.name === context?.context?.cluster)?.cluster;
    const user = doc?.users?.find(entry => entry.name === context?.context?.user)?.user;
    const endpoint = cluster?.server;
    const ca = cluster?.['certificate-authority-data'];
    const cert = user?.['client-certificate-data'];
    const key = user?.['client-key-data'];
    if (typeof endpoint !== 'string' || typeof ca !== 'string' || typeof cert !== 'string' || typeof key !== 'string') {
      throw new Error('The CatBee kubeconfig is missing the Kubernetes API endpoint or TLS credentials.');
    }
    const server = URL.parse(endpoint.replace(/^https:\/\/0\.0\.0\.0:/, 'https://127.0.0.1:'));
    if (server?.protocol !== 'https:' || server.username || server.password) {
      throw new Error('The CatBee kubeconfig does not contain a valid HTTPS API endpoint.');
    }
    return {
      server,
      ca: Buffer.from(ca, 'base64'),
      cert: Buffer.from(cert, 'base64'),
      key: Buffer.from(key, 'base64')
    };
  }

  private async isApiReady({ server, ca, cert, key }: ApiTarget, signal?: AbortSignal): Promise<boolean> {
    const timeout = AbortSignal.timeout(4_000);
    return new Promise<boolean>(resolve => {
      const request = httpsGet(
        new URL('/readyz', server),
        {
          ca,
          cert,
          key,
          rejectUnauthorized: true,
          agent: false,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout
        },
        response => {
          response.resume();
          resolve(response.statusCode === 200);
        }
      );
      request.on('error', () => resolve(false));
    }).catch(() => false);
  }

  private async waitForApi(target: ApiTarget, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + API_START_TIMEOUT_MS;
    do {
      signal.throwIfAborted();
      const ready = await this.isApiReady(target, signal);
      signal.throwIfAborted();
      if (ready) return;
      await delay(1_000, undefined, { signal });
    } while (Date.now() < deadline);
    throw new Error('The Kubernetes API did not become ready at the endpoint published to the host.');
  }

  private generateKindConfig(version: string, nodeCount: number): string {
    const imageTag = version.startsWith('v') ? version : `v${version}`;
    const lines = [
      'kind: Cluster',
      'apiVersion: kind.x-k8s.io/v1alpha4',
      `name: ${CATBEE_K8S_CLUSTER_NAME}`,
      'networking:',
      `  apiServerAddress: "${process.platform === 'linux' ? '127.0.0.1' : '0.0.0.0'}"`,
      'kubeadmConfigPatches:',
      '  - |',
      '    kind: ClusterConfiguration',
      '    apiServer:',
      '      certSANs:',
      '        - "127.0.0.1"',
      '        - "localhost"',
      '        - "0.0.0.0"',
      'nodes:',
      '  - role: control-plane',
      `    image: kindest/node:${imageTag}`
    ];

    for (let i = 1; i < nodeCount; i++) {
      lines.push('  - role: worker', `    image: kindest/node:${imageTag}`);
    }

    return lines.join('\n') + '\n';
  }

  private parseKindOutput(line: string): void {
    kindLogger.debug(line);
    // Strip ANSI escape sequences (cursor movement, colors, and formatting).
    const ansiRegex = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
    const cleanAnsi = line.replace(ansiRegex, '');
    const cleaned = cleanAnsi.replace(/^[^\w]+/, '').trim();

    if (/ensuring node image/i.test(cleaned)) {
      this.emitProgress({
        operation: 'start',
        stage: 'Pulling Kubernetes node image (~1 GB)...',
        progress: 25,
        detail: 'This only happens once per Kubernetes version.'
      });
    } else if (/preparing nodes/i.test(cleaned)) {
      this.emitProgress({
        operation: 'start',
        stage: 'Preparing cluster node container...',
        progress: 45,
        detail: cleaned
      });
    } else if (/writing configuration/i.test(cleaned)) {
      this.emitProgress({
        operation: 'start',
        stage: 'Writing cluster configuration...',
        progress: 55,
        detail: cleaned
      });
    } else if (/starting.*control[- ]?plane/i.test(cleaned)) {
      this.emitProgress({
        operation: 'start',
        stage: 'Starting control-plane services (etcd, apiserver)...',
        progress: 70,
        detail: 'Initializing control plane components. This usually takes 1-2 minutes.'
      });
    } else if (/waiting.*control[- ]?plane.*ready/i.test(cleaned)) {
      this.emitProgress({
        operation: 'start',
        stage: 'Waiting for control-plane to become ready...',
        progress: 80,
        detail: cleaned
      });
    } else if (/installing cni/i.test(cleaned)) {
      this.emitProgress({
        operation: 'start',
        stage: 'Installing cluster networking (CNI)...',
        progress: 85,
        detail: cleaned
      });
    } else if (/installing storageclass/i.test(cleaned)) {
      this.emitProgress({
        operation: 'start',
        stage: 'Configuring cluster storage...',
        progress: 90,
        detail: cleaned
      });
    } else if (/joining worker/i.test(cleaned)) {
      this.emitProgress({
        operation: 'start',
        stage: 'Joining worker nodes to cluster...',
        progress: 94,
        detail: cleaned
      });
    } else if (/set kubectl context/i.test(cleaned) || /you can now use your cluster/i.test(cleaned)) {
      this.emitProgress({
        operation: 'start',
        stage: 'Kubernetes cluster is ready!',
        progress: 100,
        detail: cleaned
      });
    } else if (cleaned && this.currentProgress?.operation === 'start' && !/^[IWEF]\d{4}\s/.test(cleaned)) {
      this.emitProgress({
        ...this.currentProgress,
        detail: cleaned
      });
    }
  }

  private getKubeconfigPath(): string {
    // eslint-disable-next-line n/no-process-env
    return process.env.KUBECONFIG?.split(path.delimiter).find(Boolean) ?? path.join(homeDir(), '.kube', 'config');
  }

  private async syncKubeconfig(runtime: SelectedDockerRuntime): Promise<ApiTarget> {
    const kubeconfigPath = path.resolve(this.getKubeconfigPath());
    try {
      const kindPath = this.isWslEngine(runtime) ? windowsToWslPath(kubeconfigPath) : kubeconfigPath;
      if (!kindPath) throw new Error('The kubeconfig path is not accessible from WSL.');
      await this.executeKind(
        runtime,
        ['export', 'kubeconfig', '--kubeconfig', kindPath, '--name', CATBEE_K8S_CLUSTER_NAME],
        {
          timeoutMs: 30_000
        }
      );
    } catch (exportErr) {
      throw new Error('Could not export the Kubernetes kubeconfig.', { cause: exportErr });
    }

    try {
      const raw = await readFile(kubeconfigPath, 'utf8');
      const doc = jsyaml.load(raw) as KubeconfigDoc | null;
      const kindName = `kind-${CATBEE_K8S_CLUSTER_NAME}`;
      const context = doc?.contexts?.find(entry => entry.name === kindName);
      const cluster = doc?.clusters?.find(entry => entry.name === kindName);
      const user = doc?.users?.find(entry => entry.name === kindName);
      if (!doc || !context || !cluster || !user || typeof cluster.cluster?.server !== 'string') {
        throw new Error('Kind did not export a complete kubeconfig for the cluster.');
      }

      // Replace any previous CatBee aliases with the entries exported from this engine.
      const keep = (entry: { name: string }): boolean =>
        entry.name !== kindName && entry.name !== CATBEE_K8S_CLUSTER_NAME;
      const server = cluster.cluster.server.replace(/^https:\/\/0\.0\.0\.0:/, 'https://127.0.0.1:');
      doc.clusters = [
        ...(doc.clusters ?? []).filter(keep),
        { name: CATBEE_K8S_CLUSTER_NAME, cluster: { ...cluster.cluster, server } }
      ];
      doc.users = [...(doc.users ?? []).filter(keep), { ...user, name: CATBEE_K8S_CLUSTER_NAME }];
      doc.contexts = [
        ...(doc.contexts ?? []).filter(keep),
        {
          name: CATBEE_K8S_CLUSTER_NAME,
          context: { ...context.context, cluster: CATBEE_K8S_CLUSTER_NAME, user: CATBEE_K8S_CLUSTER_NAME }
        }
      ];

      doc['current-context'] = CATBEE_K8S_CLUSTER_NAME;
      const target = this.getApiTarget(doc);
      await writeFile(kubeconfigPath, jsyaml.dump(doc, { lineWidth: -1 }), 'utf8');
      logger.debug(`Successfully synced kubeconfig with context "${CATBEE_K8S_CLUSTER_NAME}".`);
      return target;
    } catch (err) {
      throw new Error('Could not update the CatBee context in kubeconfig.', { cause: err });
    }
  }

  async cleanKubeconfig(): Promise<void> {
    const kubeconfigPath = this.getKubeconfigPath();
    try {
      if (!(await pathExists(kubeconfigPath))) return;
      const raw = await readFile(kubeconfigPath, 'utf8');
      const doc = jsyaml.load(raw) as KubeconfigDoc | null;
      if (!doc) return;

      const kindContextName = `kind-${CATBEE_K8S_CLUSTER_NAME}`;
      const isCatBeeName = (name?: string): boolean => name === CATBEE_K8S_CLUSTER_NAME || name === kindContextName;
      const keep = (entry: { name: string }): boolean => !isCatBeeName(entry.name);
      const contexts = Array.isArray(doc.contexts) ? doc.contexts.filter(keep) : undefined;
      const clusters = Array.isArray(doc.clusters) ? doc.clusters.filter(keep) : undefined;
      const users = Array.isArray(doc.users) ? doc.users.filter(keep) : undefined;
      const currentContextRemoved = isCatBeeName(doc['current-context']);
      const entriesRemoved =
        (contexts && contexts.length !== doc.contexts?.length) ||
        (clusters && clusters.length !== doc.clusters?.length) ||
        (users && users.length !== doc.users?.length);
      if (!entriesRemoved && !currentContextRemoved) return;

      if (contexts) doc.contexts = contexts;
      if (clusters) doc.clusters = clusters;
      if (users) doc.users = users;
      if (currentContextRemoved) doc['current-context'] = contexts?.[0]?.name ?? '';

      await writeFile(kubeconfigPath, jsyaml.dump(doc, { lineWidth: -1 }), 'utf8');
      logger.debug(`Removed "${CATBEE_K8S_CLUSTER_NAME}" contexts from kubeconfig.`);
    } catch (err) {
      logger.error({ err }, 'Failed to clean kubeconfig contexts.');
      throw err;
    }
  }

  /** Prevents provisioning from racing with a Docker context change, shutdown, or data removal. */
  async suspendOperations(): Promise<() => void> {
    this.suspensions++;
    const resumed = (this.operationsResumed ??= Promise.withResolvers<void>());
    const resume = (): void => {
      this.suspensions--;
      if (this.suspensions === 0) {
        this.operationsResumed = null;
        resumed.resolve();
      }
    };
    try {
      this.apiReadinessController?.abort();
      if (this.activeCreation && !(await this.cancelCurrentOperation()).success) {
        throw new Error('Could not cancel Kubernetes provisioning before changing the Docker engine.');
      }
      await this.pendingOperation;
      await Promise.allSettled(this.kindInstalls.values());
      return resume;
    } catch (error) {
      resume();
      throw error;
    }
  }

  async onAppQuit(): Promise<void> {
    if (dockerManager.currentRuntime?.source !== 'embedded') return;
    logger.debug('Gracefully stopping Kubernetes companion and cluster containers on app quit...');
    const service = dockerManager.containers;
    try {
      const containers = await service.listContainers({ all: true });
      const companion = containers.find(isCloudProvider);
      if (companion) {
        await service.removeContainer(companion.Id, true);
      }
      for (const container of containers.filter(isClusterNode)) {
        if (container.State === 'paused') await service.unpauseContainer(container.Id);
        if (['running', 'paused', 'restarting'].includes(container.State)) {
          await service.stopContainer(container.Id);
        }
      }
    } catch (err) {
      logger.debug('Error stopping cluster containers on quit:', err);
    }
  }

  async onEngineUninstall(): Promise<void> {
    this.lastError = null;
    this.currentProgress = null;
    await this.cleanKubeconfig();
  }

  private async ensureCloudProvider(engine: ClusterEngine): Promise<void> {
    const { runtime, containers: service } = engine;
    // On Linux the embedded daemon and its socket share the host filesystem.
    // VM and external engines can expose a different socket to the desktop app.
    const rootlessSocket =
      process.platform === 'linux' && runtime.source === 'embedded' && runtime.connection.type === 'unix'
        ? runtime.connection.path
        : undefined;
    try {
      const containers = await service.listContainers({ all: true });
      const existing = containers.find(isCloudProvider);
      if (existing && (await this.reuseCloudProvider(service, existing, rootlessSocket))) return;

      logger.debug(`Ensuring cloud-provider-kind container (${KIND_CLOUD_PROVIDER_IMAGE})...`);
      await this.ensureCloudProviderImage(engine.images);
      const targetNetwork = await this.resolveCloudProviderNetwork(engine.networks, containers);

      const container = await service.createContainer({
        Image: KIND_CLOUD_PROVIDER_IMAGE,
        name: KIND_CLOUD_PROVIDER_CONTAINER,
        HostConfig: {
          NetworkMode: targetNetwork,
          ...(rootlessSocket
            ? { Mounts: [{ Type: 'bind', Source: rootlessSocket, Target: CLOUD_PROVIDER_DOCKER_SOCKET }] }
            : { Binds: [`${CLOUD_PROVIDER_DOCKER_SOCKET}:${CLOUD_PROVIDER_DOCKER_SOCKET}`] }),
          RestartPolicy: { Name: 'always' }
        },
        Labels: {
          [KIND_CLUSTER_LABEL]: CATBEE_K8S_CLUSTER_NAME,
          [KUBERNETES_NAMESPACE_LABEL]: 'kube-system'
        }
      });

      try {
        await service.startContainer(container.Id);
      } catch (startErr) {
        await service.removeContainer(container.Id, true).catch(() => {});
        throw startErr;
      }
      logger.debug(`Successfully started ${KIND_CLOUD_PROVIDER_CONTAINER}.`);
    } catch (err) {
      logger.warn({ err }, 'Optional cloud-provider-kind could not be started.');
    }
  }

  private async reuseCloudProvider(
    service: ClusterEngine['containers'],
    existing: Docker.ContainerInfo,
    rootlessSocket: string | undefined
  ): Promise<boolean> {
    if (
      rootlessSocket &&
      !existing.Mounts?.some(
        mount => mount.Source === rootlessSocket && mount.Destination === CLOUD_PROVIDER_DOCKER_SOCKET
      )
    ) {
      await service.removeContainer(existing.Id, true);
      return false;
    }
    if (existing.State === 'running') return true;

    try {
      await service.startContainer(existing.Id);
      return true;
    } catch (error) {
      logger.warn(
        { err: error },
        `Failed to start existing ${KIND_CLOUD_PROVIDER_CONTAINER}, removing and recreating...`
      );
      await service.removeContainer(existing.Id, true).catch(() => {});
      return false;
    }
  }

  private async ensureCloudProviderImage(images: ClusterEngine['images']): Promise<void> {
    try {
      const expectedTag = KIND_CLOUD_PROVIDER_IMAGE.replace(/^docker\.io\//, '');
      const available = await images.listImages();
      if (available.some(image => image.RepoTags?.some(tag => tag.replace(/^docker\.io\//, '') === expectedTag)))
        return;
      logger.debug(`Pulling cloud-provider-kind image: ${KIND_CLOUD_PROVIDER_IMAGE}...`);
      await images.pullImage(KIND_CLOUD_PROVIDER_IMAGE);
    } catch (err) {
      logger.warn({ err }, 'Could not pull cloud-provider-kind image, attempting container create anyway.');
    }
  }

  private async resolveCloudProviderNetwork(
    service: ClusterEngine['networks'],
    containers: Docker.ContainerInfo[]
  ): Promise<string> {
    let targetNetwork = 'kind';
    try {
      const networks = await service.listNetworks();
      if (networks.some(network => network.Name === targetNetwork)) return targetNetwork;

      const controlPlane = containers.find(
        node => isClusterNode(node) && node.Labels[KIND_ROLE_LABEL] === 'control-plane'
      );
      targetNetwork = Object.keys(controlPlane?.NetworkSettings?.Networks ?? {})[0] || targetNetwork;
      if (!networks.some(network => network.Name === targetNetwork)) {
        logger.debug(`Creating missing Docker network "${targetNetwork}" for kind...`);
        await service.createNetwork({ Name: targetNetwork, Driver: 'bridge' });
      }
    } catch (err) {
      logger.warn({ err }, 'Could not inspect/create Docker network for cloud provider.');
    }
    return targetNetwork;
  }

  async startCluster(
    config?: KubernetesSettingsConfig,
    fromReset = false,
    engine = this.getClusterEngine()
  ): Promise<K8sStartResult> {
    if (this.suspensions || this.isStarting || this.isStopping || (!fromReset && this.isResetting))
      return { success: false };
    this.assertEngineAvailable();
    if (!engine) throw new Error(EMBEDDED_ENGINE_REQUIRED);
    this.isStarting = true;
    const finish = fromReset ? undefined : this.trackOperation();
    this.lastError = null;

    try {
      await this.requireReachableEngine(engine.runtime);
      const settings = await getEngineSettings();
      const k8s = config ?? settings.kubernetes;
      if (!(await this.prepareClusterNodes(engine, k8s, fromReset)) || this.suspensions) {
        return { success: false, cancelled: true };
      }

      const target = await this.syncKubeconfig(engine.runtime);
      if (this.suspensions) return { success: false, cancelled: true };
      const readiness = new AbortController();
      this.apiReadinessController = readiness;
      this.emitProgress({
        operation: fromReset ? 'reset' : 'start',
        stage: 'Waiting for the Kubernetes API server...',
        progress: 95
      });
      await this.waitForApi(target, readiness.signal);
      readiness.signal.throwIfAborted();
      this.apiReadinessController = null;
      await this.ensureCloudProvider(engine);
      logger.info(`Successfully started cluster "${CATBEE_K8S_CLUSTER_NAME}".`);
      return { success: true };
    } catch (error) {
      if (this.apiReadinessController?.signal.aborted) return { success: false, cancelled: true };
      if (error instanceof Error && error.message === EMBEDDED_ENGINE_REQUIRED) throw error;
      await this.recordClusterStartFailure(error, engine);
      throw error;
    } finally {
      this.apiReadinessController = null;
      this.isStarting = false;
      finish?.();
      if (!fromReset) {
        this.emitProgress(null);
      }
    }
  }

  private async prepareClusterNodes(
    engine: ClusterEngine,
    config: KubernetesSettingsConfig,
    fromReset: boolean
  ): Promise<boolean> {
    const service = engine.containers;
    const containers = await service.listContainers({ all: true });
    if (this.suspensions) return false;

    // Startup resumes existing nodes. Configuration changes take effect through an explicit cluster reset.
    const nodes = containers.filter(isClusterNode);
    if (!nodes.length) return this.createCluster(engine, config, fromReset);
    if (!nodes.some(node => node.Labels[KIND_ROLE_LABEL] === 'control-plane')) {
      throw new Error('The existing Kubernetes cluster is missing its control-plane container.');
    }

    const stoppedNodes = nodes.filter(node => node.State !== 'running');
    if (!stoppedNodes.length) return true;
    this.emitProgress({
      operation: fromReset ? 'reset' : 'start',
      stage: 'Starting existing cluster containers...',
      progress: 50,
      detail: `Starting ${stoppedNodes.length} container(s)`
    });
    for (const node of stoppedNodes) {
      if (this.suspensions) return false;
      if (node.State === 'paused') await service.unpauseContainer(node.Id);
      else await service.startContainer(node.Id);
    }
    return true;
  }

  private async recordClusterStartFailure(error: unknown, engine: ClusterEngine | null): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = { runtime: engine?.runtime ?? null, message };
    logger.error({ err: error }, `Failed to start cluster: ${message}`);
    if (!engine) return;

    try {
      const containers = await engine.containers.listContainers({ all: true });
      const controlPlane = containers.find(
        node => isClusterNode(node) && node.Labels[KIND_ROLE_LABEL] === 'control-plane'
      );
      if (!controlPlane) return;
      const { State } = await engine.containers.inspectContainer(controlPlane.Id);
      logger.error(
        `Retained control-plane state=${controlPlane.State}, exitCode=${State.ExitCode}, error="${State.Error}", OOMKilled=${State.OOMKilled}`
      );
    } catch (err) {
      logger.debug({ err }, 'Could not inspect retained control-plane container.');
    }
  }

  private async createCluster(
    engine: ClusterEngine,
    config: KubernetesSettingsConfig,
    fromReset: boolean
  ): Promise<boolean> {
    // AppData/Temp can be virtualized in MSIX; WSL needs files at their actual host paths.
    const tempRoot = path.join(homeDir(), '.catbee', 'k8s');
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const tempDir = await mkdtemp(path.join(tempRoot, 'create-'));
    const configPath = path.join(tempDir, 'kind.yaml');
    const kubeconfigPath = path.join(tempDir, 'kubeconfig');
    const cancelFile = this.isWslEngine(engine.runtime) ? path.join(tempDir, 'cancel') : undefined;
    const controller = new AbortController();
    const completion = Promise.withResolvers<boolean>();
    let cleanedUp = false;

    try {
      await writeFile(configPath, this.generateKindConfig(config.version, config.nodeCount), 'utf8');
      if (this.suspensions) return false;
      this.emitProgress({
        operation: fromReset ? 'reset' : 'start',
        stage: 'Initializing cluster configuration...',
        progress: 10,
        detail: `Preparing cluster "${CATBEE_K8S_CLUSTER_NAME}" (${config.version})`
      });
      this.activeCreation = { controller, completion: completion.promise, cancelFile };
      await this.executeKind(
        engine.runtime,
        [
          'create',
          'cluster',
          '--config',
          configPath,
          '--kubeconfig',
          kubeconfigPath,
          '--name',
          CATBEE_K8S_CLUSTER_NAME,
          '--retain',
          '-v',
          '4'
        ],
        {
          timeoutMs: KIND_CREATE_TIMEOUT_MS,
          signal: controller.signal,
          cancelFile,
          onOutput: line => {
            if (!controller.signal.aborted) this.parseKindOutput(line);
          }
        }
      );
      controller.signal.throwIfAborted();
      return true;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      await this.deleteClusterContainers(engine.containers);
      cleanedUp = true;
      logger.info('Cancelled cluster creation and removed its containers.');
      return false;
    } finally {
      this.activeCreation = null;
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      completion.resolve(cleanedUp);
    }
  }

  private async deleteClusterContainers(service: ClusterEngine['containers']): Promise<void> {
    const containers = await service.listContainers({ all: true });
    const companion = containers.find(isCloudProvider);
    if (companion) {
      await service.removeContainer(companion.Id, true);
    }
    for (const container of containers.filter(isClusterNode)) {
      // kind deletes node containers together with their anonymous volumes.
      await service.removeContainer(container.Id, true, true);
    }
  }

  private trackOperation(): () => void {
    const completion = Promise.withResolvers<void>();
    this.pendingOperation = completion.promise;
    return () => {
      this.pendingOperation = null;
      completion.resolve();
    };
  }

  applyEnabledSetting(): Promise<void> {
    const apply = this.settingsQueue.then(async () => {
      for (;;) {
        const pending = this.operationsResumed?.promise ?? this.pendingOperation;
        if (pending) {
          await pending;
          continue;
        }
        const { kubernetes } = await getEngineSettings();
        if (this.operationsResumed || this.pendingOperation) continue;
        if (!dockerManager.isEmbeddedEngineReady || !this.getClusterEngine()) return;
        if (kubernetes.enabled) await this.startCluster(kubernetes);
        else await this.stopCluster();
        return;
      }
    });
    this.settingsQueue = apply.catch(() => {});
    return apply;
  }

  async stopCluster(): Promise<void> {
    if (this.suspensions) throw new Error('Wait for the engine operation to finish before stopping Kubernetes.');
    if (this.isStopping) return;
    if (this.isStarting || this.isResetting) throw new Error('Wait for the active Kubernetes operation to finish.');
    this.assertEngineAvailable();
    this.isStopping = true;
    const finish = this.trackOperation();
    const engine = this.getClusterEngine();
    this.emitProgress({ operation: 'stop', stage: 'Stopping Kubernetes cluster...', progress: 50 });
    try {
      if (engine) await this.stopClusterContainers(engine.containers);
      this.lastError = null;
    } finally {
      this.isStopping = false;
      finish();
      this.emitProgress(null);
    }
  }

  private async stopClusterContainers(service: ClusterEngine['containers']): Promise<void> {
    const containers = await service.listContainers({ all: true });
    for (const container of containers) {
      if (!isClusterNode(container) && !isCloudProvider(container)) continue;
      if (container.State === 'paused') await service.unpauseContainer(container.Id);
      if (['running', 'paused', 'restarting'].includes(container.State)) {
        await service.stopContainer(container.Id);
      }
    }
  }

  async removeCluster(engine = this.getClusterEngine()): Promise<void> {
    if (engine) await this.deleteClusterContainers(engine.containers);
    await this.cleanKubeconfig();
  }

  async resetCluster(): Promise<K8sStartResult> {
    if (this.suspensions || this.isResetting || this.isStarting || this.isStopping) return { success: false };
    this.isResetting = true;
    const finish = this.trackOperation();
    const engine = this.getClusterEngine();
    this.lastError = null;
    this.emitProgress({
      operation: 'reset',
      stage: 'Resetting Kubernetes cluster...',
      progress: 10
    });

    try {
      logger.info(`Resetting cluster "${CATBEE_K8S_CLUSTER_NAME}"...`);
      await this.requireReachableEngine(engine?.runtime ?? null);
      await this.removeCluster(engine);

      const settings = await getEngineSettings();
      if (settings.kubernetes.enabled) {
        return await this.startCluster(settings.kubernetes, true, engine);
      }
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.lastError = { runtime: engine?.runtime ?? null, message: msg };
      logger.error({ err: error }, `Failed to reset cluster: ${msg}`);
      return { success: false };
    } finally {
      this.isResetting = false;
      finish();
      this.emitProgress(null);
    }
  }

  async uninstallRuntime(): Promise<{ success: boolean }> {
    if (this.suspensions || this.kindInstalls.size || this.isStarting || this.isStopping || this.isResetting)
      return { success: false };
    this.isStopping = true;
    const finish = this.trackOperation();
    const engine = this.getClusterEngine();
    this.emitProgress({
      operation: 'uninstall',
      stage: 'Uninstalling Kubernetes runtime (kind)...',
      progress: 20
    });
    try {
      await this.requireReachableEngine(engine?.runtime ?? null);
      await this.removeCluster(engine);

      if (this.isWslEngine(engine?.runtime ?? null)) {
        await this.runInWsl(['rm', '-f', '--', WSL_KIND_BINARY], { timeoutMs: 15_000 });
        await this.rememberWslKindInstallation(false);
        const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
        const cachedLinuxBin = path.join(getEngineBinDir(), `kind-linux-${arch}`);
        await rm(cachedLinuxBin, { force: true });
      }

      const kindBin = await this.getKindBinaryPath();
      if (kindBin && (await pathExists(kindBin))) {
        await rm(kindBin, { force: true });
        logger.debug(`Removed kind binary: ${kindBin}`);
      }

      this.lastError = null;
      logger.info('Kubernetes runtime uninstalled.');
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.lastError = { runtime: engine?.runtime ?? null, message: msg };
      logger.error({ err: error }, `Failed to uninstall kind: ${msg}`);
      return { success: false };
    } finally {
      this.isStopping = false;
      finish();
      this.emitProgress(null);
    }
  }

  async cancelCurrentOperation(): Promise<{ success: boolean }> {
    const creation = this.activeCreation;
    if (!creation) {
      return { success: false };
    }
    if (creation.controller.signal.aborted) {
      return { success: await creation.completion };
    }
    if (creation.cancelFile) {
      try {
        writeFileSync(creation.cancelFile, '');
      } catch (err) {
        logger.error({ err }, 'Could not signal cancellation to the WSL process.');
        return { success: false };
      }
    }
    logger.debug('User requested cancellation of active Kubernetes cluster operation.');
    this.emitProgress({
      operation: 'stop',
      stage: 'Cancelling operation and cleaning up cluster...',
      progress: 50
    });

    creation.controller.abort();
    return { success: await creation.completion };
  }
}

export const k8sManager = new K8sManager();
