import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Docker from 'dockerode';
import jsyaml from 'js-yaml';
import { logger } from '../logger';
import { getEngineBinDir } from '../docker/embedded/engine-paths';
import {
  commandExists,
  describeDownload,
  downloadFile,
  ensureHostDockerCli,
  pathExists,
  runCommand,
  type RunResult
} from '../docker/embedded/engine-utils';
import { getEngineSettings, type KubernetesSettingsConfig } from '../docker/embedded/engine-settings';
import { dockerManager } from '../docker/services/docker.manager';
import { connectionToUri } from '../docker/embedded/engine-utils';
import { windowsToWslPath } from '../docker/embedded/windows-path-rewriter';

import {
  CATBEE_K8S_CLUSTER_NAME,
  CATBEE_WSL_DISTRO,
  CATBEE_WSL_DOCKER_TCP_PORT,
  DEFAULT_K8S_VERSIONS,
  KIND_RELEASE_VERSION,
  KIND_CLOUD_PROVIDER_IMAGE,
  KIND_CLOUD_PROVIDER_CONTAINER
} from '../../constants.docker';

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
  private isInstalling = false;
  private currentAbortController: AbortController | null = null;
  private installPromise: Promise<string> | null = null;
  private lastError: string | null = null;
  private cachedStartedAt: number | null = null;
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
            return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), m[4] ?? ''];
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

  private isWslEngine(): boolean {
    return process.platform === 'win32' && dockerManager.currentRuntime?.source === 'embedded';
  }

  async getKindBinaryPath(): Promise<string | null> {
    const binDir = getEngineBinDir();
    const exeName = process.platform === 'win32' ? 'kind.exe' : 'kind';
    const localBin = path.join(binDir, exeName);

    if (await pathExists(localBin)) {
      return localBin;
    }

    if (await commandExists('kind')) {
      return 'kind';
    }

    return null;
  }

  async isKindInstalled(): Promise<boolean> {
    if (this.isWslEngine()) {
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

  async installKind(): Promise<string> {
    if (this.installPromise) {
      return this.installPromise;
    }
    this.isInstalling = true;
    this.installPromise = (async () => {
      if (this.isWslEngine()) {
        const binDir = getEngineBinDir();
        await mkdir(binDir, { recursive: true });
        const cachedLinuxBin = path.join(binDir, 'kind-linux-amd64');
        const downloadUrl = `https://github.com/kubernetes-sigs/kind/releases/download/${KIND_RELEASE_VERSION}/kind-linux-amd64`;

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
                detail:
                  total > 0 ? `${(received / 1048576).toFixed(1)} MB / ${(total / 1048576).toFixed(1)} MB` : undefined
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
        } finally {
          this.isInstalling = false;
          this.installPromise = null;
          this.emitProgress(null);
        }
      }

      const binDir = getEngineBinDir();
      await mkdir(binDir, { recursive: true });
      const exeName = process.platform === 'win32' ? 'kind.exe' : 'kind';
      const target = path.join(binDir, exeName);

      const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
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
      } finally {
        this.isInstalling = false;
        this.installPromise = null;
        this.emitProgress(null);
      }
    })();
    return this.installPromise;
  }

  async ensureKindBinary(): Promise<string> {
    void ensureHostDockerCli().catch(err => {
      logger.debug('[K8sManager] Could not ensure standalone Docker CLI in background:', err);
    });
    if (this.isWslEngine()) {
      const isInstalled = await this.isKindInstalled();
      if (!isInstalled) {
        return this.installKind();
      }
      return '/usr/local/bin/kind';
    }
    const existing = await this.getKindBinaryPath();
    if (existing) {
      return existing;
    }
    return this.installKind();
  }

  private async executeKind(
    args: string[],
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onOutput?: (line: string) => void;
    }
  ): Promise<RunResult> {
    if (this.isWslEngine()) {
      await this.ensureKindBinary();
      const wslArgs = args.map(arg => {
        if (typeof arg === 'string' && /^[a-zA-Z]:[/\\]/.test(arg)) {
          return windowsToWslPath(arg) ?? arg;
        }
        return arg;
      });
      return runCommand('wsl.exe', ['-d', CATBEE_WSL_DISTRO, '-u', 'root', '/usr/local/bin/kind', ...wslArgs], options);
    }

    const kindBin = await this.ensureKindBinary();
    return runCommand(kindBin, args, {
      env: this.getDockerEnv(),
      ...options
    });
  }

  private getDockerEnv(): NodeJS.ProcessEnv {
    // eslint-disable-next-line n/no-process-env
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Drop DOCKER_CONTEXT so Docker CLI does not direct commands to a third-party context (e.g. Rancher Desktop)
    delete env.DOCKER_CONTEXT;

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

    // 1. Prepend CatBee's own engine bin dir to PATH so kind and external tools always find our own official docker CLI first
    const binDir = getEngineBinDir();
    env.PATH = `${binDir};${env.PATH ?? ''}`;

    if (process.platform === 'win32') {
      // Prepend official Docker CLI installations to PATH as fallbacks
      const localAppData = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
      const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
      const preferredDirs = [
        path.join(localAppData, 'Programs', 'DockerDesktop', 'resources', 'bin'),
        path.join(programFiles, 'Docker', 'Docker', 'resources', 'bin')
      ];
      for (const dir of preferredDirs) {
        if (existsSync(path.join(dir, 'docker.exe'))) {
          env.PATH = `${dir};${env.PATH ?? ''}`;
          break;
        }
      }
    }

    const runtime = dockerManager.currentRuntime;
    if (runtime?.connection) {
      // On Windows with embedded WSL engine, dockerd listens directly on TCP loopback port 23750.
      // Pointing kind directly to TCP bypasses the named pipe relay's request rewriter, avoiding
      // stream buffering deadlocks during hijacked exec/cp operations (e.g. writing kubeadm.conf).
      if (process.platform === 'win32' && runtime.source === 'embedded') {
        env.DOCKER_HOST = `tcp://127.0.0.1:${CATBEE_WSL_DOCKER_TCP_PORT}`;
      } else {
        env.DOCKER_HOST = connectionToUri(runtime.connection);
      }
    }
    return env;
  }

  async getStatus(): Promise<K8sClusterInfo> {
    const settings = await getEngineSettings();
    const k8sConfig = settings.kubernetes;
    const isKindInstalled = await this.isKindInstalled();

    if (this.isInstalling) {
      return {
        status: 'starting',
        name: CATBEE_K8S_CLUSTER_NAME,
        provisioner: k8sConfig.provisioner,
        version: k8sConfig.version,
        nodeCount: k8sConfig.nodeCount,
        isKindInstalled: false,
        runtimeVersion: KIND_RELEASE_VERSION,
        operation: this.currentProgress,
        error: this.lastError ?? undefined
      };
    }

    if (this.isStarting) {
      return {
        status: 'starting',
        name: CATBEE_K8S_CLUSTER_NAME,
        provisioner: k8sConfig.provisioner,
        version: k8sConfig.version,
        nodeCount: k8sConfig.nodeCount,
        isKindInstalled,
        runtimeVersion: KIND_RELEASE_VERSION,
        operation: this.currentProgress,
        error: this.lastError ?? undefined
      };
    }

    if (this.isStopping) {
      return {
        status: 'stopping',
        name: CATBEE_K8S_CLUSTER_NAME,
        provisioner: k8sConfig.provisioner,
        version: k8sConfig.version,
        nodeCount: k8sConfig.nodeCount,
        isKindInstalled,
        runtimeVersion: KIND_RELEASE_VERSION,
        operation: this.currentProgress
      };
    }

    if (this.isResetting) {
      return {
        status: this.isStarting ? 'starting' : 'stopping',
        name: CATBEE_K8S_CLUSTER_NAME,
        provisioner: k8sConfig.provisioner,
        version: k8sConfig.version,
        nodeCount: k8sConfig.nodeCount,
        isKindInstalled,
        runtimeVersion: KIND_RELEASE_VERSION,
        operation: this.currentProgress
      };
    }

    try {
      if (!dockerManager.currentRuntime) {
        return {
          status: this.lastError ? 'error' : 'stopped',
          name: CATBEE_K8S_CLUSTER_NAME,
          provisioner: k8sConfig.provisioner,
          version: k8sConfig.version,
          nodeCount: k8sConfig.nodeCount,
          isKindInstalled,
          runtimeVersion: KIND_RELEASE_VERSION,
          operation: this.currentProgress,
          error: this.lastError ?? undefined
        };
      }

      const containers = await dockerManager.containers.listContainers({ all: true });
      const clusterContainers = containers.filter((c: Docker.ContainerInfo) => {
        const names = c.Names ?? [];
        if (names.some(n => n.includes(KIND_CLOUD_PROVIDER_CONTAINER))) return false;
        const labels = c.Labels ?? {};
        return (
          labels['io.x-k8s.kind.cluster'] === CATBEE_K8S_CLUSTER_NAME ||
          names.some((n: string) => n.includes(CATBEE_K8S_CLUSTER_NAME))
        );
      });

      if (clusterContainers.length === 0) {
        this.cachedStartedAt = null;
        return {
          status: this.lastError ? 'error' : 'stopped',
          name: CATBEE_K8S_CLUSTER_NAME,
          provisioner: k8sConfig.provisioner,
          version: k8sConfig.version,
          nodeCount: k8sConfig.nodeCount,
          isKindInstalled,
          runtimeVersion: KIND_RELEASE_VERSION,
          operation: this.currentProgress,
          error: this.lastError ?? undefined
        };
      }

      const controlPlane =
        clusterContainers.find((c: Docker.ContainerInfo) => {
          const labels = c.Labels ?? {};
          const names = c.Names ?? [];
          return (
            labels['io.x-k8s.kind.role'] === 'control-plane' || names.some((n: string) => n.includes('control-plane'))
          );
        }) ?? clusterContainers[0];

      const isRunning = controlPlane.State === 'running';
      const isStarting = controlPlane.State === 'restarting' || controlPlane.State === 'created';

      if (this.lastError) {
        return {
          status: 'error',
          name: CATBEE_K8S_CLUSTER_NAME,
          provisioner: k8sConfig.provisioner,
          version: k8sConfig.version,
          nodeCount: clusterContainers.length,
          isKindInstalled,
          runtimeVersion: KIND_RELEASE_VERSION,
          operation: this.currentProgress,
          error: this.lastError
        };
      }

      let version = k8sConfig.version;
      if (controlPlane.Image) {
        const match = /kindest\/node:(v?\d+\.\d+\.\d+)/.exec(controlPlane.Image);
        if (match?.[1]) {
          version = match[1].startsWith('v') ? match[1] : `v${match[1]}`;
        }
      }

      const startedAt = controlPlane.Created ? controlPlane.Created * 1000 : (this.cachedStartedAt ?? Date.now());
      if (isRunning && !this.cachedStartedAt) {
        this.cachedStartedAt = startedAt;
      }

      const kubeconfigPath = path.join(os.homedir(), '.kube', 'config');

      return {
        status: isRunning ? 'running' : isStarting ? 'starting' : 'stopped',
        name: CATBEE_K8S_CLUSTER_NAME,
        provisioner: k8sConfig.provisioner,
        version,
        nodeCount: clusterContainers.length,
        isKindInstalled,
        runtimeVersion: KIND_RELEASE_VERSION,
        operation: this.currentProgress,
        startedAt: isRunning ? startedAt : undefined,
        kubeconfigPath,
        error: this.lastError ?? undefined
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
    // Strip ANSI escape codes (e.g. \u001b[2K, cursor moves, color codes) and leading symbols/bullets
    const cleanAnsi = line.replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
    const cleaned = cleanAnsi.replace(/^[^\w\d]+/, '').trim();

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
    return path.join(os.homedir(), '.kube', 'config');
  }

  async verifyClusterHealth(): Promise<boolean> {
    try {
      const { stdout } = await this.executeKind(['get', 'clusters'], { timeoutMs: 15_000 });
      return stdout.includes(CATBEE_K8S_CLUSTER_NAME);
    } catch {
      return false;
    }
  }

  async syncKubeconfig(): Promise<void> {
    const kubeconfigPath = this.getKubeconfigPath();
    try {
      if (this.isWslEngine()) {
        const wslKubeconfig = windowsToWslPath(kubeconfigPath);
        if (wslKubeconfig) {
          await this.executeKind(
            ['export', 'kubeconfig', '--kubeconfig', wslKubeconfig, '--name', CATBEE_K8S_CLUSTER_NAME],
            { timeoutMs: 30_000 }
          );
        }
      } else {
        await this.executeKind(['export', 'kubeconfig', '--name', CATBEE_K8S_CLUSTER_NAME], {
          timeoutMs: 30_000
        });
      }
    } catch (exportErr) {
      logger.warn({ err: exportErr }, '[K8sManager] kind export kubeconfig command failed.');
      return;
    }

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

      const kindClusterName = `kind-${CATBEE_K8S_CLUSTER_NAME}`;
      if (Array.isArray(doc.clusters)) {
        for (const cl of doc.clusters) {
          if (cl.name === kindClusterName || cl.name === CATBEE_K8S_CLUSTER_NAME) {
            cl.name = CATBEE_K8S_CLUSTER_NAME;
            const server = typeof cl.cluster?.server === 'string' ? cl.cluster.server : '';
            if (server.startsWith('https://0.0.0.0:')) {
              cl.cluster.server = server.replace('https://0.0.0.0:', 'https://127.0.0.1:');
            }
          }
        }
      }

      if (Array.isArray(doc.users)) {
        for (const u of doc.users) {
          if (u.name === kindClusterName || u.name === CATBEE_K8S_CLUSTER_NAME) {
            u.name = CATBEE_K8S_CLUSTER_NAME;
          }
        }
      }

      const kindContextName = `kind-${CATBEE_K8S_CLUSTER_NAME}`;
      for (const c of doc.contexts) {
        if (c.name === kindContextName || c.name === CATBEE_K8S_CLUSTER_NAME) {
          c.name = CATBEE_K8S_CLUSTER_NAME;
          if (c.context) {
            c.context.cluster = CATBEE_K8S_CLUSTER_NAME;
            c.context.user = CATBEE_K8S_CLUSTER_NAME;
          }
        }
      }

      // Deduplicate contexts, clusters, and users by name
      doc.contexts = doc.contexts.filter((c, idx, arr) => arr.findIndex(x => x.name === c.name) === idx);
      if (doc.clusters) {
        doc.clusters = doc.clusters.filter((cl, idx, arr) => arr.findIndex(x => x.name === cl.name) === idx);
      }
      if (doc.users) {
        doc.users = doc.users.filter((u, idx, arr) => arr.findIndex(x => x.name === u.name) === idx);
      }

      doc['current-context'] = CATBEE_K8S_CLUSTER_NAME;
      await writeFile(kubeconfigPath, jsyaml.dump(doc, { lineWidth: -1 }), 'utf8');
      logger.info(`[K8sManager] Successfully synced kubeconfig with context "${CATBEE_K8S_CLUSTER_NAME}".`);
    } catch (err) {
      logger.warn({ err }, '[K8sManager] Failed to create catbee-desktop context alias in kubeconfig.');
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
    logger.info('[K8sManager] Gracefully stopping Kubernetes companion and cluster containers on app quit...');
    await this.stopCloudProvider().catch(() => {});
    if (dockerManager.currentRuntime) {
      try {
        const containers = await dockerManager.containers.listContainers({ all: true });
        const clusterContainers = containers.filter((c: Docker.ContainerInfo) => {
          const labels = c.Labels ?? {};
          const names = c.Names ?? [];
          return (
            labels['io.x-k8s.kind.cluster'] === CATBEE_K8S_CLUSTER_NAME ||
            names.some((n: string) => n.includes(CATBEE_K8S_CLUSTER_NAME))
          );
        });
        for (const container of clusterContainers) {
          if (container.State === 'running') {
            await dockerManager.containers.stopContainer(container.Id).catch(() => {});
          }
        }
      } catch (err) {
        logger.debug('[K8sManager] Error stopping cluster containers on quit:', err);
      }
    }
  }

  async onEngineUninstall(): Promise<void> {
    this.cachedStartedAt = null;
    this.lastError = null;
    this.currentProgress = null;
    await this.cleanKubeconfig().catch(() => {});
  }

  async ensureCloudProvider(): Promise<void> {
    if (!dockerManager.currentRuntime) return;
    try {
      const containers = await dockerManager.containers.listContainers({ all: true });
      const existing = containers.find((c: Docker.ContainerInfo) =>
        (c.Names ?? []).some((n: string) => n.includes(KIND_CLOUD_PROVIDER_CONTAINER))
      );

      if (existing) {
        if (existing.State === 'running') {
          return;
        }
        try {
          await dockerManager.containers.startContainer(existing.Id);
          return;
        } catch (startErr) {
          logger.warn(
            { err: startErr },
            `[K8sManager] Failed to start existing ${KIND_CLOUD_PROVIDER_CONTAINER}, removing and recreating...`
          );
          await dockerManager.containers.removeContainer(existing.Id, true).catch(() => {});
        }
      }

      logger.info(`[K8sManager] Ensuring cloud-provider-kind container (${KIND_CLOUD_PROVIDER_IMAGE})...`);

      try {
        const images = await dockerManager.images.listImages();
        const hasImage = images.some((img: Docker.ImageInfo) =>
          (img.RepoTags ?? []).some(
            (t: string) => t.includes(KIND_CLOUD_PROVIDER_IMAGE) || t.includes('desktop-cloud-provider-kind')
          )
        );
        if (!hasImage) {
          logger.info(`[K8sManager] Pulling cloud-provider-kind image: ${KIND_CLOUD_PROVIDER_IMAGE}...`);
          await dockerManager.images.pullImage(KIND_CLOUD_PROVIDER_IMAGE);
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
        const networks = await dockerManager.networks.listNetworks();
        const hasKindNet = networks.some((n: Docker.NetworkInspectInfo) => n.Name === 'kind');
        if (!hasKindNet) {
          // Check if kind control-plane container is connected to another network
          const clusterContainers = await dockerManager.containers.listContainers({ all: true });
          const controlPlane = clusterContainers.find((c: Docker.ContainerInfo) =>
            (c.Names ?? []).some((n: string) => n.includes(`${CATBEE_K8S_CLUSTER_NAME}-control-plane`))
          );
          if (controlPlane?.NetworkSettings?.Networks) {
            const nets = Object.keys(controlPlane.NetworkSettings.Networks);
            if (nets.length > 0 && nets[0]) {
              targetNetwork = nets[0];
            }
          }
          if (!networks.some((n: Docker.NetworkInspectInfo) => n.Name === targetNetwork)) {
            logger.info(`[K8sManager] Creating missing Docker network "${targetNetwork}" for kind...`);
            await dockerManager.networks.createNetwork({
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
        container = await dockerManager.containers.createContainer({
          Image: KIND_CLOUD_PROVIDER_IMAGE,
          name: KIND_CLOUD_PROVIDER_CONTAINER,
          HostConfig: {
            NetworkMode: targetNetwork,
            Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
            RestartPolicy: {
              Name: 'always'
            }
          },
          Labels: {
            'io.x-k8s.kind.cluster': CATBEE_K8S_CLUSTER_NAME,
            'io.kubernetes.pod.namespace': 'kube-system'
          }
        });

        await dockerManager.containers.startContainer(container.Id);
        logger.info(`[K8sManager] Successfully started ${KIND_CLOUD_PROVIDER_CONTAINER}.`);
      } catch (startErr) {
        if (container) {
          await dockerManager.containers.removeContainer(container.Id, true).catch(() => {});
        }
        throw startErr;
      }
    } catch (err) {
      logger.warn({ err }, '[K8sManager] Optional cloud-provider-kind could not be started.');
    }
  }

  async stopCloudProvider(): Promise<void> {
    if (!dockerManager.currentRuntime) return;
    try {
      const containers = await dockerManager.containers.listContainers({ all: true });
      const cp = containers.find((c: Docker.ContainerInfo) =>
        (c.Names ?? []).some((n: string) => n.includes(KIND_CLOUD_PROVIDER_CONTAINER))
      );
      if (cp) {
        await dockerManager.containers.stopContainer(cp.Id).catch(() => {});
        await dockerManager.containers.removeContainer(cp.Id, true).catch(() => {});
        logger.info(`[K8sManager] Removed ${KIND_CLOUD_PROVIDER_CONTAINER}.`);
      }
    } catch (err) {
      logger.debug('[K8sManager] Error stopping cloud provider container:', err);
    }
  }

  async startCluster(config?: KubernetesSettingsConfig, fromReset = false): Promise<void> {
    if (this.isStarting || (!fromReset && this.isResetting)) return;
    this.isStarting = true;
    this.lastError = null;

    try {
      const settings = await getEngineSettings();
      const k8s = config ?? settings.kubernetes;

      // 1. If cluster containers already exist, verify health before resuming
      if (dockerManager.currentRuntime) {
        try {
          const containers = await dockerManager.containers.listContainers({ all: true });
          const clusterContainers = containers.filter((c: Docker.ContainerInfo) => {
            const names = c.Names ?? [];
            if (names.some(n => n.includes(KIND_CLOUD_PROVIDER_CONTAINER))) return false;
            const labels = c.Labels ?? {};
            return (
              labels['io.x-k8s.kind.cluster'] === CATBEE_K8S_CLUSTER_NAME ||
              names.some(n => n.includes(CATBEE_K8S_CLUSTER_NAME))
            );
          });

          if (clusterContainers.length > 0) {
            const controlPlane = clusterContainers.find((c: Docker.ContainerInfo) =>
              (c.Names ?? []).some(n => n.includes('control-plane'))
            );
            const imageMatches = !controlPlane?.Image || controlPlane.Image.includes(k8s.version.replace(/^v/, ''));
            const nodeCountMatches = clusterContainers.length === k8s.nodeCount;

            if (imageMatches && nodeCountMatches) {
              const isHealthy = await this.verifyClusterHealth();
              if (isHealthy) {
                const allRunning = clusterContainers.every(c => c.State === 'running');
                if (!allRunning) {
                  this.emitProgress({
                    operation: fromReset ? 'reset' : 'start',
                    stage: 'Starting existing cluster containers...',
                    progress: 50,
                    detail: `Starting ${clusterContainers.length} container(s)`
                  });
                  for (const container of clusterContainers) {
                    if (container.State !== 'running') {
                      await dockerManager.containers.startContainer(container.Id);
                    }
                  }
                }
                await this.syncKubeconfig();
                await this.ensureCloudProvider();
                this.cachedStartedAt = this.cachedStartedAt ?? Date.now();
                this.lastError = null;
                return;
              }
            } else {
              logger.info(
                `[K8sManager] Cluster configuration changed (image: ${controlPlane?.Image} vs ${k8s.version}, nodes: ${clusterContainers.length} vs ${k8s.nodeCount}). Recreating cluster...`
              );
              await this.stopCluster();
            }

            logger.warn(
              `[K8sManager] Cluster containers for "${CATBEE_K8S_CLUSTER_NAME}" are uninitialized or broken. Cleaning up before recreation...`
            );
            await this.stopCluster();
          }
        } catch (inspectErr) {
          logger.debug('[K8sManager] Could not inspect existing containers, proceeding with kind create:', inspectErr);
        }
      }

      // 2. Ensure standalone host Docker CLI and kind binary are present
      await ensureHostDockerCli().catch(err => {
        logger.debug('[K8sManager] Could not ensure standalone Docker CLI before cluster create:', err);
      });
      await this.ensureKindBinary();
      const configYaml = this.generateKindConfig(k8s.version, k8s.nodeCount);

      const tempDir = path.join(os.tmpdir(), 'catbee-k8s');
      await mkdir(tempDir, { recursive: true });
      const configPath = path.join(tempDir, `kind-config-${Date.now()}.yaml`);
      await writeFile(configPath, configYaml, 'utf8');

      this.emitProgress({
        operation: 'start',
        stage: 'Initializing cluster configuration...',
        progress: 10,
        detail: `Preparing cluster "${CATBEE_K8S_CLUSTER_NAME}" (${k8s.version})`
      });

      logger.info(
        `[K8sManager] Creating cluster "${CATBEE_K8S_CLUSTER_NAME}" with kind (version: ${k8s.version}, nodes: ${k8s.nodeCount})`
      );

      const abortController = new AbortController();
      this.currentAbortController = abortController;

      try {
        await this.executeKind(
          ['create', 'cluster', '--config', configPath, '--name', CATBEE_K8S_CLUSTER_NAME, '--retain', '-v', '4'],
          {
            timeoutMs: 15 * 60_000,
            signal: abortController.signal,
            onOutput: line => this.parseKindOutput(line)
          }
        );
        await this.syncKubeconfig();
        await this.ensureCloudProvider();
        this.cachedStartedAt = Date.now();
        this.lastError = null;
        logger.info(`[K8sManager] Successfully started cluster "${CATBEE_K8S_CLUSTER_NAME}".`);
      } finally {
        await rm(configPath, { force: true }).catch(() => {});
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('aborted') || msg.includes('Command aborted')) {
        logger.info(`[K8sManager] Cluster creation for "${CATBEE_K8S_CLUSTER_NAME}" was cancelled by user.`);
        this.lastError = null;
      } else {
        this.lastError = msg;
        logger.error({ err: error }, `[K8sManager] Failed to start cluster: ${msg}`);
        try {
          const containers = await dockerManager.containers.listContainers({ all: true });
          const controlPlane = containers.find((c: Docker.ContainerInfo) =>
            (c.Names ?? []).some((n: string) => n.includes(`${CATBEE_K8S_CLUSTER_NAME}-control-plane`))
          );
          if (controlPlane) {
            logger.error(
              `[K8sManager] Retained control-plane container state: ${controlPlane.State}, status: ${controlPlane.Status}`
            );
            const inspect = await dockerManager.containers.inspectContainer(controlPlane.Id);
            logger.error(
              `[K8sManager] Control-plane exitCode=${inspect.State.ExitCode}, error="${inspect.State.Error}", OOMKilled=${inspect.State.OOMKilled}`
            );
          }
        } catch (inspectErr) {
          logger.debug('[K8sManager] Could not inspect retained control-plane container:', inspectErr);
        }
        throw error;
      }
    } finally {
      this.isStarting = false;
      this.currentAbortController = null;
      if (!fromReset) {
        this.emitProgress(null);
      }
    }
  }

  async stopCluster(): Promise<void> {
    if (this.isStopping) return;
    this.isStopping = true;
    this.emitProgress({
      operation: 'stop',
      stage: 'Stopping and deleting Kubernetes cluster...',
      progress: 50
    });

    try {
      await this.stopCloudProvider();

      logger.info(`[K8sManager] Deleting cluster "${CATBEE_K8S_CLUSTER_NAME}" with kind.`);
      await this.executeKind(['delete', 'cluster', '--name', CATBEE_K8S_CLUSTER_NAME], {
        timeoutMs: 120_000
      }).catch(err => {
        logger.warn({ err }, '[K8sManager] kind delete cluster returned non-zero code.');
      });

      if (dockerManager.currentRuntime) {
        try {
          const containers = await dockerManager.containers.listContainers({ all: true });
          const clusterContainers = containers.filter((c: Docker.ContainerInfo) => {
            const labels = c.Labels ?? {};
            const names = c.Names ?? [];
            return (
              labels['io.x-k8s.kind.cluster'] === CATBEE_K8S_CLUSTER_NAME ||
              names.some((n: string) => n.includes(CATBEE_K8S_CLUSTER_NAME))
            );
          });
          for (const c of clusterContainers) {
            await dockerManager.containers.removeContainer(c.Id, true).catch(() => {});
          }
        } catch {
          // ignore
        }
      }

      await this.cleanKubeconfig();
      this.cachedStartedAt = null;
      this.lastError = null;
    } finally {
      this.isStopping = false;
      this.emitProgress(null);
    }
  }

  async resetCluster(): Promise<{ success: boolean }> {
    if (this.isResetting) return { success: false };
    this.isResetting = true;
    this.lastError = null;
    this.emitProgress({
      operation: 'reset',
      stage: 'Resetting Kubernetes cluster...',
      progress: 10
    });

    try {
      logger.info(`[K8sManager] Resetting cluster "${CATBEE_K8S_CLUSTER_NAME}"...`);
      await this.stopCluster();

      const settings = await getEngineSettings();
      if (settings.kubernetes.enabled) {
        await this.startCluster(settings.kubernetes, true);
      }
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.lastError = msg;
      logger.error({ err: error }, `[K8sManager] Failed to reset cluster: ${msg}`);
      return { success: false };
    } finally {
      this.isResetting = false;
      this.emitProgress(null);
    }
  }

  async uninstallRuntime(): Promise<{ success: boolean }> {
    this.emitProgress({
      operation: 'uninstall',
      stage: 'Uninstalling Kubernetes runtime (kind)...',
      progress: 20
    });
    try {
      await this.stopCluster();

      if (this.isWslEngine()) {
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
      this.lastError = msg;
      logger.error({ err: error }, `[K8sManager] Failed to uninstall kind: ${msg}`);
      return { success: false };
    } finally {
      this.emitProgress(null);
    }
  }

  async cancelCurrentOperation(): Promise<{ success: boolean }> {
    if (!this.isStarting && !this.isResetting) {
      return { success: false };
    }
    logger.info('[K8sManager] User requested cancellation of active Kubernetes cluster operation.');
    this.emitProgress({
      operation: 'stop',
      stage: 'Cancelling operation and cleaning up cluster...',
      progress: 50
    });

    if (this.currentAbortController) {
      try {
        this.currentAbortController.abort();
      } catch {
        // ignore
      }
      this.currentAbortController = null;
    }

    try {
      await this.stopCluster();
    } catch (err) {
      logger.warn({ err }, '[K8sManager] Error cleaning up cluster after cancellation.');
    } finally {
      this.isStarting = false;
      this.isResetting = false;
      this.currentAbortController = null;
      this.lastError = null;
      this.emitProgress(null);
    }

    return { success: true };
  }
}

export const k8sManager = new K8sManager();
