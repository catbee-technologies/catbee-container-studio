import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { logger as appLogger } from '../../../logger';
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
import { getEngineSettings, type EngineSettings } from '../engine-settings';
import { buildDaemonConfig, proxyToEnv, resolveDaemonProxy } from '../daemon-config';
import { detectSystemProxy } from '../system-proxy';
import { EndpointRelay } from '../endpoint-relay';
import { DockerRequestRewriter } from '../windows-path-rewriter';
import {
  CATBEE_WINDOWS_PIPE_PATH,
  CATBEE_WSL_DISTRO,
  CATBEE_WSL_DOCKER_TCP_PORT,
  getEngineDownloadsDir,
  getEngineLogsDir,
  getEngineManifestPath,
  getEngineRootDir,
  getWslEngineDiskPath
} from '../engine-paths';
import {
  describeDownload,
  dockerApiGetJson,
  downloadFile,
  fetchEngineResource,
  ensureHostDockerCli,
  getDockerServerVersion,
  hostArch,
  pathExists,
  readEngineManifest,
  runCommand,
  sameJson,
  shellQuote,
  sleep,
  updateEngineManifest,
  writeEngineManifest,
  type RunResult
} from '../engine-utils';

const logger = appLogger.child({}, { msgPrefix: '[WslEngineDriver] ' });

/** dockerd listens on loopback inside WSL; WSL's localhost forwarding makes it reachable from Windows. */
const TCP_CONNECTION: DockerConnection = { type: 'tcp', host: '127.0.0.1', port: CATBEE_WSL_DOCKER_TCP_PORT };
const DAEMON_CONFIG_PATH = '/etc/docker/daemon.json';
const DAEMON_LOG_PATH = '/var/log/docker/dockerd.log';
const START_SCRIPT_PATH = '/usr/local/bin/catbee-dockerd';
const INTEGRATION_PROFILE = '/etc/profile.d/catbee-docker.sh';
const FALLBACK_ALPINE_VERSION = '3.24.4';

const INSTALL_DOCKER_PACKAGES = String.raw`
grep -q "^nameserver" /etc/resolv.conf 2>/dev/null || printf '%s\n' 'nameserver 1.1.1.1' > /etc/resolv.conf
bootstrap_ca=$(mktemp)
trap 'rm -f "$bootstrap_ca"' EXIT
# Repair joined PEM records left by older installers in a temporary copy. Alpine's
# /etc/ssl/cert.pem is a symlink to this bundle, so appending to both broke it.
sed 's/-----END CERTIFICATE----------BEGIN CERTIFICATE-----/-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----/g' /etc/ssl/certs/ca-certificates.crt > "$bootstrap_ca"
for cert in /usr/local/share/ca-certificates/catbee-win-*.crt; do
  [ -f "$cert" ] || continue
  printf '\n' >> "$bootstrap_ca"
  cat "$cert" >> "$bootstrap_ca"
done
SSL_CERT_FILE="$bootstrap_ca" apk add --no-cache docker docker-cli-buildx docker-cli-compose iptables ip6tables ca-certificates
update-ca-certificates
`.trim();

// eslint-disable-next-line n/no-process-env
const systemRoot = process.env.SystemRoot;
const WSL_EXECUTABLE = systemRoot ? path.join(systemRoot, 'System32', 'wsl.exe') : 'wsl.exe';
const POWERSHELL_EXECUTABLE = systemRoot
  ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

const START_SCRIPT = `#!/bin/sh
# Launched by CatBee Container Studio; keeps the WSL session (and therefore the distro) alive.
mount --make-rshared / 2>/dev/null || true
mkdir -p /var/log/docker /var/run

# Setup cgroups for Docker and nested systemd containers (Kubernetes/kind)
if [ -x /etc/init.d/cgroups ]; then
  /etc/init.d/cgroups start 2>/dev/null || true
fi
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init
  for p in $(cat /sys/fs/cgroup/cgroup.procs 2>/dev/null); do
    [ "$p" != "0" ] && echo "$p" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
  done
  for controller in $(cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null); do
    echo "+$controller" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
  done
fi
if [ -d /sys/fs/cgroup ] && [ ! -d /sys/fs/cgroup/systemd ] && [ ! -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/systemd
  mount -t cgroup -o none,name=systemd cgroup /sys/fs/cgroup/systemd 2>/dev/null || true
fi

if [ -f /var/run/docker.pid ] && kill -0 "$(cat /var/run/docker.pid)" 2>/dev/null; then
  echo "dockerd already running, keeping WSL session alive" >&2
  PID="$(cat /var/run/docker.pid)"
  while kill -0 "$PID" 2>/dev/null; do
    sleep 2
  done
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
  private readonly diskPath = getWslEngineDiskPath();
  private readonly wslDir = path.dirname(this.diskPath);
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
      dataLocation: this.diskPath,
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
      logger.warn({ err: error }, 'wsl.exe --status failed.');
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
    const distros = await this.listDistros(false);
    if (!distros.some(name => name.toLowerCase() === CATBEE_WSL_DISTRO)) return false;

    const manifest = await this.getManifest();
    if (manifest?.engineVersion && !['unknown', 'pending first start'].includes(manifest.engineVersion)) return true;
    // The registration and the installed binary can outlive a missing or unreadable manifest.
    return (await this.readInstalledDockerVersion()) !== null;
  }

  async getManifest(): Promise<EngineManifest | null> {
    const manifest = await readEngineManifest();
    return manifest?.backend === 'wsl2' ? manifest : null;
  }

  private newManifest(): EngineManifest {
    return {
      schemaVersion: 2,
      backend: 'wsl2',
      engineVersion: 'unknown',
      platform: 'win32',
      architecture: hostArch(),
      distribution: 'alpine',
      installedAt: new Date().toISOString(),
      endpoint: { type: 'npipe', address: CATBEE_WINDOWS_PIPE_PATH },
      state: 'stopped'
    };
  }

  private async readInstalledDockerVersion(): Promise<string | null> {
    return this.sh(`test -x ${START_SCRIPT_PATH} && dockerd --version`, { timeoutMs: 20_000 })
      .then(({ stdout }) => /version\s+([\w.\-+]+)/i.exec(stdout)?.[1] ?? null)
      .catch(() => null);
  }

  async install(onProgress: EngineProgressCallback): Promise<EngineManifest> {
    const prereq = await this.checkPrerequisites();
    if (!prereq.ok) {
      throw new Error(`${prereq.reason ?? 'WSL 2 is unavailable.'} ${prereq.actionHint ?? ''}`.trim());
    }

    const registered = (await this.listDistros(false)).some(name => name.toLowerCase() === CATBEE_WSL_DISTRO);
    const manifest = (await this.getManifest()) ?? this.newManifest();
    if (registered) {
      onProgress(30, 'Reusing the existing CatBee WSL distribution...');
      const installedVersion = await this.readInstalledDockerVersion();
      if (installedVersion) {
        manifest.engineVersion = installedVersion;
        await writeEngineManifest(manifest);
        onProgress(100, 'Installation recovered.');
        return manifest;
      }
    } else {
      if (await pathExists(this.diskPath)) {
        throw new Error(
          'The CatBee WSL disk exists, but its distribution is not registered. Restore the distribution before reinstalling.'
        );
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
      await mkdir(this.wslDir, { recursive: true });
      await this.wsl(['--import', CATBEE_WSL_DISTRO, this.wslDir, rootfsPath, '--version', '2'], {
        timeoutMs: 5 * 60_000
      });
      manifest.components = { alpine: version };
      manifest.distribution = `alpine-${version}`;
    }

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

    onProgress(50, 'Synchronizing corporate CA certificates into distribution...');
    await this.syncHostCaCertificates(msg => onProgress(50, msg)).catch(err => {
      logger.warn({ err }, 'Could not synchronize host CA certificates during install.');
    });

    onProgress(55, 'Installing Docker Engine (docker, containerd, iptables)...');
    await this.installDockerPackages(onProgress);

    onProgress(85, 'Installing the engine launcher...');
    await this.writeFileInDistro(START_SCRIPT_PATH, START_SCRIPT);
    await this.sh(`chmod +x ${START_SCRIPT_PATH} && mkdir -p /etc/docker /var/log/docker`);

    const installedVersion = await this.readInstalledDockerVersion();
    if (!installedVersion)
      throw new Error('Docker packages finished installing, but dockerd is unavailable in CatBee WSL.');
    manifest.engineVersion = installedVersion;

    // Stop the distro so the next start picks up wsl.conf.
    await this.wsl(['--terminate', CATBEE_WSL_DISTRO]).catch(() => undefined);

    onProgress(90, 'Ensuring standalone host Docker CLI...');
    await ensureHostDockerCli((fraction, stage) => {
      onProgress(90 + Math.round(fraction * 0.08), stage);
    }).catch(err => {
      logger.warn({ err }, 'Could not download host Docker CLI, continuing with system fallback.');
    });

    manifest.state = 'stopped';
    await writeEngineManifest(manifest);
    onProgress(100, 'Installation complete.');
    return manifest;
  }

  private async installDockerPackages(onProgress: EngineProgressCallback): Promise<void> {
    const settings = await getEngineSettings();
    const proxyEnv = proxyToEnv(resolveDaemonProxy(settings, await detectSystemProxy()));
    const exports = Object.entries(proxyEnv).map(([key, value]) => `export ${key}=${shellQuote(value)}`);
    let certificateError: string | undefined;
    try {
      await this.sh(['set -e', ...exports, INSTALL_DOCKER_PACKAGES].join('\n'), {
        timeoutMs: 15 * 60_000,
        onOutput: line => {
          if (/TLS:.*certificate/i.test(line)) certificateError = line;
          // apk can pad the item counter, for example "( 1/14) Installing ca-certificates".
          const match = /^\(\s*(\d{1,5})\/(\d{1,5})\)\s+(\S[^\r\n]*)$/.exec(line);
          if (match) {
            onProgress(55 + Math.round((Number(match[1]) / Number(match[2])) * 30), match[3]);
          }
        }
      });
    } catch (error) {
      if (certificateError)
        throw new Error(`CatBee WSL could not verify the Alpine package repository. ${certificateError}`, {
          cause: error
        });
      throw error;
    }
  }

  async buildDaemonConfig(settings: EngineSettings): Promise<Record<string, unknown>> {
    return buildDaemonConfig(settings, {
      hosts: ['unix:///var/run/docker.sock', `tcp://127.0.0.1:${CATBEE_WSL_DOCKER_TCP_PORT}`],
      daemonProxy: resolveDaemonProxy(settings, await detectSystemProxy())
    });
  }

  async start(settings: EngineSettings, onStatus?: (status: string) => void): Promise<DockerConnection> {
    onStatus?.('Applying engine configuration...');
    const caCertsUpdated = await this.syncHostCaCertificates(onStatus);
    const dockerCertsUpdated = await this.syncHostDockerCerts();
    const certsUpdated = caCertsUpdated || dockerCertsUpdated;

    const desiredConfig = `${JSON.stringify(await this.buildDaemonConfig(settings), null, 2)}\n`;
    const currentConfig = await this.sh(`cat ${DAEMON_CONFIG_PATH} 2>/dev/null || true`)
      .then(r => r.stdout)
      .catch(() => '');
    const configChanged = !sameJson(currentConfig, desiredConfig);
    if (configChanged) {
      await this.writeFileInDistro(DAEMON_CONFIG_PATH, desiredConfig);
    }

    const currentStartScript = await this.sh(`cat ${START_SCRIPT_PATH} 2>/dev/null || true`)
      .then(r => r.stdout)
      .catch(() => '');
    const scriptChanged = currentStartScript.trim() !== START_SCRIPT.trim();
    if (scriptChanged) {
      await this.writeFileInDistro(START_SCRIPT_PATH, START_SCRIPT);
      await this.sh(`chmod +x ${START_SCRIPT_PATH}`);
    }

    // Always ensure cgroup controllers are enabled in the live distro
    await this.sh(
      `if [ -f /sys/fs/cgroup/cgroup.controllers ]; then mkdir -p /sys/fs/cgroup/init; for p in $(cat /sys/fs/cgroup/cgroup.procs 2>/dev/null); do [ "$p" != "0" ] && echo "$p" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true; done; for c in $(cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null); do echo "+$c" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true; done; fi`
    ).catch(() => {});

    // Ensure standalone host Docker CLI is available in CatBee bin directory
    void ensureHostDockerCli().catch(err => {
      logger.debug('Background host Docker CLI check failed:', err);
    });

    const alreadyRunning = (await this.isDistroRunning()) && (await this.getGuestEngineId());
    if (alreadyRunning && (configChanged || scriptChanged || certsUpdated)) {
      onStatus?.('Restarting Docker Engine to apply new settings...');
      await this.stopDaemon();
    }

    const hasActiveKeeper = this.daemonProcess !== null && this.daemonProcess.exitCode === null;
    if (!alreadyRunning || configChanged || scriptChanged || certsUpdated || !hasActiveKeeper) {
      onStatus?.('Starting Docker Engine in WSL 2...');
      this.spawnDaemon();
    }

    onStatus?.('Waiting for Docker Engine...');
    try {
      await this.waitForGuestEndpoint();
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

    const manifest = (await this.getManifest()) ?? this.newManifest();
    await writeEngineManifest({
      ...manifest,
      state: 'running',
      engineVersion: (await getDockerServerVersion(TCP_CONNECTION)) ?? manifest.engineVersion,
      updatedAt: new Date().toISOString(),
      endpoint: pipeReady
        ? { type: 'npipe', address: CATBEE_WINDOWS_PIPE_PATH }
        : { type: 'tcp', address: '127.0.0.1', port: CATBEE_WSL_DOCKER_TCP_PORT }
    });
    return connection;
  }

  async stop(): Promise<void> {
    if (await this.isDistroRunning()) {
      await this.stopDaemon();
      let terminationError: unknown;
      try {
        await this.wsl(['--terminate', CATBEE_WSL_DISTRO]);
      } catch (error) {
        terminationError = error;
      }
      if (await this.isDistroRunning()) {
        throw new Error('The CatBee WSL distribution is still running after shutdown.', { cause: terminationError });
      }
    }
    await this.pipeRelay.stop();
    await updateEngineManifest({ state: 'stopped' });
  }

  async getStatus(): Promise<EngineDriverStatus> {
    if ((await this.isDistroRunning().catch(() => false)) && (await this.isGuestEndpoint().catch(() => false))) {
      return 'running';
    }
    return (await this.isInstalled()) ? 'stopped' : 'not-installed';
  }

  async uninstall(onProgress?: EngineProgressCallback): Promise<void> {
    onProgress?.(10, 'Stopping Docker Engine...');
    if ((await pathExists(this.wslDir)) || (await this.getManifest())) {
      const distros = await this.listDistros(false, true);
      if (distros.some(name => name.toLowerCase() === CATBEE_WSL_DISTRO)) {
        await this.stop();
        const settings = await getEngineSettings();
        for (const distro of settings.wslAdditionalDistros.filter(name => distros.includes(name))) {
          if (!(await this.configureWslDistroIntegration(distro, false))) {
            throw new Error(`Could not remove CatBee Docker integration from WSL distribution "${distro}".`);
          }
        }
        onProgress?.(35, 'Removing the CatBee WSL distribution and its data...');
        await this.wsl(['--unregister', CATBEE_WSL_DISTRO], { timeoutMs: 5 * 60_000 });
        if ((await this.listDistros(false, true)).some(name => name.toLowerCase() === CATBEE_WSL_DISTRO)) {
          throw new Error('The CatBee WSL distribution is still registered. Its files have not been deleted.');
        }
      }
    }
    onProgress?.(80, 'Deleting engine files...');
    await rm(this.wslDir, { recursive: true, force: true });
    await rm(getEngineDownloadsDir(), { recursive: true, force: true });
    await rm(getEngineLogsDir(), { recursive: true, force: true });
    await rm(getEngineManifestPath(), { force: true }).catch(() => undefined);
    onProgress?.(100, 'Built-in engine removed.');
  }

  async reclaimMemory(): Promise<void> {
    await this.sh(
      'sync; echo 3 > /proc/sys/vm/drop_caches; echo 1 > /proc/sys/vm/compact_memory 2>/dev/null; true'
    ).catch(() => undefined);
  }

  /** Lists user WSL distributions (excluding CatBee and Docker Desktop internals) for WSL integration. */
  async getInstalledDistros(requireSuccess = false): Promise<string[]> {
    return (await this.listDistros(false, requireSuccess)).filter(
      name => !/^(catbee-container-engine|docker-desktop(-data)?)$/i.test(name)
    );
  }

  async configureWslDistroIntegration(distroName: string, enabled: boolean): Promise<boolean> {
    if (!/^[a-zA-Z0-9._][a-zA-Z0-9._-]*$/.test(distroName) || distroName.toLowerCase() === CATBEE_WSL_DISTRO) {
      return false;
    }
    // All WSL 2 distros share one network namespace, so loopback reaches the CatBee daemon.
    const script = enabled
      ? `mkdir -p /etc/profile.d && echo 'export DOCKER_HOST=tcp://127.0.0.1:${CATBEE_WSL_DOCKER_TCP_PORT}' > ${INTEGRATION_PROFILE}`
      : `rm -f ${INTEGRATION_PROFILE}`;
    try {
      await this.wsl(['-d', distroName, '-u', 'root', '--exec', 'sh', '-s'], { input: script });
      logger.info(`${enabled ? 'Enabled' : 'Disabled'} Docker integration for ${distroName}.`);
      return true;
    } catch (err) {
      logger.error({ err }, `Could not update integration for ${distroName}.`);
      return false;
    }
  }

  private spawnDaemon(): void {
    this.daemonExitReason = null;
    const child = spawn(WSL_EXECUTABLE, ['-d', CATBEE_WSL_DISTRO, '-u', 'root', '--exec', START_SCRIPT_PATH], {
      windowsHide: true,
      stdio: 'ignore',
      env: wslEnv()
    });
    child.on('error', err => {
      this.daemonExitReason = `Failed to launch wsl.exe: ${err.message}`;
      logger.error({ err }, 'Failed to spawn dockerd.');
    });
    child.on('exit', code => {
      if (this.daemonProcess === child) {
        this.daemonProcess = null;
        if (code !== 0) {
          this.daemonExitReason = `dockerd exited unexpectedly (code ${code}).`;
          logger.error({ exitCode: code }, 'dockerd exited unexpectedly.');
          return;
        }
      }
      logger.debug({ exitCode: code }, 'dockerd session exited.');
    });
    this.daemonProcess = child;
  }

  private async stopDaemon(): Promise<void> {
    await this.sh(STOP_DOCKERD_SCRIPT, { timeoutMs: 40_000 }).catch(err => {
      logger.debug({ err }, 'Stopping dockerd failed (distro may be stopped).');
    });
    if (this.daemonProcess) {
      this.daemonProcess.kill();
      this.daemonProcess = null;
    }
    await sleep(250);
  }

  private async getGuestEngineId(): Promise<string | null> {
    const { stdout } = await this.sh(
      `env -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY docker --host unix:///var/run/docker.sock info --format '{{.ID}}'`,
      { timeoutMs: 4_000 }
    ).catch(() => ({ stdout: '' }));
    return stdout.trim() || null;
  }

  private async isGuestEndpoint(): Promise<boolean> {
    const guestId = await this.getGuestEngineId();
    if (!guestId) return false;
    const hostInfo = await dockerApiGetJson<{ ID?: string }>(TCP_CONNECTION, '/info', 2_000).catch(() => null);
    if (!hostInfo) return false;
    if (hostInfo.ID !== guestId) {
      throw new Error(`A different Docker daemon is answering on Windows port ${CATBEE_WSL_DOCKER_TCP_PORT}.`);
    }
    return true;
  }

  private async waitForGuestEndpoint(): Promise<void> {
    const deadline = Date.now() + 90_000;
    do {
      if (this.daemonExitReason) throw new Error(this.daemonExitReason);
      if (await this.isGuestEndpoint()) {
        if (this.daemonExitReason) throw new Error(this.daemonExitReason);
        return;
      }
      await sleep(1_000);
    } while (Date.now() < deadline);
    throw new Error('The CatBee WSL daemon did not become reachable from Windows within 90 seconds.');
  }

  private async isDistroRunning(): Promise<boolean> {
    const { stdout } = await this.wsl(['-l', '--running', '-q'], { timeoutMs: 5_000 });
    return stdout
      .replaceAll('\0', '')
      .split(/\r?\n/)
      .some(name => name.trim() === CATBEE_WSL_DISTRO);
  }

  private async listDistros(runningOnly: boolean, requireSuccess = false): Promise<string[]> {
    try {
      const args = runningOnly ? ['-l', '--running', '-q'] : ['-l', '-q'];
      const { stdout } = await this.wsl(args);
      return stdout
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);
    } catch (error) {
      if (requireSuccess) throw error;
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
    options: { input?: string; timeoutMs?: number; onOutput?: (line: string) => void } = {}
  ): Promise<RunResult> {
    // WSL's default shell can expand variables in the script before our guest shell sees them.
    const shellArgs = options.input === undefined ? ['-s'] : ['-c', script];
    return this.wsl(['-d', CATBEE_WSL_DISTRO, '-u', 'root', '--exec', 'sh', ...shellArgs], {
      ...options,
      input: options.input ?? `${script}\n`
    });
  }

  private async writeFileInDistro(filePath: string, content: string): Promise<void> {
    await this.sh(`mkdir -p ${shellQuote(path.posix.dirname(filePath))} && cat > ${shellQuote(filePath)}`, {
      input: content.replaceAll('\r\n', '\n')
    });
  }

  /**
   * Synchronizes trusted Windows Certificate Store Root CA certificates into the
   * CatBee WSL Alpine Linux distribution (/usr/local/share/ca-certificates) and runs
   * update-ca-certificates so dockerd and container processes trust corporate registries.
   *
   * Security & Trust rules:
   * 1. Only exports from trusted root stores (LocalMachine\Root and CurrentUser\Root).
   *    Intermediate CA stores are excluded so unverified intermediates are not elevated
   *    to root trust anchors in Alpine Linux.
   * 2. Excludes any certificate present in LocalMachine\Disallowed or CurrentUser\Disallowed.
   * 3. Validates trust chain using X509Chain and rejects revoked, untrusted, or signature-invalid certs.
   * 4. Enforces validFrom/validTo periods and basicConstraints:CA in Node.js.
   */
  private async syncHostCaCertificates(onStatus?: (status: string) => void): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    const cachePath = '/etc/catbee-ca-certs.hash';

    try {
      // Export trusted root CAs from Windows Certificate Store, validating trust and excluding distrusted/revoked roots
      const psScript = String.raw`
$ErrorActionPreference = 'Stop'
$disallowed = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($store in @('Cert:\LocalMachine\Disallowed', 'Cert:\CurrentUser\Disallowed')) {
  if (Test-Path -LiteralPath $store) {
    foreach ($cert in (Get-ChildItem -LiteralPath $store)) {
      [void]$disallowed.Add($cert.Thumbprint)
    }
  }
}

$rejectedStatus = [System.Security.Cryptography.X509Certificates.X509ChainStatusFlags]::Revoked -bor
                  [System.Security.Cryptography.X509Certificates.X509ChainStatusFlags]::ExplicitDistrust -bor
                  [System.Security.Cryptography.X509Certificates.X509ChainStatusFlags]::UntrustedRoot -bor
                  [System.Security.Cryptography.X509Certificates.X509ChainStatusFlags]::NotSignatureValid
$exported = [System.Collections.Generic.List[string]]::new()
foreach ($store in @('Cert:\LocalMachine\Root', 'Cert:\CurrentUser\Root')) {
  foreach ($cert in (Get-ChildItem -LiteralPath $store)) {
    if ($disallowed.Contains($cert.Thumbprint)) { continue }

    $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
    try {
      $chain.ChainPolicy.RevocationFlag = [System.Security.Cryptography.X509Certificates.X509RevocationFlag]::EntireChain
      $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::Offline
      $chain.ChainPolicy.UrlRetrievalTimeout = [System.TimeSpan]::FromSeconds(3)
      [void]$chain.Build($cert)
      if ($chain.ChainStatus | Where-Object { $_.Status -band $rejectedStatus }) { continue }

      $bytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
      $exported.Add([System.Convert]::ToBase64String($bytes))
    } finally {
      $chain.Dispose()
    }
  }
}
ConvertTo-Json -InputObject ($exported.ToArray()) -Compress
`.trim();

      // Windows PowerShell must resolve its own modules when CatBee was launched from PowerShell 7.
      // eslint-disable-next-line n/no-process-env
      const inheritedEnv = process.env;
      const env = Object.fromEntries(
        Object.entries(inheritedEnv).filter(([key]) => key.toLowerCase() !== 'psmodulepath')
      );
      const { stdout } = await runCommand(
        POWERSHELL_EXECUTABLE,
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { env, timeoutMs: 30_000 }
      );
      const exported: unknown = JSON.parse(stdout);
      if (!Array.isArray(exported)) {
        throw new Error('Invalid Windows certificate export.');
      }

      const seenFingerprints = new Set<string>();
      const trustedCaPems: string[] = [];
      const now = Date.now();

      for (const encoded of exported) {
        if (typeof encoded !== 'string') {
          throw new Error('Invalid certificate in Windows certificate export.');
        }
        const cert = new crypto.X509Certificate(Buffer.from(encoded, 'base64'));
        if (!cert.ca) continue;
        if (now > new Date(cert.validTo).getTime() || now < new Date(cert.validFrom).getTime()) continue;
        if (seenFingerprints.has(cert.fingerprint256)) continue;
        seenFingerprints.add(cert.fingerprint256);
        trustedCaPems.push(cert.toString().trim());
      }

      const certsPayload = trustedCaPems.join('\n\n');
      const certsHash = certsPayload ? crypto.createHash('sha256').update(certsPayload).digest('hex') : 'empty';
      const currentHash = await this.sh(`cat ${cachePath} 2>/dev/null || true`)
        .then(r => r.stdout.trim())
        .catch(() => '');

      if (currentHash === certsHash) {
        return false;
      }

      if (trustedCaPems.length === 0) {
        onStatus?.('Cleaning up host CA certificates in CatBee WSL...');
        const cleanupScript = `set -e
rm -f /usr/local/share/ca-certificates/catbee-win-*.crt
if command -v update-ca-certificates >/dev/null 2>&1; then
  update-ca-certificates
fi
echo "${certsHash}" > ${cachePath}
`;
        await this.sh(cleanupScript);
        return true;
      }

      onStatus?.('Synchronizing trusted host CA certificates into CatBee WSL...');
      await this.sh('mkdir -p /usr/local/share/ca-certificates');
      const installScript = `set -e
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
cat > "$tmpdir/certs.pem"
rm -f /usr/local/share/ca-certificates/catbee-win-*.crt
awk 'BEGIN {c=0} /BEGIN CERTIFICATE/ {c++} {print > ("/usr/local/share/ca-certificates/catbee-win-" c ".crt")}' "$tmpdir/certs.pem"
if command -v update-ca-certificates >/dev/null 2>&1; then
  update-ca-certificates
fi
echo "${certsHash}" > ${cachePath}
`;
      await this.sh(installScript, { input: certsPayload });
      logger.debug(`Synchronized ${trustedCaPems.length} trusted host CA certificates into CatBee WSL.`);
      return true;
    } catch (err) {
      logger.warn({ err }, 'Could not synchronize host CA certificates.');
      return false;
    }
  }

  /**
   * Synchronizes host Docker certificates (%USERPROFILE%\.docker\certs.d) into the WSL
   * Alpine distribution (/etc/docker/certs.d).
   * Returns true if certificates were added, updated, or removed, requiring a dockerd restart.
   */
  private async syncHostDockerCerts(): Promise<boolean> {
    const hostCertsDir = path.join(os.homedir(), '.docker', 'certs.d');
    const marker = '/etc/docker/.catbee-certs-d-copied';
    const hashMarker = '/etc/docker/.catbee-certs-d.hash';

    if (!existsSync(hostCertsDir)) {
      const cleanupScript = `set -e
if [ -d /etc/docker/certs.d ] && [ -f "${marker}" ]; then
  rm -rf /etc/docker/certs.d "${marker}" "${hashMarker}"
  echo "REMOVED"
  exit 0
fi
echo "NONE"
`;
      const res = await this.sh(cleanupScript).catch(() => ({ stdout: 'NONE' }));
      return res.stdout.trim() === 'REMOVED';
    }

    try {
      const certFiles = await collectCertFiles(hostCertsDir);
      if (certFiles.length === 0) {
        const emptyCleanScript = `set -e
if [ -d /etc/docker/certs.d ] && [ -f "${marker}" ]; then
  rm -rf /etc/docker/certs.d "${marker}" "${hashMarker}"
  echo "REMOVED"
  exit 0
fi
echo "NONE"
`;
        const { stdout: cleanOut } = await this.sh(emptyCleanScript);
        return cleanOut.trim() === 'REMOVED';
      }

      const payload = certFiles.map(f => `${f.base64}:${f.relPath}`).join('\n');
      const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');

      const checkScript = `[ -d /etc/docker/certs.d ] && [ -f "${marker}" ] && [ "$(cat "${hashMarker}" 2>/dev/null)" = "${payloadHash}" ] && echo "VALID" || echo "STALE"`;
      const { stdout: checkOut } = await this.sh(checkScript);
      if (checkOut.trim() === 'VALID') {
        return false;
      }

      const copyScript = `set -e
marker="${marker}"
hash_marker="${hashMarker}"

# Do not overwrite user-managed directories
if [ -e /etc/docker/certs.d ] && [ ! -f "$marker" ]; then
  echo "PRESERVED"
  exit 0
fi

mkdir -p /etc/docker
staging=$(mktemp -d /etc/docker/.catbee-certs-stage.XXXXXX)
trap 'rm -rf "$staging"' EXIT
chmod 700 "$staging"
cat > "$staging/.payload"

while IFS= read -r line || [ -n "$line" ]; do
  [ -z "$line" ] && continue
  b64="\${line%%:*}"
  rel="\${line#*:}"
  dest="$staging/$rel"
  mkdir -p "$(dirname "$dest")"
  chmod 700 "$(dirname "$dest")"
  echo "$b64" | base64 -d > "$dest"
  chmod 600 "$dest"
done < "$staging/.payload"
rm -f "$staging/.payload"

rm -rf /etc/docker/certs.d
mv "$staging" /etc/docker/certs.d
echo "copied" > "$marker"
echo "${payloadHash}" > "$hash_marker"
echo "UPDATED"
`;
      const copyRes = await this.sh(copyScript, {
        input: payload
      });
      const isUpdated = copyRes.stdout.trim() === 'UPDATED';
      if (isUpdated) {
        logger.debug(`Reconciled ${certFiles.length} host Docker certificate files via copy into WSL.`);
      }
      return isUpdated;
    } catch (err) {
      logger.warn({ err }, 'Could not synchronize Docker certs directory.');
      return false;
    }
  }
}

async function collectCertFiles(dir: string, baseDir = dir): Promise<Array<{ relPath: string; base64: string }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: Array<{ relPath: string; base64: string }> = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectCertFiles(full, baseDir)));
    } else if (entry.isFile()) {
      results.push({
        relPath: path.relative(baseDir, full).replaceAll('\\', '/'),
        base64: await readFile(full, 'base64')
      });
    }
  }
  return results;
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
    const response = await fetchEngineResource(`${base}/latest-releases.yaml`, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const yaml = await response.text();
      const match = /file:\s*(alpine-minirootfs-([\d.]+)-\w+\.tar\.gz)/.exec(yaml);
      if (match) {
        return { url: `${base}/${match[1]}`, version: match[2] };
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Could not resolve latest Alpine release; using pinned version.');
  }
  const minor = FALLBACK_ALPINE_VERSION.split('.').slice(0, 2).join('.');
  return {
    url: `https://dl-cdn.alpinelinux.org/alpine/v${minor}/releases/${arch}/alpine-minirootfs-${FALLBACK_ALPINE_VERSION}-${arch}.tar.gz`,
    version: FALLBACK_ALPINE_VERSION
  };
}
