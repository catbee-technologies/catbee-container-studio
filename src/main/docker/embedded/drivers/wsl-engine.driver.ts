import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../../../logger';
import { setupCatBeeContext } from '../../context/docker-context.manager';
import type { DockerConnection } from '../../types/connection.types';
import type { EngineManifest } from '../types/manifest.types';
import type { PlatformEngineDriver, PrerequisiteCheckResult } from '../types/engine.interface';
import { WindowsPipeRelay } from './windows-pipe-relay';
import { getEngineSettings, type EngineSettings } from '../engine-settings';

const execFileAsync = promisify(execFile);

const DISTRO_NAME = 'catbee-container-engine';
const DOCKER_TCP_PORT = 23750;
const ALPINE_ROOTFS_URL =
  'https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-minirootfs-3.20.3-x86_64.tar.gz';

export class WslEngineDriver implements PlatformEngineDriver {
  readonly platform: NodeJS.Platform = 'win32';
  private readonly engineDir: string;
  private readonly wslDir: string;
  private readonly manifestPath: string;

  constructor(customEngineDir?: string) {
    // eslint-disable-next-line n/no-process-env
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    this.engineDir = customEngineDir ?? path.join(localAppData, 'CatBee', 'engine');
    this.wslDir = path.join(this.engineDir, 'wsl');
    this.manifestPath = path.join(this.engineDir, 'manifest.json');
  }

  async checkPrerequisites(): Promise<PrerequisiteCheckResult> {
    logger.debug('[WslEngineDriver] Checking WSL prerequisites.');

    if (process.platform !== 'win32') {
      return {
        ok: false,
        reason: 'WSL2 engine driver is only supported on Windows.',
        actionHint: 'Use the platform-native container engine for your operating system.'
      };
    }

    try {
      const { stdout } = await execFileAsync('wsl.exe', ['--status'], {
        encoding: 'utf8',
        windowsHide: true
      });

      logger.debug(`[WslEngineDriver] wsl --status output: ${stdout.slice(0, 100)}`);
      return { ok: true };
    } catch (error) {
      logger.warn({ err: error }, '[WslEngineDriver] wsl.exe --status check failed.');

      // Check if wsl.exe exists in system32
      try {
        await execFileAsync('where', ['wsl.exe'], { encoding: 'utf8', windowsHide: true });
        return {
          ok: false,
          reason: 'WSL is available, but the WSL2 Linux kernel may not be installed.',
          actionHint: 'Run "wsl --update" in PowerShell to ensure the WSL2 kernel is up to date.'
        };
      } catch {
        return {
          ok: false,
          reason: 'Windows Subsystem for Linux (WSL2) is not installed.',
          actionHint:
            'Open PowerShell as Administrator and run "wsl --install --no-distribution", then restart your computer.'
        };
      }
    }
  }

  async isInstalled(): Promise<boolean> {
    try {
      const manifest = await this.getManifest();
      if (!manifest) {
        return false;
      }

      const distros = await this.listWslDistros();
      const distroExists = distros.includes(DISTRO_NAME.toLowerCase());
      logger.debug(`[WslEngineDriver] Distro "${DISTRO_NAME}" registered: ${distroExists}`);
      return distroExists;
    } catch (error) {
      logger.debug(
        `[WslEngineDriver] isInstalled check error: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  async getManifest(): Promise<EngineManifest | null> {
    try {
      await access(this.manifestPath);
      const content = await readFile(this.manifestPath, 'utf8');
      return JSON.parse(content) as EngineManifest;
    } catch {
      return null;
    }
  }

  async install(onProgress: (progress: number, stage: string) => void): Promise<EngineManifest> {
    logger.info('[WslEngineDriver] Beginning embedded engine installation.');

    const prereq = await this.checkPrerequisites();
    if (!prereq.ok) {
      throw new Error(
        `WSL2 prerequisite check failed: ${prereq.reason ?? 'Unknown reason'}. ${prereq.actionHint ?? ''}`
      );
    }

    onProgress(5, 'Preparing engine directory...');
    await mkdir(this.wslDir, { recursive: true });

    // 1. Download Alpine minirootfs if not already downloaded
    const rootfsTarPath = path.join(this.engineDir, 'alpine-minirootfs.tar.gz');
    let needsDownload = true;
    try {
      await access(rootfsTarPath);
      needsDownload = false;
      logger.info('[WslEngineDriver] Rootfs tarball already cached locally.');
    } catch {
      // Need download
    }

    if (needsDownload) {
      onProgress(15, 'Downloading lightweight container rootfs...');
      logger.info(`[WslEngineDriver] Downloading Alpine rootfs from: ${ALPINE_ROOTFS_URL}`);

      const response = await fetch(ALPINE_ROOTFS_URL);
      if (!response.ok) {
        throw new Error(`Failed to download rootfs: ${response.status} ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      await writeFile(rootfsTarPath, Buffer.from(arrayBuffer));
      logger.info(`[WslEngineDriver] Downloaded rootfs (${arrayBuffer.byteLength} bytes).`);
    }

    // 2. Unregister existing distro if partially present
    onProgress(35, 'Importing container distribution into WSL2...');
    const distros = await this.listWslDistros();
    if (distros.includes(DISTRO_NAME.toLowerCase())) {
      logger.info(`[WslEngineDriver] Unregistering previous distro instance: ${DISTRO_NAME}`);
      try {
        await execFileAsync('wsl.exe', ['--unregister', DISTRO_NAME], {
          encoding: 'utf8',
          windowsHide: true
        });
      } catch (err) {
        logger.warn({ err }, '[WslEngineDriver] Failed to unregister old distro, continuing.');
      }
    }

    // 3. Import rootfs into WSL2
    logger.info(`[WslEngineDriver] Importing ${DISTRO_NAME} into ${this.wslDir}`);
    await execFileAsync('wsl.exe', ['--import', DISTRO_NAME, this.wslDir, rootfsTarPath, '--version', '2'], {
      encoding: 'utf8',
      windowsHide: true
    });

    // 4. Configure Alpine inside WSL2
    onProgress(60, 'Installing container runtime packages (docker, iptables)...');
    logger.info('[WslEngineDriver] Updating package repositories and installing docker...');

    // Configure DNS and package repositories
    await this.runInWsl('sh', [
      '-c',
      'echo "nameserver 1.1.1.1" > /etc/resolv.conf && apk update && apk add --no-cache docker iptables'
    ]);

    onProgress(80, 'Configuring container daemon...');
    // Configure Docker daemon
    const daemonJson = JSON.stringify(
      {
        hosts: ['unix:///var/run/docker.sock', `tcp://0.0.0.0:${DOCKER_TCP_PORT}`],
        iptables: false,
        tls: false
      },
      null,
      2
    );

    await this.runInWsl('sh', ['-c', `mkdir -p /etc/docker && echo '${daemonJson}' > /etc/docker/daemon.json`]);

    // Create startup script
    const startScript = `#!/bin/sh
mkdir -p /var/log/docker
if ! pgrep dockerd > /dev/null 2>&1; then
  nohup dockerd > /var/log/docker/dockerd.log 2>&1 &
fi
`;
    await this.runInWsl('sh', [
      '-c',
      `echo '${startScript}' > /usr/local/bin/dockerd-start.sh && chmod +x /usr/local/bin/dockerd-start.sh`
    ]);

    onProgress(95, 'Finalizing manifest...');
    const manifest: EngineManifest = {
      schemaVersion: 1,
      engineVersion: '1.0.0',
      platform: 'win32',
      architecture: process.arch === 'arm64' ? 'arm64' : 'x64',
      distribution: 'alpine',
      installedAt: new Date().toISOString(),
      endpoint: {
        type: 'tcp',
        address: '127.0.0.1',
        port: DOCKER_TCP_PORT
      },
      state: 'stopped'
    };

    await writeFile(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    logger.info('[WslEngineDriver] Installation completed successfully.');
    onProgress(100, 'Installation complete.');
    return manifest;
  }

  private daemonProcess: ChildProcess | null = null;
  private readonly pipeRelay = new WindowsPipeRelay();

  async start(onStatus?: (status: string) => void): Promise<DockerConnection> {
    logger.info('[WslEngineDriver] Starting embedded container engine.');
    onStatus?.('Starting container daemon in WSL2...');

    // 1. Check if dockerd is already responding
    let wslIp = await this.getWslInternalIp();
    const isAlreadyResponding = wslIp ? await this.testPing(wslIp, DOCKER_TCP_PORT) : false;

    if (!isAlreadyResponding) {
      logger.info(
        '[WslEngineDriver] Container daemon not responding. Cleaning stale processes and spawning fresh dockerd.'
      );
      // Terminate any stale dockerd/containerd or lock files from previous unclean shutdowns
      await this.runInWsl('sh', [
        '-c',
        'killall -9 dockerd containerd 2>/dev/null || true; rm -f /var/run/docker.pid /var/run/docker.sock'
      ]).catch(() => {});

      const child = spawn('wsl.exe', ['-d', DISTRO_NAME, '-u', 'root', '--', 'dockerd'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      child.on('error', err => {
        logger.error({ err }, '[WslEngineDriver] Failed to spawn dockerd process in WSL2');
      });
      child.on('exit', (code, signal) => {
        logger.info(`[WslEngineDriver] dockerd process in WSL2 exited (code: ${code}, signal: ${signal})`);
      });
      this.daemonProcess = child;
    } else {
      logger.info('[WslEngineDriver] Container daemon is already active and healthy.');
    }

    onStatus?.('Connecting to CatBee Engine...');
    // 2. Ping verification
    const verifiedConnection = await this.verifyEngineConnectivity();
    logger.info({ endpoint: verifiedConnection }, '[WslEngineDriver] Container engine connection verified.');

    // 3. Start Windows Named Pipe Relay on \\.\pipe\catbee-desktop
    const pipeStarted = await this.pipeRelay.start('catbee-desktop', verifiedConnection.host, verifiedConnection.port);

    // Update manifest state
    const manifest = await this.getManifest();
    if (manifest) {
      manifest.state = 'running';
      manifest.updatedAt = new Date().toISOString();
      manifest.endpoint = {
        type: 'tcp',
        address: verifiedConnection.host,
        port: verifiedConnection.port
      };
      await writeFile(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    }

    if (pipeStarted) {
      const pipePath = '//./pipe/catbee-desktop';
      logger.info('[WslEngineDriver] Using Windows Named Pipe for container engine connection.');
      await setupCatBeeContext(true, `npipe://${pipePath}`).catch(err => {
        logger.debug({ err }, '[WslEngineDriver] Non-fatal: Docker CLI context registration skipped.');
      });
      return {
        type: 'npipe',
        path: pipePath
      };
    }

    // Fallback to TCP if pipe relay failed
    const verifiedEndpoint = `tcp://${verifiedConnection.host}:${verifiedConnection.port}`;
    await setupCatBeeContext(true, verifiedEndpoint).catch(err => {
      logger.debug({ err }, '[WslEngineDriver] Non-fatal: Docker CLI context registration skipped.');
    });

    return verifiedConnection;
  }

  async stop(): Promise<void> {
    logger.info('[WslEngineDriver] Stopping embedded container engine.');
    this.pipeRelay.stop();
    if (this.daemonProcess) {
      try {
        this.daemonProcess.kill();
      } catch {
        // Ignore errors
      }
      this.daemonProcess = null;
    }

    try {
      await this.runInWsl('sh', ['-c', 'killall dockerd containerd 2>/dev/null || true']);
    } catch {
      // Ignore errors if already stopped
    }

    try {
      await execFileAsync('wsl.exe', ['--terminate', DISTRO_NAME], {
        encoding: 'utf8',
        windowsHide: true
      });
      logger.info(`[WslEngineDriver] Terminated WSL distro ${DISTRO_NAME}`);
    } catch (error) {
      logger.warn({ err: error }, '[WslEngineDriver] Error terminating WSL distro');
    }

    const manifest = await this.getManifest();
    if (manifest) {
      manifest.state = 'stopped';
      manifest.updatedAt = new Date().toISOString();
      await writeFile(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    }
  }

  async getStatus(): Promise<'running' | 'stopped' | 'error' | 'not-installed'> {
    const installed = await this.isInstalled();
    if (!installed) {
      return 'not-installed';
    }

    try {
      const runningDistros = await this.listRunningWslDistros();
      if (!runningDistros.includes(DISTRO_NAME.toLowerCase())) {
        return 'stopped';
      }

      // If distro is running, verify if Docker ping responds
      const isAlive = await this.testPing('127.0.0.1', DOCKER_TCP_PORT);
      if (isAlive) {
        return 'running';
      }

      const wslIp = await this.getWslInternalIp();
      if (wslIp && (await this.testPing(wslIp, DOCKER_TCP_PORT))) {
        return 'running';
      }

      return 'stopped';
    } catch {
      return 'error';
    }
  }

  async uninstall(): Promise<void> {
    logger.info('[WslEngineDriver] Uninstalling embedded container engine.');
    await this.stop();

    try {
      await execFileAsync('wsl.exe', ['--unregister', DISTRO_NAME], {
        encoding: 'utf8',
        windowsHide: true
      });
    } catch (err) {
      logger.warn({ err }, '[WslEngineDriver] Unregister failed during uninstall');
    }

    try {
      await rm(this.engineDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err }, '[WslEngineDriver] Removing engine directory failed');
    }
  }

  private async verifyEngineConnectivity(timeoutMs = 45_000): Promise<{ type: 'tcp'; host: string; port: number }> {
    const startTime = Date.now();
    const intervalMs = 1_000;

    let wslIp: string | null = null;

    while (Date.now() - startTime < timeoutMs) {
      // 1. Try 127.0.0.1
      if (await this.testPing('127.0.0.1', DOCKER_TCP_PORT)) {
        return { type: 'tcp', host: '127.0.0.1', port: DOCKER_TCP_PORT };
      }

      // 2. Try WSL internal IP
      wslIp = await this.getWslInternalIp();
      if (wslIp && (await this.testPing(wslIp, DOCKER_TCP_PORT))) {
        return { type: 'tcp', host: wslIp, port: DOCKER_TCP_PORT };
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Docker engine in WSL2 did not respond to /_ping within ${timeoutMs / 1000} seconds.`);
  }

  private async testPing(host: string, port: number): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1_500);

      const response = await fetch(`http://${host}:${port}/_ping`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const text = await response.text();
        return text.trim() === 'OK';
      }
      return false;
    } catch {
      return false;
    }
  }

  private async getWslInternalIp(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        'wsl.exe',
        ['-d', DISTRO_NAME, '-u', 'root', 'ip', '-4', 'addr', 'show', 'eth0'],
        {
          encoding: 'utf8',
          windowsHide: true
        }
      );
      const match = stdout.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
      if (match && match[1]) {
        logger.debug(`[WslEngineDriver] Detected WSL internal IP: ${match[1]}`);
        return match[1];
      }
    } catch {
      // Fallback
    }

    try {
      const { stdout } = await execFileAsync(
        'wsl.exe',
        ['-d', DISTRO_NAME, '-u', 'root', 'ip', 'route', 'get', '1.1.1.1'],
        {
          encoding: 'utf8',
          windowsHide: true
        }
      );
      const match = stdout.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
      if (match && match[1]) {
        logger.debug(`[WslEngineDriver] Detected WSL internal IP from route: ${match[1]}`);
        return match[1];
      }
    } catch {
      // Fallback
    }

    return null;
  }

  private async runInWsl(command: string, args: string[] = []): Promise<string> {
    const fullArgs = ['-d', DISTRO_NAME, '-u', 'root', command, ...args];
    const { stdout } = await execFileAsync('wsl.exe', fullArgs, {
      encoding: 'utf8',
      windowsHide: true
    });
    return stdout;
  }

  async getInstalledDistros(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync('wsl.exe', ['-l', '-q'], {
        encoding: 'utf16le',
        windowsHide: true
      });

      return stdout
        .replace(/\0/g, '')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async configureWslDistroIntegration(distroName: string, enabled: boolean): Promise<boolean> {
    if (distroName.toLowerCase() === DISTRO_NAME.toLowerCase()) {
      return true;
    }
    try {
      if (enabled) {
        await execFileAsync(
          'wsl.exe',
          [
            '-d',
            distroName,
            '-u',
            'root',
            '--',
            'sh',
            '-c',
            `mkdir -p /etc/profile.d && echo 'export DOCKER_HOST=tcp://localhost:${DOCKER_TCP_PORT}' > /etc/profile.d/catbee-docker.sh 2>/dev/null || true`
          ],
          { windowsHide: true }
        );
        logger.info(`[WslEngineDriver] Enabled Docker integration for WSL distro: ${distroName}`);
      } else {
        await execFileAsync(
          'wsl.exe',
          ['-d', distroName, '-u', 'root', '--', 'rm', '-f', '/etc/profile.d/catbee-docker.sh'],
          { windowsHide: true }
        );
        logger.info(`[WslEngineDriver] Disabled Docker integration for WSL distro: ${distroName}`);
      }
      return true;
    } catch (err) {
      logger.debug({ err }, `[WslEngineDriver] Integration update for ${distroName} skipped:`);
      return false;
    }
  }

  async applyDaemonConfiguration(settings?: EngineSettings): Promise<void> {
    const s = settings ?? (await getEngineSettings());
    const hosts = ['unix:///var/run/docker.sock'];
    if (s.exposeTcp) {
      hosts.push(`tcp://0.0.0.0:${DOCKER_TCP_PORT}`);
    }

    const daemonConfig: Record<string, unknown> = {
      hosts,
      iptables: false,
      tls: false
    };

    if (s.network?.dockerSubnet) {
      const parts = s.network.dockerSubnet.split('/');
      const ipParts = parts[0].split('.');
      if (ipParts.length === 4) {
        daemonConfig.bip = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}.1/${parts[1] || '24'}`;
      }
    }

    if (s.network?.portBindingBehavior === 'localhost') {
      daemonConfig.ip = '127.0.0.1';
    }

    if (s.network?.defaultNetworkingMode === 'dualstack') {
      daemonConfig.ipv6 = true;
    }

    const daemonJson = JSON.stringify(daemonConfig, null, 2);
    await this.runInWsl('sh', ['-c', `mkdir -p /etc/docker && echo '${daemonJson}' > /etc/docker/daemon.json`]).catch(
      () => {}
    );

    if (s.desktopProxy?.mode === 'manual' && (s.desktopProxy.httpProxy || s.desktopProxy.httpsProxy)) {
      const proxyLines = [
        `export HTTP_PROXY="${s.desktopProxy.httpProxy || ''}"`,
        `export HTTPS_PROXY="${s.desktopProxy.httpsProxy || ''}"`,
        `export NO_PROXY="${s.desktopProxy.noProxy || 'localhost,127.0.0.1'}"`
      ].join('\n');
      await this.runInWsl('sh', ['-c', `echo '${proxyLines}' > /etc/default/docker`]).catch(() => {});
    } else {
      await this.runInWsl('sh', ['-c', 'rm -f /etc/default/docker']).catch(() => {});
    }
  }

  private async listWslDistros(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync('wsl.exe', ['-l', '-q'], {
        encoding: 'utf16le', // wsl.exe outputs UTF-16LE in Windows
        windowsHide: true
      });

      return stdout
        .replace(/\0/g, '')
        .split(/\r?\n/)
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async listRunningWslDistros(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync('wsl.exe', ['-l', '--running', '-q'], {
        encoding: 'utf16le',
        windowsHide: true
      });

      return stdout
        .replace(/\0/g, '')
        .split(/\r?\n/)
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
