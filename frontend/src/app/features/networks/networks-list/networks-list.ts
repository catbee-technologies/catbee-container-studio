import { CommonModule } from '@angular/common';
import { Component, HostListener, computed, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { CopyButtonComponent } from '@components/copy-button/copy-button';
import { DockerApiService } from '@core/docker-api.service';
import { ConfirmDialogComponent } from '@components/dialog/confirm-dialog';
import { DialogComponent } from '@components/dialog/dialog';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { SearchInputComponent } from '@components/search-input/search-input';
import { SegmentedFilterComponent, SegmentedFilterOption } from '@components/segmented-filter/segmented-filter';
import { SwitchInputComponent } from '@components/switch-input/switch-input';
import { TableCheckboxComponent } from '@components/table-checkbox/table-checkbox';
import { TableSortHeaderComponent } from '@components/table-sort-header/table-sort-header';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { TooltipDateComponent } from '@components/tooltip-date/tooltip-date';
import {
  ColumnOption,
  TableColumnActionsMenuComponent
} from '@components/table-column-actions-menu/table-column-actions-menu';
import { LocalStorageService, SessionStorageService } from '@ng-catbee/storage';
import { DockerNetworkInfo } from '@shared/types/docker-api.types';
import {
  NETWORK_SORT_KEYS,
  NETWORK_USAGE_FILTERS,
  NetworkSortKey,
  NetworkUsageFilter,
  SORT_DIRECTIONS,
  SortDirection
} from '@shared/types';
import { removeStalePrefixedStorageEntries, UI_STORAGE_DEFAULTS, UI_STORAGE_KEYS } from '@utils/storage.utils';
import { CatbeeLoader } from '@ng-catbee/loader';

type NetworkColumn = 'id' | 'driver' | 'subnet' | 'flags' | 'containers' | 'created';
type NetworkAction = 'remove';

@Component({
  selector: 'catbee-container-studio-networks-page',
  imports: [
    CommonModule,
    SearchInputComponent,
    SegmentedFilterComponent,
    SwitchInputComponent,
    TableCheckboxComponent,
    TableSortHeaderComponent,
    TableColumnActionsMenuComponent,
    TooltipDateComponent,
    CopyButtonComponent,
    ConfirmDialogComponent,
    DialogComponent,
    EmptyStateComponent,
    ErrorBannerComponent,
    CatbeeTooltip,
    CatbeeLoader
  ],
  templateUrl: './networks-list.html',
  styleUrl: './networks-list.scss'
})
export class NetworksPage {
  private readonly dockerApi = inject(DockerApiService);
  private readonly router = inject(Router);
  private readonly localStorage = inject(LocalStorageService);
  private readonly sessionStorage = inject(SessionStorageService);
  private readonly networkSearchInput = viewChild<SearchInputComponent>('networkSearchInput');

  readonly tooltipDelay = 300;
  readonly UI_STORAGE_KEYS = UI_STORAGE_KEYS;
  readonly networks = signal<DockerNetworkInfo[]>([]);
  readonly searchTerm = signal(this.sessionStorage.getWithDefault(UI_STORAGE_KEYS.NETWORKS_SEARCH_QUERY, ''));
  readonly usageFilter = signal<NetworkUsageFilter>(
    this.localStorage.getEnumWithDefault(
      UI_STORAGE_KEYS.NETWORKS_USAGE_FILTER,
      UI_STORAGE_DEFAULTS.NETWORKS_USAGE_FILTER,
      NETWORK_USAGE_FILTERS
    )
  );
  readonly sortKey = signal<NetworkSortKey>(
    this.localStorage.getEnumWithDefault(
      UI_STORAGE_KEYS.NETWORKS_SORT_KEY,
      UI_STORAGE_DEFAULTS.NETWORKS_SORT_KEY,
      NETWORK_SORT_KEYS
    )
  );
  readonly sortDirection = signal<SortDirection>(
    this.localStorage.getEnumWithDefault(
      UI_STORAGE_KEYS.NETWORKS_SORT_DIRECTION,
      UI_STORAGE_DEFAULTS.NETWORKS_SORT_DIRECTION,
      SORT_DIRECTIONS
    )
  );
  readonly selectedNetworkIds = signal<Set<string>>(new Set());
  readonly isLoading = signal(false);
  readonly isRefreshing = signal(false);
  readonly error = signal<string | null>(null);
  readonly pendingDeleteNetworkIds = signal<string[]>([]);
  readonly confirmPruneOpen = signal(false);
  readonly createDialogOpen = signal(false);
  readonly networkName = signal('');
  readonly networkDriver = signal('bridge');
  readonly networkInternal = signal(false);
  readonly networkAttachable = signal(false);
  readonly isCreating = signal(false);
  readonly createError = signal<string | null>(null);
  readonly columnOptions: ColumnOption<NetworkColumn>[] = [
    { key: 'id', label: 'ID' },
    { key: 'driver', label: 'Driver' },
    { key: 'subnet', label: 'Subnet' },
    { key: 'flags', label: 'Flags' },
    { key: 'containers', label: 'Containers' },
    { key: 'created', label: 'Created' }
  ];
  readonly defaultVisibleColumns: NetworkColumn[] = ['driver', 'subnet', 'containers', 'created'];
  readonly visibleColumns = signal<Set<NetworkColumn>>(
    new Set(
      this.localStorage.getArrayWithDefault<NetworkColumn>(
        UI_STORAGE_KEYS.NETWORKS_VISIBLE_COLUMNS,
        this.defaultVisibleColumns
      )
    )
  );

  readonly usageFilterOptions: readonly SegmentedFilterOption[] = [
    { value: 'all', label: 'All' },
    { value: 'used', label: 'Used' },
    { value: 'unused', label: 'Unused' }
  ];

  readonly filteredNetworks = computed(() => {
    const query = this.searchTerm().trim().toLowerCase();
    return this.networks().filter(network => {
      if (this.usageFilter() === 'used' && !this.isUsed(network)) return false;
      if (this.usageFilter() === 'unused' && this.isUsed(network)) return false;
      return (
        !query ||
        [network.Name, network.Driver, network.Id, this.networkAddress(network)].some(value =>
          value.toLowerCase().includes(query)
        )
      );
    });
  });

  readonly sortedNetworks = computed(() => {
    const key = this.sortKey();
    const direction = this.sortDirection() === 'asc' ? 1 : -1;
    return [...this.filteredNetworks()].sort((left, right) => {
      const base =
        key === 'used'
          ? Number(this.isUsed(left)) - Number(this.isUsed(right))
          : key === 'name'
            ? left.Name.localeCompare(right.Name)
            : key === 'driver'
              ? left.Driver.localeCompare(right.Driver)
              : key === 'subnet'
                ? this.networkSubnetValue(left) - this.networkSubnetValue(right)
                : key === 'containers'
                  ? this.connectedContainerCount(left) - this.connectedContainerCount(right)
                  : this.createdUnix(left) - this.createdUnix(right);
      return base === 0 ? left.Name.localeCompare(right.Name) * direction : base * direction;
    });
  });

  readonly selectedCount = computed(() => this.selectedNetworkIds().size);
  readonly allVisibleSelected = computed(() => {
    const visible = this.sortedNetworks();
    return visible.length > 0 && visible.every(network => this.selectedNetworkIds().has(network.Id));
  });
  readonly partiallyVisibleSelected = computed(() => {
    const selected = this.sortedNetworks().filter(network => this.selectedNetworkIds().has(network.Id)).length;
    return selected > 0 && selected < this.sortedNetworks().length;
  });
  readonly pendingDeleteLabel = computed(() => {
    const ids = this.pendingDeleteNetworkIds();
    return ids.length === 1
      ? (this.networks().find(network => network.Id === ids[0])?.Name ?? ids[0] ?? '')
      : `${ids.length} networks`;
  });

  readonly activeNetworkActions = signal<Map<string, NetworkAction>>(new Map());
  readonly selectedDeletableNetworkCount = computed(
    () => this.networks().filter(network => this.selectedNetworkIds().has(network.Id) && !this.isUsed(network)).length
  );

  constructor() {
    void this.loadNetworks();
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      this.networkSearchInput()?.focusAndSelect();
    } else if (event.key === 'Escape') {
      this.clearSelection();
    }
  }

  async loadNetworks(): Promise<void> {
    const firstLoad = this.networks().length === 0;
    this.isLoading.set(firstLoad);
    this.isRefreshing.set(!firstLoad);
    this.error.set(null);
    try {
      const networks = await this.dockerApi.listNetworks();
      const inspectedNetworks = await Promise.all(
        networks.map(async network => {
          try {
            return await this.dockerApi.inspectNetwork(network.Id);
          } catch {
            return network;
          }
        })
      );
      this.networks.set(inspectedNetworks);
      removeStalePrefixedStorageEntries(
        UI_STORAGE_KEYS.NETWORKS_SELECTED_TAB_PREFIX,
        inspectedNetworks.map(network => network.Id)
      );
      this.clearSelection();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to load networks.');
    } finally {
      this.isLoading.set(false);
      this.isRefreshing.set(false);
    }
  }

  setSearchTerm(value: string): void {
    this.searchTerm.set(value);
    this.sessionStorage.set(UI_STORAGE_KEYS.NETWORKS_SEARCH_QUERY, value);
  }

  setUsageFilter(value: string): void {
    if (value === 'all' || value === 'used' || value === 'unused') {
      this.usageFilter.set(value);
      this.localStorage.set(UI_STORAGE_KEYS.NETWORKS_USAGE_FILTER, value);
    }
  }

  toggleSort(key: NetworkSortKey): void {
    if (this.sortKey() === key) {
      this.sortDirection.update(direction => {
        const next: SortDirection = direction === 'asc' ? 'desc' : 'asc';
        this.localStorage.set(UI_STORAGE_KEYS.NETWORKS_SORT_DIRECTION, next);
        return next;
      });
      return;
    }
    const direction: SortDirection = key === 'created' ? 'desc' : 'asc';
    this.sortKey.set(key);
    this.sortDirection.set(direction);
    this.localStorage.set(UI_STORAGE_KEYS.NETWORKS_SORT_KEY, key);
    this.localStorage.set(UI_STORAGE_KEYS.NETWORKS_SORT_DIRECTION, direction);
  }

  isSortActive(key: NetworkSortKey): boolean {
    return this.sortKey() === key;
  }
  sortIndicator(key: NetworkSortKey): string {
    return this.sortKey() !== key ? 'unfold_more' : this.sortDirection() === 'asc' ? 'north' : 'south';
  }
  isUsed(network: DockerNetworkInfo): boolean {
    return Object.keys(network.Containers ?? {}).length > 0;
  }
  connectedContainerCount(network: DockerNetworkInfo): number {
    return Object.keys(network.Containers ?? {}).length;
  }

  networkAddress(network: DockerNetworkInfo): string {
    const config = network.IPAM?.Config?.[0];
    if (!config?.Subnet) {
      return '--';
    }
    return config.Gateway ? `${config.Subnet} (${config.Gateway})` : config.Subnet;
  }

  private networkSubnetValue(network: DockerNetworkInfo): number {
    const subnet = network.IPAM?.Config?.[0]?.Subnet?.split('/')[0];
    if (!subnet) {
      return 0;
    }

    return subnet.split('.').reduce((value, part) => value * 256 + Number(part), 0);
  }

  networkFlags(network: DockerNetworkInfo): string {
    return (
      [network.Internal && 'Internal', network.Attachable && 'Attachable', network.EnableIPv6 && 'IPv6']
        .filter((value): value is string => Boolean(value))
        .join(', ') || '--'
    );
  }

  openNetworkDetails(networkId: string): void {
    void this.router.navigate(['/networks', networkId], { state: { returnTo: this.router.url } });
  }

  toggleNetworkSelection(id: string): void {
    this.selectedNetworkIds.update(selected => {
      const next = new Set(selected);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  toggleSelectAllVisible(): void {
    const ids = this.sortedNetworks().map(network => network.Id);
    this.selectedNetworkIds.update(selected => {
      const next = new Set(selected);
      const allSelected = ids.every(id => next.has(id));
      for (const id of ids) {
        if (allSelected) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
  }

  clearSelection(): void {
    this.selectedNetworkIds.set(new Set());
  }

  requestDeleteSingle(network: DockerNetworkInfo): void {
    if (this.isUsed(network)) {
      return;
    }

    this.pendingDeleteNetworkIds.set([network.Id]);
  }

  requestDeleteSelected(): void {
    const ids = this.sortedNetworks()
      .filter(network => this.selectedNetworkIds().has(network.Id) && !this.isUsed(network))
      .map(network => network.Id);

    if (ids.length === 0) {
      return;
    }

    this.pendingDeleteNetworkIds.set(ids);
  }

  private setNetworkAction(id: string, action: NetworkAction): void {
    this.activeNetworkActions.update(current => {
      const next = new Map(current);
      next.set(id, action);
      return next;
    });
  }

  private clearNetworkAction(id: string): void {
    this.activeNetworkActions.update(current => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }

  cancelDelete(): void {
    this.pendingDeleteNetworkIds.set([]);
  }

  async confirmDelete(): Promise<void> {
    const ids = this.pendingDeleteNetworkIds();
    if (ids.length === 0) return;

    this.pendingDeleteNetworkIds.set([]);
    this.error.set(null);

    const failedNames: string[] = [];
    const networksById = new Map(this.networks().map(network => [network.Id, network]));

    const deletableIds = ids.filter(id => {
      const network = networksById.get(id);
      return network && !this.isUsed(network);
    });

    for (const id of deletableIds) {
      this.setNetworkAction(id, 'remove');
    }

    await Promise.all(
      deletableIds.map(async id => {
        try {
          await this.dockerApi.removeNetwork(id);
        } catch {
          failedNames.push(networksById.get(id)?.Name ?? id);
        } finally {
          this.clearNetworkAction(id);
        }
      })
    );

    await this.loadNetworks();

    if (failedNames.length > 0) {
      this.error.set(`Could not delete network${failedNames.length === 1 ? '' : 's'}: ${failedNames.join(', ')}`);
    }
  }

  async confirmPrune(): Promise<void> {
    this.confirmPruneOpen.set(false);
    try {
      await this.dockerApi.pruneNetworks();
      await this.loadNetworks();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to prune networks.');
    }
  }

  openCreateDialog(): void {
    this.networkName.set('');
    this.networkDriver.set('bridge');
    this.networkInternal.set(false);
    this.networkAttachable.set(false);
    this.createError.set(null);
    this.createDialogOpen.set(true);
  }
  closeCreateDialog(): void {
    if (!this.isCreating()) this.createDialogOpen.set(false);
  }

  async createNetwork(): Promise<void> {
    const name = this.networkName().trim();
    if (!name || this.isCreating()) return;
    this.isCreating.set(true);
    this.createError.set(null);
    try {
      await this.dockerApi.createNetwork({
        Name: name,
        Driver: this.networkDriver(),
        Internal: this.networkInternal(),
        Attachable: this.networkAttachable()
      });
      this.createDialogOpen.set(false);
      await this.loadNetworks();
    } catch (error) {
      this.createError.set(error instanceof Error ? error.message : 'Failed to create network.');
    } finally {
      this.isCreating.set(false);
    }
  }

  private createdUnix(network: DockerNetworkInfo): number {
    const timestamp = network.Created ? Date.parse(network.Created) : 0;
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
}
