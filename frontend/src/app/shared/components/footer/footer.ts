import { CommonModule } from '@angular/common';
import { Component, inject, input, OnInit, signal } from '@angular/core';
import { UpdaterComponent } from '@components/updater/updater';
import { ElectronApiService } from '@core/electron-api.service';
import { environment } from '@environments/environment';
import { UpdateDownloadProgress } from '@shared/types';
import { formatDockerBytes } from '@utils/docker-display.utils';

@Component({
  selector: 'catbee-container-studio-footer',
  templateUrl: './footer.html',
  styleUrl: './footer.scss',
  imports: [UpdaterComponent, CommonModule]
})
export class FooterComponent implements OnInit {
  private readonly electronApi = inject(ElectronApiService);

  readonly dockerConnected = input.required<boolean>();

  readonly currentVersion = signal(environment.version);
  readonly updaterDialogOpen = signal(false);
  readonly updateAvailable = signal(false);
  readonly downloadProgress = signal<UpdateDownloadProgress | null>(null);
  readonly updateDownloaded = signal(false);
  readonly isMicrosoftStore = signal(false);

  async ngOnInit(): Promise<void> {
    const microsoftStore = await this.electronApi.isMicrosoftStoreInstallation();
    this.isMicrosoftStore.set(microsoftStore);
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
