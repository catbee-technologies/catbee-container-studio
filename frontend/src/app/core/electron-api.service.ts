import { Injectable } from '@angular/core';
import { ElectronBaseService } from './electron-base.service';
import {
  AutoUpdaterStatus,
  ReleaseNotesInfo,
  DockerBuilderInfo,
  DockerContextDetails,
  DockerInitializationStatus,
  EmbeddedEngineStatus,
  EngineOperationProgress,
  EngineSettings,
  K8sClusterInfo,
  K8sOperationProgress,
  K8sStartResult,
  KubernetesSettingsConfig
} from '@shared/types';

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

  onNavigate(callback: (payload: { path: string; queryParams?: Record<string, string> }) => void): () => void {
    return this.bridge.app?.onNavigate?.(callback) ?? (() => undefined);
  }

  onQuitting(callback: () => void): () => void {
    return this.bridge.app?.onQuitting?.(callback) ?? (() => undefined);
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

  async getEmbeddedEngineStatus(): Promise<EmbeddedEngineStatus | undefined> {
    const response = await this.bridge.app?.engine?.getStatus();
    return this.unwrapResult(response);
  }

  /** Live install/uninstall progress; `null` means the operation finished. */
  onEngineOperationProgress(callback: (progress: EngineOperationProgress | null) => void): () => void {
    return this.bridge.app?.engine?.onProgress?.(callback) ?? (() => undefined);
  }

  async uninstallEmbeddedEngine(): Promise<void> {
    const response = await this.bridge.app?.engine?.uninstall?.();
    this.unwrapResult(response);
  }

  async purgeData(): Promise<
    | {
        containersPruned: number;
        imagesPruned: number;
        volumesPruned: number;
        spaceReclaimed: number;
      }
    | undefined
  > {
    const response = await this.bridge.app?.engine?.purgeData?.();
    return this.unwrapResult(response);
  }

  async factoryResetTeardown(): Promise<void> {
    const response = await this.bridge.app?.engine?.factoryResetTeardown?.();
    this.unwrapResult(response);
  }

  async applyEngineSettings(): Promise<{ applied: boolean }> {
    const response = await this.bridge.app?.engine?.applySettings?.();
    return this.unwrapResult(response) ?? { applied: false };
  }

  async getEngineDaemonConfig(draft?: Partial<EngineSettings>): Promise<Record<string, unknown> | undefined> {
    const response = await this.bridge.app?.engine?.getDaemonConfig?.(draft);
    return this.unwrapResult(response);
  }

  async getStartAtLogin(): Promise<boolean | undefined> {
    const response = await this.bridge.app?.platform?.getStartAtLogin?.();
    return this.unwrapResult(response);
  }

  async setStartAtLogin(enabled: boolean): Promise<boolean | undefined> {
    const response = await this.bridge.app?.platform?.setStartAtLogin?.(enabled);
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

  async getDockerBuilderInfo(): Promise<DockerBuilderInfo | undefined> {
    const response = await this.bridge.app?.engine?.getBuilderInfo?.();
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

  async resetEngineSettings(): Promise<EngineSettings | undefined> {
    const response = await this.bridge.app?.engine?.resetSettings?.();
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
    freeDiskGb?: number | null;
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

  async getReleaseNotes(version?: string): Promise<ReleaseNotesInfo | null> {
    const response = await this.bridge.app?.updater?.getReleaseNotes(version);
    return this.unwrapResult<ReleaseNotesInfo | null>(response);
  }

  async getK8sStatus(): Promise<K8sClusterInfo | undefined> {
    const response = await this.bridge.app?.k8s?.getStatus?.();
    return this.unwrapResult<K8sClusterInfo | undefined>(response);
  }

  async getK8sProgress(): Promise<K8sOperationProgress | null> {
    const response = await this.bridge.app?.k8s?.getProgress?.();
    return this.unwrapResult<K8sOperationProgress | null>(response) ?? null;
  }

  async startK8sCluster(config?: KubernetesSettingsConfig): Promise<K8sStartResult> {
    const response = await this.bridge.app?.k8s?.startCluster?.(config);
    return this.unwrapResult<K8sStartResult>(response) ?? { success: false };
  }

  async stopK8sCluster(): Promise<{ success: boolean }> {
    const response = await this.bridge.app?.k8s?.stopCluster?.();
    return this.unwrapResult<{ success: boolean }>(response) ?? { success: false };
  }

  async resetK8sCluster(config?: KubernetesSettingsConfig): Promise<K8sStartResult> {
    const response = await this.bridge.app?.k8s?.resetCluster?.(config);
    return this.unwrapResult<K8sStartResult>(response) ?? { success: false };
  }

  async cancelK8sOperation(): Promise<{ success: boolean }> {
    const response = await this.bridge.app?.k8s?.cancelOperation?.();
    return this.unwrapResult<{ success: boolean }>(response) ?? { success: false };
  }

  async getK8sVersions(): Promise<string[]> {
    const response = await this.bridge.app?.k8s?.getVersions?.();
    return this.unwrapResult<string[]>(response) ?? [];
  }

  async installK8sRuntime(): Promise<{ success: boolean }> {
    const response = await this.bridge.app?.k8s?.installRuntime?.();
    return this.unwrapResult<{ success: boolean }>(response) ?? { success: false };
  }

  async uninstallK8sRuntime(): Promise<{ success: boolean }> {
    const response = await this.bridge.app?.k8s?.uninstallRuntime?.();
    return this.unwrapResult<{ success: boolean }>(response) ?? { success: false };
  }

  onK8sProgress(callback: (progress: K8sOperationProgress | null) => void): () => void {
    return this.bridge.app?.k8s?.onProgress?.(callback) ?? (() => undefined);
  }
}
