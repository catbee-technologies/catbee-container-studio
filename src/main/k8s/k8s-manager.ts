import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Docker from 'dockerode';
import jsyaml from 'js-yaml';
import { logger } from '../logger';
import { getEngineBinDir, homeDir } from '../docker/embedded/engine-paths';
import {
  describeDownload,
  downloadFile,
  ensureHostDockerCli,
  pathExists,
  runCommand,
  sleep,
  type RunResult
} from '../docker/embedded/engine-utils';
import { getEngineSettings, type KubernetesSettingsConfig } from '../docker/embedded/engine-settings';
import { dockerManager } from '../docker/services/docker.manager';
import { getDockerCliPath } from '../docker/runtime/docker.runtime';
import type { SelectedDockerRuntime } from '../docker/types/runtime.types';
import { connectionToUri } from '../docker/embedded/engine-utils';
import { windowsToWslPath } from '../docker/embedded/windows-path-rewriter';

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

type ClusterEngine = Pick<typeof dockerManager, 'containers' | 'exec' | 'images' | 'networks'> & {
  runtime: SelectedDockerRuntime;
};

function isClusterNode(container: Docker.ContainerInfo): boolean {
  return (
    container.Labels?.[KIND_CLUSTER_LABEL] === CATBEE_K8S_CLUSTER_NAME && Boolean(container.Labels[KIND_ROLE_LABEL])
  );
}

function isCloudProvider(container: Docker.ContainerInfo): boolean {
  return (
    container.Labels?.[KIND_CLUSTER_LABEL] === CATBEE_K8S_CLUSTER_NAME &&
    container.Labels[KUBERNETES_NAMESPACE_LABEL] === 'kube-system' &&
    Boolean(container.Names?.includes(`/${KIND_CLOUD_PROVIDER_CONTAINER}`))
  );
}

export interface K8sOperationProgress {
  operation: 'install' | 'start' | 'stop' | 'reset' | 'uninstall';
  stage: string;
  progress?: number;
  detail?: string;
}

export interface K8sClusterInfo {
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  name: string;
  provisioner: 'kind' | 'kubeadm';
  version: string;
  nodeCount: number;
  isKindInstalled: boolean;
  runtimeVersion?: string;
  operation?: K8sOperationProgress | null;
  startedAt?: number;
  error?: string;
  apiEndpoint?: string;
  kubeconfigPath?: string;
}

class K8sManager {
  private isStarting = false;
  private isStopping = false;
  private isResetting = false;
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
        logger.error({ err }, '[K8sManager] Error in progress listener.');
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
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch('https://registry.hub.docker.com/v2/repositories/kindest/node/tags?page_size=100', {
        signal: controller.signal
      });
      clearTimeout(timeout);

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
      logger.debug(
        `[K8sManager] Could not fetch remote kindest/node tags: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return [...DEFAULT_K8S_VERSIONS];
  }

  private getClusterEngine(): ClusterEngine | null {
    const { currentRuntime: runtime, containers, exec, images, networks } = dockerManager;
    return runtime ? { runtime, containers, exec, images, networks } : null;
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
    if (this.isWslEngine(runtime)) {
      try {
        await runCommand('wsl.exe', ['-d', CATBEE_WSL_DISTRO, '-u', 'root', 'test', '-x', '/usr/local/bin/kind'], {
          timeoutMs: 5000
        });
        return true;
      } catch {
        return false;
      }
    }
    return (await this.getKindBinaryPath()) !== null;
  }

  private async installKindInWsl(): Promise<string> {
    const binDir = getEngineBinDir();
    await mkdir(binDir, { recursive: true });
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const cachedLinuxBin = path.join(binDir, `kind-linux-${arch}`);
    const downloadUrl = `https://github.com/kubernetes-sigs/kind/releases/download/${KIND_RELEASE_VERSION}/kind-linux-${arch}`;

    if (!(await pathExists(cachedLinuxBin))) {
      logger.info(`[K8sManager] Downloading kind Linux binary from ${downloadUrl} to ${cachedLinuxBin}`);
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
        logger.error(`[K8sManager] Failed to download kind Linux binary: ${msg}`);
        throw new Error(`Failed to obtain kind binary: ${msg}`);
      }
    }

    const wslSource = windowsToWslPath(cachedLinuxBin);
    if (!wslSource) {
      throw new Error(`Could not translate Windows path to WSL: ${cachedLinuxBin}`);
    }

    try {
      await runCommand(
        'wsl.exe',
        [
          '-d',
          CATBEE_WSL_DISTRO,
          '-u',
          'root',
          'sh',
          '-c',
          `cp '${wslSource}' /usr/local/bin/kind && chmod +x /usr/local/bin/kind`
        ],
        { timeoutMs: 30_000 }
      );
      logger.info('[K8sManager] Successfully installed kind binary in WSL distro.');
      return '/usr/local/bin/kind';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[K8sManager] Failed to copy kind binary into WSL: ${msg}`);
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

    logger.info(`[K8sManager] Downloading kind binary from ${downloadUrl} to ${target}`);
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
      logger.info(`[K8sManager] Successfully installed kind binary to ${target}`);
      return target;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[K8sManager] Failed to download kind binary: ${msg}`);
      throw new Error(`Failed to obtain kind binary: ${msg}`);
    }
  }

  async installKind(runtime = dockerManager.currentRuntime): Promise<string> {
    const wsl = this.isWslEngine(runtime);
    const existing = this.kindInstalls.get(wsl);
    if (existing) return existing;

    const install = (wsl ? this.installKindInWsl() : this.installKindOnHost()).finally(() => {
      this.kindInstalls.delete(wsl);
      if (!this.kindInstalls.size) this.emitProgress(null);
    });
    this.kindInstalls.set(wsl, install);
    return install;
  }

  private async ensureKindBinary(runtime: SelectedDockerRuntime): Promise<string> {
    await ensureHostDockerCli().catch(err => {
      logger.debug('[K8sManager] Could not ensure standalone Docker CLI in background:', err);
    });
    if (this.isWslEngine(runtime)) {
      const isInstalled = await this.isKindInstalled(runtime);
      if (!isInstalled) {
        return this.installKind(runtime);
      }
      return '/usr/local/bin/kind';
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
      return runCommand(
        'wsl.exe',
        [
          '-d',
          CATBEE_WSL_DISTRO,
          '-u',
          'root',
          '--',
          'env',
          'DOCKER_CONTEXT=',
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

  private async getDockerEnv(runtime: SelectedDockerRuntime): Promise<NodeJS.ProcessEnv> {
    // eslint-disable-next-line n/no-process-env
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Drop DOCKER_CONTEXT so Docker CLI does not direct commands to a third-party context (e.g. Rancher Desktop)
    delete env.DOCKER_CONTEXT;
    env.DOCKER_HOST = connectionToUri(runtime.connection);
    env.KIND_EXPERIMENTAL_PROVIDER = 'docker';

    // Isolate Docker CLI from ~/.docker/config.json plugin hooks (such as "debug": {"hooks": "exec"}
    // or credential helper prompts) that break non-interactive docker exec streams in Kind.
    const configDir = path.join(os.tmpdir(), 'catbee-k8s-docker');
    try {
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }
      const configPath = path.join(configDir, 'config.json');
      if (!existsSync(configPath)) {
        writeFileSync(configPath, '{}', 'utf8');
      }
      env.DOCKER_CONFIG = configDir;
    } catch {
      // ignore
    }

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
    const engine = this.getClusterEngine();
    const settings = await getEngineSettings();
    const k8sConfig = settings.kubernetes;
    const isKindInstalled = await this.isKindInstalled(engine?.runtime ?? null);
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

    if (this.kindInstalls.size) {
      return { ...baseInfo, status: 'starting', isKindInstalled: false };
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
      if (!engine) {
        return { ...baseInfo, status: lastError ? 'error' : 'stopped' };
      }

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
      if (!(await this.isApiReady(engine.exec, controlPlane.Id))) {
        return { ...clusterInfo, status: 'error', error: 'The Kubernetes API server is not ready.' };
      }

      return {
        ...clusterInfo,
        status: 'running',
        startedAt: controlPlane.Created ? controlPlane.Created * 1000 : undefined,
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

  private async isApiReady(exec: ClusterEngine['exec'], containerId: string): Promise<boolean> {
    // Kind ships kubectl and the control-plane kubeconfig inside the node.
    const exitCode = await exec
      .getCommandExitCode(
        containerId,
        ['kubectl', '--kubeconfig=/etc/kubernetes/admin.conf', '--request-timeout=3s', 'get', '--raw=/readyz'],
        AbortSignal.timeout(5_000)
      )
      .catch(() => null);
    return exitCode === 0;
  }

  private async waitForApi(engine: ClusterEngine): Promise<void> {
    const containers = await engine.containers.listContainers({ all: true });
    const controlPlane = containers.find(c => isClusterNode(c) && c.Labels[KIND_ROLE_LABEL] === 'control-plane');
    if (!controlPlane) throw new Error('The Kubernetes cluster is missing its control-plane container.');

    const deadline = Date.now() + API_START_TIMEOUT_MS;
    do {
      if (await this.isApiReady(engine.exec, controlPlane.Id)) return;
      await sleep(1_000);
    } while (Date.now() < deadline);
    throw new Error('The Kubernetes API server did not become ready. Cluster data was preserved.');
  }

  private generateKindConfig(version: string, nodeCount: number): string {
    const imageTag = version.startsWith('v') ? version : `v${version}`;
    const lines = [
      'kind: Cluster',
      'apiVersion: kind.x-k8s.io/v1alpha4',
      `name: ${CATBEE_K8S_CLUSTER_NAME}`,
      'networking:',
      '  apiServerAddress: "0.0.0.0"',
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
    logger.info(`[K8sManager:kind] ${line}`);
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
    if (process.env.KUBECONFIG) {
      // eslint-disable-next-line n/no-process-env
      return process.env.KUBECONFIG.split(path.delimiter)[0];
    }
    return path.join(homeDir(), '.kube', 'config');
  }

  private async syncKubeconfig(runtime: SelectedDockerRuntime): Promise<void> {
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
      interface KubeconfigDoc {
        contexts?: { name: string; context: Record<string, unknown> }[];
        clusters?: { name: string; cluster: Record<string, unknown> }[];
        users?: { name: string; user: Record<string, unknown> }[];
        'current-context'?: string;
        [key: string]: unknown;
      }
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
      await writeFile(kubeconfigPath, jsyaml.dump(doc, { lineWidth: -1 }), 'utf8');
      logger.info(`[K8sManager] Successfully synced kubeconfig with context "${CATBEE_K8S_CLUSTER_NAME}".`);
    } catch (err) {
      throw new Error('Could not update the CatBee context in kubeconfig.', { cause: err });
    }
  }

  async cleanKubeconfig(): Promise<void> {
    const kubeconfigPath = this.getKubeconfigPath();
    try {
      if (!(await pathExists(kubeconfigPath))) return;
      const raw = await readFile(kubeconfigPath, 'utf8');
      interface KubeconfigDoc {
        contexts?: { name: string; context: Record<string, unknown> }[];
        clusters?: { name: string; cluster: Record<string, unknown> }[];
        users?: { name: string; user: Record<string, unknown> }[];
        'current-context'?: string;
        [key: string]: unknown;
      }
      const doc = jsyaml.load(raw) as KubeconfigDoc | null;
      if (!doc || !Array.isArray(doc.contexts)) return;

      const kindContextName = `kind-${CATBEE_K8S_CLUSTER_NAME}`;
      doc.contexts = doc.contexts.filter(c => c.name !== CATBEE_K8S_CLUSTER_NAME && c.name !== kindContextName);
      if (doc.clusters) {
        doc.clusters = doc.clusters.filter(cl => cl.name !== kindContextName && cl.name !== CATBEE_K8S_CLUSTER_NAME);
      }
      if (doc.users) {
        doc.users = doc.users.filter(u => u.name !== kindContextName && u.name !== CATBEE_K8S_CLUSTER_NAME);
      }

      if (doc['current-context'] === CATBEE_K8S_CLUSTER_NAME || doc['current-context'] === kindContextName) {
        doc['current-context'] = doc.contexts[0]?.name ?? '';
      }

      await writeFile(kubeconfigPath, jsyaml.dump(doc, { lineWidth: -1 }), 'utf8');
      logger.info(`[K8sManager] Removed "${CATBEE_K8S_CLUSTER_NAME}" contexts from kubeconfig.`);
    } catch (err) {
      logger.warn({ err }, '[K8sManager] Failed to clean kubeconfig contexts.');
    }
  }

  async onAppQuit(): Promise<void> {
    if (!dockerManager.currentRuntime) return;
    logger.info('[K8sManager] Gracefully stopping Kubernetes companion and cluster containers on app quit...');
    const service = dockerManager.containers;
    try {
      const containers = await service.listContainers({ all: true });
      const companion = containers.find(isCloudProvider);
      if (companion) {
        await service.stopContainer(companion.Id).catch(() => {});
        await service.removeContainer(companion.Id, true).catch(() => {});
      }
      for (const container of containers.filter(isClusterNode)) {
        if (container.State === 'running') {
          await service.stopContainer(container.Id).catch(() => {});
        }
      }
    } catch (err) {
      logger.debug('[K8sManager] Error stopping cluster containers on quit:', err);
    }
  }

  async onEngineUninstall(): Promise<void> {
    this.lastError = null;
    this.currentProgress = null;
    await this.cleanKubeconfig().catch(() => {});
  }

  private async ensureCloudProvider(engine: ClusterEngine): Promise<void> {
    const { runtime, containers: service, images, networks: networkService } = engine;
    // On Linux the embedded daemon and its socket share the host filesystem.
    // VM and external engines can expose a different socket to the desktop app.
    const rootlessSocket =
      process.platform === 'linux' && runtime.source === 'embedded' && runtime.connection.type === 'unix'
        ? runtime.connection.path
        : undefined;
    try {
      const containers = await service.listContainers({ all: true });
      const existing = containers.find(isCloudProvider);

      if (
        existing &&
        rootlessSocket &&
        !existing.Mounts?.some(
          mount => mount.Source === rootlessSocket && mount.Destination === CLOUD_PROVIDER_DOCKER_SOCKET
        )
      ) {
        await service.removeContainer(existing.Id, true);
      } else if (existing) {
        if (existing.State === 'running') {
          return;
        }
        try {
          await service.startContainer(existing.Id);
          return;
        } catch (startErr) {
          logger.warn(
            { err: startErr },
            `[K8sManager] Failed to start existing ${KIND_CLOUD_PROVIDER_CONTAINER}, removing and recreating...`
          );
          await service.removeContainer(existing.Id, true).catch(() => {});
        }
      }

      logger.info(`[K8sManager] Ensuring cloud-provider-kind container (${KIND_CLOUD_PROVIDER_IMAGE})...`);

      try {
        const availableImages = await images.listImages();
        const hasImage = availableImages.some((img: Docker.ImageInfo) =>
          (img.RepoTags ?? []).some(
            (t: string) => t.includes(KIND_CLOUD_PROVIDER_IMAGE) || t.includes('desktop-cloud-provider-kind')
          )
        );
        if (!hasImage) {
          logger.info(`[K8sManager] Pulling cloud-provider-kind image: ${KIND_CLOUD_PROVIDER_IMAGE}...`);
          await images.pullImage(KIND_CLOUD_PROVIDER_IMAGE);
        }
      } catch (pullErr) {
        logger.warn(
          { err: pullErr },
          '[K8sManager] Could not pull cloud-provider-kind image, attempting container create anyway.'
        );
      }

      // Check available Docker networks and determine target network
      let targetNetwork = 'kind';
      try {
        const networks = await networkService.listNetworks();
        const hasKindNet = networks.some((n: Docker.NetworkInspectInfo) => n.Name === 'kind');
        if (!hasKindNet) {
          // Check if kind control-plane container is connected to another network
          const controlPlane = containers.find(c => isClusterNode(c) && c.Labels[KIND_ROLE_LABEL] === 'control-plane');
          if (controlPlane?.NetworkSettings?.Networks) {
            const nets = Object.keys(controlPlane.NetworkSettings.Networks);
            if (nets.length > 0 && nets[0]) {
              targetNetwork = nets[0];
            }
          }
          if (!networks.some((n: Docker.NetworkInspectInfo) => n.Name === targetNetwork)) {
            logger.info(`[K8sManager] Creating missing Docker network "${targetNetwork}" for kind...`);
            await networkService.createNetwork({
              Name: targetNetwork,
              Driver: 'bridge'
            });
          }
        }
      } catch (netErr) {
        logger.warn({ err: netErr }, '[K8sManager] Could not inspect/create Docker network for cloud provider.');
      }

      let container: { Id: string } | null = null;
      try {
        container = await service.createContainer({
          Image: KIND_CLOUD_PROVIDER_IMAGE,
          name: KIND_CLOUD_PROVIDER_CONTAINER,
          HostConfig: {
            NetworkMode: targetNetwork,
            ...(rootlessSocket
              ? { Mounts: [{ Type: 'bind', Source: rootlessSocket, Target: CLOUD_PROVIDER_DOCKER_SOCKET }] }
              : { Binds: [`${CLOUD_PROVIDER_DOCKER_SOCKET}:${CLOUD_PROVIDER_DOCKER_SOCKET}`] }),
            RestartPolicy: {
              Name: 'always'
            }
          },
          Labels: {
            [KIND_CLUSTER_LABEL]: CATBEE_K8S_CLUSTER_NAME,
            [KUBERNETES_NAMESPACE_LABEL]: 'kube-system'
          }
        });

        await service.startContainer(container.Id);
        logger.info(`[K8sManager] Successfully started ${KIND_CLOUD_PROVIDER_CONTAINER}.`);
      } catch (startErr) {
        if (container) {
          await service.removeContainer(container.Id, true).catch(() => {});
        }
        throw startErr;
      }
    } catch (err) {
      logger.warn({ err }, '[K8sManager] Optional cloud-provider-kind could not be started.');
    }
  }

  async startCluster(
    config?: KubernetesSettingsConfig,
    fromReset = false,
    engine = this.getClusterEngine()
  ): Promise<void> {
    if (this.isStarting || this.isStopping || (!fromReset && this.isResetting)) return;
    this.isStarting = true;
    this.lastError = null;

    try {
      const settings = await getEngineSettings();
      const k8s = config ?? settings.kubernetes;

      if (!engine) {
        throw new Error('A Docker engine must be connected to start Kubernetes.');
      }
      const service = engine.containers;
      const containers = await service.listContainers({ all: true });
      const clusterContainers = containers.filter(isClusterNode);

      // Startup resumes existing nodes. Configuration changes take effect through an explicit cluster reset.
      if (clusterContainers.length > 0) {
        if (!clusterContainers.some(container => container.Labels[KIND_ROLE_LABEL] === 'control-plane')) {
          throw new Error('The existing Kubernetes cluster is missing its control-plane container.');
        }

        const stoppedNodes = clusterContainers.filter(container => container.State !== 'running');
        if (stoppedNodes.length > 0) {
          this.emitProgress({
            operation: fromReset ? 'reset' : 'start',
            stage: 'Starting existing cluster containers...',
            progress: 50,
            detail: `Starting ${stoppedNodes.length} container(s)`
          });
          for (const container of stoppedNodes) {
            await service.startContainer(container.Id);
          }
        }
      } else if (!(await this.createCluster(engine, k8s, fromReset))) {
        return;
      }

      this.emitProgress({
        operation: fromReset ? 'reset' : 'start',
        stage: 'Waiting for the Kubernetes API server...',
        progress: 95
      });
      await this.waitForApi(engine);
      await this.syncKubeconfig(engine.runtime);
      await this.ensureCloudProvider(engine);
      logger.info(`[K8sManager] Successfully started cluster "${CATBEE_K8S_CLUSTER_NAME}".`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.lastError = { runtime: engine?.runtime ?? null, message: msg };
      logger.error({ err: error }, `[K8sManager] Failed to start cluster: ${msg}`);
      try {
        const containers = await engine?.containers.listContainers({ all: true });
        const controlPlane = containers?.find(c => isClusterNode(c) && c.Labels[KIND_ROLE_LABEL] === 'control-plane');
        if (controlPlane && engine) {
          const { State } = await engine.containers.inspectContainer(controlPlane.Id);
          logger.error(
            `[K8sManager] Retained control-plane state=${controlPlane.State}, exitCode=${State.ExitCode}, error="${State.Error}", OOMKilled=${State.OOMKilled}`
          );
        }
      } catch (inspectErr) {
        logger.debug({ err: inspectErr }, '[K8sManager] Could not inspect retained control-plane container.');
      }
      throw error;
    } finally {
      this.isStarting = false;
      if (!fromReset) {
        this.emitProgress(null);
      }
    }
  }

  private async createCluster(
    engine: ClusterEngine,
    config: KubernetesSettingsConfig,
    fromReset: boolean
  ): Promise<boolean> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'catbee-k8s-'));
    const configPath = path.join(tempDir, 'kind.yaml');
    const kubeconfigPath = path.join(tempDir, 'kubeconfig');
    const cancelFile = this.isWslEngine(engine.runtime) ? path.join(tempDir, 'cancel') : undefined;
    const controller = new AbortController();
    const completion = Promise.withResolvers<boolean>();
    let cleanedUp = false;

    try {
      await writeFile(configPath, this.generateKindConfig(config.version, config.nodeCount), 'utf8');
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
      logger.info('[K8sManager] Cancelled cluster creation and removed its containers.');
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

  async stopCluster(fromReset = false, engine = this.getClusterEngine()): Promise<void> {
    if (this.isStopping) return;
    this.isStopping = true;
    if (!fromReset) {
      this.emitProgress({
        operation: 'stop',
        stage: 'Stopping and deleting Kubernetes cluster...',
        progress: 50
      });
    }

    try {
      if (engine) await this.deleteClusterContainers(engine.containers);

      await this.cleanKubeconfig();
      this.lastError = null;
    } finally {
      this.isStopping = false;
      if (!fromReset) {
        this.emitProgress(null);
      }
    }
  }

  async resetCluster(): Promise<{ success: boolean }> {
    if (this.isResetting) return { success: false };
    this.isResetting = true;
    const engine = this.getClusterEngine();
    this.lastError = null;
    this.emitProgress({
      operation: 'reset',
      stage: 'Resetting Kubernetes cluster...',
      progress: 10
    });

    try {
      logger.info(`[K8sManager] Resetting cluster "${CATBEE_K8S_CLUSTER_NAME}"...`);
      await this.stopCluster(true, engine);

      const settings = await getEngineSettings();
      if (settings.kubernetes.enabled) {
        await this.startCluster(settings.kubernetes, true, engine);
      }
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.lastError = { runtime: engine?.runtime ?? null, message: msg };
      logger.error({ err: error }, `[K8sManager] Failed to reset cluster: ${msg}`);
      return { success: false };
    } finally {
      this.isResetting = false;
      this.emitProgress(null);
    }
  }

  async uninstallRuntime(): Promise<{ success: boolean }> {
    const engine = this.getClusterEngine();
    this.emitProgress({
      operation: 'uninstall',
      stage: 'Uninstalling Kubernetes runtime (kind)...',
      progress: 20
    });
    try {
      await this.stopCluster(false, engine);

      if (this.isWslEngine(engine?.runtime ?? null)) {
        await runCommand('wsl.exe', ['-d', CATBEE_WSL_DISTRO, '-u', 'root', 'rm', '-f', '/usr/local/bin/kind'], {
          timeoutMs: 15_000
        }).catch(() => {});
        const cachedLinuxBin = path.join(getEngineBinDir(), 'kind-linux-amd64');
        await rm(cachedLinuxBin, { force: true }).catch(() => {});
      }

      const kindBin = await this.getKindBinaryPath();
      if (kindBin && (await pathExists(kindBin))) {
        await rm(kindBin, { force: true }).catch(() => {});
        logger.info(`[K8sManager] Removed kind binary: ${kindBin}`);
      }

      this.lastError = null;
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.lastError = { runtime: engine?.runtime ?? null, message: msg };
      logger.error({ err: error }, `[K8sManager] Failed to uninstall kind: ${msg}`);
      return { success: false };
    } finally {
      this.emitProgress(null);
    }
  }

  async cancelCurrentOperation(): Promise<{ success: boolean }> {
    const creation = this.activeCreation;
    if (!creation || creation.controller.signal.aborted) {
      return { success: false };
    }
    if (creation.cancelFile) {
      try {
        writeFileSync(creation.cancelFile, '');
      } catch (err) {
        logger.warn({ err }, '[K8sManager] Could not signal cancellation to the WSL process.');
        return { success: false };
      }
    }
    logger.info('[K8sManager] User requested cancellation of active Kubernetes cluster operation.');
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
