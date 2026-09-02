import { CommonModule } from '@angular/common';
import { Component, HostListener, computed, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { DockerApiService } from '@core/docker-api.service';
import { DockerImageInfo } from '@shared/types/docker-api.types';
import { ConfirmDialogComponent } from '@components/dialog/confirm-dialog';
import { LocalStorageService, SessionStorageService } from '@ng-catbee/storage';
import { SearchInputComponent } from '@components/search-input/search-input';
import { SegmentedFilterComponent, SegmentedFilterOption } from '@components/segmented-filter/segmented-filter';
import { TableCheckboxComponent } from '@components/table-checkbox/table-checkbox';
import { TableSortHeaderComponent } from '@components/table-sort-header/table-sort-header';
import { UI_STORAGE_DEFAULTS, UI_STORAGE_KEYS } from '@utils/storage.utils';
import { formatDockerBytes } from '@utils/docker-display.utils';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import {
  IMAGE_SORT_KEYS,
  IMAGE_USAGE_FILTERS,
  ImageSortKey,
  ImageUsageFilter,
  SORT_DIRECTIONS,
  SortDirection
} from '@shared/types';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { CopyButtonComponent } from '@components/copy-button/copy-button';
import { TooltipDateComponent } from '@components/tooltip-date/tooltip-date';
import { PullImageDialogComponent } from '@docker-images/pull-image-dialog/pull-image-dialog';
import { RunContainerDialogComponent } from '@docker-images/run-container-dialog/run-container-dialog';

@Component({
  selector: 'catbee-container-studio-images-page',
  imports: [
    CommonModule,
    SearchInputComponent,
    ConfirmDialogComponent,
    SegmentedFilterComponent,
    TableCheckboxComponent,
    TableSortHeaderComponent,
    EmptyStateComponent,
    ErrorBannerComponent,
    CatbeeTooltip,
    CopyButtonComponent,
    TooltipDateComponent,
    PullImageDialogComponent,
    RunContainerDialogComponent
  ],
  templateUrl: './images-list.html',
  styleUrl: './images-list.scss'
})
export class ImagesPage {
  private readonly dockerApi = inject(DockerApiService);
  private readonly router = inject(Router);
  private readonly localStorage = inject(LocalStorageService);
  private readonly sessionStorage = inject(SessionStorageService);

  private readonly imageSearchInput = viewChild<SearchInputComponent>('imageSearchInput');

  readonly tooltipDelay = 300;

  readonly images = signal<DockerImageInfo[]>([]);
  readonly searchTerm = signal(this.sessionStorage.getWithDefault(UI_STORAGE_KEYS.IMAGES_SEARCH_QUERY, ''));
  readonly usageFilter = signal<ImageUsageFilter>(
    this.localStorage.getEnumWithDefault<ImageUsageFilter>(
      UI_STORAGE_KEYS.IMAGES_USAGE_FILTER,
      UI_STORAGE_DEFAULTS.IMAGES_USAGE_FILTER,
      IMAGE_USAGE_FILTERS
    )
  );
  readonly sortKey = signal<ImageSortKey>(
    this.localStorage.getEnumWithDefault<ImageSortKey>(
      UI_STORAGE_KEYS.IMAGES_SORT_KEY,
      UI_STORAGE_DEFAULTS.IMAGES_SORT_KEY,
      IMAGE_SORT_KEYS
    )
  );
  readonly sortDirection = signal<SortDirection>(
    this.localStorage.getEnumWithDefault<SortDirection>(
      UI_STORAGE_KEYS.IMAGES_SORT_DIRECTION,
      UI_STORAGE_DEFAULTS.IMAGES_SORT_DIRECTION,
      SORT_DIRECTIONS
    )
  );
  readonly selectedImageIds = signal<Set<string>>(new Set<string>());
  readonly isLoading = signal(false);
  readonly isRefreshing = signal(false);
  readonly error = signal<string | null>(null);

  readonly pendingDeleteImageIds = signal<string[]>([]);
  readonly confirmPruneOpen = signal(false);
  readonly pullDialogOpen = signal(false);
  readonly runDialogImage = signal<string | null>(null);
  readonly usageFilterOptions: readonly SegmentedFilterOption[] = [
    { value: 'all', label: 'All' },
    { value: 'used', label: 'Used' },
    { value: 'unused', label: 'Unused' },
    { value: 'dangling', label: 'Dangling' }
  ];

  readonly filteredImages = computed(() => {
    const query = this.searchTerm().trim().toLowerCase();
    return this.images().filter(img => {
      const usageFilter = this.usageFilter();
      const used = this.isUsed(img);
      const dangling = this.isDangling(img);

      if (usageFilter === 'used' && !used) {
        return false;
      }

      if (usageFilter === 'unused' && used) {
        return false;
      }

      if (usageFilter === 'dangling' && !dangling) {
        return false;
      }

      if (!query) return true;
      const [repo, tag] = this.repositoryAndTag(img);
      const tags = (img.RepoTags ?? []).join(' ').toLowerCase();
      const id = img.Id;
      return (
        tags.includes(query) ||
        id.includes(query) ||
        repo.toLowerCase().includes(query) ||
        tag.toLowerCase().includes(query)
      );
    });
  });

  readonly sortedImages = computed(() => {
    const key = this.sortKey();
    const direction = this.sortDirection() === 'asc' ? 1 : -1;

    return [...this.filteredImages()].sort((left, right) => {
      const leftRepoTag = this.repositoryAndTag(left);
      const rightRepoTag = this.repositoryAndTag(right);

      const base =
        key === 'used'
          ? Number(this.isUsed(left)) - Number(this.isUsed(right))
          : key === 'repository'
            ? leftRepoTag[0].localeCompare(rightRepoTag[0])
            : key === 'tag'
              ? leftRepoTag[1].localeCompare(rightRepoTag[1])
              : key === 'size'
                ? (left.Size ?? 0) - (right.Size ?? 0)
                : (left.Created ?? 0) - (right.Created ?? 0);

      if (base !== 0) return base * direction;
      return leftRepoTag[0].localeCompare(rightRepoTag[0]) * direction;
    });
  });

  readonly totalSize = computed(() => this.images().reduce((acc, img) => acc + (img.Size ?? 0), 0));

  readonly danglingCount = computed(
    () => this.images().filter(img => !img.RepoTags || img.RepoTags.length === 0).length
  );

  readonly allVisibleSelected = computed(() => {
    const visible = this.sortedImages();
    if (visible.length === 0) return false;
    const selected = this.selectedImageIds();
    return visible.every(item => selected.has(item.Id));
  });

  readonly partiallyVisibleSelected = computed(() => {
    const visible = this.sortedImages();
    if (visible.length === 0) return false;

    const selected = this.selectedImageIds();
    const selectedCount = visible.reduce((count, item) => (selected.has(item.Id) ? count + 1 : count), 0);
    return selectedCount > 0 && selectedCount < visible.length;
  });

  readonly selectedImages = computed(() => {
    const selected = this.selectedImageIds();
    return this.images().filter(item => selected.has(item.Id));
  });

  readonly selectedCount = computed(() => this.selectedImages().length);

  readonly pendingDeleteLabel = computed(() => {
    const ids = this.pendingDeleteImageIds();
    if (ids.length === 0) return '';
    if (ids.length === 1) {
      const image = this.images().find(item => item.Id === ids[0]);
      if (!image) return '';
      const [repository, tag] = this.repositoryAndTag(image);
      return `${repository}:${tag}`;
    }

    return `${ids.length} images`;
  });

  constructor() {
    void this.loadImages();
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      this.imageSearchInput()?.focusAndSelect();
      return;
    }

    if (event.key === 'Escape') {
      this.clearSelection();
    }
  }

  async loadImages(): Promise<void> {
    const first = this.images().length === 0;
    this.isLoading.set(first);
    this.isRefreshing.set(!first);
    this.error.set(null);

    try {
      const images = await this.dockerApi.listImages();
      this.images.set(images);
      this.clearSelection();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load images.');
    } finally {
      this.isLoading.set(false);
      this.isRefreshing.set(false);
    }
  }

  setSearchTerm(value: string): void {
    this.searchTerm.set(value);
    this.sessionStorage.set(UI_STORAGE_KEYS.IMAGES_SEARCH_QUERY, value ?? '');
  }

  openImageDetails(imageId: string): void {
    void this.router.navigate(['/images', imageId], { state: { returnTo: this.router.url } });
  }

  clearSelection(): void {
    this.selectedImageIds.set(new Set<string>());
  }

  setUsageFilter(filter: string): void {
    if (this.isImageUsageFilter(filter)) {
      this.usageFilter.set(filter);
      this.localStorage.set(UI_STORAGE_KEYS.IMAGES_USAGE_FILTER, filter);
    }
  }

  isSortActive(key: ImageSortKey): boolean {
    return this.sortKey() === key;
  }

  sortIndicator(key: ImageSortKey): string {
    if (this.sortKey() !== key) {
      return 'unfold_more';
    }

    return this.sortDirection() === 'asc' ? 'north' : 'south';
  }

  toggleSort(key: ImageSortKey): void {
    if (this.sortKey() === key) {
      this.sortDirection.update(value => {
        const nextDirection: SortDirection = value === 'asc' ? 'desc' : 'asc';
        this.localStorage.set(UI_STORAGE_KEYS.IMAGES_SORT_DIRECTION, nextDirection);
        return nextDirection;
      });
      return;
    }
    const nextDirection: SortDirection = key === 'created' || key === 'size' ? 'desc' : 'asc';
    this.sortKey.set(key);
    this.sortDirection.set(nextDirection);
    this.localStorage.set(UI_STORAGE_KEYS.IMAGES_SORT_KEY, key);
    this.localStorage.set(UI_STORAGE_KEYS.IMAGES_SORT_DIRECTION, nextDirection);
  }

  toggleImageSelection(imageId: string): void {
    this.selectedImageIds.update(current => {
      const next = new Set(current);
      if (next.has(imageId)) {
        next.delete(imageId);
      } else {
        next.add(imageId);
      }
      return next;
    });
  }

  toggleSelectAllVisible(): void {
    const visibleIds = this.sortedImages().map(item => item.Id);
    if (visibleIds.length === 0) {
      return;
    }

    this.selectedImageIds.update(current => {
      const next = new Set(current);
      const allSelected = visibleIds.every(id => next.has(id));

      if (allSelected) {
        for (const id of visibleIds) {
          next.delete(id);
        }
      } else {
        for (const id of visibleIds) {
          next.add(id);
        }
      }

      return next;
    });
  }

  requestDeleteSingle(imageId: string): void {
    this.pendingDeleteImageIds.set([imageId]);
  }

  requestDeleteSelected(): void {
    const ids = [...this.selectedImageIds()];
    if (ids.length === 0) {
      return;
    }

    this.pendingDeleteImageIds.set(ids);
  }

  cancelDelete(): void {
    this.pendingDeleteImageIds.set([]);
  }

  async confirmDelete(): Promise<void> {
    const ids = this.pendingDeleteImageIds();
    if (ids.length === 0) return;

    this.pendingDeleteImageIds.set([]);

    for (const id of ids) {
      try {
        await this.dockerApi.removeImage(id, false);
      } catch {
        // Continue removing remaining images and show a final refresh/error state.
      }
    }

    try {
      await this.loadImages();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to delete image.');
    }
  }

  requestPrune(): void {
    this.confirmPruneOpen.set(true);
  }

  cancelPrune(): void {
    this.confirmPruneOpen.set(false);
  }

  async confirmPrune(): Promise<void> {
    this.confirmPruneOpen.set(false);

    try {
      await this.dockerApi.pruneImages();
      await this.loadImages();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to prune images.');
    }
  }

  openPullDialog(): void {
    this.pullDialogOpen.set(true);
  }

  closePullDialog(): void {
    this.pullDialogOpen.set(false);
  }

  onImagePulled(): void {
    this.pullDialogOpen.set(false);
    void this.loadImages();
  }

  openRunDialog(image: DockerImageInfo): void {
    const [repository, tag] = this.repositoryAndTag(image);
    this.runDialogImage.set(repository === '<none>' ? image.Id : `${repository}:${tag}`);
  }

  closeRunDialog(): void {
    this.runDialogImage.set(null);
  }

  onContainerCreated(containerId: string): void {
    this.runDialogImage.set(null);
    void this.router.navigate(['/containers', containerId], { state: { returnTo: this.router.url } });
  }

  repositoryAndTag(image: DockerImageInfo): [string, string] {
    const primary = image.RepoTags?.[0] ?? '<none>:<none>';
    const idx = primary.lastIndexOf(':');
    if (idx < 0) return [primary, '<none>'];

    return [primary.slice(0, idx), primary.slice(idx + 1)];
  }

  shortId(image: DockerImageInfo): string {
    return image.Id.replace('sha256:', '').slice(0, 12);
  }

  formatSize(bytes: number): string {
    return formatDockerBytes(bytes, 1);
  }

  formatCreated(unixSeconds: number): Date {
    return new Date(unixSeconds * 1000);
  }

  isDangling(image: DockerImageInfo): boolean {
    return !image.RepoTags || image.RepoTags.length === 0;
  }

  isUsed(image: DockerImageInfo): boolean {
    return (image.Containers ?? 0) > 0;
  }

  private isImageUsageFilter(value: string | null): value is ImageUsageFilter {
    const validValues: ImageUsageFilter[] = ['all', 'used', 'unused', 'dangling'];
    return validValues.includes(value as ImageUsageFilter);
  }
}
