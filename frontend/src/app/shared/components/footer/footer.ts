import { CommonModule } from '@angular/common';
import { Component, input, signal } from '@angular/core';
import { UpdaterComponent } from '@components/updater/updater';
import { environment } from '@environments/environment';
import { UpdateDownloadProgress } from '@shared/types';
import { formatBytes } from '@utils/docker-display.utils';

@Component({
  selector: 'catbee-container-studio-footer',
  templateUrl: './footer.html',
  styleUrl: './footer.scss',
  imports: [UpdaterComponent, CommonModule]
})
export class FooterComponent {
  readonly dockerConnected = input.required<boolean>();

  readonly currentVersion = signal(environment.version);
  readonly updaterDialogOpen = signal(false);
  readonly updateAvailable = signal(false);
  readonly downloadProgress = signal<UpdateDownloadProgress | null>(null);
  readonly updateDownloaded = signal(false);

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

  formatBytes(bytes: number): string {
    return formatBytes(bytes);
  }
}
