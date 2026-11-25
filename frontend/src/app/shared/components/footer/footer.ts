import { CommonModule } from '@angular/common';
import { Component, computed, DestroyRef, effect, inject, input, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MenuComponent } from '@components/menu/menu';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { ElectronApiService } from '@core/electron-api.service';
import { SettingsService } from '@features/settings/services/settings.service';
import { environment } from '@environments/environment';
import {
  DockerInitializationStatus,
  EngineOperationProgress,
  K8sClusterInfo,
  K8sOperationProgress,
  UpdateDownloadProgress
} from '@shared/types';
import { formatDockerBytes } from '@utils/docker-display.utils';
import { K8sIconComponent } from '@shared/components/k8s-icon/k8s-icon.component';

function formatK8sOperationLabel(op: K8sOperationProgress): string {
  const pct = op.progress !== undefined ? ` (${op.progress}%)` : '';
  switch (op.operation) {
    case 'install':
      return `Installing kind${pct}...`;
    case 'uninstall':
      return 'Uninstalling kind...';
    case 'stop':
      return 'Kubernetes stopping...';
    case 'reset':
      return `Kubernetes resetting${pct}...`;
    default:
      return op.progress !== undefined ? `Kubernetes (${op.progress}%)...` : 'Kubernetes starting...';
  }
}

@Component({
  selector: 'catbee-container-studio-footer',
  templateUrl: './footer.html',
  styleUrl: './footer.scss',
  imports: [MenuComponent, CatbeeTooltip, CommonModule, K8sIconComponent]
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
  readonly isInstallingUpdate = signal(false);
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

  // Kubernetes state
  readonly k8sClusterInfo = signal<K8sClusterInfo | null>(null);
  readonly k8sOperation = signal<K8sOperationProgress | null>(null);
  readonly isK8sEnabled = computed(() => this.settings.kubernetes().enabled);

  readonly k8sStatus = computed(() => {
    if (
      !this.dockerConnected() ||
      this.connectedRuntimeSource() !== 'embedded' ||
      this.k8sClusterInfo()?.status === 'unavailable'
    ) {
      return 'unavailable';
    }
    const op = this.k8sOperation();
    if (op) {
      if (op.operation === 'stop' || op.operation === 'uninstall') return 'stopping';
      return 'starting';
    }
    return this.k8sClusterInfo()?.status ?? 'stopped';
  });

  readonly k8sStatusLabel = computed(() => {
    if (this.k8sStatus() === 'unavailable') return 'Kubernetes unavailable';
    const op = this.k8sOperation();
    if (op) {
      return formatK8sOperationLabel(op);
    }
    const statusLabels: Record<string, string> = {
      running: 'Kubernetes running',
      degraded: 'Kubernetes degraded',
      starting: 'Kubernetes starting...',
      stopping: 'Kubernetes stopping...',
      error: 'Kubernetes error',
      stopped: 'Kubernetes stopped'
    };
    return statusLabels[this.k8sStatus()] ?? 'Kubernetes stopped';
  });

  readonly k8sTooltip = computed(() => {
    if (this.k8sStatus() === 'unavailable') return 'Start and connect to the CatBee built-in engine to use Kubernetes.';
    const op = this.k8sOperation();
    if (op) {
      return `${op.stage}${op.detail ? ' — ' + op.detail : ''} - Click to open settings`;
    }
    const status = this.k8sStatus();
    const version = this.k8sClusterInfo()?.version || this.settings.kubernetes().version;
    const nodes = this.k8sClusterInfo()?.nodeCount || this.settings.kubernetes().nodeCount;
    switch (status) {
      case 'running':
        return `Kubernetes cluster is running (${version}, ${nodes} ${nodes === 1 ? 'node' : 'nodes'}) - Click to open settings`;
      case 'degraded':
        return this.k8sClusterInfo()?.warning ?? 'The Kubernetes cloud provider is unavailable.';
      case 'starting':
        return 'Kubernetes cluster is starting... - Click to open settings';
      case 'stopping':
        return 'Kubernetes cluster is stopping... - Click to open settings';
      case 'error':
        return 'Kubernetes cluster error - Click to view in settings';
      case 'stopped':
      default:
        return 'Kubernetes cluster is stopped - Click to configure in settings';
    }
  });

  constructor() {
    effect(() => {
      if (this.dockerInitStatus()?.state === 'ready' || this.dockerConnected()) {
        void this.refreshEngineStatus();
        if (this.isK8sEnabled()) {
          void this.refreshK8sStatus();
        }
      }
    });

    effect(() => {
      const enabled = this.isK8sEnabled();
      if (enabled && this.dockerConnected()) {
        void this.refreshK8sStatus();
      }
    });
  }

  async ngOnInit(): Promise<void> {
    const unsubscribeProgress = this.electronApi.onEngineOperationProgress(progress => {
      this.receivedOperationProgress = progress !== null;
      this.engineOperation.set(progress);
      if (!progress) {
        void this.refreshEngineStatus();
      }
    });
    const unsubscribeK8sProgress = this.electronApi.onK8sProgress(progress => {
      this.k8sOperation.set(progress);
      if (!progress && this.isK8sEnabled() && this.dockerConnected()) {
        void this.refreshK8sStatus();
      }
    });
    const unsubscribeQuitting = this.electronApi.onQuitting(() => {
      this.isExiting.set(true);
    });
    const unsubscribeUpdater = this.electronApi.onUpdaterStatus(status => {
      this.isInstallingUpdate.set(
        status.status === 'downloaded' &&
          (status.install?.phase === 'preparing' || status.install?.phase === 'installing')
      );
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

    const k8sInterval = setInterval(() => {
      if (this.isK8sEnabled() && this.dockerConnected()) {
        void this.refreshK8sStatus();
      }
    }, 4000);

    this.destroyRef.onDestroy(() => {
      clearInterval(k8sInterval);
      unsubscribeProgress();
      unsubscribeK8sProgress();
      unsubscribeQuitting();
      unsubscribeUpdater();
    });
    // Picks up an install/uninstall that was already running when the window loaded.
    void this.refreshEngineStatus();
    if (this.isK8sEnabled()) {
      void this.refreshK8sStatus();
    }
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

  async refreshK8sStatus(): Promise<void> {
    try {
      const info = await this.electronApi.getK8sStatus();
      if (info) {
        this.k8sClusterInfo.set(info);
        if (info.operation !== undefined) {
          this.k8sOperation.set(info.operation);
        }
      }
    } catch {
      // ignore
    }
  }

  private async refreshEngineStatus(): Promise<void> {
    try {
      const status = await this.electronApi.getEmbeddedEngineStatus();
      this.connectedRuntimeSource.set(status?.runtime?.source ?? null);
      if (!this.receivedOperationProgress) {
        this.engineOperation.set(status?.operation ?? null);
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
      await this.refreshPauseStatus();
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
