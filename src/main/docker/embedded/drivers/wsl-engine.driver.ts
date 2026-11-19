import { mkdir, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { logger } from '../../../logger';
import type { DockerConnection } from '../../types/connection.types';
import type { EngineManifest } from '../types/manifest.types';
import type {
  EngineCapabilities,
  EngineDriverStatus,
  EngineInfo,
  EngineProgressCallback,
  PlatformEngineDriver,
  PrerequisiteCheckResult
} from '../types/engine.interface';
import type { EngineSettings } from '../engine-settings';
import { buildDaemonConfig, proxyToEnv, resolveDaemonProxy } from '../daemon-config';
import { detectSystemProxy } from '../system-proxy';
import { EndpointRelay } from '../endpoint-relay';
import { DockerRequestRewriter } from '../windows-path-rewriter';
import { CATBEE_WINDOWS_PIPE_PATH, CATBEE_WSL_DISTRO, getEngineDownloadsDir, getEngineRootDir } from '../engine-paths';
import {
  describeDownload,
  downloadFile,
  getDockerServerVersion,
  hostArch,
  pathExists,
  pingDockerEndpoint,
  readEngineManifest,
  runCommand,
  shellQuote,
  sleep,
  updateEngineManifest,
  waitForDockerEndpoint,
  writeEngineManifest,
  type RunResult
} from '../engine-utils';

/** dockerd listens on loopback inside WSL; WSL's localhost forwarding makes it reachable from Windows. */
const DOCKER_TCP_PORT = 23750;
const TCP_CONNECTION: DockerConnection = { type: 'tcp', host: '127.0.0.1', port: DOCKER_TCP_PORT };
const DAEMON_CONFIG_PATH = '/etc/docker/daemon.json';
const DAEMON_LOG_PATH = '/var/log/docker/dockerd.log';
const START_SCRIPT_PATH = '/usr/local/bin/catbee-dockerd';
const INTEGRATION_PROFILE = '/etc/profile.d/catbee-docker.sh';
const FALLBACK_ALPINE_VERSION = '3.24.4';

// eslint-disable-next-line n/no-process-env
const WSL_EXECUTABLE = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'wsl.exe') : 'wsl.exe';

const START_SCRIPT = `#!/bin/sh
# Launched by CatBee Container Studio; keeps the WSL session (and therefore the distro) alive.
mount --make-rshared / 2>/dev/null || true
mkdir -p /var/log/docker /var/run
if [ -f /var/run/docker.pid ] && kill -0 "$(cat /var/run/docker.pid)" 2>/dev/null; then
  echo "dockerd already running" >&2
  exit 0
fi
rm -f /var/run/docker.pid /var/run/docker.sock /var/run/docker/containerd/containerd.pid
exec dockerd --config-file ${DAEMON_CONFIG_PATH} >>${DAEMON_LOG_PATH} 2>&1
`;

const STOP_DOCKERD_SCRIPT = `
if [ -f /var/run/docker.pid ]; then kill "$(cat /var/run/docker.pid)" 2>/dev/null || true; fi
i=0
while pgrep -x dockerd >/dev/null 2>&1 && [ $i -lt 20 ]; do sleep 1; i=$((i+1)); done
pkill -9 -x dockerd 2>/dev/null || true
pkill -9 -x containerd 2>/dev/null || true
rm -f /var/run/docker.pid /var/run/docker.sock
true
`;

export class WslEngineDriver implements PlatformEngineDriver {
  readonly platform: NodeJS.Platform = 'win32';
  private readonly engineDir = getEngineRootDir();
  private readonly wslDir = path.join(this.engineDir, 'wsl');
  private daemonProcess: ChildProcess | null = null;
  private daemonExitReason: string | null = null;
  /** Translates Windows bind-mount paths (C:\...) to /mnt/<drive>/... for every client using the pipe. */
  private readonly pipeRelay = new EndpointRelay('wsl-pipe', {
    createRequestTransform: () => new DockerRequestRewriter()
  });

  getRunningConnection(): DockerConnection {
    return this.pipeRelay.isRunning ? { type: 'npipe', path: CATBEE_WINDOWS_PIPE_PATH } : TCP_CONNECTION;
  }

  getCapabilities(): EngineCapabilities {
    return {
      backend: 'wsl2',
      backendLabel: 'WSL 2 (Alpine Linux)',
      managesVmResources: false,
      resources: { cpus: false, memory: false, swap: false, disk: false, rosetta: false },
      resourcesNote: String.raw`WSL 2 shares CPU, memory and swap across all distributions. Configure limits in %UserProfile%\.wslconfig and run "wsl --shutdown" to apply them.`,
      fileSharing: false,
      fileSharingNote: String.raw`Windows drives are shared automatically through WSL 2. Bind mounts such as -v C:\src:/src are translated to /mnt/c/src.`,
      wslIntegration: true,
      resourceChangesRequireRestart: false,
      resourceSaver: true
    };
  }

  getInfo(): EngineInfo {
    return {
      capabilities: this.getCapabilities(),
      engineDir: this.engineDir,
      dataLocation: path.join(this.wslDir, 'ext4.vhdx'),
      logsLocation: `\\\\wsl.localhost\\${CATBEE_WSL_DISTRO}${DAEMON_LOG_PATH.replaceAll('/', '\\')}`,
      daemonConfigLocation: `\\\\wsl.localhost\\${CATBEE_WSL_DISTRO}${DAEMON_CONFIG_PATH.replaceAll('/', '\\')}`,
      distribution: CATBEE_WSL_DISTRO
    };
  }

  async checkPrerequisites(): Promise<PrerequisiteCheckResult> {
    if (process.platform !== 'win32') {
      return { ok: false, reason: 'The WSL 2 engine is only supported on Windows.' };
    }

    try {
      await this.wsl(['--status'], { timeoutMs: 20_000 });
    } catch (error) {
      logger.warn({ err: error }, '[WslEngineDriver] wsl.exe --status failed.');
      const hasWsl = await runCommand('where', ['wsl.exe'])
        .then(() => true)
        .catch(() => false);
      return hasWsl
        ? {
            ok: false,
            reason: 'WSL is present, but the WSL 2 platform is not ready.',
            actionHint:
              'Run "wsl --install --no-distribution" (or "wsl --update") in an elevated PowerShell, then reboot.'
          }
        : {
            ok: false,
            reason: 'Windows Subsystem for Linux (WSL 2) is not installed.',
            actionHint: 'Open PowerShell as Administrator, run "wsl --install --no-distribution", then restart Windows.'
          };
    }
    return { ok: true };
  }

  async isInstalled(): Promise<boolean> {
    const manifest = await readEngineManifest();
    if (manifest?.backend !== 'wsl2' || !manifest.engineVersion || manifest.engineVersion === 'pending first start') {
      return false;
    }
    const distros = await this.listDistros(false);
    return distros.some(name => name.toLowerCase() === CATBEE_WSL_DISTRO);
  }

  async getManifest(): Promise<EngineManifest | null> {
    return await readEngineManifest();
  }

  async install(onProgress: EngineProgressCallback): Promise<EngineManifest> {
    const prereq = await this.checkPrerequisites();
    if (!prereq.ok) {
      throw new Error(`${prereq.reason ?? 'WSL 2 is unavailable.'} ${prereq.actionHint ?? ''}`.trim());
    }

    onProgress(5, 'Resolving Alpine Linux release...');
    const { url, version } = await resolveAlpineRootfs();
    const rootfsPath = path.join(getEngineDownloadsDir(), path.basename(url));

    if (!(await pathExists(rootfsPath))) {
      await downloadFile(url, rootfsPath, (fraction, received, total) => {
        onProgress(5 + Math.round(fraction * 20), describeDownload(`Alpine Linux ${version}`, received, total));
      });
    }

    onProgress(30, 'Registering the CatBee WSL distribution...');
    if ((await this.listDistros(false)).some(name => name.toLowerCase() === CATBEE_WSL_DISTRO)) {
      await this.wsl(['--unregister', CATBEE_WSL_DISTRO]).catch(err => {
        logger.warn({ err }, '[WslEngineDriver] Failed to unregister previous distro; continuing.');
      });
    }
    await mkdir(this.wslDir, { recursive: true });
    await this.wsl(['--import', CATBEE_WSL_DISTRO, this.wslDir, rootfsPath, '--version', '2'], {
      timeoutMs: 5 * 60_000
    });

    onProgress(45, 'Configuring the distribution...');
    await this.writeFileInDistro(
      '/etc/wsl.conf',
      [
        '[automount]',
        'enabled = true',
        'root = /mnt/',
        '',
        '[interop]',
        'appendWindowsPath = false',
        '',
        '[user]',
        'default = root',
        ''
      ].join('\n')
    );

    onProgress(55, 'Installing Docker Engine (docker, containerd, iptables)...');
    const proxyEnv = proxyToEnv(await detectSystemProxy());
    const exports = Object.entries(proxyEnv)
      .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
      .join('; ');
    await this.sh(
      [
        exports,
        'grep -q "^nameserver" /etc/resolv.conf 2>/dev/null || echo "nameserver 1.1.1.1" > /etc/resolv.conf',
        'apk update',
        'apk add --no-cache docker docker-cli-buildx docker-cli-compose iptables ip6tables ca-certificates'
      ]
        .filter(Boolean)
        .join(' && '),
      {
        timeoutMs: 15 * 60_000,
        onOutput: line => {
          // apk prints "(12/40) Installing containerd (1.7.x)"; map that onto the 55-85% band.
          const match = /^\((\d{1,5})\/(\d{1,5})\)\s+(\S[^\r\n]*)$/.exec(line);
          if (match) {
            onProgress(55 + Math.round((Number(match[1]) / Number(match[2])) * 30), match[3]);
          }
        }
      }
    );

    onProgress(85, 'Installing the engine launcher...');
    await this.writeFileInDistro(START_SCRIPT_PATH, START_SCRIPT);
    await this.sh(`chmod +x ${START_SCRIPT_PATH} && mkdir -p /etc/docker /var/log/docker`);

    const dockerVersion = await this.sh('dockerd --version')
      .then(({ stdout }) => /version\s+([\w.\-+]+)/i.exec(stdout)?.[1] ?? 'unknown')
      .catch(() => 'unknown');

    // Stop the distro so the next start picks up wsl.conf.
    await this.wsl(['--terminate', CATBEE_WSL_DISTRO]).catch(() => undefined);

    const manifest: EngineManifest = {
      schemaVersion: 2,
      backend: 'wsl2',
      engineVersion: dockerVersion,
      components: { alpine: version },
      platform: 'win32',
      architecture: hostArch(),
      distribution: `alpine-${version}`,
      installedAt: new Date().toISOString(),
      endpoint: { type: 'npipe', address: CATBEE_WINDOWS_PIPE_PATH },
      state: 'stopped'
    };
    await writeEngineManifest(manifest);
    onProgress(100, 'Installation complete.');
    return manifest;
  }

  async buildDaemonConfig(settings: EngineSettings): Promise<Record<string, unknown>> {
    return buildDaemonConfig(settings, {
      hosts: ['unix:///var/run/docker.sock', `tcp://127.0.0.1:${DOCKER_TCP_PORT}`],
      daemonProxy: resolveDaemonProxy(settings, await detectSystemProxy())
    });
  }

  async start(settings: EngineSettings, onStatus?: (status: string) => void): Promise<DockerConnection> {
    onStatus?.('Applying engine configuration...');
    const desiredConfig = `${JSON.stringify(await this.buildDaemonConfig(settings), null, 2)}\n`;
    const currentConfig = await this.sh(`cat ${DAEMON_CONFIG_PATH} 2>/dev/null || true`)
      .then(r => r.stdout)
      .catch(() => '');
    const configChanged = currentConfig.trim() !== desiredConfig.trim();
    if (configChanged) {
      await this.writeFileInDistro(DAEMON_CONFIG_PATH, desiredConfig);
    }

    const alreadyRunning = await pingDockerEndpoint(TCP_CONNECTION);
    if (alreadyRunning && configChanged) {
      onStatus?.('Restarting Docker Engine to apply new settings...');
      await this.stopDaemon();
    }

    if (!alreadyRunning || configChanged) {
      onStatus?.('Starting Docker Engine in WSL 2...');
      this.spawnDaemon();
    }

    onStatus?.('Waiting for Docker Engine...');
    try {
      await waitForDockerEndpoint(TCP_CONNECTION, 90_000, () => this.daemonExitReason);
    } catch (error) {
      const log = await this.sh(`tail -n 15 ${DAEMON_LOG_PATH} 2>/dev/null || true`)
        .then(r => r.stdout.trim())
        .catch(() => '');
      const errMsg = error instanceof Error ? error.message : String(error);
      const logSuffix = log ? `\n\ndockerd log:\n${log}` : '';
      throw new Error(`${errMsg}${logSuffix}`);
    }

    const pipeReady = await this.pipeRelay.start({ type: 'npipe', path: CATBEE_WINDOWS_PIPE_PATH }, TCP_CONNECTION);
    const connection: DockerConnection = pipeReady ? { type: 'npipe', path: CATBEE_WINDOWS_PIPE_PATH } : TCP_CONNECTION;

    await updateEngineManifest({
      state: 'running',
      engineVersion: (await getDockerServerVersion(TCP_CONNECTION)) ?? (await readEngineManifest())?.engineVersion,
      endpoint: pipeReady
        ? { type: 'npipe', address: CATBEE_WINDOWS_PIPE_PATH }
        : { type: 'tcp', address: '127.0.0.1', port: DOCKER_TCP_PORT }
    });
    return connection;
  }

  async stop(): Promise<void> {
    await this.pipeRelay.stop();
    await this.stopDaemon();
    await this.wsl(['--terminate', CATBEE_WSL_DISTRO]).catch(err => {
      logger.debug({ err }, '[WslEngineDriver] wsl --terminate failed (distro may already be stopped).');
    });
    await updateEngineManifest({ state: 'stopped' });
  }

  async getStatus(): Promise<EngineDriverStatus> {
    if (await pingDockerEndpoint(TCP_CONNECTION)) {
      return 'running';
    }
    return (await this.isInstalled()) ? 'stopped' : 'not-installed';
  }

  async uninstall(onProgress?: EngineProgressCallback): Promise<void> {
    onProgress?.(10, 'Stopping Docker Engine...');
    await this.stop().catch(() => undefined);
    onProgress?.(35, 'Removing the CatBee WSL distribution and its data...');
    await this.wsl(['--unregister', CATBEE_WSL_DISTRO], { timeoutMs: 5 * 60_000 }).catch(err => {
      logger.warn({ err }, '[WslEngineDriver] wsl --unregister failed during uninstall.');
    });
    onProgress?.(80, 'Deleting engine files...');
    await rm(this.engineDir, { recursive: true, force: true });
    onProgress?.(100, 'Built-in engine removed.');
  }

  async reclaimMemory(): Promise<void> {
    await this.sh(
      'sync; echo 3 > /proc/sys/vm/drop_caches; echo 1 > /proc/sys/vm/compact_memory 2>/dev/null; true'
    ).catch(() => undefined);
  }

  /** Lists user WSL distributions (excluding CatBee and Docker Desktop internals) for WSL integration. */
  async getInstalledDistros(): Promise<string[]> {
    return (await this.listDistros(false)).filter(
      name => !/^(catbee-container-engine|docker-desktop(-data)?)$/i.test(name)
    );
  }

  async configureWslDistroIntegration(distroName: string, enabled: boolean): Promise<boolean> {
    if (!distroName || !/^[a-zA-Z0-9._-]+$/.test(distroName) || distroName.toLowerCase() === CATBEE_WSL_DISTRO) {
      return false;
    }
    // All WSL 2 distros share one network namespace, so loopback reaches the CatBee daemon.
    const script = enabled
      ? `mkdir -p /etc/profile.d && echo 'export DOCKER_HOST=tcp://127.0.0.1:${DOCKER_TCP_PORT}' > ${INTEGRATION_PROFILE}`
      : `rm -f ${INTEGRATION_PROFILE}`;
    try {
      await this.wsl(['-d', distroName, '-u', 'root', '--', 'sh', '-c', script]);
      logger.info(`[WslEngineDriver] ${enabled ? 'Enabled' : 'Disabled'} Docker integration for ${distroName}.`);
      return true;
    } catch (err) {
      logger.warn({ err }, `[WslEngineDriver] Could not update integration for ${distroName}.`);
      return false;
    }
  }

  private spawnDaemon(): void {
    this.daemonExitReason = null;
    const child = spawn(WSL_EXECUTABLE, ['-d', CATBEE_WSL_DISTRO, '-u', 'root', '--', START_SCRIPT_PATH], {
      windowsHide: true,
      stdio: 'ignore',
      env: wslEnv()
    });
    child.on('error', err => {
      this.daemonExitReason = `Failed to launch wsl.exe: ${err.message}`;
      logger.error({ err }, '[WslEngineDriver] Failed to spawn dockerd.');
    });
    child.on('exit', code => {
      logger.info(`[WslEngineDriver] dockerd session exited (code ${code}).`);
      if (this.daemonProcess === child) {
        this.daemonProcess = null;
        if (code !== 0) {
          this.daemonExitReason = `dockerd exited unexpectedly (code ${code}).`;
        }
      }
    });
    this.daemonProcess = child;
  }

  private async stopDaemon(): Promise<void> {
    await this.sh(STOP_DOCKERD_SCRIPT, { timeoutMs: 40_000 }).catch(err => {
      logger.debug({ err }, '[WslEngineDriver] Stopping dockerd failed (distro may be stopped).');
    });
    if (this.daemonProcess) {
      this.daemonProcess.kill();
      this.daemonProcess = null;
    }
    await sleep(250);
  }

  private async listDistros(runningOnly: boolean): Promise<string[]> {
    try {
      const args = runningOnly ? ['-l', '--running', '-q'] : ['-l', '-q'];
      const { stdout } = await this.wsl(args);
      return stdout
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private wsl(
    args: string[],
    options: { input?: string; timeoutMs?: number; onOutput?: (line: string) => void } = {}
  ): Promise<RunResult> {
    return runCommand(WSL_EXECUTABLE, args, {
      env: wslEnv(),
      timeoutMs: options.timeoutMs ?? 60_000,
      input: options.input,
      onOutput: options.onOutput
    });
  }

  private sh(
    script: string,
    options: { timeoutMs?: number; onOutput?: (line: string) => void } = {}
  ): Promise<RunResult> {
    return this.wsl(['-d', CATBEE_WSL_DISTRO, '-u', 'root', '--', 'sh', '-c', script], options);
  }

  private async writeFileInDistro(filePath: string, content: string): Promise<void> {
    await this.wsl(
      [
        '-d',
        CATBEE_WSL_DISTRO,
        '-u',
        'root',
        '--',
        'sh',
        '-c',
        `mkdir -p ${shellQuote(path.posix.dirname(filePath))} && cat > ${shellQuote(filePath)}`
      ],
      { input: content.replaceAll('\r\n', '\n') }
    );
  }
}

function wslEnv(): NodeJS.ProcessEnv {
  // Ask wsl.exe for UTF-8 output instead of UTF-16LE (ignored by old builds; NULs are stripped anyway).
  // eslint-disable-next-line n/no-process-env
  return { ...process.env, WSL_UTF8: '1' };
}

async function resolveAlpineRootfs(): Promise<{ url: string; version: string }> {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const base = `https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/${arch}`;
  try {
    const response = await fetch(`${base}/latest-releases.yaml`, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const yaml = await response.text();
      const match = /file:\s*(alpine-minirootfs-([\d.]+)-\w+\.tar\.gz)/.exec(yaml);
      if (match) {
        return { url: `${base}/${match[1]}`, version: match[2] };
      }
    }
  } catch (err) {
    logger.warn({ err }, '[WslEngineDriver] Could not resolve latest Alpine release; using pinned version.');
  }
  const minor = FALLBACK_ALPINE_VERSION.split('.').slice(0, 2).join('.');
  return {
    url: `https://dl-cdn.alpinelinux.org/alpine/v${minor}/releases/${arch}/alpine-minirootfs-${FALLBACK_ALPINE_VERSION}-${arch}.tar.gz`,
    version: FALLBACK_ALPINE_VERSION
  };
}
