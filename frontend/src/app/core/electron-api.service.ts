import { Injectable } from '@angular/core';
import { ElectronBaseService } from './electron-base.service';
import { AutoUpdaterStatus, DockerContextDetails, DockerInitializationStatus, EngineSettings } from '@shared/types';

@Injectable({ providedIn: 'root' })
export class ElectronApiService extends ElectronBaseService {
  async openExternalUrl(url: string): Promise<boolean> {
    const response = await this.bridge.app.external.open(url);
    const data = this.unwrapResult<{ opened: boolean }>(response);
    return data.opened;
  }

  async showItemInFolder(path: string): Promise<void> {
    await this.bridge.app.shell.showItem(path);
  }

  async selectDirectory(): Promise<string | null> {
    const response = await this.bridge.app.dialog.selectDirectory();
    const data = this.unwrapResult<{ path: string | null }>(response);
    return data.path;
  }

  async minimizeWindow(): Promise<void> {
    const response = await this.bridge.app?.window?.minimize?.();
    this.unwrapResult(response);
  }

  async toggleMaximizeWindow(): Promise<{ maximized: boolean }> {
    const response = await this.bridge.app?.window?.toggleMaximize?.();
    return this.unwrapResult<{ maximized: boolean }>(response);
  }

  async getWindowState(): Promise<{ maximized: boolean; fullscreen: boolean }> {
    const response = await this.bridge.app?.window?.getState?.();
    return this.unwrapResult<{ maximized: boolean; fullscreen: boolean }>(response);
  }

  async closeWindow(): Promise<void> {
    const response = await this.bridge.app?.window?.close?.();
    this.unwrapResult(response);
  }

  async quitApp(): Promise<void> {
    const response = await (this.bridge.app?.quit?.() ?? this.bridge.app?.window?.close?.());
    this.unwrapResult(response);
  }

  async showApplicationMenu(): Promise<void> {
    const response = await this.bridge.app?.menu?.show?.();
    this.unwrapResult(response);
  }

  async showApplicationSubmenu(label: string): Promise<void> {
    const response = await this.bridge.app?.menu?.showSubmenu?.(label);
    this.unwrapResult(response);
  }

  onDockerInitializationStatus(callback: (status: DockerInitializationStatus) => void): () => void {
    return this.bridge.app?.initialization?.docker?.onStatus(callback);
  }

  notifyDockerRendererReady(): void {
    this.bridge.app?.initialization?.rendererReady();
  }

  async installEmbeddedEngine(): Promise<void> {
    const response = await this.bridge.app?.engine?.install();
    this.unwrapResult(response);
  }

  async startEmbeddedEngine(): Promise<void> {
    const response = await this.bridge.app?.engine?.start();
    this.unwrapResult(response);
  }

  async stopEmbeddedEngine(): Promise<void> {
    const response = await this.bridge.app?.engine?.stop();
    this.unwrapResult(response);
  }

  async restartEmbeddedEngine(mode?: string): Promise<void> {
    const response = await this.bridge.app?.engine?.restart(mode);
    this.unwrapResult(response);
  }

  async pauseEngine(): Promise<{ pausedCount: number; isPaused: boolean }> {
    const response = await this.bridge.app?.engine?.pause?.();
    return this.unwrapResult(response) ?? { pausedCount: 0, isPaused: true };
  }

  async resumeEngine(): Promise<{ resumedCount: number; isPaused: boolean }> {
    const response = await this.bridge.app?.engine?.resume?.();
    return this.unwrapResult(response) ?? { resumedCount: 0, isPaused: false };
  }

  async getEnginePauseStatus(): Promise<{ isPaused: boolean; pausedCount: number }> {
    const response = await this.bridge.app?.engine?.getPauseStatus?.();
    return this.unwrapResult(response) ?? { isPaused: false, pausedCount: 0 };
  }

  async getEmbeddedEngineStatus(): Promise<
    { isInstalled: boolean; state: string; manifest: unknown; runtime: unknown } | undefined
  > {
    const response = await this.bridge.app?.engine?.getStatus();
    return this.unwrapResult(response);
  }

  async checkEnginePrerequisites(): Promise<{ ok: boolean; reason?: string; actionHint?: string } | undefined> {
    const response = await this.bridge.app?.engine?.checkPrerequisites();
    return this.unwrapResult(response);
  }

  async getDockerContextInfo(): Promise<DockerContextDetails | undefined> {
    const response = await this.bridge.app?.engine?.getContextInfo();
    return this.unwrapResult(response);
  }

  async useDockerContext(contextName: string): Promise<DockerContextDetails | undefined> {
    const response = await this.bridge.app?.engine?.useContext(contextName);
    return this.unwrapResult(response);
  }

  async setupCatBeeContext(setAsActive = false, customEndpoint?: string): Promise<DockerContextDetails | undefined> {
    const response = await this.bridge.app?.engine?.setupCatBeeContext(setAsActive, customEndpoint);
    return this.unwrapResult(response);
  }

  async getEngineSettings(): Promise<EngineSettings | undefined> {
    const response = await this.bridge.app?.engine?.getSettings();
    return this.unwrapResult(response);
  }

  async saveEngineSettings(settings: Partial<EngineSettings>): Promise<EngineSettings | undefined> {
    const response = await this.bridge.app?.engine?.saveSettings(settings);
    return this.unwrapResult(response);
  }

  async getWslDistros(): Promise<string[]> {
    const response = await this.bridge.app?.engine?.getWslDistros();
    return this.unwrapResult(response) ?? [];
  }

  async applyWslDistroIntegration(distroName: string, enabled: boolean): Promise<boolean> {
    const response = await this.bridge.app?.engine?.applyWslDistroIntegration(distroName, enabled);
    return Boolean(this.unwrapResult(response));
  }

  onUpdaterStatus(callback: (status: AutoUpdaterStatus) => void): () => void {
    return this.bridge.app?.updater?.onStatus(callback);
  }

  async checkForUpdates(): Promise<void> {
    await this.bridge.app?.updater?.checkForUpdates();
  }

  async downloadUpdate(): Promise<void> {
    await this.bridge.app?.updater?.downloadUpdate();
  }

  async restartAndInstallUpdate(): Promise<void> {
    await this.bridge.app?.updater?.restartAndInstallUpdate();
  }

  async getPlatform(): Promise<string> {
    const response = await this.bridge.app?.platform?.get();
    return this.unwrapResult<string>(response);
  }

  async getPlatformInfo(): Promise<{
    platform: string;
    arch: string;
    appVersion: string;
    electronVersion: string;
    nodeVersion: string;
    osRelease: string;
    osType: string;
    totalMemory: number;
    cpuCount: number;
  }> {
    const response = await this.bridge.app?.platform?.getInfo();
    return this.unwrapResult(response);
  }

  async openLogsFolder(): Promise<void> {
    const response = await this.bridge.app?.platform?.openLogs();
    this.unwrapResult(response);
  }

  async openEngineDirectory(): Promise<string> {
    const response = await this.bridge.app?.platform?.openEngineDir();
    const data = this.unwrapResult<{ opened: boolean; path: string }>(response);
    return data.path;
  }

  async isMicrosoftStoreInstallation(): Promise<boolean> {
    const response = await this.bridge.app?.updater?.isMicrosoftStore();
    return this.unwrapResult<boolean>(response);
  }
}
