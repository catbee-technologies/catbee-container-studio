import { CommonModule } from '@angular/common';
import { Component, HostListener, computed, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { DockerApiService } from '@core/docker-api.service';
import { DockerVolumeInfo } from '@shared/types/docker-api.types';
import { ConfirmDialogComponent } from '@components/dialog/confirm-dialog';
import { LocalStorageService, SessionStorageService } from '@ng-catbee/storage';
import { SegmentedFilterComponent, SegmentedFilterOption } from '@components/segmented-filter/segmented-filter';
import { SearchInputComponent } from '@components/search-input/search-input';
import { TableCheckboxComponent } from '@components/table-checkbox/table-checkbox';
import { UI_STORAGE_DEFAULTS, UI_STORAGE_KEYS } from '@utils/storage.utils';
import { formatDockerBytes } from '@utils/docker-display.utils';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import {
  SORT_DIRECTIONS,
  SortDirection,
  VOLUME_SORT_KEYS,
  VOLUME_USAGE_FILTERS,
  VolumeSortKey,
  VolumeUsageFilter
} from '@shared/types';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { TooltipDateComponent } from '@components/tooltip-date/tooltip-date';
import { DataTableComponent } from '@components/data-table/data-table';
import { DataTableColumnDef, DataTableHeaderDef } from '@components/data-table/data-table-defs.directive';
import { DataTableColumn } from '@components/data-table/data-table.types';

@Component({
  selector: 'catbee-container-studio-volumes-page',
  imports: [
    CommonModule,
    SearchInputComponent,
    ConfirmDialogComponent,
    SegmentedFilterComponent,
    TableCheckboxComponent,
    EmptyStateComponent,
    ErrorBannerComponent,
    CatbeeTooltip,
    TooltipDateComponent,
    DataTableComponent,
    DataTableColumnDef,
    DataTableHeaderDef
  ],
  templateUrl: './volumes-list.html',
  styleUrl: './volumes-list.scss'
})
export class VolumesPage {
  readonly columns: readonly DataTableColumn[] = [
    {
      id: 'checkbox',
      label: 'Select',
      hideable: false,
      width: 38,
      headerClass: 'col-checkbox',
      cellClass: 'col-checkbox'
    },
    { id: 'used', label: 'Used', sortable: true, width: 64, headerClass: 'col-used', cellClass: 'col-used' },
    { id: 'name', label: 'Name', sortable: true, hideable: false, minWidth: 140, width: 260 },
    { id: 'driver', label: 'Driver', sortable: true, minWidth: 90 },
    { id: 'size', label: 'Size', sortable: true, minWidth: 90 },
    { id: 'created', label: 'Created', sortable: true, minWidth: 120 },
    {
      id: 'actions',
      label: 'Actions',
      hideable: false,
      // frozen: 'end',
      width: 90,
      headerClass: 'col-actions',
      cellClass: 'col-actions'
    }
  ];

  readonly volumeKey = (volume: DockerVolumeInfo): string => volume.Name;
  private readonly dockerApi = inject(DockerApiService);
  private readonly router = inject(Router);
  private readonly localStorage = inject(LocalStorageService);
  private readonly sessionStorage = inject(SessionStorageService);

  private readonly volumeSearchInput = viewChild<SearchInputComponent>('volumeSearchInput');

  readonly tooltipDelay = 300;

  readonly volumes = signal<DockerVolumeInfo[]>([]);
  readonly searchTerm = signal(this.sessionStorage.getWithDefault(UI_STORAGE_KEYS.VOLUMES_SEARCH_QUERY, ''));
  readonly usageFilter = signal<VolumeUsageFilter>(
    this.localStorage.getEnumWithDefault<VolumeUsageFilter>(
      UI_STORAGE_KEYS.VOLUMES_USAGE_FILTER,
      UI_STORAGE_DEFAULTS.VOLUMES_USAGE_FILTER,
      VOLUME_USAGE_FILTERS
    )
  );
  readonly sortKey = signal<VolumeSortKey>(
    this.localStorage.getEnumWithDefault<VolumeSortKey>(
      UI_STORAGE_KEYS.VOLUMES_SORT_KEY,
      UI_STORAGE_DEFAULTS.VOLUMES_SORT_KEY,
      VOLUME_SORT_KEYS
    )
  );
  readonly sortDirection = signal<SortDirection>(
    this.localStorage.getEnumWithDefault<SortDirection>(
      UI_STORAGE_KEYS.VOLUMES_SORT_DIRECTION,
      UI_STORAGE_DEFAULTS.VOLUMES_SORT_DIRECTION,
      SORT_DIRECTIONS
    )
  );
  readonly selectedVolumeNames = signal<Set<string>>(new Set<string>());
  readonly usedVolumeNames = signal<Set<string>>(new Set<string>());
  readonly isLoading = signal(false);
  readonly isRefreshing = signal(false);
  readonly error = signal<string | null>(null);

  readonly pendingDeleteVolumeNames = signal<string[]>([]);
  readonly confirmPruneOpen = signal(false);
  readonly usageFilterOptions: readonly SegmentedFilterOption[] = [
    { value: 'all', label: 'All' },
    { value: 'used', label: 'Used' },
    { value: 'unused', label: 'Unused' }
  ];

  readonly filteredVolumes = computed(() => {
    const query = this.searchTerm().trim().toLowerCase();
    return this.volumes().filter(vol => {
      const usageFilter = this.usageFilter();
      const used = this.isUsed(vol.Name);

      if (usageFilter === 'used' && !used) {
        return false;
      }

      if (usageFilter === 'unused' && used) {
        return false;
      }

      if (!query) return true;
      return (
        vol.Name.toLowerCase().includes(query) ||
        vol.Driver.toLowerCase().includes(query) ||
        vol.Mountpoint.toLowerCase().includes(query)
      );
    });
  });

  readonly sortedVolumes = computed(() => {
    const key = this.sortKey();
    const direction = this.sortDirection() === 'asc' ? 1 : -1;

    return [...this.filteredVolumes()].sort((left, right) => {
      const base =
        key === 'used'
          ? Number(this.isUsed(left.Name)) - Number(this.isUsed(right.Name))
          : key === 'name'
            ? left.Name.localeCompare(right.Name)
            : key === 'driver'
              ? left.Driver.localeCompare(right.Driver)
              : key === 'scope'
                ? left.Scope.localeCompare(right.Scope)
                : key === 'size'
                  ? (left.UsageData?.Size ?? 0) - (right.UsageData?.Size ?? 0)
                  : this.createdUnix(left) - this.createdUnix(right);

      if (base !== 0) {
        return base * direction;
      }

      return left.Name.localeCompare(right.Name) * direction;
    });
  });

  readonly totalUsedSize = computed(() => this.volumes().reduce((acc, vol) => acc + (vol.UsageData?.Size ?? 0), 0));

  readonly allVisibleSelected = computed(() => {
    const visible = this.sortedVolumes();
    if (visible.length === 0) return false;
    const selected = this.selectedVolumeNames();
    return visible.every(item => selected.has(item.Name));
  });

  readonly partiallyVisibleSelected = computed(() => {
    const visible = this.sortedVolumes();
    if (visible.length === 0) return false;

    const selected = this.selectedVolumeNames();
    const selectedCount = visible.reduce((count, item) => (selected.has(item.Name) ? count + 1 : count), 0);
    return selectedCount > 0 && selectedCount < visible.length;
  });

  readonly selectedVolumes = computed(() => {
    const selected = this.selectedVolumeNames();
    return this.volumes().filter(item => selected.has(item.Name));
  });

  readonly selectedCount = computed(() => this.selectedVolumes().length);

  readonly pendingDeleteLabel = computed(() => {
    const names = this.pendingDeleteVolumeNames();
    if (names.length === 0) return '';
    if (names.length === 1) return names[0] ?? '';
    return `${names.length} volumes`;
  });

  constructor() {
    void this.loadVolumes();
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      this.volumeSearchInput()?.focusAndSelect();
      return;
    }

    if (event.key === 'Escape') {
      this.clearSelection();
    }
  }

  async loadVolumes(): Promise<void> {
    const first = this.volumes().length === 0;
    this.isLoading.set(first);
    this.isRefreshing.set(!first);
    this.error.set(null);

    try {
      const volumes = await this.dockerApi.listVolumes();
      this.volumes.set(volumes);
      this.clearSelection();
      void this.refreshVolumeUsage();
      void this.refreshUsedVolumes();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load volumes.');
    } finally {
      this.isLoading.set(false);
      this.isRefreshing.set(false);
    }
  }

  setSearchTerm(value: string): void {
    this.searchTerm.set(value);
    this.sessionStorage.set(UI_STORAGE_KEYS.VOLUMES_SEARCH_QUERY, value ?? '');
  }

  openVolumeDetails(name: string): void {
    void this.router.navigate(['/volumes', name], { state: { returnTo: this.router.url } });
  }

  clearSelection(): void {
    this.selectedVolumeNames.set(new Set<string>());
  }

  setUsageFilter(filter: string): void {
    if (this.isVolumeUsageFilter(filter)) {
      this.usageFilter.set(filter);
      this.localStorage.set(UI_STORAGE_KEYS.VOLUMES_USAGE_FILTER, filter);
    }
  }

  onSortChange(columnId: string): void {
    if ((VOLUME_SORT_KEYS as readonly string[]).includes(columnId)) {
      this.toggleSort(columnId as VolumeSortKey);
    }
  }

  toggleSort(key: VolumeSortKey): void {
    if (this.sortKey() === key) {
      this.sortDirection.update(value => {
        const nextDirection: SortDirection = value === 'asc' ? 'desc' : 'asc';
        this.localStorage.set(UI_STORAGE_KEYS.VOLUMES_SORT_DIRECTION, nextDirection);
        return nextDirection;
      });
      return;
    }

    const nextDirection: SortDirection = key === 'size' || key === 'created' ? 'desc' : 'asc';
    this.sortKey.set(key);
    this.sortDirection.set(nextDirection);
    this.localStorage.set(UI_STORAGE_KEYS.VOLUMES_SORT_KEY, key);
    this.localStorage.set(UI_STORAGE_KEYS.VOLUMES_SORT_DIRECTION, nextDirection);
  }

  isSortActive(key: VolumeSortKey): boolean {
    return this.sortKey() === key;
  }

  sortIndicator(key: VolumeSortKey): string {
    if (this.sortKey() !== key) {
      return 'unfold_more';
    }

    return this.sortDirection() === 'asc' ? 'north' : 'south';
  }

  toggleVolumeSelection(name: string): void {
    this.selectedVolumeNames.update(current => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  toggleSelectAllVisible(): void {
    const visibleNames = this.sortedVolumes().map(item => item.Name);
    if (visibleNames.length === 0) return;

    this.selectedVolumeNames.update(current => {
      const next = new Set(current);
      const allSelected = visibleNames.every(name => next.has(name));
      if (allSelected) {
        for (const name of visibleNames) {
          next.delete(name);
        }
      } else {
        for (const name of visibleNames) {
          next.add(name);
        }
      }
      return next;
    });
  }

  requestDeleteSingle(name: string): void {
    this.pendingDeleteVolumeNames.set([name]);
  }

  requestDeleteSelected(): void {
    const names = [...this.selectedVolumeNames()];
    if (names.length === 0) return;
    this.pendingDeleteVolumeNames.set(names);
  }

  cancelDelete(): void {
    this.pendingDeleteVolumeNames.set([]);
  }

  async confirmDelete(): Promise<void> {
    const names = this.pendingDeleteVolumeNames();
    if (names.length === 0) return;

    this.pendingDeleteVolumeNames.set([]);

    for (const name of names) {
      try {
        await this.dockerApi.removeVolume(name, false);
      } catch {
        // Continue removing remaining volumes and refresh state afterwards.
      }
    }

    try {
      await this.loadVolumes();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to delete volume.');
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
      await this.dockerApi.pruneVolumes();
      await this.loadVolumes();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to prune volumes.');
    }
  }

  formatSize(bytes: number): string {
    if (bytes <= 0) return '--';
    return formatDockerBytes(bytes, 1);
  }

  isUsed(name: string): boolean {
    return this.usedVolumeNames().has(name);
  }

  private isVolumeUsageFilter(value: string | null): value is VolumeUsageFilter {
    return value === 'all' || value === 'used' || value === 'unused';
  }

  private createdUnix(volume: DockerVolumeInfo): number {
    if (!volume.CreatedAt) {
      return 0;
    }

    const value = Date.parse(volume.CreatedAt);
    return Number.isFinite(value) ? value : 0;
  }

  private async refreshVolumeUsage(): Promise<void> {
    try {
      const usageByName = await this.dockerApi.getVolumeUsage();
      this.volumes.update(volumes =>
        volumes.map(volume => ({
          ...volume,
          UsageData: usageByName[volume.Name] ?? volume.UsageData
        }))
      );
    } catch {
      return;
    }
  }

  private async refreshUsedVolumes(): Promise<void> {
    const used = new Set<string>();

    for (const volume of this.volumes()) {
      if ((volume.UsageData?.RefCount ?? 0) > 0) {
        used.add(volume.Name);
      }
    }

    try {
      const containers = await this.dockerApi.listContainers();
      const inspectResults = await Promise.allSettled(
        containers.map(container => this.dockerApi.inspectContainer(container.Id))
      );

      for (const result of inspectResults) {
        if (result.status !== 'fulfilled') {
          continue;
        }

        const mounts = result.value.Mounts;
        if (!Array.isArray(mounts)) {
          continue;
        }

        for (const mount of mounts) {
          if (mount.Type === 'volume' && typeof mount.Name === 'string') {
            used.add(mount.Name);
          }
        }
      }
    } catch {
      // Keep usage markers from volume usage data when container inspect fails.
    }

    this.usedVolumeNames.set(used);
  }
}
