import { CommonModule } from '@angular/common';
import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { UpdaterComponent } from '@components/updater/updater';
import { MenuComponent } from '@components/menu/menu';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { ElectronApiService } from '@core/electron-api.service';
import { SettingsService } from '@features/settings/services/settings.service';
import { environment } from '@environments/environment';
import { DockerInitializationStatus, UpdateDownloadProgress } from '@shared/types';
import { formatDockerBytes } from '@utils/docker-display.utils';

@Component({
  selector: 'catbee-container-studio-footer',
  templateUrl: './footer.html',
  styleUrl: './footer.scss',
  imports: [UpdaterComponent, MenuComponent, CatbeeTooltip, CommonModule]
})
export class FooterComponent implements OnInit {
  private readonly electronApi = inject(ElectronApiService);
  private readonly router = inject(Router);
  readonly settings = inject(SettingsService);

  readonly dockerConnected = input.required<boolean>();
  readonly isStarting = input<boolean>(false);
  readonly dockerInitStatus = input<DockerInitializationStatus | null>(null);

  readonly currentVersion = signal(environment.version);
  readonly updaterDialogOpen = signal(false);
  readonly updateAvailable = signal(false);
  readonly downloadProgress = signal<UpdateDownloadProgress | null>(null);
  readonly updateDownloaded = signal(false);
  readonly isMicrosoftStore = signal(false);

  // Engine controls state
  readonly isMenuOpen = signal(false);
  readonly isEnginePaused = signal(false);
  readonly isPausing = signal(false);
  readonly isRestarting = signal(false);
  readonly isExiting = signal(false);

  readonly isEngineStarting = computed(() => {
    return this.isRestarting() || this.isStarting();
  });

  readonly isExternalMode = computed(() => this.settings.engineMode() === 'external');
  readonly isMac = signal(false);
  readonly platformModifier = computed(() => (this.isMac() ? '⌘' : 'Ctrl'));

  async ngOnInit(): Promise<void> {
    const microsoftStore = await this.electronApi.isMicrosoftStoreInstallation();
    this.isMicrosoftStore.set(microsoftStore);

    try {
      const p = await this.electronApi.getPlatform();
      this.isMac.set(p === 'darwin');
    } catch {
      // ignore
    }

    try {
      const pauseStatus = await this.electronApi.getEnginePauseStatus();
      this.isEnginePaused.set(pauseStatus.isPaused);
    } catch {
      // ignore
    }
  }

  toggleMenu(event?: MouseEvent): void {
    if (event) {
      event.stopPropagation();
    }
    const next = !this.isMenuOpen();
    this.isMenuOpen.set(next);
    if (next) {
      void this.refreshPauseStatus();
    }
  }

  closeMenu(): void {
    this.isMenuOpen.set(false);
  }

  private async refreshPauseStatus(): Promise<void> {
    try {
      const status = await this.electronApi.getEnginePauseStatus();
      this.isEnginePaused.set(status.isPaused);
    } catch {
      // ignore
    }
  }

  async toggleEnginePause(): Promise<void> {
    if (this.isPausing() || !this.dockerConnected()) return;
    this.isPausing.set(true);
    try {
      if (this.isEnginePaused()) {
        const res = await this.electronApi.resumeEngine();
        this.isEnginePaused.set(res.isPaused);
      } else {
        const res = await this.electronApi.pauseEngine();
        this.isEnginePaused.set(res.isPaused);
      }
    } catch (err) {
      console.error('Failed to toggle engine pause state:', err);
    } finally {
      this.isPausing.set(false);
    }
  }

  async restartEngine(): Promise<void> {
    if (this.isExternalMode() || this.isRestarting()) return;
    this.isRestarting.set(true);
    this.isMenuOpen.set(false);
    try {
      await this.electronApi.restartEmbeddedEngine();
      this.isEnginePaused.set(false);
    } catch (err) {
      console.error('Failed to restart engine:', err);
    } finally {
      this.isRestarting.set(false);
    }
  }

  async quitApp(): Promise<void> {
    this.isExiting.set(true);
    this.isMenuOpen.set(false);
    try {
      await this.electronApi.quitApp();
    } catch (err) {
      console.error('Failed to quit application:', err);
      this.isExiting.set(false);
    }
  }

  openSettings(category = 'general'): void {
    this.isMenuOpen.set(false);
    void this.router.navigate(['/settings'], { queryParams: { tab: category } });
  }

  openAbout(): void {
    this.isMenuOpen.set(false);
    void this.router.navigate(['/settings'], { queryParams: { tab: 'about' } });
  }

  onUpdateAvailable(): void {
    this.updateAvailable.set(true);
  }

  onUpdateDownloadProgress(progress: UpdateDownloadProgress): void {
    this.updateAvailable.set(false);
    this.updateDownloaded.set(false);
    this.downloadProgress.set(progress);
  }

  onUpdateDownloaded(): void {
    this.downloadProgress.set(null);
    this.updateDownloaded.set(true);
  }

  formatDockerBytes(bytes: number): string {
    return formatDockerBytes(bytes);
  }

  openUpdaterDialog(): void {
    if (this.isMicrosoftStore()) {
      return;
    }
    this.updaterDialogOpen.set(true);
  }
}
