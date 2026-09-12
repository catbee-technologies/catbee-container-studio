import { CommonModule } from '@angular/common';
import { Component, DestroyRef, HostListener, computed, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { DockerApiService } from '@core/docker-api.service';
import { DockerContainerInfo, DockerStreamEventEnvelope } from '@shared/types/docker-api.types';
import { ConfirmDialogComponent } from '@components/dialog/confirm-dialog';
import { LocalStorageService, SessionStorageService } from '@ng-catbee/storage';
import { MenuComponent } from '@components/menu/menu';
import { PortListComponent } from '@components/port-list/port-list';
import { SearchInputComponent } from '@components/search-input/search-input';
import { TableCheckboxComponent } from '@components/table-checkbox/table-checkbox';
import { TableSortHeaderComponent } from '@components/table-sort-header/table-sort-header';
import {
  formatDockerBytes,
  formatDockerNames,
  formatDockerStatus,
  parseDockerStatus
} from '@utils/docker-display.utils';
import {
  LOGS_STORAGE_KEYS,
  removeStalePrefixedStorageEntries,
  UI_STORAGE_DEFAULTS,
  UI_STORAGE_KEYS
} from '@utils/storage.utils';
import { SwitchInputComponent } from '@components/switch-input/switch-input';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { CONTAINER_SORT_KEYS, ContainerSortKey, SORT_DIRECTIONS, SortDirection } from '@shared/types';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { CopyButtonComponent } from '@components/copy-button/copy-button';
import {
  ColumnOption,
  TableColumnActionsMenuComponent
} from '@components/table-column-actions-menu/table-column-actions-menu';
import { CatbeeLoader } from '@ng-catbee/loader';

type ContainerColumn =
  'name' | 'id' | 'image' | 'ports' | 'state' | 'status' | 'cpu' | 'memory' | 'disk' | 'network' | 'pids';
type ContainerAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'remove';

interface ContainerGroup {
  id: string;
  name: string;
  folder: string | null;
  containers: DockerContainerInfo[];
}

@Component({
  selector: 'catbee-container-studio-containers-page',
  imports: [
    CommonModule,
    SearchInputComponent,
    ConfirmDialogComponent,
    PortListComponent,
    MenuComponent,
    TableCheckboxComponent,
    TableSortHeaderComponent,
    SwitchInputComponent,
    EmptyStateComponent,
    ErrorBannerComponent,
    CatbeeTooltip,
    CopyButtonComponent,
    TableColumnActionsMenuComponent,
    CatbeeLoader
  ],
  templateUrl: './containers-list.html',
  styleUrl: './containers-list.scss'
})
export class ContainersPage {
  private static readonly STATS_POLL_MS = 10_000;

  readonly UI_STORAGE_KEYS = UI_STORAGE_KEYS;

  private readonly dockerApi = inject(DockerApiService);
  private readonly router = inject(Router);
  private readonly localStorage = inject(LocalStorageService);
  private readonly sessionStorage = inject(SessionStorageService);
  private readonly destroyRef = inject(DestroyRef);
  private isRuntimeSummaryUpdating = false;
  private eventsStreamId: string | null = null;
  private autoRefreshDebounce: ReturnType<typeof setTimeout> | null = null;
  private statsPollTimer: ReturnType<typeof setInterval> | null = null;

  private readonly containerSearchInput = viewChild<SearchInputComponent>('containerSearchInput');

  readonly tooltipDelay = 300;

  readonly containers = signal<DockerContainerInfo[]>([]);
  readonly searchTerm = signal(this.sessionStorage.getWithDefault(UI_STORAGE_KEYS.CONTAINERS_SEARCH_QUERY, ''));
  readonly showRunningOnly = signal(
    this.localStorage.getBooleanWithDefault(
      UI_STORAGE_KEYS.CONTAINERS_RUNNING_ONLY,
      UI_STORAGE_DEFAULTS.CONTAINERS_RUNNING_ONLY
    )
  );
  readonly sortKey = signal<ContainerSortKey>(
    this.localStorage.getEnumWithDefault<ContainerSortKey>(
      UI_STORAGE_KEYS.CONTAINERS_SORT_KEY,
      UI_STORAGE_DEFAULTS.CONTAINERS_SORT_KEY,
      CONTAINER_SORT_KEYS
    )
  );
  readonly sortDirection = signal<SortDirection>(
    this.localStorage.getEnumWithDefault<SortDirection>(
      UI_STORAGE_KEYS.CONTAINERS_SORT_DIRECTION,
      UI_STORAGE_DEFAULTS.CONTAINERS_SORT_DIRECTION,
      SORT_DIRECTIONS
    )
  );

  readonly isLoading = signal(false);
  readonly isRefreshing = signal(false);
  readonly error = signal<string | null>(null);
  readonly activeBulkAction = signal<ContainerAction | null>(null);

  readonly pendingDeleteContainerId = signal<string | null>(null);
  readonly pendingDeleteSelection = signal(false);

  readonly collapsedGroupIds = signal<Set<string>>(
    new Set<string>(this.sessionStorage.getArrayWithDefault<string>(UI_STORAGE_KEYS.CONTAINERS_COLLAPSED_GROUPS, []))
  );

  readonly selectedContainerIds = signal<Set<string>>(new Set<string>());
  readonly openContainerActionsMenuId = signal<string | null>(null);
  readonly openGroupActionsMenuId = signal<string | null>(null);
  readonly pendingDeleteGroup = signal<ContainerGroup | null>(null);
  readonly showBulkActionsMenu = signal(false);

  readonly runningCount = computed(() => this.containers().filter(item => item.State === 'running').length);
  readonly stoppedCount = computed(() => this.containers().filter(item => item.State !== 'running').length);

  readonly cpuUsageSummary = signal('--');
  readonly memoryUsageSummary = signal('--');
  readonly cpuUsagePercent = signal<number | null>(null);
  readonly memoryUsagePercent = signal<number | null>(null);
  private readonly previousContainerIoStats = new Map<
    string,
    {
      timestamp: number;
      diskReadBytes: number;
      diskWriteBytes: number;
      networkRxBytes: number;
      networkTxBytes: number;
    }
  >();
  readonly containerRuntimeStats = signal<
    Map<
      string,
      {
        cpuPercent: number;
        memoryUsage: number;
        memoryLimit: number;
        diskReadBytesPerSecond: number;
        diskWriteBytesPerSecond: number;
        networkRxBytesPerSecond: number;
        networkTxBytesPerSecond: number;
        pids: number;
      }
    >
  >(new Map());
  readonly activeContainerActions = signal<Map<string, ContainerAction>>(new Map());

  readonly allGroups = computed<ContainerGroup[]>(() => this.groupContainersByCompose(this.containers()));

  readonly visibleContainers = computed(() => {
    const query = this.searchTerm().trim().toLowerCase();
    const runningOnly = this.showRunningOnly();

    return this.containers().filter(container => {
      if (runningOnly && container.State !== 'running') {
        return false;
      }

      if (!query) {
        return true;
      }

      const name = this.primaryName(container).toLowerCase();
      const id = container.Id;
      const image = container.Image.toLowerCase();

      return name.includes(query) || id.toLowerCase().includes(query) || image.includes(query);
    });
  });

  readonly groupedContainers = computed<ContainerGroup[]>(() =>
    this.groupContainersByCompose(this.sortedContainers(this.visibleContainers()))
  );

  readonly groupColspan = computed(() => {
    const visible = this.visibleColumns();
    let metricsCount = 0;
    if (visible.has('cpu')) metricsCount++;
    if (visible.has('memory')) metricsCount++;
    if (visible.has('disk')) metricsCount++;
    if (visible.has('network')) metricsCount++;
    if (visible.has('pids')) metricsCount++;
    return visible.size + 1 - metricsCount;
  });

  readonly groupRuntimeStats = computed(() => {
    const statsMap = this.containerRuntimeStats();
    const result = new Map<
      string,
      {
        cpuPercent: number;
        memoryUsage: number;
        memoryLimit: number;
        diskReadBytesPerSecond: number;
        diskWriteBytesPerSecond: number;
        networkRxBytesPerSecond: number;
        networkTxBytesPerSecond: number;
      }
    >();

    for (const group of this.groupedContainers()) {
      let hasStats = false;
      let cpuPercent = 0;
      let memoryUsage = 0;
      let memoryLimit = 0;
      let diskReadBytesPerSecond = 0;
      let diskWriteBytesPerSecond = 0;
      let networkRxBytesPerSecond = 0;
      let networkTxBytesPerSecond = 0;

      for (const container of group.containers) {
        const stats = statsMap.get(container.Id);
        if (stats) {
          hasStats = true;
          cpuPercent += stats.cpuPercent;
          memoryUsage += stats.memoryUsage;
          if (stats.memoryLimit > memoryLimit) {
            memoryLimit = stats.memoryLimit;
          }
          diskReadBytesPerSecond += stats.diskReadBytesPerSecond;
          diskWriteBytesPerSecond += stats.diskWriteBytesPerSecond;
          networkRxBytesPerSecond += stats.networkRxBytesPerSecond;
          networkTxBytesPerSecond += stats.networkTxBytesPerSecond;
        }
      }

      if (hasStats) {
        result.set(group.id, {
          cpuPercent,
          memoryUsage,
          memoryLimit,
          diskReadBytesPerSecond,
          diskWriteBytesPerSecond,
          networkRxBytesPerSecond,
          networkTxBytesPerSecond
        });
      }
    }

    return result;
  });

  readonly selectedContainers = computed(() => {
    const ids = this.selectedContainerIds();
    if (ids.size === 0) {
      return [];
    }

    return this.containers().filter(container => ids.has(container.Id));
  });

  readonly selectedRunningCount = computed(
    () => this.selectedContainers().filter(container => container.State === 'running').length
  );

  readonly selectedPausedCount = computed(
    () => this.selectedContainers().filter(container => container.State === 'paused').length
  );

  readonly selectedStoppedCount = computed(
    () =>
      this.selectedContainers().filter(container => container.State !== 'running' && container.State !== 'paused')
        .length
  );

  readonly isSelectionPartiallyPaused = computed(
    () => this.selectedPausedCount() > 0 && this.selectedRunningCount() > 0
  );

  readonly allVisibleSelected = computed(() => {
    const visible = this.visibleContainers();
    if (visible.length === 0) {
      return false;
    }

    const selected = this.selectedContainerIds();
    return visible.every(container => selected.has(container.Id));
  });

  readonly partiallyVisibleSelected = computed(() => {
    const visible = this.visibleContainers();
    if (visible.length === 0) {
      return false;
    }

    const selected = this.selectedContainerIds();
    const selectedCount = visible.filter(container => selected.has(container.Id)).length;
    return selectedCount > 0 && selectedCount < visible.length;
  });

  readonly pendingDeleteContainer = computed(() => {
    const pendingId = this.pendingDeleteContainerId();
    if (!pendingId) {
      return null;
    }

    return this.containers().find(container => container.Id === pendingId) ?? null;
  });

  readonly columnOptions: ColumnOption<ContainerColumn>[] = [
    { key: 'id', label: 'ID' },
    { key: 'image', label: 'Image' },
    { key: 'ports', label: 'Ports' },
    { key: 'state', label: 'State' },
    { key: 'status', label: 'Status' },
    { key: 'cpu', label: 'CPU' },
    { key: 'memory', label: 'Memory' },
    { key: 'disk', label: 'Disk R/W' },
    { key: 'network', label: 'Network I/O' },
    { key: 'pids', label: 'PIDs' }
  ];

  readonly defaultVisibleColumns: ContainerColumn[] = ['name', 'id', 'image', 'ports', 'state', 'cpu', 'memory'];

  readonly visibleColumns = signal<Set<ContainerColumn>>(
    new Set([
      'name',
      ...this.localStorage.getArrayWithDefault<ContainerColumn>(
        UI_STORAGE_KEYS.CONTAINERS_VISIBLE_COLUMNS,
        this.defaultVisibleColumns
      )
    ])
  );

  constructor() {
    void this.loadContainers(true);
    void this.startEventStream();

    const unsubscribe = this.dockerApi.onStreamEvent(event => this.onDockerEvent(event));

    this.statsPollTimer = setInterval(() => {
      void this.loadContainers();
    }, ContainersPage.STATS_POLL_MS);

    this.destroyRef.onDestroy(() => {
      unsubscribe();
      if (this.autoRefreshDebounce) {
        clearTimeout(this.autoRefreshDebounce);
      }
      if (this.statsPollTimer) {
        clearInterval(this.statsPollTimer);
        this.statsPollTimer = null;
      }
      if (this.eventsStreamId) {
        void this.dockerApi.stopStream(this.eventsStreamId);
      }
    });
  }

  private async startEventStream(): Promise<void> {
    try {
      const result = await this.dockerApi.startEventsStream();
      this.eventsStreamId = result.streamId;
    } catch {
      // Docker events unavailable; auto-refresh won't work but the page still functions.
    }
  }

  private onDockerEvent(event: DockerStreamEventEnvelope): void {
    if (event.kind !== 'events' || event.type !== 'data') {
      return;
    }

    const data = event.data as Record<string, unknown> | null | undefined;
    if (!data || data['Type'] !== 'container') {
      return;
    }

    const action = String(data['Action'] ?? '');
    const triggers = ['start', 'stop', 'die', 'pause', 'unpause', 'create', 'destroy', 'rename', 'kill'];
    if (!triggers.includes(action)) {
      return;
    }

    if (this.autoRefreshDebounce) {
      clearTimeout(this.autoRefreshDebounce);
    }

    this.autoRefreshDebounce = setTimeout(() => {
      void this.loadContainers();
    }, 400);
  }

  async loadContainers(firstLoad = false): Promise<void> {
    this.error.set(null);

    if (firstLoad) {
      this.isLoading.set(true);
    } else {
      this.isRefreshing.set(true);
    }

    try {
      const containers = await this.dockerApi.listContainers();
      this.containers.set(containers);
      const containerIds = containers.map(container => container.Id);
      removeStalePrefixedStorageEntries(UI_STORAGE_KEYS.CONTAINERS_SELECTED_TAB_PREFIX, containerIds);
      removeStalePrefixedStorageEntries(UI_STORAGE_KEYS.CONTAINERS_FILES_PATH_PREFIX, containerIds);
      removeStalePrefixedStorageEntries(LOGS_STORAGE_KEYS.CLEARED_SINCE_PREFIX, containerIds);
      removeStalePrefixedStorageEntries(LOGS_STORAGE_KEYS.GLOBAL_CLEARED_SINCE_PREFIX, containerIds);
      this.syncCollapsedGroups(this.groupContainersByCompose(containers));
      this.syncSelectedContainers(containers);
      this.updateRuntimeSummaries(containers);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to load containers.');
      this.resetRuntimeSummaries();
    } finally {
      this.isLoading.set(false);
      this.isRefreshing.set(false);
    }
  }

  setSearchTerm(value: string): void {
    this.searchTerm.set(value);
    this.sessionStorage.set(UI_STORAGE_KEYS.CONTAINERS_SEARCH_QUERY, value ?? '');
  }

  toggleRunningOnly(): void {
    this.showRunningOnly.update(value => {
      const next = !value;
      this.localStorage.set(UI_STORAGE_KEYS.CONTAINERS_RUNNING_ONLY, next ? 'true' : 'false');
      return next;
    });
  }

  toggleSort(key: ContainerSortKey): void {
    if (this.sortKey() === key) {
      this.sortDirection.update(direction => {
        const nextDirection: SortDirection = direction === 'asc' ? 'desc' : 'asc';
        this.localStorage.set(UI_STORAGE_KEYS.CONTAINERS_SORT_DIRECTION, nextDirection);
        return nextDirection;
      });
      return;
    }

    const nextDirection: SortDirection = 'asc';
    this.sortKey.set(key);
    this.sortDirection.set(nextDirection);
    this.localStorage.set(UI_STORAGE_KEYS.CONTAINERS_SORT_KEY, key);
    this.localStorage.set(UI_STORAGE_KEYS.CONTAINERS_SORT_DIRECTION, nextDirection);
  }

  isSortActive(key: ContainerSortKey): boolean {
    return this.sortKey() === key;
  }

  sortIndicator(key: ContainerSortKey): string {
    if (this.sortKey() !== key) {
      return 'unfold_more';
    }

    return this.sortDirection() === 'asc' ? 'north' : 'south';
  }

  openContainer(containerId: string): void {
    void this.router.navigate(['/containers', containerId], { state: { returnTo: this.router.url } });
  }

  toggleGroupCollapse(groupId: string): void {
    this.collapsedGroupIds.update(current => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }

      this.sessionStorage.setArray(UI_STORAGE_KEYS.CONTAINERS_COLLAPSED_GROUPS, [...next]);
      return next;
    });
  }

  isGroupCollapsed(groupId: string): boolean {
    return this.collapsedGroupIds().has(groupId);
  }

  toggleGroupSelection(group: ContainerGroup): void {
    const ids = group.containers.map(container => container.Id);
    const current = this.selectedContainerIds();
    const allSelected = ids.length > 0 && ids.every(id => current.has(id));

    this.selectedContainerIds.update(existing => {
      const next = new Set(existing);
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

  isGroupSelected(group: ContainerGroup): boolean {
    if (group.containers.length === 0) {
      return false;
    }

    const selected = this.selectedContainerIds();
    return group.containers.every(container => selected.has(container.Id));
  }

  isGroupPartiallySelected(group: ContainerGroup): boolean {
    const selected = this.selectedContainerIds();
    const selectedCount = group.containers.filter(container => selected.has(container.Id)).length;
    return selectedCount > 0 && selectedCount < group.containers.length;
  }

  toggleContainerSelection(containerId: string): void {
    this.selectedContainerIds.update(current => {
      const next = new Set(current);
      if (next.has(containerId)) {
        next.delete(containerId);
      } else {
        next.add(containerId);
      }

      return next;
    });
  }

  isContainerSelected(containerId: string): boolean {
    return this.selectedContainerIds().has(containerId);
  }

  toggleSelectAllVisible(): void {
    const visibleIds = this.visibleContainers().map(container => container.Id);
    if (visibleIds.length === 0) {
      return;
    }

    const allSelected = this.allVisibleSelected();
    this.selectedContainerIds.update(current => {
      const next = new Set(current);
      for (const id of visibleIds) {
        if (allSelected) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }

      return next;
    });
  }

  toggleContainerActionsMenu(event: MouseEvent, containerId: string): void {
    event.stopPropagation();
    this.openContainerActionsMenuId.update(current => (current === containerId ? null : containerId));
  }

  closeContainerActionsMenu(): void {
    this.openContainerActionsMenuId.set(null);
  }

  toggleGroupActionsMenu(event: MouseEvent, groupId: string): void {
    event.stopPropagation();
    this.openGroupActionsMenuId.update(current => (current === groupId ? null : groupId));
  }

  closeGroupActionsMenu(): void {
    this.openGroupActionsMenuId.set(null);
  }

  toggleBulkActionsMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.showBulkActionsMenu.update(value => !value);
  }

  closeBulkActionsMenu(): void {
    this.showBulkActionsMenu.set(false);
  }

  clearSelection(): void {
    this.selectedContainerIds.set(new Set());
  }

  async startContainer(containerId: string): Promise<void> {
    await this.runContainerAction(containerId, 'start', async () => {
      await this.dockerApi.startContainer(containerId);
      await this.loadContainers();
    });
  }

  async stopContainer(containerId: string): Promise<void> {
    await this.runContainerAction(containerId, 'stop', async () => {
      await this.dockerApi.stopContainer(containerId);
      await this.loadContainers();
    });
  }

  async restartContainer(containerId: string): Promise<void> {
    await this.runContainerAction(containerId, 'restart', async () => {
      await this.dockerApi.restartContainer(containerId);
      await this.loadContainers();
    });
  }

  async pauseContainer(containerId: string): Promise<void> {
    await this.runContainerAction(containerId, 'pause', async () => {
      await this.dockerApi.pauseContainer(containerId);
      await this.loadContainers();
    });
  }

  async unpauseContainer(containerId: string): Promise<void> {
    await this.runContainerAction(containerId, 'unpause', async () => {
      await this.dockerApi.unpauseContainer(containerId);
      await this.loadContainers();
    });
  }

  requestDeleteContainer(containerId: string): void {
    this.pendingDeleteContainerId.set(containerId);
  }

  cancelDeleteContainer(): void {
    this.pendingDeleteContainerId.set(null);
  }

  confirmDeleteContainer(): void {
    const pending = this.pendingDeleteContainer();
    if (!pending) {
      return;
    }

    void this.removeContainer(pending.Id);
  }

  async removeContainer(containerId: string): Promise<void> {
    this.pendingDeleteContainerId.set(null);
    await this.runContainerAction(containerId, 'remove', async () => {
      await this.dockerApi.removeContainer(containerId, true);
      await this.loadContainers();
    });
  }

  requestDeleteSelected(): void {
    if (this.selectedContainers().length === 0) {
      return;
    }

    this.pendingDeleteSelection.set(true);
  }

  cancelDeleteSelected(): void {
    this.pendingDeleteSelection.set(false);
  }

  async removeSelectedContainers(): Promise<void> {
    this.pendingDeleteSelection.set(false);
    await this.runBulkAction(
      'remove',
      async container => {
        await this.dockerApi.removeContainer(container.Id, true);
      },
      () => true
    );
  }

  async startSelectedContainers(): Promise<void> {
    await this.runBulkAction(
      'start',
      async container => {
        await this.dockerApi.startContainer(container.Id);
      },
      container => container.State !== 'running' && container.State !== 'paused'
    );
  }

  async stopSelectedContainers(): Promise<void> {
    await this.runBulkAction(
      'stop',
      async container => {
        await this.dockerApi.stopContainer(container.Id);
      },
      container => container.State === 'running' || container.State === 'paused'
    );
  }

  async restartSelectedContainers(): Promise<void> {
    await this.runBulkAction(
      'restart',
      async container => {
        await this.dockerApi.restartContainer(container.Id);
      },
      () => true
    );
  }

  async pauseSelectedContainers(): Promise<void> {
    await this.runBulkAction(
      'pause',
      async container => {
        await this.dockerApi.pauseContainer(container.Id);
      },
      container => container.State === 'running'
    );
  }

  async unpauseSelectedContainers(): Promise<void> {
    await this.runBulkAction(
      'unpause',
      async container => {
        await this.dockerApi.unpauseContainer(container.Id);
      },
      container => container.State === 'paused'
    );
  }

  formatNames(names: string[]): string {
    return formatDockerNames(names);
  }

  primaryName(container: DockerContainerInfo): string {
    const first = container.Names[0] ?? container.Id;
    return first.replace(/^\//, '');
  }

  trackByContainerId(_: number, container: DockerContainerInfo): string {
    return container.Id;
  }

  pendingContainerDeleteMessage(): string {
    const pending = this.pendingDeleteContainer();
    if (!pending) {
      return 'Delete this container permanently? \n This action cannot be undone.';
    }

    return `Delete ${formatDockerNames(pending.Names)} permanently? \n This action cannot be undone.`;
  }

  pendingSelectionDeleteMessage(): string {
    return `Delete ${this.selectedContainers().length} selected containers permanently? \n This action cannot be undone.`;
  }

  pendingGroupDeleteMessage(): string {
    const group = this.pendingDeleteGroup();
    if (!group) {
      return 'Delete all containers in this group permanently? \n This action cannot be undone.';
    }
    return `Delete all ${group.containers.length} containers in group "${group.name}" permanently? \n This action cannot be undone.`;
  }

  isGroupActionActive(group: ContainerGroup): boolean {
    const active = this.activeContainerActions();
    return group.containers.some(c => active.has(c.Id));
  }

  canStartGroup(group: ContainerGroup): boolean {
    if (this.isGroupActionActive(group) || this.activeBulkAction() !== null) {
      return false;
    }
    return group.containers.some(c => c.State !== 'running' && c.State !== 'paused');
  }

  canStopGroup(group: ContainerGroup): boolean {
    if (this.isGroupActionActive(group) || this.activeBulkAction() !== null) {
      return false;
    }
    return group.containers.some(c => c.State === 'running' || c.State === 'paused');
  }

  canRestartOrDeleteGroup(group: ContainerGroup): boolean {
    if (this.isGroupActionActive(group) || this.activeBulkAction() !== null) {
      return false;
    }
    return group.containers.length > 0;
  }

  canRestartGroup(group: ContainerGroup): boolean {
    return this.canRestartOrDeleteGroup(group);
  }

  canPauseGroup(group: ContainerGroup): boolean {
    if (this.isGroupActionActive(group) || this.activeBulkAction() !== null) {
      return false;
    }
    return group.containers.some(c => c.State === 'running');
  }

  canUnpauseGroup(group: ContainerGroup): boolean {
    if (this.isGroupActionActive(group) || this.activeBulkAction() !== null) {
      return false;
    }
    return group.containers.some(c => c.State === 'paused');
  }

  isGroupStarted(group: ContainerGroup): boolean {
    return group.containers.some(c => c.State === 'running' || c.State === 'paused');
  }

  isGroupPartiallyStarted(group: ContainerGroup): boolean {
    const hasStarted = group.containers.some(c => c.State === 'running' || c.State === 'paused');
    const hasStopped = group.containers.some(c => c.State !== 'running' && c.State !== 'paused');
    return hasStarted && hasStopped;
  }

  isGroupPartiallyPaused(group: ContainerGroup): boolean {
    const hasRunning = group.containers.some(c => c.State === 'running');
    const hasPaused = group.containers.some(c => c.State === 'paused');
    return hasRunning && hasPaused;
  }

  canDeleteGroup(group: ContainerGroup): boolean {
    return this.canRestartOrDeleteGroup(group);
  }

  async startGroup(group: ContainerGroup): Promise<void> {
    await this.runGroupAction(
      group,
      'start',
      async container => {
        await this.dockerApi.startContainer(container.Id);
      },
      container => container.State !== 'running' && container.State !== 'paused'
    );
  }

  async stopGroup(group: ContainerGroup): Promise<void> {
    await this.runGroupAction(
      group,
      'stop',
      async container => {
        await this.dockerApi.stopContainer(container.Id);
      },
      container => container.State === 'running' || container.State === 'paused'
    );
  }

  async restartGroup(group: ContainerGroup): Promise<void> {
    await this.runGroupAction(
      group,
      'restart',
      async container => {
        await this.dockerApi.restartContainer(container.Id);
      },
      () => true
    );
  }

  async pauseGroup(group: ContainerGroup): Promise<void> {
    await this.runGroupAction(
      group,
      'pause',
      async container => {
        await this.dockerApi.pauseContainer(container.Id);
      },
      container => container.State === 'running'
    );
  }

  async unpauseGroup(group: ContainerGroup): Promise<void> {
    await this.runGroupAction(
      group,
      'unpause',
      async container => {
        await this.dockerApi.unpauseContainer(container.Id);
      },
      container => container.State === 'paused'
    );
  }

  requestDeleteGroup(group: ContainerGroup): void {
    this.pendingDeleteGroup.set(group);
  }

  cancelDeleteGroup(): void {
    this.pendingDeleteGroup.set(null);
  }

  async confirmDeleteGroup(): Promise<void> {
    const group = this.pendingDeleteGroup();
    if (!group) {
      return;
    }
    this.pendingDeleteGroup.set(null);
    await this.runGroupAction(
      group,
      'remove',
      async container => {
        await this.dockerApi.removeContainer(container.Id, true);
      },
      () => true
    );
  }

  openImageDetails(imageRef: string): void {
    if (!imageRef) {
      return;
    }
    void this.router.navigate(['/images', imageRef], { state: { returnTo: this.router.url } });
  }

  private async runContainerAction(
    containerId: string,
    actionName: ContainerAction,
    action: () => Promise<void>
  ): Promise<void> {
    this.setContainerAction(containerId, actionName);
    this.error.set(null);

    try {
      await action();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Container action failed.');
    } finally {
      this.clearContainerAction(containerId);
    }
  }

  private async runBulkAction(
    actionName: ContainerAction,
    action: (container: DockerContainerInfo) => Promise<void>,
    predicate: (container: DockerContainerInfo) => boolean
  ): Promise<void> {
    this.error.set(null);
    this.activeBulkAction.set(actionName);

    try {
      const targets = this.selectedContainers().filter(predicate);
      const failedContainers: string[] = [];

      for (const container of targets) {
        this.setContainerAction(container.Id, actionName);
      }

      await Promise.all(
        targets.map(async container => {
          try {
            await action(container);
          } catch {
            failedContainers.push(this.primaryName(container));
          } finally {
            this.clearContainerAction(container.Id);
          }
        })
      );

      await this.loadContainers();

      if (failedContainers.length > 0) {
        this.error.set(
          `Failed to ${actionName} ${
            failedContainers.length === 1 ? 'container' : 'containers'
          }: ${failedContainers.join(', ')}`
        );
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Bulk action failed.');
    } finally {
      this.clearSelection();
      this.activeBulkAction.set(null);
    }
  }

  private async runGroupAction(
    group: ContainerGroup,
    actionName: ContainerAction,
    action: (container: DockerContainerInfo) => Promise<void>,
    predicate: (container: DockerContainerInfo) => boolean
  ): Promise<void> {
    this.error.set(null);

    try {
      const targets = group.containers.filter(predicate);
      if (targets.length === 0) {
        return;
      }

      const failedContainers: string[] = [];

      for (const container of targets) {
        this.setContainerAction(container.Id, actionName);
      }

      await Promise.all(
        targets.map(async container => {
          try {
            await action(container);
          } catch {
            failedContainers.push(this.primaryName(container));
          } finally {
            this.clearContainerAction(container.Id);
          }
        })
      );

      if (actionName === 'remove') {
        const targetIds = new Set(targets.map(t => t.Id));
        this.selectedContainerIds.update(current => {
          const next = new Set(current);
          for (const id of targetIds) {
            next.delete(id);
          }
          return next;
        });
      }

      await this.loadContainers();

      if (failedContainers.length > 0) {
        this.error.set(
          `Failed to ${actionName} ${
            failedContainers.length === 1 ? 'container' : 'containers'
          } in group "${group.name}": ${failedContainers.join(', ')}`
        );
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Group action failed.');
    }
  }

  private groupContainersByCompose(containers: DockerContainerInfo[]): ContainerGroup[] {
    const groups = new Map<string, ContainerGroup>();

    for (const container of containers) {
      const composeProject = container.Labels?.['com.docker.compose.project'] ?? null;
      const composeFolderRaw = container.Labels?.['com.docker.compose.project.working_dir'] ?? null;
      const folder = this.extractFolderName(composeFolderRaw);

      const groupId = composeProject ?? 'standalone';
      const group = groups.get(groupId) ?? {
        id: groupId,
        name: composeProject ? `${composeProject}` : 'Standalone Containers',
        folder,
        containers: []
      };

      group.containers.push(container);
      groups.set(groupId, group);
    }

    return Array.from(groups.values()).sort((a, b) => {
      if (a.id === 'standalone') {
        return -1;
      }

      if (b.id === 'standalone') {
        return 1;
      }

      return a.name.localeCompare(b.name);
    });
  }

  private sortedContainers(containers: DockerContainerInfo[]): DockerContainerInfo[] {
    const key = this.sortKey();
    const direction = this.sortDirection() === 'asc' ? 1 : -1;

    return [...containers].sort((left, right) => {
      let result = 0;

      if (key === 'name') {
        result = this.primaryName(left).localeCompare(this.primaryName(right));
      } else if (key === 'id') {
        result = left.Id.localeCompare(right.Id);
      } else if (key === 'image') {
        result = left.Image.localeCompare(right.Image);
      } else if (key === 'ports') {
        result = left.Ports.length - right.Ports.length;
      } else if (key === 'state') {
        result = left.State.localeCompare(right.State);
      } else if (key === 'status') {
        result = (left.Status ?? '').localeCompare(right.Status ?? '');
      } else if (key === 'cpu') {
        const leftCpu = this.containerRuntimeStats().get(left.Id)?.cpuPercent ?? 0;
        const rightCpu = this.containerRuntimeStats().get(right.Id)?.cpuPercent ?? 0;
        result = leftCpu - rightCpu;
      } else if (key === 'memory') {
        const leftMemory = this.containerRuntimeStats().get(left.Id)?.memoryUsage ?? 0;
        const rightMemory = this.containerRuntimeStats().get(right.Id)?.memoryUsage ?? 0;
        result = leftMemory - rightMemory;
      } else if (key === 'disk') {
        const leftDisk = this.containerRuntimeStats().get(left.Id)?.diskReadBytesPerSecond ?? 0;
        const rightDisk = this.containerRuntimeStats().get(right.Id)?.diskReadBytesPerSecond ?? 0;
        result = leftDisk - rightDisk;
      } else if (key === 'network') {
        const leftNetwork = this.containerRuntimeStats().get(left.Id)?.networkTxBytesPerSecond ?? 0;
        const rightNetwork = this.containerRuntimeStats().get(right.Id)?.networkTxBytesPerSecond ?? 0;
        result = leftNetwork - rightNetwork;
      } else if (key === 'pids') {
        const leftPids = this.containerRuntimeStats().get(left.Id)?.pids ?? 0;
        const rightPids = this.containerRuntimeStats().get(right.Id)?.pids ?? 0;
        result = leftPids - rightPids;
      }

      if (result === 0) {
        result = this.primaryName(left).localeCompare(this.primaryName(right));
      }

      return result * direction;
    });
  }

  private extractFolderName(rawPath: string | null): string | null {
    if (!rawPath) {
      return null;
    }

    const normalized = rawPath.replace(/\\/g, '/').split('/').filter(Boolean);
    return normalized.length > 0 ? normalized[normalized.length - 1] : null;
  }

  private setContainerAction(containerId: string, action: ContainerAction): void {
    this.activeContainerActions.update(current => {
      const next = new Map(current);
      next.set(containerId, action);
      return next;
    });
  }

  private clearContainerAction(containerId: string): void {
    this.activeContainerActions.update(current => {
      const next = new Map(current);
      next.delete(containerId);
      return next;
    });
  }

  private syncCollapsedGroups(groups: ContainerGroup[]): void {
    const validIds = new Set(groups.map(group => group.id));

    this.collapsedGroupIds.update(current => {
      const next = new Set<string>();
      for (const id of current) {
        if (validIds.has(id)) {
          next.add(id);
        }
      }

      this.sessionStorage.setArray(UI_STORAGE_KEYS.CONTAINERS_COLLAPSED_GROUPS, [...next]);
      return next;
    });
  }

  private syncSelectedContainers(containers: DockerContainerInfo[]): void {
    const validIds = new Set(containers.map(container => container.Id));

    this.selectedContainerIds.update(current => {
      const next = new Set<string>();
      for (const id of current) {
        if (validIds.has(id)) {
          next.add(id);
        }
      }

      return next;
    });
  }

  usageLevel(value: number | null): 'normal' | 'warning' | 'high' | 'critical' {
    if (value === null) {
      return 'normal';
    }
    if (value >= 90) {
      return 'critical';
    }
    if (value >= 80) {
      return 'high';
    }
    if (value >= 60) {
      return 'warning';
    }
    return 'normal';
  }

  private resetRuntimeSummaries(): void {
    this.cpuUsagePercent.set(null);
    this.memoryUsagePercent.set(null);
    this.cpuUsageSummary.set('--');
    this.memoryUsageSummary.set('--');
    this.containerRuntimeStats.set(new Map());
    this.previousContainerIoStats.clear();
  }

  private async updateRuntimeSummaries(containers: DockerContainerInfo[]): Promise<void> {
    if (this.isRuntimeSummaryUpdating) {
      return;
    }

    this.isRuntimeSummaryUpdating = true;

    const running = containers.filter(container => container.State === 'running');
    const snapshotIds = new Set(containers.map(container => container.Id));

    try {
      if (running.length === 0) {
        this.resetRuntimeSummaries();
        return;
      }

      const statsResults = await Promise.all(
        running.map(async container => {
          if (!this.containers().some(c => c.Id === container.Id)) {
            return null;
          }

          try {
            const stats = await this.dockerApi.getContainerStats(container.Id);

            return {
              containerId: container.Id,
              stats
            };
          } catch {
            return null;
          }
        })
      );

      const currentIds = new Set(this.containers().map(container => container.Id));
      if (currentIds.size !== snapshotIds.size || [...snapshotIds].some(id => !currentIds.has(id))) {
        return;
      }

      const now = Date.now();
      const runtimeStats = new Map<
        string,
        {
          cpuPercent: number;
          memoryUsage: number;
          memoryLimit: number;
          diskReadBytesPerSecond: number;
          diskWriteBytesPerSecond: number;
          networkRxBytesPerSecond: number;
          networkTxBytesPerSecond: number;
          pids: number;
        }
      >();

      let cpuPercentSum = 0;
      let maxAvailableCpus = 1;
      let memoryUsageSum = 0;
      let memoryLimitMax = 0;

      for (const result of statsResults) {
        if (!result) {
          continue;
        }
        const { containerId, stats } = result;
        /* CPU */
        const cpuDelta =
          (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
        const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);

        const onlineCpus = stats.cpu_stats?.online_cpus ?? stats.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
        let cpuPercent = 0;

        if (cpuDelta > 0 && systemDelta > 0 && onlineCpus > 0) {
          cpuPercent = (cpuDelta / systemDelta) * onlineCpus * 100;
          cpuPercentSum += cpuPercent;
        }

        if (onlineCpus > maxAvailableCpus) {
          maxAvailableCpus = onlineCpus;
        }

        /* Memory */
        const memoryUsage = stats.memory_stats?.usage ?? 0;
        const memoryLimit = stats.memory_stats?.limit ?? 0;

        memoryUsageSum += memoryUsage;

        if (memoryLimit > memoryLimitMax) {
          memoryLimitMax = memoryLimit;
        }

        /* Disk I/O */
        let diskReadBytes = 0;
        let diskWriteBytes = 0;

        const blkioEntries = stats.blkio_stats?.io_service_bytes_recursive ?? [];

        for (const entry of blkioEntries) {
          const value = Number(entry.value ?? 0);

          if (!Number.isFinite(value) || value < 0) {
            continue;
          }

          if (entry.op?.toLowerCase() === 'read') {
            diskReadBytes += value;
          } else if (entry.op?.toLowerCase() === 'write') {
            diskWriteBytes += value;
          }
        }

        /* Network I/O */
        let networkRxBytes = 0;
        let networkTxBytes = 0;

        for (const network of Object.values(
          (stats.networks ?? {}) as Record<
            string,
            {
              rx_bytes?: number;
              tx_bytes?: number;
            }
          >
        )) {
          networkRxBytes += Number(network.rx_bytes ?? 0);
          networkTxBytes += Number(network.tx_bytes ?? 0);
        }

        /* Calculate I/O rates from the previous cumulative counters. */
        let diskReadBytesPerSecond = 0;
        let diskWriteBytesPerSecond = 0;
        let networkRxBytesPerSecond = 0;
        let networkTxBytesPerSecond = 0;

        const previous = this.previousContainerIoStats.get(containerId);

        if (previous) {
          const elapsedSeconds = (now - previous.timestamp) / 1000;

          if (elapsedSeconds > 0) {
            const diskReadDelta = diskReadBytes - previous.diskReadBytes;
            const diskWriteDelta = diskWriteBytes - previous.diskWriteBytes;
            const networkRxDelta = networkRxBytes - previous.networkRxBytes;
            const networkTxDelta = networkTxBytes - previous.networkTxBytes;

            if (diskReadDelta >= 0) {
              diskReadBytesPerSecond = diskReadDelta / elapsedSeconds;
            }

            if (diskWriteDelta >= 0) {
              diskWriteBytesPerSecond = diskWriteDelta / elapsedSeconds;
            }

            if (networkRxDelta >= 0) {
              networkRxBytesPerSecond = networkRxDelta / elapsedSeconds;
            }

            if (networkTxDelta >= 0) {
              networkTxBytesPerSecond = networkTxDelta / elapsedSeconds;
            }
          }
        }

        this.previousContainerIoStats.set(containerId, {
          timestamp: now,
          diskReadBytes,
          diskWriteBytes,
          networkRxBytes,
          networkTxBytes
        });

        /* PIDs */
        const pids = stats.pids_stats?.current ?? 0;
        runtimeStats.set(containerId, {
          cpuPercent,
          memoryUsage,
          memoryLimit,
          diskReadBytesPerSecond,
          diskWriteBytesPerSecond,
          networkRxBytesPerSecond,
          networkTxBytesPerSecond,
          pids
        });
      }

      /* Remove I/O baselines for containers that no longer exist. */
      for (const containerId of this.previousContainerIoStats.keys()) {
        if (!currentIds.has(containerId)) {
          this.previousContainerIoStats.delete(containerId);
        }
      }

      this.containerRuntimeStats.set(runtimeStats);

      /* CPU summary */
      const cpuCapacityPercent = maxAvailableCpus * 100;
      this.cpuUsagePercent.set(cpuCapacityPercent > 0 ? (cpuPercentSum / cpuCapacityPercent) * 100 : null);

      this.cpuUsageSummary.set(
        `${cpuPercentSum.toFixed(2)}% / ${(maxAvailableCpus * 100).toFixed(0)}% (${maxAvailableCpus} CPUs available)`
      );

      /* Memory summary */
      if (memoryLimitMax > 0) {
        this.memoryUsagePercent.set((memoryUsageSum / memoryLimitMax) * 100);
        this.memoryUsageSummary.set(`${formatDockerBytes(memoryUsageSum)} / ${formatDockerBytes(memoryLimitMax)}`);
      } else {
        this.memoryUsagePercent.set(null);
        this.memoryUsageSummary.set(`${formatDockerBytes(memoryUsageSum)} / --`);
      }
    } finally {
      this.isRuntimeSummaryUpdating = false;
    }
  }

  formatDockerBytes(bytes: number): string {
    return formatDockerBytes(bytes);
  }

  formatDockerStatus(status: string | null | undefined): string {
    return formatDockerStatus(status);
  }

  parseDockerStatus(status: string | null | undefined) {
    return parseDockerStatus(status);
  }

  formatIoRate(bytesPerSecond: number): string {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
      return '0 B/s';
    }
    if (bytesPerSecond < 1024) {
      return `${bytesPerSecond.toFixed(2)} B/s`;
    }
    return `${formatDockerBytes(bytesPerSecond)}/s`;
  }

  @HostListener('window:keydown', ['$event'])
  onWindowKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      this.containerSearchInput()?.focusAndSelect();
    }
  }
}
