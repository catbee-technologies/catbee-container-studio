import { CommonModule, DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { combineLatest } from 'rxjs';
import { DockerApiService } from '@core/docker-api.service';
import { DockerContainerInfo, DockerImageHistoryInfo, DockerImageInspectInfo } from '@shared/types/docker-api.types';
import { DATE_FORMAT, formatDockerBytes, formatDockerNames } from '@utils/docker-display.utils';
import { TabsComponent, TabItem } from '@components/tabs/tabs';
import { ImageDetailsPrefetch } from './image-details.resolver';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { SessionStorageService } from '@ng-catbee/storage';
import { UI_STORAGE_KEYS } from '@utils/storage.utils';
import { CopyButtonComponent } from '@components/copy-button/copy-button';
import { RunContainerDialogComponent } from '@docker-images/run-container-dialog/run-container-dialog';

enum ImageDetailsTab {
  Layers = 'layers',
  Containers = 'containers'
}

@Component({
  selector: 'catbee-container-studio-image-details-page',
  imports: [
    CommonModule,
    TabsComponent,
    EmptyStateComponent,
    ErrorBannerComponent,
    CopyButtonComponent,
    RunContainerDialogComponent
  ],
  templateUrl: './image-details.html',
  styleUrl: './image-details.scss'
})
export class ImageDetailsPage {
  private readonly dockerApi = inject(DockerApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly datePipe = inject(DatePipe);
  private readonly sessionStorage = inject(SessionStorageService);

  readonly imageId = signal('');
  readonly inspectData = signal<DockerImageInspectInfo | null>(null);
  readonly inUseByContainers = signal<DockerContainerInfo[]>([]);
  readonly history = signal<DockerImageHistoryInfo[]>([]);
  readonly isLoading = signal(false);
  readonly error = signal<string | null>(null);
  readonly activeTab = signal<ImageDetailsTab>(ImageDetailsTab.Layers);
  readonly runDialogOpen = signal(false);
  readonly tabs: readonly TabItem[] = [
    { id: 'layers', label: 'Layers', icon: 'layers' },
    { id: 'containers', label: 'Containers using this image', icon: 'deployed_code' }
  ];

  readonly runImageReference = computed(() => this.inspectData()?.RepoTags?.[0] ?? this.imageId());

  readonly title = computed(() => {
    const tags = this.inspectData()?.RepoTags;
    if (tags && tags.length > 0) {
      return tags[0] ?? this.shortId(this.imageId());
    }

    return this.shortId(this.imageId());
  });

  readonly details = computed(() => {
    const inspect = this.inspectData();
    if (!inspect) {
      return [] as { label: string; value: string }[];
    }

    return [
      {
        label: 'Created',
        value: inspect.Created ? (this.datePipe.transform(new Date(inspect.Created), DATE_FORMAT) ?? '--') : '--'
      },
      { label: 'Author', value: inspect.Author ?? '--' },
      { label: 'OS / Arch', value: `${inspect.Os ?? '--'} / ${inspect.Architecture ?? '--'}` },
      { label: 'Entrypoint', value: inspect.Config?.Entrypoint?.join(' ') || '--' },
      { label: 'Cmd', value: inspect.Config?.Cmd?.join(' ') || '--' }
    ];
  });

  constructor() {
    const routeSub = combineLatest([this.route.paramMap, this.route.data]).subscribe(([params, data]) => {
      const id = params.get('id') ?? '';
      this.imageId.set(id);
      if (!id) {
        return;
      }

      this.activeTab.set(
        this.sessionStorage.getEnumWithDefault<ImageDetailsTab>(
          `${UI_STORAGE_KEYS.IMAGES_SELECTED_TAB_PREFIX}${id}`,
          ImageDetailsTab.Layers,
          Object.values(ImageDetailsTab)
        )
      );

      const preloaded = (data['preloadedImageDetails'] ?? null) as ImageDetailsPrefetch | null;
      void this.load(preloaded);
    });

    this.destroyRef.onDestroy(() => {
      routeSub.unsubscribe();
    });
  }

  backToImages(): void {
    void this.router.navigateByUrl(this.getReturnTo('/images'));
  }

  openContainer(containerId: string): void {
    void this.router.navigate(['/containers', containerId], { state: { returnTo: this.router.url } });
  }

  openRunDialog(): void {
    this.runDialogOpen.set(true);
  }

  closeRunDialog(): void {
    this.runDialogOpen.set(false);
  }

  onContainerCreated(containerId: string): void {
    this.runDialogOpen.set(false);
    this.openContainer(containerId);
  }

  formatContainerName(container: DockerContainerInfo): string {
    return formatDockerNames(container.Names);
  }

  shortId(rawId: string): string {
    return rawId.replace('sha256:', '').slice(0, 12);
  }

  shortLayerId(layer: string): string {
    return layer.replace('sha256:', '').slice(0, 12);
  }

  setActiveTab(tab: string): void {
    const allowedTabs = Object.values(ImageDetailsTab);
    if (!allowedTabs.includes(tab as ImageDetailsTab)) {
      return;
    }
    this.activeTab.set(tab as ImageDetailsTab);
    this.sessionStorage.set(`${UI_STORAGE_KEYS.IMAGES_SELECTED_TAB_PREFIX}${this.imageId()}`, tab);
  }

  private getReturnTo(fallback: string): string {
    const state = window.history.state as { returnTo?: string } | null;
    return typeof state?.returnTo === 'string' && state.returnTo.length > 0 ? state.returnTo : fallback;
  }

  formatSize(bytes: number): string {
    return formatDockerBytes(bytes, 1);
  }

  private async load(preloaded: ImageDetailsPrefetch | null = null): Promise<void> {
    const id = this.imageId();
    if (!id) {
      this.error.set('Invalid image id.');
      return;
    }

    this.isLoading.set(preloaded === null);
    this.error.set(null);

    try {
      if (preloaded !== null) {
        if (preloaded.error) {
          this.error.set(preloaded.error);
          this.inspectData.set(null);
          this.inUseByContainers.set([]);
          return;
        }

        this.inspectData.set(preloaded.inspectData ?? null);
        this.inUseByContainers.set(preloaded.inUseByContainers);
        this.history.set(preloaded.history);
        return;
      }

      const inspectRaw = await this.dockerApi.inspectImage(id);
      const inspect = inspectRaw ?? null;
      this.inspectData.set(inspect);

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

        const payload = result.value;
        const inspectImage = payload.ImageID ?? payload.Image;
        if (typeof inspectImage === 'string' && inspectImage === id) {
          const container = containers[idx];
          if (container) {
            inUse.push(container);
          }
        }
      }

      this.inUseByContainers.set(inUse);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load image details.');
    } finally {
      this.isLoading.set(false);
    }
  }
}
