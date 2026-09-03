import { CommonModule } from '@angular/common';
import { Component, DestroyRef, effect, inject, input, model, output, signal } from '@angular/core';
import { ElectronApiService } from '@core/electron-api.service';
import { AutoUpdaterStatus, UpdateDownloadProgress } from '@shared/types';
import { DialogComponent } from '@components/dialog/dialog';
import { formatDockerBytes } from '@utils/docker-display.utils';

@Component({
  selector: 'catbee-container-studio-updater',
  templateUrl: './updater.html',
  styleUrl: './updater.scss',
  imports: [CommonModule, DialogComponent]
})
export class UpdaterComponent {
  private readonly electronApi = inject(ElectronApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly updaterDialogOpen = model.required<boolean>();
  readonly currentVersion = input.required<string>();
  readonly updateAvailable = output<void>();
  readonly updateDownloaded = output<void>();
  readonly updateDownloadProgress = output<UpdateDownloadProgress>();

  readonly updaterStatus = signal<AutoUpdaterStatus>({ status: 'idle' });
  readonly githubRepoUrl = 'https://github.com/catbee-technologies/catbee-container-studio';

  readonly isMacOS = signal(false);

  private downloadInProgress = false;

  constructor() {
    this.initialize();

    effect(() => {
      const updaterDialogOpen = this.updaterDialogOpen();
      if (updaterDialogOpen && !this.downloadInProgress) {
        this.checkForUpdates();
      }
    });
  }

  private async initialize(): Promise<void> {
    const platform = await this.electronApi.getPlatform();
    this.isMacOS.set(platform === 'darwin');

    const unsubscribe = this.electronApi.onUpdaterStatus(status => {
      this.updaterStatus.set(status);
      console.log(`\x1b[36m${new Date().toISOString()}\x1b[0m Updater status:`, status);

      switch (status.status) {
        case 'available':
          this.updateAvailable.emit();
          break;
        case 'downloading':
          this.downloadInProgress = true;
          this.updateDownloadProgress.emit(status);
          break;
        case 'downloaded':
          this.downloadInProgress = false;
          this.updateDownloaded.emit();
          break;
      }
    });
    this.destroyRef.onDestroy(() => {
      unsubscribe();
    });
    await this.checkForUpdates();
  }

  async checkForUpdates(): Promise<void> {
    await this.electronApi.checkForUpdates();
  }

  async downloadUpdate(): Promise<void> {
    if (this.isMacOS()) {
      return;
    }
    await this.electronApi.downloadUpdate();
  }

  restartAndInstall(): void {
    if (this.isMacOS()) {
      return;
    }
    this.electronApi.restartAndInstallUpdate();
  }

  closeUpdater(): void {
    this.updaterDialogOpen.set(false);
  }

  formatDockerBytes(bytes: number): string {
    return formatDockerBytes(bytes);
  }

  downloadInBackground(): void {
    this.updaterDialogOpen.set(false);
  }

  openChangelog(currentVersion: string, newVersion: string): void {
    const changelogUrl = `${this.githubRepoUrl}/compare/v${currentVersion}...v${newVersion}`;
    this.electronApi.openExternalUrl(changelogUrl);
  }

  openLatestRelease(): void {
    const status = this.updaterStatus();
    if (status.status !== 'available') {
      return;
    }
    this.electronApi.openExternalUrl(`${this.githubRepoUrl}/releases/tag/v${status.version}`);
  }

  updaterTitle(): string {
    switch (this.updaterStatus().status) {
      case 'checking':
        return 'Checking for Updates';
      case 'available':
        return 'Update Available';
      case 'downloading':
        return 'Downloading Update';
      case 'downloaded':
        return 'Update Ready';
      case 'not-available':
        return 'No Updates Available';
      case 'error':
        return 'Update Error';
      case 'idle':
        return 'Updates';
    }
  }
}
