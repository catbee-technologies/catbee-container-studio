import { Component, inject, OnDestroy, signal } from '@angular/core';
import { ElectronApiService } from '@core/electron-api.service';
import { ThemeSwitchComponent } from '@components/theme-switch/theme-switch';

@Component({
  selector: 'catbee-container-studio-window-header',
  templateUrl: './window-header.html',
  styleUrl: './window-header.scss',
  imports: [ThemeSwitchComponent]
})
export class WindowHeaderComponent implements OnDestroy {
  readonly electronApi = inject(ElectronApiService);

  isMacOS = /Mac|iPhone|iPad|iPod/i.test(globalThis.navigator?.platform ?? '');
  readonly isWindowMaximized = signal(false);
  readonly isWindowFullscreen = signal(false);
  private resizeSyncTimer?: ReturnType<typeof globalThis.setTimeout>;
  private readonly onResize = (): void => {
    if (this.resizeSyncTimer) {
      globalThis.clearTimeout(this.resizeSyncTimer);
    }

    this.resizeSyncTimer = globalThis.setTimeout(() => {
      void this.syncWindowState();
    }, 120);
  };

  constructor() {
    void this.syncWindowState();
    globalThis.addEventListener('resize', this.onResize);
  }

  ngOnDestroy(): void {
    globalThis.removeEventListener('resize', this.onResize);

    if (this.resizeSyncTimer) {
      globalThis.clearTimeout(this.resizeSyncTimer);
    }
  }

  async minimizeWindow(): Promise<void> {
    await this.electronApi.minimizeWindow();
  }

  async toggleMaximizeWindow(): Promise<void> {
    const data = await this.electronApi.toggleMaximizeWindow();
    this.isWindowMaximized.set(data.maximized);
    void this.syncWindowState();
  }

  async closeWindow(): Promise<void> {
    await this.electronApi.closeWindow();
  }

  async showMenu(): Promise<void> {
    await this.electronApi.showApplicationMenu();
  }

  private async syncWindowState(): Promise<void> {
    try {
      const data = await this.electronApi.getWindowState();
      this.isWindowMaximized.set(data.maximized);
      this.isWindowFullscreen.set(data.fullscreen);
    } catch {
      // Ignore and keep default state.
    }
  }
}
