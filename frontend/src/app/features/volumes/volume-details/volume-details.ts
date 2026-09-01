import { CommonModule, DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { combineLatest } from 'rxjs';
import { DockerApiService } from '@core/docker-api.service';
import { DockerContainerInfo, DockerVolumeInfo } from '@shared/types/docker-api.types';
import { TabsComponent, TabItem } from '@components/tabs/tabs';
import { DATE_FORMAT, formatDockerNames } from '@utils/docker-display.utils';
import { VolumeDetailsPrefetch } from './volume-details.resolver';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { SessionStorageService } from '@ng-catbee/storage';
import { UI_STORAGE_KEYS } from '@utils/storage.utils';
import { CopyButtonComponent } from '@components/copy-button/copy-button';
import { VolumeFilesTabComponent } from './components/volume-files-tab/volume-files-tab';

enum VolumeDetailsTab {
  Containers = 'containers',
  Files = 'files'
}

@Component({
  selector: 'catbee-container-studio-volume-details-page',
  imports: [
    CommonModule,
    TabsComponent,
    EmptyStateComponent,
    ErrorBannerComponent,
    CopyButtonComponent,
    VolumeFilesTabComponent
  ],
  templateUrl: './volume-details.html',
  styleUrl: './volume-details.scss'
})
export class VolumeDetailsPage {
  private readonly dockerApi = inject(DockerApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly datePipe = inject(DatePipe);
  private readonly sessionStorage = inject(SessionStorageService);

  readonly volumeName = signal('');
  readonly volume = signal<DockerVolumeInfo | null>(null);
  readonly containersInUse = signal<DockerContainerInfo[]>([]);
  readonly isLoading = signal(false);
  readonly error = signal<string | null>(null);
  readonly activeTab = signal<VolumeDetailsTab>(VolumeDetailsTab.Containers);
  readonly tabs: readonly TabItem[] = [
    { id: 'containers', label: 'Containers using this volume', icon: 'deployed_code' },
    { id: 'files', label: 'Files', icon: 'folder_copy' }
  ];

  readonly summaryItems = computed(() => {
    const volume = this.volume();
    if (!volume) {
      return [] as { label: string; value: string }[];
    }

    return [
      { label: 'Driver', value: volume.Driver.toUpperCase() },
      { label: 'Mountpoint', value: volume.Mountpoint },
      {
        label: 'Created',
        value: volume.CreatedAt ? (this.datePipe.transform(new Date(volume.CreatedAt), DATE_FORMAT) ?? '--') : '--'
      },
      { label: 'Size', value: this.formatBytes(volume.UsageData?.Size ?? 0) },
      { label: 'Ref Count', value: String(volume.UsageData?.RefCount ?? 0) }
    ];
  });

  constructor() {
    const routeSub = combineLatest([this.route.paramMap, this.route.data]).subscribe(([params, data]) => {
      const name = params.get('name') ?? '';
      this.volumeName.set(name);
      if (!name) {
        return;
      }

      this.activeTab.set(
        this.sessionStorage.getEnumWithDefault<VolumeDetailsTab>(
          `${UI_STORAGE_KEYS.VOLUMES_SELECTED_TAB_PREFIX}${name}`,
          VolumeDetailsTab.Containers,
          Object.values(VolumeDetailsTab)
        )
      );

      const preloaded = (data['preloadedVolumeDetails'] ?? null) as VolumeDetailsPrefetch | null;
      void this.load(preloaded);
    });

    this.destroyRef.onDestroy(() => {
      routeSub.unsubscribe();
    });
  }

  backToVolumes(): void {
    void this.router.navigateByUrl(this.getReturnTo('/volumes'));
  }

  openContainer(containerId: string): void {
    void this.router.navigate(['/containers', containerId], { state: { returnTo: this.router.url } });
  }

  formatContainerName(container: DockerContainerInfo): string {
    return formatDockerNames(container.Names);
  }

  setActiveTab(tab: string): void {
    const allowedTabs = Object.values(VolumeDetailsTab);
    if (!allowedTabs.includes(tab as VolumeDetailsTab)) {
      return;
    }
    this.activeTab.set(tab as VolumeDetailsTab);
    this.sessionStorage.set(`${UI_STORAGE_KEYS.VOLUMES_SELECTED_TAB_PREFIX}${this.volumeName()}`, tab);
  }

  private getReturnTo(fallback: string): string {
    const state = window.history.state as { returnTo?: string } | null;
    return typeof state?.returnTo === 'string' && state.returnTo.length > 0 ? state.returnTo : fallback;
  }

  private formatBytes(bytes: number): string {
    if (bytes <= 0) {
      return '--';
    }

    if (bytes < 1024) {
      return `${bytes} B`;
    }

    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }

    return `${value.toFixed(1)} ${units[unit]}`;
  }

  private async load(preloaded: VolumeDetailsPrefetch | null = null): Promise<void> {
    const name = this.volumeName();
    if (!name) {
      this.error.set('Invalid volume name.');
      return;
    }

    this.isLoading.set(preloaded === null);
    this.error.set(null);

    try {
      if (preloaded !== null) {
        if (preloaded.error) {
          this.error.set(preloaded.error);
          this.volume.set(null);
          this.containersInUse.set([]);
          return;
        }

        this.volume.set(preloaded.volume);
        this.containersInUse.set(preloaded.containersInUse);
        return;
      }

      const volume = await this.dockerApi.inspectVolume(name);
      this.volume.set(volume as DockerVolumeInfo);

      const containers = await this.dockerApi.listContainers();
      const inUse: DockerContainerInfo[] = [];
      const inspectResults = await Promise.allSettled(
        containers.map(container => this.dockerApi.inspectContainer(container.Id))
      );

      for (let idx = 0; idx < inspectResults.length; idx += 1) {
        const result = inspectResults[idx];
        if (!result || result.status !== 'fulfilled') {
          continue;
        }

        const mounts = result.value.Mounts;
        if (!Array.isArray(mounts)) {
          continue;
        }

        const isUsingVolume = mounts.some(mount => mount.Type === 'volume' && mount.Name === name);
        if (isUsingVolume) {
          const container = containers[idx];
          if (container) {
            inUse.push(container);
          }
        }
      }

      this.containersInUse.set(inUse);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load volume details.');
    } finally {
      this.isLoading.set(false);
    }
  }
}
