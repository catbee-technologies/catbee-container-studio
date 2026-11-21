import { CommonModule } from '@angular/common';
import { Component, computed, DestroyRef, effect, inject, input, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MenuComponent } from '@components/menu/menu';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { ElectronApiService } from '@core/electron-api.service';
import { SettingsService } from '@features/settings/services/settings.service';
import { environment } from '@environments/environment';
import { DockerInitializationStatus, EngineOperationProgress, UpdateDownloadProgress } from '@shared/types';
import { formatDockerBytes } from '@utils/docker-display.utils';

@Component({
  selector: 'catbee-container-studio-footer',
  templateUrl: './footer.html',
  styleUrl: './footer.scss',
  imports: [MenuComponent, CatbeeTooltip, CommonModule]
})
export class FooterComponent implements OnInit {
  private readonly electronApi = inject(ElectronApiService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  readonly settings = inject(SettingsService);

  readonly dockerConnected = input.required<boolean>();
  readonly isStarting = input<boolean>(false);
  readonly dockerInitStatus = input<DockerInitializationStatus | null>(null);

  readonly currentVersion = signal(environment.version);
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

  /** Live built-in engine install/uninstall progress pushed from the main process. */
  private readonly engineOperation = signal<EngineOperationProgress | null>(null);
  private receivedOperationProgress = false;
  /** Source of the engine CatBee was last connected to, captured whenever the connection becomes ready. */
  private readonly connectedRuntimeSource = signal<'embedded' | 'external' | null>(null);

  /** Install/uninstall work that affects the engine this footer reports on. */
  private readonly activeEngineOperation = computed(() => {
    const operation = this.engineOperation();
    // Uninstalling the built-in engine while connected to another engine leaves that engine untouched.
    if (operation?.operation === 'uninstall' && this.connectedRuntimeSource() === 'external') return null;
    return operation;
  });

  readonly isEngineStarting = computed(() => {
    return this.isRestarting() || this.isStarting() || this.activeEngineOperation() !== null;
  });

  /** What the engine is busy with, so an install or restart isn't reported as a cold start. */
  readonly engineActivity = computed<
    'installing' | 'uninstalling' | 'starting' | 'restarting' | 'stopping' | 'applying'
  >(() => {
    const status = this.dockerInitStatus();
    const operation = this.activeEngineOperation()?.operation;
    if (operation === 'uninstall') return 'uninstalling';
    if (operation === 'install' || status?.state === 'installing-engine') return 'installing';
    if (this.isRestarting() || status?.operation === 'restart') return 'restarting';
    if (status?.operation === 'apply-settings') return 'applying';
    if (status?.operation === 'stop' || status?.state === 'stopping-engine') return 'stopping';
    return 'starting';
  });

  private readonly engineActivityProgress = computed(() => {
    const operation = this.activeEngineOperation();
    if (operation) return ` (${Math.round(operation.progress)}%)`;
    const status = this.dockerInitStatus();
    return status?.state === 'installing-engine' ? ` (${Math.round(status.progress)}%)` : '';
  });

  readonly engineActivityLabel = computed(() => {
    const progress = this.engineActivityProgress();
    const labels = {
      installing: `Installing engine${progress}...`,
      uninstalling: `Uninstalling engine${progress}...`,
      starting: 'Engine starting...',
      restarting: 'Engine restarting...',
      stopping: 'Engine stopping...',
      applying: 'Applying settings...'
    } as const;
    return labels[this.engineActivity()];
  });

  readonly engineActivityTitle = computed(() => {
    const progress = this.engineActivityProgress();
    const titles = {
      installing: `Installing the built-in engine${progress}...`,
      uninstalling: `Uninstalling the built-in engine${progress}...`,
      starting: 'Docker Engine is starting...',
      restarting: 'Docker Engine is restarting...',
      stopping: 'Docker Engine is stopping...',
      applying: 'Applying engine settings...'
    } as const;
    return titles[this.engineActivity()];
  });

  readonly isExternalMode = computed(() => this.settings.engineMode() === 'external');
  readonly isMac = signal(false);
  readonly platformModifier = computed(() => (this.isMac() ? '⌘' : 'Ctrl'));

  constructor() {
    effect(() => {
      if (this.dockerInitStatus()?.state === 'ready') {
        void this.refreshEngineStatus();
      }
    });
  }

  async ngOnInit(): Promise<void> {
    const unsubscribeProgress = this.electronApi.onEngineOperationProgress(progress => {
      this.receivedOperationProgress = true;
      this.engineOperation.set(progress);
    });
    const unsubscribeQuitting = this.electronApi.onQuitting(() => {
      this.isExiting.set(true);
    });
    const unsubscribeUpdater = this.electronApi.onUpdaterStatus(status => {
      switch (status.status) {
        case 'available':
          this.updateAvailable.set(true);
          this.downloadProgress.set(null);
          this.updateDownloaded.set(false);
          break;
        case 'downloading':
          this.updateAvailable.set(false);
          this.downloadProgress.set(status);
          this.updateDownloaded.set(false);
          break;
        case 'downloaded':
          this.updateAvailable.set(false);
          this.downloadProgress.set(null);
          this.updateDownloaded.set(true);
          break;
        default:
          this.updateAvailable.set(false);
          this.downloadProgress.set(null);
          this.updateDownloaded.set(false);
          break;
      }
    });
    this.destroyRef.onDestroy(() => {
      unsubscribeProgress();
      unsubscribeQuitting();
      unsubscribeUpdater();
    });
    // Picks up an install/uninstall that was already running when the window loaded.
    void this.refreshEngineStatus();
    void this.electronApi.checkForUpdates();

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

  private async refreshEngineStatus(): Promise<void> {
    try {
      const status = await this.electronApi.getEmbeddedEngineStatus();
      this.connectedRuntimeSource.set(status?.runtime?.source ?? null);
      if (!this.receivedOperationProgress && status?.operation) {
        this.engineOperation.set(status.operation);
      }
    } catch {
      // ignore
    }
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
    this.settings.openCategory(category);
    void this.router.navigate(['/settings'], { queryParams: { tab: category } });
  }

  openAbout(): void {
    this.isMenuOpen.set(false);
    this.settings.openCategory('about');
    void this.router.navigate(['/settings'], { queryParams: { tab: 'about' } });
  }

  formatDockerBytes(bytes: number): string {
    return formatDockerBytes(bytes);
  }

  openUpdates(): void {
    this.settings.openCategory('updates');
    void this.router.navigate(['/settings'], { queryParams: { tab: 'updates' } });
  }
}
