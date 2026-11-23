import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import { getEngineSettings, type EngineSettings } from '../engine-settings';
import { buildDaemonConfig, proxyToEnv, resolveDaemonProxy } from '../daemon-config';
import { detectSystemProxy } from '../system-proxy';
import { CATBEE_LIMA_INSTANCE, getEngineDownloadsDir, getEngineRootDir, getLimaHomeDir } from '../engine-paths';
import {
  describeDownload,
  downloadFile,
  ensureHostDockerCli,
  extractArchive,
  getDockerServerVersion,
  hostArch,
  pathExists,
  pingDockerEndpoint,
  readEngineManifest,
  runCommand,
  updateEngineManifest,
  waitForDockerEndpoint,
  writeEngineManifest,
  type RunResult
} from '../engine-utils';

const FALLBACK_LIMA_VERSION = '2.3.0';
const DAEMON_CONFIG_PATH = '/etc/docker/daemon.json';
/** Features the docker-rootful template merges into daemon.json on every boot; keep them so configs stay stable. */
const TEMPLATE_FEATURES = { features: { cdi: true, 'containerd-snapshotter': true } };
/**
 * Lima forwards guest ports to 127.0.0.1 on the Mac by default. For "open" port binding, ports Docker publishes on
 * 0.0.0.0 in the guest are forwarded to 0.0.0.0 on the Mac too. Idempotent: always drops our rule before re-adding it.
 */
const LAN_PORT_RULE = '{"guestIPMustBeZero": true, "guestIP": "0.0.0.0", "hostIP": "0.0.0.0"}';
const WITHOUT_LAN_PORT_RULE = '[(.portForwards // [])[] | select(.hostIP != "0.0.0.0")]';

interface AppliedVmConfig {
  cpus: number;
  memoryGb: number;
  diskGb: number;
  mounts: string[];
  rosetta: boolean;
  lanPorts: boolean;
}

interface LimaInstanceInfo {
  name: string;
  status: string;
  dir?: string;
}

/** macOS engine: a Lima-managed Ubuntu VM using Apple Virtualization.framework (vz) with virtiofs mounts. */
export class LimaEngineDriver implements PlatformEngineDriver {
  readonly platform: NodeJS.Platform = 'darwin';
  private readonly engineDir = getEngineRootDir();
  private readonly limaDistDir = path.join(this.engineDir, 'lima');
  private readonly limactl = path.join(this.limaDistDir, 'bin', 'limactl');
  private readonly limaHome = getLimaHomeDir();
  private readonly instanceDir = path.join(this.limaHome, CATBEE_LIMA_INSTANCE);
  private readonly appliedConfigPath = path.join(this.engineDir, 'lima-vm.json');
  private readonly socket: DockerUnixConnection = {
    type: 'unix',
    path: path.join(this.limaHome, CATBEE_LIMA_INSTANCE, 'sock', 'docker.sock')
  };

  getRunningConnection(): DockerConnection {
    return this.socket;
  }

  getCapabilities(): EngineCapabilities {
    const appleSilicon = process.arch === 'arm64';
    return {
      backend: 'lima',
      backendLabel: 'Lima VM (Apple Virtualization.framework)',
      managesVmResources: true,
      resources: { cpus: true, memory: true, swap: true, disk: true, rosetta: appleSilicon },
      resourcesNote: 'The virtual disk can only grow. Shrinking it requires resetting the engine.',
      fileSharing: true,
      fileSharingNote: 'Only shared directories can be bind-mounted into containers (shared via virtiofs).',
      wslIntegration: false,
      resourceChangesRequireRestart: true,
      // Virtualization.framework never hands freed guest pages back to macOS, so dropping caches saves nothing.
      resourceSaver: false
    };
  }

  getInfo(): EngineInfo {
    return {
      capabilities: this.getCapabilities(),
      engineDir: this.engineDir,
      dataLocation: this.diskImagePath(),
      logsLocation: path.join(this.instanceDir, 'ha.stderr.log'),
      daemonConfigLocation: `${CATBEE_LIMA_INSTANCE}:${DAEMON_CONFIG_PATH}`,
      distribution: 'Ubuntu LTS (Lima)'
    };
  }

  /** Lima 2.x names the VM disk `disk`; 1.x used `diffdisk`. */
  private diskImagePath(): string {
    const legacy = path.join(this.instanceDir, 'diffdisk');
    return existsSync(legacy) ? legacy : path.join(this.instanceDir, 'disk');
  }

  async checkPrerequisites(): Promise<PrerequisiteCheckResult> {
    if (process.platform !== 'darwin') {
      return { ok: false, reason: 'The Lima engine is only supported on macOS.' };
    }
    const darwinMajor = Number(os.release().split('.')[0]);
    if (darwinMajor < 22) {
      return {
        ok: false,
        reason: 'macOS 13 (Ventura) or later is required for the built-in engine.',
        actionHint: 'Update macOS, or switch to an external Docker engine.'
      };
    }
    try {
      const { stdout } = await runCommand('sysctl', ['-n', 'kern.hv_support']);
      if (stdout.trim() !== '1') {
        return {
          ok: false,
          reason: 'Hardware virtualization is not available on this Mac.',
          actionHint: 'If macOS runs inside a VM, enable nested virtualization for it.'
        };
      }
    } catch {
      // sysctl unavailable: let Lima report the actual problem.
    }
    return { ok: true };
  }

  async isInstalled(): Promise<boolean> {
    const manifest = await readEngineManifest();
    if (manifest?.backend !== 'lima' || !manifest.engineVersion || manifest.engineVersion === 'pending first start') {
      return false;
    }
    return (await pathExists(this.limactl)) && (await pathExists(path.join(this.instanceDir, 'lima.yaml')));
  }

  async getManifest(): Promise<EngineManifest | null> {
    return await readEngineManifest();
  }

  async install(onProgress: EngineProgressCallback): Promise<EngineManifest> {
    const prereq = await this.checkPrerequisites();
    if (!prereq.ok) {
      throw new Error(`${prereq.reason ?? 'Unsupported system.'} ${prereq.actionHint ?? ''}`.trim());
    }

    const settings = await getEngineSettings();
    const env = await this.limaEnv(settings);

    onProgress(3, 'Resolving Lima release...');
    const limaVersion = await resolveLimaVersion();
    const limaArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    const archiveName = `lima-${limaVersion}-Darwin-${limaArch}.tar.gz`;
    const archivePath = path.join(getEngineDownloadsDir(), archiveName);
    if (!(await pathExists(archivePath))) {
      await downloadFile(
        `https://github.com/lima-vm/lima/releases/download/v${limaVersion}/${archiveName}`,
        archivePath,
        (fraction, received, total) =>
          onProgress(3 + Math.round(fraction * 17), describeDownload(`Lima ${limaVersion}`, received, total))
      );
    }

    onProgress(22, 'Installing Lima...');
    await rm(this.limaDistDir, { recursive: true, force: true });
    await extractArchive(archivePath, this.limaDistDir);

    onProgress(25, 'Creating the CatBee virtual machine...');
    await mkdir(this.limaHome, { recursive: true });
    if (await pathExists(this.instanceDir)) {
      await this.limactlRun(['delete', '--force', CATBEE_LIMA_INSTANCE], env).catch(() => undefined);
    }

    const vmConfig = this.desiredVmConfig(settings, null);
    await this.limactlRun(
      [
        'create',
        `--name=${CATBEE_LIMA_INSTANCE}`,
        '--tty=false',
        '--vm-type=vz',
        '--mount-type=virtiofs',
        ...this.vmConfigArgs(vmConfig),
        'template:docker-rootful'
      ],
      env,
      { timeoutMs: 5 * 60_000 }
    );
    await this.saveAppliedConfig(vmConfig);

    const manifest: EngineManifest = {
      schemaVersion: 2,
      backend: 'lima',
      engineVersion: 'pending first start',
      components: { lima: limaVersion },
      platform: 'darwin',
      architecture: hostArch(),
      distribution: 'ubuntu',
      installedAt: new Date().toISOString(),
      endpoint: { type: 'unix', address: this.socket.path },
      state: 'stopped'
    };

    // First boot downloads the Ubuntu image and provisions Docker, so do it here with visible progress.
    onProgress(30, 'Booting the VM for the first time (downloads Ubuntu and Docker Engine)...');
    // limactl gives no overall percentage, so creep towards 90% as boot/provisioning log lines arrive.
    let bootLines = 0;
    await this.limactlRun(['start', CATBEE_LIMA_INSTANCE, '--tty=false', '--timeout=20m'], env, {
      timeoutMs: 25 * 60_000,
      onOutput: line => {
        bootLines += 1;
        onProgress(30 + Math.round(60 * (1 - Math.pow(0.97, bootLines))), limaLogMessage(line));
      }
    });
    onProgress(92, 'Waiting for Docker Engine...');
    await waitForDockerEndpoint(this.socket, 120_000);
    await this.applyGuestConfiguration(settings);

    onProgress(95, 'Ensuring standalone host Docker CLI...');
    await ensureHostDockerCli((fraction, stage) => {
      onProgress(95 + Math.round(fraction * 0.04), stage);
    }).catch(err => {
      logger.warn({ err }, '[LimaEngineDriver] Could not download host Docker CLI, continuing with system fallback.');
    });

    const version = (await getDockerServerVersion(this.socket)) ?? 'unknown';
    const finalManifest = { ...manifest, engineVersion: version, state: 'running' as const };
    await writeEngineManifest(finalManifest);
    onProgress(100, 'Installation complete.');
    return finalManifest;
  }

  async buildDaemonConfig(settings: EngineSettings): Promise<Record<string, unknown>> {
    // dockerd is socket-activated by systemd (-H fd://), so daemon.json must not define hosts.
    return buildDaemonConfig(settings, {
      daemonProxy: resolveDaemonProxy(settings, await detectSystemProxy()),
      extra: TEMPLATE_FEATURES
    });
  }

  async start(settings: EngineSettings, onStatus?: (status: string) => void): Promise<DockerConnection> {
    const env = await this.limaEnv(settings);
    const status = (await this.getInstance(env))?.status ?? 'Unknown';
    const applied = await this.readAppliedConfig();
    const desired = this.desiredVmConfig(settings, applied);
    const vmChanged = !applied || JSON.stringify(applied) !== JSON.stringify(desired);

    if (vmChanged) {
      if (status === 'Running') {
        onStatus?.('Stopping the VM to apply resource changes...');
        await this.limactlRun(['stop', CATBEE_LIMA_INSTANCE], env, { timeoutMs: 120_000 });
      }
      onStatus?.('Applying CPU, memory, disk and file sharing settings...');
      await this.limactlRun(['edit', CATBEE_LIMA_INSTANCE, '--tty=false', ...this.vmConfigArgs(desired)], env, {
        timeoutMs: 120_000
      });
      await this.saveAppliedConfig(desired);
    }

    if (status !== 'Running' || vmChanged) {
      onStatus?.('Starting the CatBee VM...');
      await this.limactlRun(['start', CATBEE_LIMA_INSTANCE, '--tty=false', '--timeout=10m'], env, {
        timeoutMs: 12 * 60_000,
        onOutput: line => onStatus?.(limaLogMessage(line))
      });
    }

    onStatus?.('Waiting for Docker Engine...');
    await waitForDockerEndpoint(this.socket, 120_000);
    await this.applyGuestConfiguration(settings, onStatus);

    // Ensure standalone host Docker CLI is available in CatBee bin directory
    void ensureHostDockerCli().catch(err => {
      logger.debug('[LimaEngineDriver] Background host Docker CLI check failed:', err);
    });

    await updateEngineManifest({
      state: 'running',
      engineVersion: (await getDockerServerVersion(this.socket)) ?? (await readEngineManifest())?.engineVersion
    });
    return this.socket;
  }

  async stop(): Promise<void> {
    const env = await this.limaEnv();
    if (!(await pathExists(this.limactl))) return;
    try {
      await this.limactlRun(['stop', CATBEE_LIMA_INSTANCE], env, { timeoutMs: 120_000 });
    } catch (err) {
      logger.warn({ err }, '[LimaEngineDriver] Graceful stop failed; forcing.');
      await this.limactlRun(['stop', '--force', CATBEE_LIMA_INSTANCE], env).catch(() => undefined);
    }
    await updateEngineManifest({ state: 'stopped' });
  }

  async getStatus(): Promise<EngineDriverStatus> {
    if (await pingDockerEndpoint(this.socket)) {
      return 'running';
    }
    if (!(await this.isInstalled())) {
      return 'not-installed';
    }
    const instance = await this.getInstance(await this.limaEnv());
    return instance?.status === 'Broken' ? 'error' : 'stopped';
  }

  async uninstall(onProgress?: EngineProgressCallback): Promise<void> {
    if (await pathExists(this.limactl)) {
      const env = await this.limaEnv();
      onProgress?.(10, 'Stopping the CatBee VM...');
      await this.limactlRun(['stop', '--force', CATBEE_LIMA_INSTANCE], env).catch(() => undefined);
      onProgress?.(40, 'Deleting the CatBee VM and its disk...');
      await this.limactlRun(['delete', '--force', CATBEE_LIMA_INSTANCE], env).catch(err => {
        logger.warn({ err }, '[LimaEngineDriver] limactl delete failed; removing files directly.');
      });
    }
    onProgress?.(75, 'Deleting engine files...');
    await rm(this.limaHome, { recursive: true, force: true });
    await rm(this.engineDir, { recursive: true, force: true });
    onProgress?.(100, 'Built-in engine removed.');
  }

  async reclaimMemory(): Promise<void> {
    await this.guestShell(
      ['sh', '-c', 'sync; echo 3 > /proc/sys/vm/drop_caches; echo 1 > /proc/sys/vm/compact_memory 2>/dev/null; true'],
      await this.limaEnv()
    ).catch(() => undefined);
  }

  /** Writes daemon.json and the swap file inside the guest, restarting dockerd only when the config changed. */
  private async applyGuestConfiguration(settings: EngineSettings, onStatus?: (status: string) => void): Promise<void> {
    const env = await this.limaEnv(settings);
    const desired = `${JSON.stringify(await this.buildDaemonConfig(settings), null, 2)}\n`;
    const current = await this.guestShell(['cat', DAEMON_CONFIG_PATH], env)
      .then(r => r.stdout)
      .catch(() => '');

    if (!sameJson(current, desired)) {
      onStatus?.('Applying Docker Engine configuration...');
      await this.guestShell(['tee', DAEMON_CONFIG_PATH], env, desired);
      await this.guestShell(['systemctl', 'restart', 'docker'], env, undefined, 120_000);
      await waitForDockerEndpoint(this.socket, 90_000);
    }

    const swapMb = Math.round(settings.resources.swapGb * 1024);
    const swapScript = `set -e
want=${swapMb}
have=$(cat /etc/catbee-swap 2>/dev/null || echo none)
if [ "$have" != "$want" ]; then
  swapoff /swapfile 2>/dev/null || true
  rm -f /swapfile
  sed -i '\\|^/swapfile |d' /etc/fstab
  if [ "$want" -gt 0 ]; then
    fallocate -l "\${want}M" /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
  echo "$want" > /etc/catbee-swap
fi
swapon -a 2>/dev/null || true`;
    await this.guestShell(['sh', '-c', swapScript], env, undefined, 120_000).catch(err => {
      logger.warn({ err }, '[LimaEngineDriver] Could not configure swap.');
    });
  }

  private desiredVmConfig(settings: EngineSettings, applied: AppliedVmConfig | null): AppliedVmConfig {
    const { cpus, memoryGb, diskGb, rosetta } = settings.resources;
    if (applied && diskGb < applied.diskGb) {
      logger.warn(
        `[LimaEngineDriver] Disk cannot shrink (${applied.diskGb} GiB -> ${diskGb} GiB); keeping current size.`
      );
    }
    return {
      cpus,
      memoryGb,
      diskGb: applied ? Math.max(applied.diskGb, diskGb) : diskGb,
      mounts: normalizeMounts(settings.fileSharingPaths),
      rosetta: process.arch === 'arm64' && rosetta,
      lanPorts: settings.network.portBindingBehavior === 'open'
    };
  }

  private vmConfigArgs(config: AppliedVmConfig): string[] {
    const args = [`--cpus=${config.cpus}`, `--memory=${config.memoryGb}`, `--disk=${config.diskGb}`];
    for (const mount of config.mounts) {
      args.push(`--mount-only=${mount}:w`);
    }
    if (process.arch === 'arm64') {
      args.push(`--rosetta=${config.rosetta}`);
    }
    const lanPortsSuffix = config.lanPorts ? ` + [${LAN_PORT_RULE}]` : '';
    args.push(`--set=.portForwards = ${WITHOUT_LAN_PORT_RULE}${lanPortsSuffix}`);
    return args;
  }

  private async readAppliedConfig(): Promise<AppliedVmConfig | null> {
    try {
      return JSON.parse(await readFile(this.appliedConfigPath, 'utf8')) as AppliedVmConfig;
    } catch {
      return null;
    }
  }

  private async saveAppliedConfig(config: AppliedVmConfig): Promise<void> {
    await mkdir(path.dirname(this.appliedConfigPath), { recursive: true });
    await writeFile(this.appliedConfigPath, JSON.stringify(config, null, 2), 'utf8');
  }

  private async getInstance(env: NodeJS.ProcessEnv): Promise<LimaInstanceInfo | null> {
    if (!(await pathExists(this.limactl))) return null;
    try {
      const { stdout } = await this.limactlRun(['list', '--json', CATBEE_LIMA_INSTANCE], env, { timeoutMs: 20_000 });
      const line = stdout.split(/\r?\n/).find(l => l.trim().startsWith('{'));
      return line ? (JSON.parse(line) as LimaInstanceInfo) : null;
    } catch {
      return null;
    }
  }

  private async limaEnv(settings?: EngineSettings): Promise<NodeJS.ProcessEnv> {
    const s = settings ?? (await getEngineSettings());
    // eslint-disable-next-line n/no-process-env
    const hostEnv = process.env;
    return {
      ...hostEnv,
      ...proxyToEnv(resolveDaemonProxy(s, await detectSystemProxy())),
      LIMA_HOME: this.limaHome,
      PATH: `${path.join(this.limaDistDir, 'bin')}:${hostEnv.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'}`
    };
  }

  private limactlRun(
    args: string[],
    env: NodeJS.ProcessEnv,
    options: { timeoutMs?: number; input?: string; onOutput?: (line: string) => void } = {}
  ): Promise<RunResult> {
    return runCommand(this.limactl, args, { env, timeoutMs: options.timeoutMs ?? 60_000, ...options });
  }

  private guestShell(
    command: string[],
    env: NodeJS.ProcessEnv,
    input?: string,
    timeoutMs = 60_000
  ): Promise<RunResult> {
    return this.limactlRun(['shell', '--workdir=/', CATBEE_LIMA_INSTANCE, 'sudo', ...command], env, {
      input,
      timeoutMs
    });
  }
}

/** Removes duplicates and paths nested inside other shared paths (Lima rejects overlapping mounts). */
function normalizeMounts(paths: string[]): string[] {
  const candidates = (paths.length ? paths : [os.homedir(), '/var/folders'])
    .map(p => {
      const expanded = p.startsWith('~/') || p === '~' ? path.join(os.homedir(), p.slice(1)) : p;
      let resolved = path.resolve(expanded);
      while (resolved.length > 1 && resolved.endsWith('/')) {
        resolved = resolved.slice(0, -1);
      }
      return resolved || '/';
    })
    .sort((a, b) => a.length - b.length);
  const result: string[] = [];
  for (const candidate of candidates) {
    if (!result.some(parent => candidate === parent || candidate.startsWith(`${parent}/`) || parent === '/')) {
      result.push(candidate);
    }
  }
  return result.sort((a, b) => a.localeCompare(b));
}

function sameJson(a: string, b: string): boolean {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
}

/** Extracts the human message from Lima's logrus output (time=... level=info msg="..."). */
function limaLogMessage(line: string): string {
  const match = /msg="((?:[^"\\]|\\.)*)"/.exec(line);
  const message = (match ? match[1].replaceAll(String.raw`\"`, '"') : line).trim();
  return message.length > 140 ? `${message.slice(0, 137)}...` : message;
}

async function resolveLimaVersion(): Promise<string> {
  try {
    const response = await fetch('https://api.github.com/repos/lima-vm/lima/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000)
    });
    if (response.ok) {
      const { tag_name: tag } = (await response.json()) as { tag_name?: string };
      const version = tag?.replace(/^v/, '');
      // The docker-rootful template syntax we rely on needs Lima 2.x.
      if (version && /^\d+\.\d+\.\d+$/.test(version) && Number(version.split('.')[0]) >= 2) {
        return version;
      }
    }
  } catch (err) {
    logger.warn({ err }, '[LimaEngineDriver] Could not resolve latest Lima release; using pinned version.');
  }
  return FALLBACK_LIMA_VERSION;
}
