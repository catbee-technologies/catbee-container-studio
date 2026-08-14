import { Component, signal } from '@angular/core';
import { IpcResult } from '@shared/types/docker-api.types';

interface ElectronBridge {
  app?: {
    window?: {
      minimize: () => Promise<unknown>;
      getState: () => Promise<unknown>;
      toggleMaximize: () => Promise<unknown>;
      close: () => Promise<unknown>;
    };
  };
}

@Component({
  selector: 'catbee-container-studio-window-header',
  templateUrl: './window-header.html',
  styleUrl: './window-header.scss'
})
export class WindowHeaderComponent {
  isMacOS = /Mac|iPhone|iPad|iPod/i.test(globalThis.navigator?.platform ?? '');
  readonly isWindowMaximized = signal(false);

  constructor() {
    void this.syncWindowState();
  }

  async minimizeWindow(): Promise<void> {
    const bridge = this.getBridge();
    const response = await bridge.app?.window?.minimize?.();
    this.unwrapResult(response);
  }

  async toggleMaximizeWindow(): Promise<void> {
    const bridge = this.getBridge();
    const response = await bridge.app?.window?.toggleMaximize?.();
    const data = this.unwrapResult<{ maximized?: boolean }>(response);
    if (typeof data?.maximized === 'boolean') {
      this.isWindowMaximized.set(data.maximized);
    } else {
      this.isWindowMaximized.update(value => !value);
    }
  }

  async closeWindow(): Promise<void> {
    const bridge = this.getBridge();
    const response = await bridge.app?.window?.close?.();
    this.unwrapResult(response);
  }

  private getBridge(): ElectronBridge {
    return (globalThis as unknown as { electron?: ElectronBridge }).electron ?? {};
  }

  private unwrapResult<T>(payload: unknown): T {
    if (!payload || typeof payload !== 'object') {
      return payload as T;
    }

    const candidate = payload as IpcResult<unknown>;
    if (candidate.ok === false) {
      throw new Error(candidate.error.message);
    }

    return candidate.data as T;
  }

  private async syncWindowState(): Promise<void> {
    try {
      const bridge = this.getBridge();
      const response = await bridge.app?.window?.getState?.();
      const data = this.unwrapResult<{ maximized?: boolean }>(response);
      if (typeof data?.maximized === 'boolean') {
        this.isWindowMaximized.set(data.maximized);
      }
    } catch {
      // Ignore and keep default state.
    }
  }
}
