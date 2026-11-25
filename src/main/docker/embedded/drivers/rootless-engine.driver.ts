import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../../../logger';
import type { DockerConnection, DockerUnixConnection } from '../../types/connection.types';
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
import {
  getEngineBinDir,
  getEngineDownloadsDir,
  getEngineLogsDir,
  getEngineRootDir,
  getLinuxRuntimeDir
} from '../engine-paths';
import {
  commandExists,
  describeDownload,
  downloadFile,
  fetchEngineResource,
  extractArchive,
  getDockerServerVersion,
  hostArch,
  pathExists,
  pingDockerEndpoint,
  readEngineManifest,
  runCommand,
  sameJson,
  sleep,
  tailFile,
  updateEngineManifest,
  waitForDockerEndpoint,
  writeEngineManifest
} from '../engine-utils';

const FALLBACK_DOCKER_VERSION = '29.10.0';
const SBIN_PATHS = ['/usr/local/sbin', '/usr/sbin', '/sbin'];

/** Linux engine: Docker's static binaries run as the current user through rootlesskit (no root, no VM). */
export class RootlessEngineDriver implements PlatformEngineDriver {
  readonly platform: NodeJS.Platform = 'linux';
  private readonly engineDir = getEngineRootDir();
  private readonly binDir = getEngineBinDir();
  private readonly dataRoot = path.join(this.engineDir, 'data');
  private readonly configPath = path.join(this.engineDir, 'daemon.json');
  private readonly logPath = path.join(getEngineLogsDir(), 'dockerd.log');
  private readonly runtimeDir = getLinuxRuntimeDir();
  private readonly pidPath = path.join(this.runtimeDir, 'catbee-dockerd.pid');
  private readonly socket: DockerUnixConnection = { type: 'unix', path: path.join(this.runtimeDir, 'docker.sock') };
  private exitReason: string | null = null;

  getRunningConnection(): DockerConnection {
    return this.socket;
  }

  getCapabilities(): EngineCapabilities {
    return {
      backend: 'rootless',
      backendLabel: 'Rootless Docker Engine (native)',
      managesVmResources: false,
      resources: { cpus: false, memory: false, swap: false, disk: false, rosetta: false },
      resourcesNote:
        'Containers run natively on this machine and share its CPU, memory and disk. Use per-container limits (--cpus, --memory) instead.',
      fileSharing: false,
      fileSharingNote: 'Containers run natively, so every directory you can access can be bind-mounted.',
      wslIntegration: false,
      resourceChangesRequireRestart: false,
      // Native engine: memory goes back to the host as soon as containers stop.
      resourceSaver: false
    };
  }

  getInfo(): EngineInfo {
    return {
      capabilities: this.getCapabilities(),
      engineDir: this.engineDir,
      dataLocation: this.dataRoot,
      logsLocation: this.logPath,
      daemonConfigLocation: this.configPath,
      distribution: 'Host Linux (rootless)'
    };
  }

  async checkPrerequisites(): Promise<PrerequisiteCheckResult> {
    if (process.platform !== 'linux') {
      return { ok: false, reason: 'The rootless engine is only supported on Linux.' };
    }
    if (process.getuid?.() === 0) {
      return {
        ok: false,
        reason: 'CatBee is running as root; the built-in engine runs rootless and needs a regular user.',
        actionHint: 'Start CatBee as a normal user, or use the system Docker Engine (External mode).'
      };
    }
    if (process.arch !== 'x64' && process.arch !== 'arm64') {
      return { ok: false, reason: `Unsupported CPU architecture: ${process.arch}.` };
    }

    for (const tool of ['newuidmap', 'newgidmap']) {
      if (!(await findBinary(tool))) {
        return {
          ok: false,
          reason: `${tool} was not found.`,
          actionHint:
            'Install the "uidmap" package (Debian/Ubuntu: sudo apt install uidmap; Fedora: sudo dnf install shadow-utils).'
        };
      }
    }

    const user = os.userInfo();
    for (const file of ['/etc/subuid', '/etc/subgid']) {
      const content = await readFile(file, 'utf8').catch(() => '');
      const hasEntry = content
        .split('\n')
        .some(line => line.startsWith(`${user.username}:`) || line.startsWith(`${user.uid}:`));
      if (!hasEntry) {
        return {
          ok: false,
          reason: `No subordinate ID range for "${user.username}" in ${file}.`,
          actionHint: `Run: sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 ${user.username}`
        };
      }
    }

    if ((await readSysctl('/proc/sys/kernel/unprivileged_userns_clone')) === '0') {
      return {
        ok: false,
        reason: 'Unprivileged user namespaces are disabled.',
        actionHint: 'Run: sudo sysctl -w kernel.unprivileged_userns_clone=1 (persist it in /etc/sysctl.d).'
      };
    }
    if ((await readSysctl('/proc/sys/user/max_user_namespaces')) === '0') {
      return {
        ok: false,
        reason: 'User namespaces are disabled (user.max_user_namespaces=0).',
        actionHint: 'Run: sudo sysctl -w user.max_user_namespaces=28633'
      };
    }
    const appArmor = await this.checkAppArmor();
    if (!appArmor.ok) return appArmor;

    if (!(await findBinary('iptables'))) {
      return {
        ok: false,
        reason: 'iptables was not found.',
        actionHint: 'Install the "iptables" package.'
      };
    }
    return { ok: true };
  }

  async isInstalled(): Promise<boolean> {
    const manifest = await readEngineManifest();
    if (
      manifest?.backend !== 'rootless' ||
      !manifest.engineVersion ||
      manifest.engineVersion === 'pending first start'
    ) {
      return false;
    }
    return (
      (await pathExists(path.join(this.binDir, 'dockerd'))) &&
      (await pathExists(path.join(this.binDir, 'dockerd-rootless.sh')))
    );
  }

  async getManifest(): Promise<EngineManifest | null> {
    return await readEngineManifest();
  }

  private launchPath(): string {
    // eslint-disable-next-line n/no-process-env
    return [this.binDir, ...SBIN_PATHS, process.env.PATH ?? '/usr/bin:/bin'].join(':');
  }

  private async checkAppArmor(): Promise<PrerequisiteCheckResult> {
    let rootlesskit = path.join(this.binDir, 'rootlesskit');
    if (
      (await readSysctl('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')) !== '1' ||
      !(await pathExists(rootlesskit))
    ) {
      return { ok: true };
    }
    try {
      // Match dockerd-rootless.sh, which prefers docker-rootlesskit even if rootlesskit is earlier in PATH.
      // eslint-disable-next-line n/no-process-env
      const env = { ...process.env, PATH: this.launchPath() };
      const { stdout } = await runCommand(
        '/bin/sh',
        ['-c', 'command -v docker-rootlesskit || command -v rootlesskit'],
        {
          env,
          timeoutMs: 5_000
        }
      );
      rootlesskit = await realpath(stdout.trim());
      await runCommand(rootlesskit, ['--net=host', '/usr/bin/true'], { env, timeoutMs: 5_000 });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: `RootlessKit could not create a user namespace with AppArmor enabled: ${error instanceof Error ? error.message : String(error)}`,
        actionHint:
          `Allow rootlesskit by creating /etc/apparmor.d/catbee-rootlesskit containing:\n` +
          `abi <abi/4.0>,\ninclude <tunables/global>\n"${rootlesskit}" flags=(unconfined) {\n  userns,\n  include if exists <local/catbee-rootlesskit>\n}\n` +
          'then run: sudo systemctl restart apparmor.service'
      };
    }
  }

  async install(onProgress: EngineProgressCallback): Promise<EngineManifest> {
    const prereq = await this.checkPrerequisites();
    if (!prereq.ok) {
      throw new Error(`${prereq.reason ?? 'Unsupported system.'} ${prereq.actionHint ?? ''}`.trim());
    }

    onProgress(5, 'Resolving Docker Engine release...');
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const version = await resolveDockerVersion(arch);
    const base = `https://download.docker.com/linux/static/stable/${arch}`;
    const archives = [`docker-${version}.tgz`, `docker-rootless-extras-${version}.tgz`];

    await Promise.all(
      archives.map(async (archive, index) => {
        const target = path.join(getEngineDownloadsDir(), archive);
        if (!(await pathExists(target))) {
          await downloadFile(`${base}/${archive}`, target, (fraction, received, total) =>
            onProgress(10 + index * 40 + Math.round(fraction * 35), describeDownload(archive, received, total))
          );
        }
      })
    );

    onProgress(85, 'Stopping the existing rootless engine before replacing binaries...');
    await this.stop();
    onProgress(88, 'Installing Docker Engine binaries...');
    await mkdir(this.binDir, { recursive: true });
    await Promise.all(
      archives.map(archive => extractArchive(path.join(getEngineDownloadsDir(), archive), this.binDir, 1))
    );
    await chmod(path.join(this.binDir, 'dockerd-rootless.sh'), 0o755);
    const appArmor = await this.checkAppArmor();
    if (!appArmor.ok) throw new Error(`${appArmor.reason} ${appArmor.actionHint}`);
    await mkdir(this.dataRoot, { recursive: true });

    const manifest: EngineManifest = {
      schemaVersion: 2,
      backend: 'rootless',
      engineVersion: version,
      components: { docker: version },
      platform: 'linux',
      architecture: hostArch(),
      distribution: 'static',
      installedAt: new Date().toISOString(),
      endpoint: { type: 'unix', address: this.socket.path },
      state: 'stopped'
    };
    await writeEngineManifest(manifest);
    onProgress(100, 'Installation complete.');
    return manifest;
  }

  async buildDaemonConfig(settings: EngineSettings): Promise<Record<string, unknown>> {
    // Listeners are passed with -H, and ip6tables is unsupported inside the rootlesskit network namespace.
    const config = buildDaemonConfig(settings, {
      daemonProxy: resolveDaemonProxy(settings, await detectSystemProxy())
    });
    delete config.ip6tables;
    return config;
  }

  async start(settings: EngineSettings, onStatus?: (status: string) => void): Promise<DockerConnection> {
    const desiredConfig = `${JSON.stringify(await this.buildDaemonConfig(settings), null, 2)}\n`;
    const currentConfig = await readFile(this.configPath, 'utf8').catch(() => '');
    const configChanged = !sameJson(currentConfig, desiredConfig);

    if (await pingDockerEndpoint(this.socket)) {
      if (!configChanged) {
        return this.socket;
      }
      onStatus?.('Restarting Docker Engine to apply new settings...');
      await this.stop();
    }

    const appArmor = await this.checkAppArmor();
    if (!appArmor.ok) throw new Error(`${appArmor.reason} ${appArmor.actionHint}`);
    onStatus?.('Starting rootless Docker Engine...');
    await mkdir(this.engineDir, { recursive: true });
    await writeFile(this.configPath, desiredConfig, 'utf8');
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    await chmod(this.runtimeDir, 0o700);
    await mkdir(path.dirname(this.logPath), { recursive: true });
    await this.cleanupStaleState();

    // eslint-disable-next-line n/no-process-env
    const hostEnv = process.env;
    const env: NodeJS.ProcessEnv = {
      ...hostEnv,
      ...proxyToEnv(resolveDaemonProxy(settings, await detectSystemProxy())),
      PATH: this.launchPath(),
      XDG_RUNTIME_DIR: this.runtimeDir,
      DOCKERD_ROOTLESS_ROOTLESSKIT_STATE_DIR: path.join(this.runtimeDir, 'dockerd-rootless'),
      HOME: hostEnv.SNAP_REAL_HOME ?? os.homedir()
    };
    // Never let an outer DOCKER_HOST/context leak into the daemon environment.
    delete env.DOCKER_HOST;
    delete env.DOCKER_CONTEXT;

    const logFd = openSync(this.logPath, 'a');
    this.exitReason = null;
    const child = spawn(
      path.join(this.binDir, 'dockerd-rootless.sh'),
      [
        `--config-file=${this.configPath}`,
        `--data-root=${this.dataRoot}`,
        `--exec-root=${path.join(this.runtimeDir, 'exec')}`,
        `--pidfile=${path.join(this.runtimeDir, 'docker.pid')}`,
        `--host=unix://${this.socket.path}`
      ],
      { env, detached: true, stdio: ['ignore', logFd, logFd] }
    );
    closeSync(logFd);
    child.on('error', err => {
      this.exitReason = `Failed to launch dockerd-rootless.sh: ${err.message}`;
    });
    child.on('exit', code => {
      this.exitReason = `Rootless Docker Engine exited (code ${code}).`;
    });
    if (child.pid) {
      await writeFile(this.pidPath, String(child.pid), 'utf8');
    }
    // Keep the engine independent of the app's event loop; it is stopped explicitly on quit.
    child.unref();

    onStatus?.('Waiting for Docker Engine...');
    try {
      await waitForDockerEndpoint(this.socket, 90_000, () => this.exitReason);
    } catch (error) {
      const log = await tailFile(this.logPath, 15);
      const errMsg = error instanceof Error ? error.message : String(error);
      const logSuffix = log ? `\n\ndockerd log:\n${log}` : '';
      throw new Error(`${errMsg}${logSuffix}`);
    }

    await updateEngineManifest({
      state: 'running',
      engineVersion: (await getDockerServerVersion(this.socket)) ?? (await readEngineManifest())?.engineVersion
    });
    return this.socket;
  }

  async stop(): Promise<void> {
    const pid = await this.readPid();
    const startTime = pid ? await this.getOwnedProcessStartTime(pid) : null;
    if (pid && startTime && (await getProcessStartTime(pid)) === startTime) {
      signalGroup(pid, 'SIGTERM');
      const stopped = await this.waitForProcessExit(pid, startTime);
      if (!stopped) {
        logger.warn('[RootlessEngineDriver] Engine did not stop within 20s; killing it.');
        if ((await getProcessStartTime(pid)) === startTime) signalGroup(pid, 'SIGKILL');
        if (!(await this.waitForProcessExit(pid, startTime))) throw new Error('Rootless Docker Engine did not stop.');
      }
    }
    await this.cleanupStaleState();
    await updateEngineManifest({ state: 'stopped' });
  }

  private async waitForProcessExit(pid: number, startTime: string): Promise<boolean> {
    for (let attempts = 0; attempts < 40; attempts++) {
      if ((await getProcessStartTime(pid)) !== startTime) return true;
      await sleep(500);
    }
    return (await getProcessStartTime(pid)) !== startTime;
  }

  async getStatus(): Promise<EngineDriverStatus> {
    if (await pingDockerEndpoint(this.socket)) {
      return 'running';
    }
    return (await this.isInstalled()) ? 'stopped' : 'not-installed';
  }

  async uninstall(onProgress?: EngineProgressCallback): Promise<void> {
    onProgress?.(10, 'Stopping Docker Engine...');
    await this.stop();

    onProgress?.(30, 'Deleting images, containers and volumes...');
    // Data created inside the user namespace is owned by subordinate IDs; rootlesskit can delete it.
    const rootlesskit = path.join(this.binDir, 'rootlesskit');
    if ((await pathExists(rootlesskit)) && (await pathExists(this.dataRoot))) {
      await runCommand(rootlesskit, ['rm', '-rf', this.dataRoot], { timeoutMs: 10 * 60_000 }).catch(err => {
        logger.warn({ err }, '[RootlessEngineDriver] rootlesskit rm failed.');
      });
    }
    onProgress?.(80, 'Deleting engine files...');
    await rm(this.engineDir, { recursive: true, force: true });
    await rm(this.runtimeDir, { recursive: true, force: true }).catch(() => undefined);
    onProgress?.(100, 'Built-in engine removed.');
  }

  async reclaimMemory(): Promise<void> {
    // Native engine: memory is returned to the host as soon as containers stop.
  }

  private async readPid(): Promise<number | null> {
    const raw = await readFile(this.pidPath, 'utf8').catch(() => '');
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  }

  private async getOwnedProcessStartTime(pid: number): Promise<string | null> {
    const startTime = await getProcessStartTime(pid);
    if (!startTime) return null;
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    const args = new Set(cmdline.split('\0'));
    const executable = await readlink(`/proc/${pid}/exe`).catch(() => '');
    // /proc resolves symlinks. Match the launcher and its CatBee arguments across binary aliases.
    const binary = path.basename(executable.replace(/ \(deleted\)$/, ''));
    const stateDir = path.join(this.runtimeDir, 'dockerd-rootless');
    if (
      !['rootlesskit', 'docker-rootlesskit'].includes(binary) ||
      !args.has(path.join(this.binDir, 'dockerd-rootless.sh')) ||
      !args.has(`--state-dir=${stateDir}`) ||
      !args.has(`--data-root=${this.dataRoot}`) ||
      (await getProcessStartTime(pid)) !== startTime
    )
      return null;
    return startTime;
  }

  /** Removes leftovers from a crashed engine; never touches a live daemon. */
  private async cleanupStaleState(): Promise<void> {
    const pid = await this.readPid();
    if (pid && (await this.getOwnedProcessStartTime(pid))) {
      return;
    }
    if (await pingDockerEndpoint(this.socket))
      throw new Error('The rootless Docker socket is active without a verified CatBee launcher.');
    await rm(this.pidPath, { force: true });
    await rm(this.socket.path, { force: true });
    await rm(path.join(this.runtimeDir, 'docker.pid'), { force: true });
    await rm(path.join(this.runtimeDir, 'dockerd-rootless'), { recursive: true, force: true });
  }
}

async function getProcessStartTime(pid: number): Promise<string | null> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  // The executable name can contain spaces and parentheses. Field 22 is the process start time.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return fields[0] === 'Z' || fields[2] !== String(pid) ? null : fields[19] || null;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    // Detached child leads its own process group: signal rootlesskit, dockerd and containerd together.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

async function readSysctl(file: string): Promise<string | null> {
  return await readFile(file, 'utf8')
    .then(v => v.trim())
    .catch(() => null);
}

async function findBinary(name: string): Promise<boolean> {
  if (await commandExists(name)) return true;
  for (const dir of SBIN_PATHS) {
    if (await pathExists(path.join(dir, name))) return true;
  }
  return false;
}

async function resolveDockerVersion(arch: string): Promise<string> {
  try {
    const response = await fetchEngineResource(`https://download.docker.com/linux/static/stable/${arch}/`, {
      signal: AbortSignal.timeout(10_000)
    });
    if (response.ok) {
      const listing = await response.text();
      const versions = [...listing.matchAll(/docker-rootless-extras-(\d+)\.(\d+)\.(\d+)\.tgz/g)].map(m => [
        Number(m[1]),
        Number(m[2]),
        Number(m[3])
      ]);
      versions.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
      if (versions[0]) {
        return versions[0].join('.');
      }
    }
  } catch (err) {
    logger.warn({ err }, '[RootlessEngineDriver] Could not resolve latest Docker release; using pinned version.');
  }
  return FALLBACK_DOCKER_VERSION;
}
