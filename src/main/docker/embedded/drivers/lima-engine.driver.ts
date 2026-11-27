import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import jsyaml from 'js-yaml';
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
  fetchEngineResource,
  ensureHostDockerCli,
  extractArchive,
  getDockerServerVersion,
  hostArch,
  pathExists,
  pingDockerEndpoint,
  readEngineManifest,
  runCommand,
  sameJson,
  updateEngineManifest,
  waitForDockerEndpoint,
  writeEngineManifest,
  type RunResult
} from '../engine-utils';

const FALLBACK_LIMA_VERSION = '2.3.0';
const DOCKER_ROOTFUL_TEMPLATE = 'template:docker-rootful';
const DAEMON_CONFIG_PATH = '/etc/docker/daemon.json';
const HOST_CA_CERTS_DIR = '/usr/local/share/ca-certificates';
const HOST_CA_CERTS_HASH_PATH = '/etc/catbee-ca-certs.hash';
/** Features the docker-rootful template merges into daemon.json on every boot; keep them so configs stay stable. */
const TEMPLATE_FEATURES = { features: { cdi: true, 'containerd-snapshotter': true } };
/**
 * Lima forwards guest ports to 127.0.0.1 on the Mac by default. For "open" port binding, ports Docker publishes on
 * 0.0.0.0 in the guest are forwarded to 0.0.0.0 on the Mac too. Idempotent: always drops our rule before re-adding it.
 */
const LAN_PORT_RULE = '{"guestIPMustBeZero": true, "guestIP": "0.0.0.0", "hostIP": "0.0.0.0"}';
const WITHOUT_LAN_PORT_RULE = '[(.portForwards // [])[] | select(.hostIP != "0.0.0.0")]';

interface AppliedVmConfig {
  schemaVersion?: number;
  cpus: number;
  memoryGb: number;
  diskGb: number;
  mounts: string[];
  rosetta: boolean;
  lanPorts: boolean;
  networkMode?: 'vznat';
  mountInotify: boolean;
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
  private readonly instanceConfigPath = path.join(this.instanceDir, 'lima.yaml');
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
    return (await pathExists(this.limactl)) && (await pathExists(this.instanceConfigPath));
  }

  async getManifest(): Promise<EngineManifest | null> {
    const manifest = await readEngineManifest();
    return manifest?.backend === 'lima' ? manifest : null;
  }

  async install(onProgress: EngineProgressCallback): Promise<EngineManifest> {
    const prereq = await this.checkPrerequisites();
    if (!prereq.ok) {
      throw new Error(`${prereq.reason ?? 'Unsupported system.'} ${prereq.actionHint ?? ''}`.trim());
    }

    const hasInstanceConfig = await pathExists(this.instanceConfigPath);
    if (!hasInstanceConfig && (await pathExists(this.instanceDir))) {
      throw new Error(
        'The CatBee VM directory exists without its Lima configuration. Restore lima.yaml before reinstalling.'
      );
    }

    const settings = await getEngineSettings();
    const limaVersion = (await pathExists(this.limactl)) ? undefined : await this.installLima(onProgress);
    if (hasInstanceConfig) {
      onProgress(25, 'Recovering the existing CatBee virtual machine...');
      const manifest = await this.startVm(settings, status => onProgress(60, status), limaVersion);
      onProgress(100, 'Installation recovered.');
      return manifest;
    }

    const env = await this.limaEnv(settings);
    onProgress(25, 'Creating the CatBee virtual machine...');
    await mkdir(this.limaHome, { recursive: true });

    const vmConfig = this.desiredVmConfig(settings, null);
    const bootstrapTemplate = await this.hostCaBootstrapTemplate();
    await this.limactlRun(
      [
        'create',
        `--name=${CATBEE_LIMA_INSTANCE}`,
        '--tty=false',
        '--vm-type=vz',
        '--mount-type=virtiofs',
        ...this.vmConfigArgs(vmConfig),
        bootstrapTemplate ? '-' : DOCKER_ROOTFUL_TEMPLATE
      ],
      env,
      { timeoutMs: 5 * 60_000, input: bootstrapTemplate }
    );
    await this.saveAppliedConfig(vmConfig);

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

    const manifest = await this.recordRunningManifest(limaVersion);
    onProgress(100, 'Installation complete.');
    return manifest;
  }

  private async installLima(onProgress: EngineProgressCallback): Promise<string> {
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
    return limaVersion;
  }

  private async recordRunningManifest(limaVersion?: string): Promise<EngineManifest> {
    const previous = await this.getManifest();
    const manifest: EngineManifest = {
      schemaVersion: 2,
      backend: 'lima',
      platform: 'darwin',
      architecture: hostArch(),
      distribution: 'ubuntu',
      installedAt: new Date().toISOString(),
      ...previous,
      ...(limaVersion ? { components: { ...previous?.components, lima: limaVersion } } : {}),
      engineVersion: (await getDockerServerVersion(this.socket)) ?? previous?.engineVersion ?? 'unknown',
      endpoint: { type: 'unix', address: this.socket.path },
      state: 'running',
      updatedAt: new Date().toISOString()
    };
    await writeEngineManifest(manifest);
    return manifest;
  }

  async buildDaemonConfig(settings: EngineSettings): Promise<Record<string, unknown>> {
    // dockerd is socket-activated by systemd (-H fd://), so daemon.json must not define hosts.
    // MTU is clamped to 1350 so container traffic passes cleanly through corporate VPN tunnels (e.g. utun interfaces).
    return buildDaemonConfig(settings, {
      daemonProxy: resolveDaemonProxy(settings, await detectSystemProxy()),
      extra: { ...TEMPLATE_FEATURES, mtu: 1350 }
    });
  }

  async start(settings: EngineSettings, onStatus?: (status: string) => void): Promise<DockerConnection> {
    await this.startVm(settings, onStatus);
    return this.socket;
  }

  private async startVm(
    settings: EngineSettings,
    onStatus?: (status: string) => void,
    limaVersion?: string
  ): Promise<EngineManifest> {
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

    return await this.recordRunningManifest(limaVersion);
  }

  async stop(): Promise<void> {
    const env = await this.limaEnv();
    if (!(await pathExists(this.limactl))) {
      if (await pathExists(this.instanceDir)) {
        throw new Error(
          'Lima is missing. Restore the built-in engine installation before stopping or removing its VM.'
        );
      }
      return;
    }
    const instance = await this.getInstance(env);
    if (!instance || instance.status === 'Stopped') return;
    try {
      await this.limactlRun(['stop', CATBEE_LIMA_INSTANCE], env, { timeoutMs: 120_000 });
    } catch (err) {
      logger.warn({ err }, '[LimaEngineDriver] Graceful stop failed; forcing.');
      await this.limactlRun(['stop', '--force', CATBEE_LIMA_INSTANCE], env);
    }
    const remaining = await this.getInstance(env);
    if (remaining && remaining.status !== 'Stopped') throw new Error('The CatBee VM did not stop.');
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
    onProgress?.(10, 'Stopping the CatBee VM...');
    await this.stop();
    if (await pathExists(this.instanceDir)) {
      const env = await this.limaEnv();
      onProgress?.(40, 'Deleting the CatBee VM and its disk...');
      await this.limactlRun(['delete', '--force', CATBEE_LIMA_INSTANCE], env);
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

  /** Writes daemon.json, MTU, swap, DNS and CA certs inside the guest, restarting dockerd only when config changed. */
  private async applyGuestConfiguration(settings: EngineSettings, onStatus?: (status: string) => void): Promise<void> {
    const env = await this.limaEnv(settings);
    const caCertsUpdated = await this.syncHostCaCertificates(env, onStatus);
    const dockerCertsUpdated = await this.syncHostDockerCerts(env);
    const certsUpdated = caCertsUpdated || dockerCertsUpdated;
    const desired = `${JSON.stringify(await this.buildDaemonConfig(settings), null, 2)}\n`;
    const current = await this.guestShell(['cat', DAEMON_CONFIG_PATH], env)
      .then(r => r.stdout)
      .catch(() => '');

    if (!sameJson(current, desired) || certsUpdated) {
      onStatus?.('Applying Docker Engine configuration...');
      await this.guestShell(['tee', DAEMON_CONFIG_PATH], env, desired);
      await this.guestShell(['systemctl', 'restart', 'docker'], env, undefined, 120_000);
      await waitForDockerEndpoint(this.socket, 90_000);
    }

    // Ensure systemd-resolved treats .local as unicast DNS with DNSSEC disabled,
    // without hardcoding static IP addresses or leaking queries to public fallback resolvers.
    // Configure and restart systemd-resolved BEFORE applying per-interface routing domains,
    // so restarting the service does not reset dynamic resolvectl settings.
    const resolvedDropIn = `[Resolve]\nMulticastDNS=no\nDNSSEC=no\nFallbackDNS=\n`;
    const resolvedPath = '/etc/systemd/resolved.conf.d/disable-mdns.conf';
    const currentResolved = await this.guestShell(['cat', resolvedPath], env)
      .then(r => r.stdout)
      .catch(() => '');

    if (currentResolved.trim() !== resolvedDropIn.trim()) {
      await this.guestShell(['mkdir', '-p', '/etc/systemd/resolved.conf.d'], env).catch(err => {
        logger.warn({ err }, '[LimaEngineDriver] Could not create resolved.conf.d directory.');
      });
      await this.guestShell(['tee', resolvedPath], env, resolvedDropIn).catch(err => {
        logger.warn({ err }, '[LimaEngineDriver] Could not write resolved drop-in configuration.');
      });
      await this.guestShell(['systemctl', 'restart', 'systemd-resolved'], env).catch(err => {
        logger.warn({ err }, '[LimaEngineDriver] Could not restart systemd-resolved.');
      });
    }

    // Configure MTU 1350 and route ~local specifically on the primary guest uplink interface.
    // Clamping MTU to 1350 allows traffic to traverse corporate VPN tunnels (e.g. utun interfaces)
    // without packet drops during TLS handshakes. Targeting exclusively the primary uplink avoids
    // multi-interface DNS contention and secondary slirp forwarder timeouts.
    // A dedicated helper script and oneshot service persist the MTU cleanly without shadowing netplan/systemd-networkd configs.
    const networkScript = `set -e
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

cat << 'EOF' > "$tmpdir/catbee-set-uplink-mtu"
#!/bin/sh
set -eu

for attempt in 1 2 3 4 5 6 7 8 9 10; do
  uplink=$(
    ip route show default 2>/dev/null |
      awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }'
  )

  if [ -n "$uplink" ]; then
    if ip link set dev "$uplink" mtu 1350 2>/dev/null; then
      exit 0
    fi
  fi

  sleep 2
done

echo "CatBee: Unable to configure uplink MTU after 10 attempts." >&2
exit 1
EOF

if ! cmp -s "$tmpdir/catbee-set-uplink-mtu" /usr/local/sbin/catbee-set-uplink-mtu 2>/dev/null; then
  install -m 755 "$tmpdir/catbee-set-uplink-mtu" /usr/local/sbin/catbee-set-uplink-mtu
else
  chmod 755 /usr/local/sbin/catbee-set-uplink-mtu 2>/dev/null || true
fi

if ! /usr/local/sbin/catbee-set-uplink-mtu; then
  echo "[CatBee] Warning: Failed to configure uplink MTU after 10 attempts." >&2
fi

uplink=$(
  ip route show default 2>/dev/null |
    awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }'
)
if [ -n "$uplink" ]; then
  resolvectl domain "$uplink" "~local" 2>/dev/null || true
  for iface in $(ip -o link show up | awk -F': ' '{print $2}'); do
    if [ "$iface" != "$uplink" ] && [ "$iface" != "lo" ]; then
      resolvectl domain "$iface" "" 2>/dev/null || true
    fi
  done
fi

# Clean up any legacy 10-catbee.network file to avoid shadowing cloud-init netplan configs
rm -f /etc/systemd/network/10-catbee.network 2>/dev/null || true

# Persist MTU 1350 on boot via a dedicated systemd oneshot service after network is ready
cat << 'EOF' > "$tmpdir/catbee-mtu.service"
[Unit]
Description=CatBee Uplink MTU Clamping
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/catbee-set-uplink-mtu
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

if ! cmp -s "$tmpdir/catbee-mtu.service" /etc/systemd/system/catbee-mtu.service 2>/dev/null; then
  install -m 644 "$tmpdir/catbee-mtu.service" /etc/systemd/system/catbee-mtu.service
  systemctl daemon-reload
fi

if ! systemctl is-enabled --quiet catbee-mtu.service 2>/dev/null; then
  systemctl enable catbee-mtu.service >/dev/null 2>&1 || true
fi
`;
    await this.guestShell(['sh', '-c', networkScript], env).catch(err => {
      logger.warn({ err }, '[LimaEngineDriver] Could not apply network MTU and DNS routing domains.');
    });

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

  /**
   * Synchronizes host Docker certificates (~/.docker/certs.d) into guest (/etc/docker/certs.d).
   * Returns true if certificates were added, updated, or removed, requiring a dockerd restart.
   * If the host directory is mounted into the VM via virtiofs/9p, creates a live symlink.
   * If the directory is not mounted (e.g. custom file sharing paths exclude $HOME or directory
   * was created after VM startup), falls back to copying the certificate files directly.
   */
  private async syncHostDockerCerts(env: NodeJS.ProcessEnv): Promise<boolean> {
    const hostCertsDir = path.join(os.homedir(), '.docker', 'certs.d');
    const marker = '/etc/docker/.catbee-certs-d-link';
    const copyMarker = '/etc/docker/.catbee-certs-d-copied';
    const hashMarker = '/etc/docker/.catbee-certs-d.hash';

    if (!existsSync(hostCertsDir)) {
      // If host certs directory does not exist or was deleted, clean up any CatBee-managed symlink or copy
      const cleanupScript = `set -e
marker="${marker}"
copy_marker="${copyMarker}"
hash_marker="${hashMarker}"

if [ -L /etc/docker/certs.d ]; then
  marker_target=$(cat "$marker" 2>/dev/null || echo "")
  current=$(readlink /etc/docker/certs.d 2>/dev/null || echo "")
  if [ -n "$marker_target" ] && [ "$current" = "$marker_target" ]; then
    rm -f /etc/docker/certs.d "$marker" "$hash_marker"
    echo "REMOVED"
    exit 0
  fi
elif [ -d /etc/docker/certs.d ] && [ -f "$copy_marker" ]; then
  rm -rf /etc/docker/certs.d "$copy_marker" "$hash_marker"
  echo "REMOVED"
  exit 0
fi
echo "NONE"
`;
      const res = await this.guestShell(['sh', '-c', cleanupScript], env).catch(() => ({ stdout: 'NONE' }));
      return res.stdout.trim() === 'REMOVED';
    }

    try {
      const linkScript = `set -e
expected="$1"
marker="${marker}"
copy_marker="${copyMarker}"
hash_marker="${hashMarker}"

fstype=$(findmnt -T "$expected" -n -o FSTYPE 2>/dev/null || echo "")
if [ "$fstype" = "virtiofs" ] || [ "$fstype" = "9p" ]; then
  if [ -d "$expected" ]; then
    mkdir -p /etc/docker
    if [ -d /etc/docker/certs.d ] && [ ! -L /etc/docker/certs.d ] && [ -f "$copy_marker" ]; then
      rm -rf /etc/docker/certs.d "$copy_marker" "$hash_marker"
    fi
    marker_target=$(cat "$marker" 2>/dev/null || echo "")
    if [ -L /etc/docker/certs.d ]; then
      current=$(readlink /etc/docker/certs.d 2>/dev/null || echo "")
      if [ -n "$marker_target" ] && [ "$current" = "$marker_target" ]; then
        if [ "$current" = "$expected" ]; then
          echo "UNCHANGED"
          exit 0
        else
          rm -f /etc/docker/certs.d
          ln -s "$expected" /etc/docker/certs.d
          echo "$expected" > "$marker"
          echo "UPDATED"
          exit 0
        fi
      else
        echo "PRESERVED"
        exit 0
      fi
    elif [ ! -e /etc/docker/certs.d ]; then
      ln -s "$expected" /etc/docker/certs.d
      echo "$expected" > "$marker"
      echo "UPDATED"
      exit 0
    else
      echo "PRESERVED"
      exit 0
    fi
  fi
fi
echo "NOT_MOUNTED"
`;
      const { stdout } = await this.guestShell(['sh', '-c', linkScript, '_', hostCertsDir], env);
      const linkStatus = stdout.trim();
      if (linkStatus === 'UPDATED') return true;
      if (linkStatus === 'UNCHANGED' || linkStatus === 'PRESERVED') return false;

      // Fallback: directory is not mounted inside the VM. Reconcile files via staging directory.
      const certFiles = await collectCertFiles(hostCertsDir);
      if (certFiles.length === 0) {
        // If host directory has no certificate files, clean up any previous CatBee copy
        const emptyCleanScript = `set -e
copy_marker="${copyMarker}"
hash_marker="${hashMarker}"

if [ -d /etc/docker/certs.d ] && [ -f "$copy_marker" ]; then
  rm -rf /etc/docker/certs.d "$copy_marker" "$hash_marker"
  echo "REMOVED"
  exit 0
fi
echo "NONE"
`;
        const { stdout: cleanOut } = await this.guestShell(['sh', '-c', emptyCleanScript], env);
        return cleanOut.trim() === 'REMOVED';
      }

      // Hash content + relPath to detect modifications
      const payload = certFiles.map(f => `${f.base64}:${f.relPath}`).join('\n');
      const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');

      // Validate cache: only skip if directory exists, is CatBee-managed, and hash matches
      const checkScript = `[ -d /etc/docker/certs.d ] && [ -f "${copyMarker}" ] && [ "$(cat "${hashMarker}" 2>/dev/null)" = "$1" ] && echo "VALID" || echo "STALE"`;
      const { stdout: checkOut } = await this.guestShell(['sh', '-c', checkScript, '_', payloadHash], env);
      if (checkOut.trim() === 'VALID') {
        return false;
      }

      const copyScript = `set -e
marker="${marker}"
copy_marker="${copyMarker}"
hash_marker="${hashMarker}"

if [ -L /etc/docker/certs.d ]; then
  marker_target=$(cat "$marker" 2>/dev/null || echo "")
  current=$(readlink /etc/docker/certs.d 2>/dev/null || echo "")
  if [ -n "$marker_target" ] && [ "$current" = "$marker_target" ]; then
    rm -f /etc/docker/certs.d "$marker"
  fi
fi

# Do not overwrite user-managed directories or symlinks
if [ -e /etc/docker/certs.d ] && [ ! -f "$copy_marker" ]; then
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
echo "copied" > "$copy_marker"
echo "$1" > "$hash_marker"
echo "UPDATED"
`;
      const copyRes = await this.guestShell(['sh', '-c', copyScript, '_', payloadHash], env, payload);
      const isUpdated = copyRes.stdout.trim() === 'UPDATED';
      if (isUpdated) {
        logger.debug(
          `[LimaEngineDriver] Reconciled ${certFiles.length} host Docker certificate files via copy fallback.`
        );
      }
      return isUpdated;
    } catch (err) {
      logger.warn({ err }, '[LimaEngineDriver] Could not synchronize Docker certs directory.');
      return false;
    }
  }

  private async readHostCaCertificates(): Promise<string[]> {
    const { stdout } = await runCommand('/usr/bin/security', ['find-certificate', '-a', '-p']);
    const blocks = stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    if (!blocks.length) return [];

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'catbee-ca-'));
    try {
      const tmpCertPath = path.join(tmpDir, 'cert.pem');
      const trustedCaPems = new Set<string>();
      for (const block of blocks) {
        let pem: string;
        try {
          const cert = new crypto.X509Certificate(block);
          if (!cert.ca) continue;
          pem = cert.toString().trim();
        } catch {
          continue;
        }
        if (trustedCaPems.has(pem)) continue;

        await writeFile(tmpCertPath, pem, 'utf8');
        try {
          const { stdout: chain } = await runCommand('/usr/bin/security', [
            'verify-cert',
            `-c${tmpCertPath}`,
            '-p',
            'ssl',
            '-L',
            '-l',
            '-Roffline',
            '-P'
          ]);
          const chainCerts = chain.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
          // macOS must terminate the TLS trust chain at this certificate before we install it as a guest anchor.
          if (chainCerts?.length === 1 && new crypto.X509Certificate(chainCerts[0]).toString().trim() === pem) {
            trustedCaPems.add(pem);
          }
        } catch {
          continue;
        }
      }
      return [...trustedCaPems].sort((a, b) => a.localeCompare(b, 'en'));
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async hostCaBootstrapTemplate(): Promise<string | undefined> {
    try {
      const certsPayload = (await this.readHostCaCertificates()).join('\n');
      if (!certsPayload) return undefined;

      // Install into the same managed store used by live sync. The hash prevents re-seeding old trust on later boots.
      const script = `if [ ! -f "${HOST_CA_CERTS_HASH_PATH}" ]; then
(
${hostCaInstallScript(hostCaHash(certsPayload))}
) <<'CATBEE_CA_CERTIFICATES'
${certsPayload}
CATBEE_CA_CERTIFICATES
fi
`;
      return jsyaml.dump({
        base: [DOCKER_ROOTFUL_TEMPLATE],
        provision: [{ mode: 'boot', script }]
      });
    } catch (err) {
      logger.warn({ err }, '[LimaEngineDriver] Could not read host CA certificates for first boot.');
      return undefined;
    }
  }

  /** Keeps the guest CA store in sync with the CA certificates trusted by macOS. */
  private async syncHostCaCertificates(env: NodeJS.ProcessEnv, onStatus?: (status: string) => void): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    try {
      const trustedCaPems = await this.readHostCaCertificates();
      const certsPayload = trustedCaPems.join('\n');
      const certsHash = hostCaHash(certsPayload);
      const currentHash = await this.guestShell(['cat', HOST_CA_CERTS_HASH_PATH], env)
        .then(r => r.stdout.trim())
        .catch(() => '');

      if (currentHash === certsHash) return false;

      onStatus?.(
        certsPayload
          ? 'Synchronizing trusted host CA certificates into CatBee VM...'
          : 'Cleaning up stale host CA certificates in CatBee VM...'
      );
      await this.guestShell(['sh', '-c', hostCaInstallScript(certsHash)], env, certsPayload);
      logger.debug(
        `[LimaEngineDriver] Synchronized ${trustedCaPems.length} trusted host CA certificates into CatBee VM.`
      );
      return true;
    } catch (err) {
      logger.warn({ err }, '[LimaEngineDriver] Could not synchronize host CA certificates.');
      return false;
    }
  }

  private desiredVmConfig(settings: EngineSettings, applied: AppliedVmConfig | null): AppliedVmConfig {
    const { cpus, memoryGb, diskGb, rosetta } = settings.resources;
    if (applied && diskGb < applied.diskGb) {
      logger.warn(
        `[LimaEngineDriver] Disk cannot shrink (${applied.diskGb} GiB -> ${diskGb} GiB); keeping current size.`
      );
    }
    return {
      schemaVersion: 2,
      cpus,
      memoryGb,
      diskGb: applied ? Math.max(applied.diskGb, diskGb) : diskGb,
      mounts: normalizeMounts(settings.fileSharingPaths),
      rosetta: process.arch === 'arm64' && rosetta,
      lanPorts: settings.network.portBindingBehavior === 'open',
      networkMode: 'vznat',
      mountInotify: settings.forwardHostFileChanges
    };
  }

  private vmConfigArgs(config: AppliedVmConfig): string[] {
    const args = [
      `--cpus=${config.cpus}`,
      `--memory=${config.memoryGb}`,
      `--disk=${config.diskGb}`,
      `--mount-inotify=${config.mountInotify}`
    ];
    for (const mount of config.mounts) {
      args.push(`--mount-only=${mount}:w`);
    }
    if (process.arch === 'arm64') {
      args.push(`--rosetta=${config.rosetta}`);
    }
    const lanPortsSuffix = config.lanPorts ? ` + [${LAN_PORT_RULE}]` : '';
    args.push(`--set=.portForwards = ${WITHOUT_LAN_PORT_RULE}${lanPortsSuffix}`);
    if (config.networkMode === 'vznat') {
      args.push('--set=.networks = [{"interface": "vznat", "vzNAT": true}]');
    }
    return args;
  }

  private async readAppliedConfig(): Promise<AppliedVmConfig | null> {
    try {
      const config = JSON.parse(await readFile(this.appliedConfigPath, 'utf8')) as AppliedVmConfig;
      // Existing snapshots omit this setting. Treat it as off to avoid an unnecessary VM restart.
      return { ...config, mountInotify: config.mountInotify === true };
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
    const { stdout } = await this.limactlRun(['list', '--json', CATBEE_LIMA_INSTANCE], env, { timeoutMs: 20_000 });
    const line = stdout.split(/\r?\n/).find(l => l.trim().startsWith('{'));
    return line ? (JSON.parse(line) as LimaInstanceInfo) : null;
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
  const hostCertsDir = path.join(os.homedir(), '.docker', 'certs.d');
  const defaults = [os.homedir(), '/var/folders'];
  const userPaths = paths.length ? paths : defaults;
  const candidatesList = [...userPaths];
  if (paths.length && existsSync(hostCertsDir)) {
    candidatesList.push(hostCertsDir);
  }
  const candidates = candidatesList
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

async function collectCertFiles(dir: string, baseDir = dir): Promise<Array<{ relPath: string; base64: string }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: Array<{ relPath: string; base64: string }> = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectCertFiles(full, baseDir)));
    } else if (entry.isFile()) {
      results.push({
        relPath: path.relative(baseDir, full),
        base64: await readFile(full, 'base64')
      });
    }
  }
  return results;
}

function hostCaHash(payload: string): string {
  return payload ? crypto.createHash('sha256').update(payload).digest('hex') : 'empty';
}

function hostCaInstallScript(hash: string): string {
  return `set -e
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
awk -v dir="$tmpdir" '
  /^-----BEGIN CERTIFICATE-----$/ {
    if (file) close(file)
    file = dir "/catbee-host-" ++count ".crt"
  }
  file && NF { print > file }
'
mkdir -p "${HOST_CA_CERTS_DIR}"
rm -f "${HOST_CA_CERTS_DIR}"/catbee-host-*.crt
for cert in "$tmpdir"/catbee-host-*.crt; do
  [ -f "$cert" ] || continue
  mv "$cert" "${HOST_CA_CERTS_DIR}/"
done
update-ca-certificates --fresh
echo "${hash}" > "${HOST_CA_CERTS_HASH_PATH}"
`;
}

/** Extracts the human message from Lima's logrus output (time=... level=info msg="..."). */
function limaLogMessage(line: string): string {
  const match = /msg="((?:[^"\\]|\\.)*)"/.exec(line);
  const message = (match ? match[1].replaceAll(String.raw`\"`, '"') : line).trim();
  return message.length > 140 ? `${message.slice(0, 137)}...` : message;
}

async function resolveLimaVersion(): Promise<string> {
  try {
    const response = await fetchEngineResource('https://api.github.com/repos/lima-vm/lima/releases/latest', {
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
