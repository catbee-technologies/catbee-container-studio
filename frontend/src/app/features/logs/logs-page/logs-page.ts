import { Component, DestroyRef, computed, inject, signal, viewChild } from '@angular/core';
import { DockerApiService } from '@core/docker-api.service';
import {
  ContainerLogEntry,
  LogsDisplayOptions,
  LogsTabComponent
} from '@docker-containers/container-details/components/logs-tab/logs-tab';
import { DockerContainerInfo, DockerLogChannel, DockerStreamEventEnvelope } from '@shared/types/docker-api.types';
import { formatDockerNames } from '@utils/docker-display.utils';
import { MenuComponent } from '@components/menu/menu';
import { SearchInputComponent } from '@components/search-input/search-input';
import { TableCheckboxComponent } from '@components/table-checkbox/table-checkbox';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { LocalStorageService } from '@ng-catbee/storage';
import { LOGS_STORAGE_KEYS } from '@utils/storage.utils';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';

interface ActiveLogStream {
  containerId: string;
  containerName: string;
}

@Component({
  selector: 'catbee-container-studio-logs-page',
  imports: [
    LogsTabComponent,
    MenuComponent,
    SearchInputComponent,
    TableCheckboxComponent,
    CatbeeTooltip,
    EmptyStateComponent,
    ErrorBannerComponent
  ],
  templateUrl: './logs-page.html',
  styleUrl: './logs-page.scss',
  host: {
    '(window:keydown)': 'onWindowKeydown($event)'
  }
})
export class LogsPage {
  private static readonly MAX_LOG_ENTRIES = 5_000;
  readonly globalTailLineOptions = [50, 100, 200] as const;
  private readonly dockerApi = inject(DockerApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly localStorage = inject(LocalStorageService);
  private readonly logsTab = viewChild(LogsTabComponent);

  private readonly streams = new Map<string, ActiveLogStream>();
  private readonly chunkBuffers = new Map<string, Record<DockerLogChannel, string>>();
  private readonly startingContainerIds = new Set<string>();
  private readonly pendingEntries: ContainerLogEntry[] = [];
  private eventsStreamId: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEntriesFrame: number | null = null;
  private disposed = false;
  private initializedSelection = false;
  private readonly hasPersistedSelection =
    window.localStorage.getItem(LOGS_STORAGE_KEYS.GLOBAL_SELECTED_CONTAINERS) !== null;

  readonly tooltipDelay = 300;
  readonly containers = signal<DockerContainerInfo[]>([]);
  readonly selectedContainerIds = signal<Set<string>>(
    new Set(this.localStorage.getArrayWithDefault<string>(LOGS_STORAGE_KEYS.GLOBAL_SELECTED_CONTAINERS, []))
  );
  readonly containerSearch = signal('');
  readonly showContainerMenu = signal(false);
  readonly logs = signal<ContainerLogEntry[]>([]);
  readonly initialFollowPending = signal(true);
  readonly isLoading = signal(true);
  readonly error = signal<string | null>(null);
  readonly displayOptions = signal<LogsDisplayOptions>({
    showTimestamps: this.localStorage.getBooleanWithDefault(LOGS_STORAGE_KEYS.GLOBAL_SHOW_TIMESTAMPS, false),
    wrapLines: this.localStorage.getBooleanWithDefault(LOGS_STORAGE_KEYS.GLOBAL_WRAP_LINES, true),
    localDates: this.localStorage.getBooleanWithDefault(LOGS_STORAGE_KEYS.GLOBAL_LOCAL_DATES, false)
  });
  readonly logTailLines = signal(
    Number.parseInt(
      this.localStorage.getEnumWithDefault(
        LOGS_STORAGE_KEYS.GLOBAL_TAIL_LINES,
        '100',
        this.globalTailLineOptions.map(String)
      ),
      10
    )
  );

  readonly visibleContainers = computed(() => {
    const search = this.containerSearch().trim().toLowerCase();
    if (!search) {
      return this.containers();
    }
    return this.containers().filter(container => {
      const name = this.containerName(container).toLowerCase();
      return name.includes(search) || container.Id.toLowerCase().includes(search);
    });
  });
  readonly selectedCount = computed(() => this.selectedContainerIds().size);
  readonly hasContainerSearch = computed(() => this.containerSearch().trim().length > 0);
  readonly hasVisibleContainers = computed(() => this.visibleContainers().length > 0);
  readonly allVisibleSelected = computed(() => {
    const visible = this.visibleContainers();
    return visible.length > 0 && visible.every(container => this.selectedContainerIds().has(container.Id));
  });
  readonly hasSelectedVisibleContainers = computed(() => {
    const selected = this.selectedContainerIds();
    return this.visibleContainers().some(container => selected.has(container.Id));
  });
  readonly streamStatus = computed(() => `${this.streams.size} live stream${this.streams.size === 1 ? '' : 's'}`);

  constructor() {
    const unsubscribe = this.dockerApi.onStreamEvent(event => this.onStreamEvent(event));
    this.destroyRef.onDestroy(() => {
      this.disposed = true;
      unsubscribe();
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
      }
      if (this.pendingEntriesFrame !== null) {
        cancelAnimationFrame(this.pendingEntriesFrame);
      }
      this.pendingEntries.length = 0;
      const streamIds = [...this.streams.keys()];
      this.streams.clear();
      for (const streamId of streamIds) {
        void this.dockerApi.stopStream(streamId);
      }
      if (this.eventsStreamId) {
        void this.dockerApi.stopStream(this.eventsStreamId);
      }
    });

    void this.loadContainers();
    void this.startEventsStream();
  }

  toggleContainerMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.showContainerMenu.update(open => !open);
  }

  onWindowKeydown(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f' || !this.logsTab()) {
      return;
    }

    event.preventDefault();
    queueMicrotask(() => this.logsTab()?.focusAndSelectSearch());
  }

  toggleContainer(containerId: string): void {
    this.selectedContainerIds.update(current => {
      const next = new Set(current);
      if (next.has(containerId)) {
        next.delete(containerId);
      } else {
        next.add(containerId);
      }
      return next;
    });
    this.saveSelection();
    this.pruneLogsForSelection();
    void this.syncStreams();
  }

  toggleSelectAllVisible(): void {
    const visible = this.visibleContainers();
    this.selectedContainerIds.update(current => {
      const next = new Set(current);
      for (const container of visible) {
        next.add(container.Id);
      }
      return next;
    });
    this.saveSelection();
    this.pruneLogsForSelection();
    void this.syncStreams();
  }

  removeFilteredContainers(): void {
    const visibleIds = new Set(this.visibleContainers().map(container => container.Id));
    this.selectedContainerIds.update(current => new Set([...current].filter(id => !visibleIds.has(id))));
    this.saveSelection();
    this.pruneLogsForSelection();
    void this.syncStreams();
  }

  selectAllContainers(): void {
    this.selectedContainerIds.set(new Set(this.containers().map(container => container.Id)));
    this.saveSelection();
    void this.syncStreams();
  }

  clearSelection(): void {
    this.selectedContainerIds.set(new Set());
    this.saveSelection();
    this.logs.set([]);
    this.clearPendingEntries();
    void this.syncStreams();
  }

  clearLogs(): void {
    const since = Math.floor(Date.now() / 1000);
    for (const id of this.selectedContainerIds()) {
      this.localStorage.set(`${LOGS_STORAGE_KEYS.GLOBAL_CLEARED_SINCE_PREFIX}${id}`, String(since));
    }
    this.logs.set([]);
    this.chunkBuffers.clear();
    this.clearPendingEntries();
    void this.restartStreams();
  }

  completeInitialFollow(): void {
    this.initialFollowPending.set(false);
  }

  onTailLinesChange(lines: number): void {
    this.logTailLines.set(lines);
    this.localStorage.set(LOGS_STORAGE_KEYS.GLOBAL_TAIL_LINES, String(lines));
    this.logs.set([]);
    this.chunkBuffers.clear();
    this.clearPendingEntries();
    void this.restartStreams();
  }

  updateDisplayOptions(options: LogsDisplayOptions): void {
    this.displayOptions.set(options);
    this.localStorage.set(LOGS_STORAGE_KEYS.GLOBAL_SHOW_TIMESTAMPS, options.showTimestamps ? 'true' : 'false');
    this.localStorage.set(LOGS_STORAGE_KEYS.GLOBAL_WRAP_LINES, options.wrapLines ? 'true' : 'false');
    this.localStorage.set(LOGS_STORAGE_KEYS.GLOBAL_LOCAL_DATES, options.localDates ? 'true' : 'false');
  }

  async loadContainers(): Promise<void> {
    this.isLoading.set(true);
    try {
      const containers = await this.dockerApi.listContainers();
      if (this.disposed) {
        return;
      }
      this.containers.set(containers);
      this.selectedContainerIds.update(current => {
        if (!this.initializedSelection) {
          this.initializedSelection = true;
          return this.hasPersistedSelection
            ? new Set([...current].filter(id => containers.some(container => container.Id === id)))
            : new Set(containers.map(container => container.Id));
        }
        return new Set([...current].filter(id => containers.some(container => container.Id === id)));
      });
      this.saveSelection();
      this.pruneLogsForSelection();
      await this.syncStreams();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to load containers.');
    } finally {
      this.isLoading.set(false);
    }
  }

  private async startEventsStream(): Promise<void> {
    try {
      const result = await this.dockerApi.startEventsStream();
      this.eventsStreamId = result.streamId;
    } catch {
      // The selector remains usable when Docker events are unavailable.
    }
  }

  private onStreamEvent(event: DockerStreamEventEnvelope): void {
    if (event.kind === 'events' && event.type === 'data' && event.streamId === this.eventsStreamId) {
      const data = event.data as Record<string, unknown> | undefined;
      if (data?.['Type'] === 'container') {
        this.scheduleRefresh();
      }
      return;
    }
    if (event.kind !== 'logs') {
      return;
    }
    const stream = this.streams.get(event.streamId);
    if (!stream) {
      return;
    }
    if (event.type === 'error') {
      this.error.set(`${stream.containerName}: ${event.error ?? 'Log stream error.'}`);
      this.streams.delete(event.streamId);
      return;
    }
    if (event.type === 'end') {
      this.flushPending(stream, event.timestamp);
      this.streams.delete(event.streamId);
      return;
    }
    if (event.type === 'data' && typeof event.data === 'string') {
      this.appendChunk(stream, event.channel ?? 'stdout', event.data, event.timestamp);
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => void this.loadContainers(), 400);
  }

  private async syncStreams(): Promise<void> {
    const wanted = new Map(
      this.containers()
        .filter(container => container.State === 'running' && this.selectedContainerIds().has(container.Id))
        .map(container => [container.Id, container])
    );
    for (const [streamId, stream] of this.streams) {
      if (!wanted.has(stream.containerId)) {
        this.streams.delete(streamId);
        this.chunkBuffers.delete(stream.containerId);
        void this.dockerApi.stopStream(streamId);
      }
    }
    const activeContainerIds = new Set([...this.streams.values()].map(stream => stream.containerId));
    await Promise.all(
      [...wanted.values()]
        .filter(container => !activeContainerIds.has(container.Id) && !this.startingContainerIds.has(container.Id))
        .map(container => this.startContainerStream(container))
    );
  }

  private async restartStreams(): Promise<void> {
    const streamIds = [...this.streams.keys()];
    this.streams.clear();
    await Promise.all(streamIds.map(streamId => this.dockerApi.stopStream(streamId)));
    await this.syncStreams();
  }

  private async startContainerStream(container: DockerContainerInfo): Promise<void> {
    this.startingContainerIds.add(container.Id);
    try {
      const result = await this.dockerApi.startLogsStream(
        container.Id,
        this.getClearedSince(container.Id),
        this.logTailLines()
      );
      const isStillWanted = this.containers().some(
        current =>
          current.Id === container.Id && current.State === 'running' && this.selectedContainerIds().has(container.Id)
      );
      if (this.disposed || !isStillWanted) {
        void this.dockerApi.stopStream(result.streamId);
        return;
      }
      this.streams.set(result.streamId, { containerId: container.Id, containerName: this.containerName(container) });
    } catch (error) {
      this.error.set(
        `${this.containerName(container)}: ${error instanceof Error ? error.message : 'Failed to start log stream.'}`
      );
    } finally {
      this.startingContainerIds.delete(container.Id);
    }
  }

  private appendChunk(stream: ActiveLogStream, channel: DockerLogChannel, chunk: string, timestamp: string): void {
    const buffers = this.chunkBuffers.get(stream.containerId) ?? { stdout: '', stderr: '' };
    const parts = `${buffers[channel]}${chunk}`.split(/\r?\n/);
    buffers[channel] = parts.pop() ?? '';
    this.chunkBuffers.set(stream.containerId, buffers);
    const colorClass = this.containerColorClass(stream.containerId);
    this.appendEntries(
      parts.map(raw => ({
        raw,
        channel,
        timestamp,
        containerId: stream.containerId,
        containerName: stream.containerName,
        containerColor: colorClass
      }))
    );
  }

  private flushPending(stream: ActiveLogStream, timestamp: string): void {
    const buffers = this.chunkBuffers.get(stream.containerId);
    if (!buffers) {
      return;
    }
    const colorClass = this.containerColorClass(stream.containerId);
    this.appendEntries(
      (['stdout', 'stderr'] as const).flatMap(channel => {
        const raw = buffers[channel];
        return raw
          ? [
              {
                raw,
                channel,
                timestamp,
                containerId: stream.containerId,
                containerName: stream.containerName,
                containerColor: colorClass
              }
            ]
          : [];
      })
    );
    this.chunkBuffers.delete(stream.containerId);
  }

  private appendEntries(entries: ContainerLogEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    this.pendingEntries.push(...entries);
    if (this.pendingEntriesFrame !== null) {
      return;
    }
    this.pendingEntriesFrame = requestAnimationFrame(() => {
      this.pendingEntriesFrame = null;
      const batch = this.pendingEntries.splice(0);
      this.logs.update(current => {
        const merged = current.concat(batch);
        return merged.length > LogsPage.MAX_LOG_ENTRIES ? merged.slice(-LogsPage.MAX_LOG_ENTRIES) : merged;
      });
    });
  }

  containerName(container: DockerContainerInfo): string {
    return formatDockerNames(container.Names) || container.Id.slice(0, 12);
  }

  private pruneLogsForSelection(): void {
    const selected = this.selectedContainerIds();
    this.logs.update(entries => entries.filter(entry => entry.containerId && selected.has(entry.containerId)));
    this.pendingEntries.splice(
      0,
      this.pendingEntries.length,
      ...this.pendingEntries.filter(entry => entry.containerId && selected.has(entry.containerId))
    );
  }

  private saveSelection(): void {
    this.localStorage.setArray(LOGS_STORAGE_KEYS.GLOBAL_SELECTED_CONTAINERS, [...this.selectedContainerIds()]);
    this.localStorage.set(LOGS_STORAGE_KEYS.GLOBAL_SELECTION_INITIALIZED, 'true');
  }

  private clearPendingEntries(): void {
    this.pendingEntries.length = 0;
    if (this.pendingEntriesFrame !== null) {
      cancelAnimationFrame(this.pendingEntriesFrame);
      this.pendingEntriesFrame = null;
    }
  }

  private getClearedSince(containerId: string): number | undefined {
    const raw = this.localStorage.getNumber(`${LOGS_STORAGE_KEYS.GLOBAL_CLEARED_SINCE_PREFIX}${containerId}`);
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
  }

  containerColorClass(containerId: string): string {
    const colorCount = 8;
    let hash = 0;
    for (const character of containerId) {
      hash = (hash * 31 + character.charCodeAt(0)) | 0;
    }
    return `log-container-color-${Math.abs(hash) % colorCount}`;
  }
}
