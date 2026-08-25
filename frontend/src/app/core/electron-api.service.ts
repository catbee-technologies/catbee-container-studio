import { Injectable } from '@angular/core';
import { ElectronBaseService } from './electron-base.service';
import { AutoUpdaterStatus, DockerInitializationStatus } from '@shared/types';

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
}
