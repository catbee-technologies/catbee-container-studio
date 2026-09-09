import { Injectable, computed, inject, signal } from '@angular/core';
import { DockerApiService } from '@core/docker-api.service';
import {
  ContainerLogEntry,
  LogsDisplayOptions
} from '@docker-containers/container-details/components/logs-tab/logs-tab';
import { DockerContainerInfo, DockerLogChannel, DockerStreamEventEnvelope } from '@shared/types/docker-api.types';
import { formatDockerNames } from '@utils/docker-display.utils';
import { LocalStorageService } from '@ng-catbee/storage';
import { LOGS_STORAGE_KEYS } from '@utils/storage.utils';

interface ActiveLogStream {
  containerId: string;
  containerName: string;
}

@Injectable({ providedIn: 'root' })
export class GlobalLogsService {
  private static readonly MAX_LOG_ENTRIES = 5000;
  private static readonly MIN_TAIL_LINES_PER_CONTAINER = 1000;
  readonly maxLogEntryOptions = [5000, 10_000, 20_000, 25_000] as const;

  private readonly dockerApi = inject(DockerApiService);
  private readonly localStorage = inject(LocalStorageService);

  private readonly streams = new Map<string, ActiveLogStream>();
  private readonly chunkBuffers = new Map<string, Record<DockerLogChannel, string>>();
  private readonly startingContainerIds = new Set<string>();
  private readonly pendingEntries: ContainerLogEntry[] = [];
  private eventsStreamId: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEntriesFrame: number | null = null;
  private initialized = false;
  private initializedSelection = false;
  private scrollAnchorHandlers: {
    capture: () => unknown;
    restore: (anchor: unknown) => void;
  } | null = null;
  private readonly hasPersistedSelection = this.localStorage.getBooleanWithDefault(
    LOGS_STORAGE_KEYS.GLOBAL_SELECTION_INITIALIZED,
    false
  );

  readonly maxLogEntries = signal(
    Number.parseInt(
      this.localStorage.getEnumWithDefault(
        LOGS_STORAGE_KEYS.GLOBAL_MAX_LOG_ENTRIES,
        String(GlobalLogsService.MAX_LOG_ENTRIES),
        this.maxLogEntryOptions.map(String)
      ),
      10
    )
  );

  readonly containers = signal<DockerContainerInfo[]>([]);
  readonly selectedContainerIds = signal<Set<string>>(
    new Set(this.localStorage.getArrayWithDefault<string>(LOGS_STORAGE_KEYS.GLOBAL_SELECTED_CONTAINERS, []))
  );
  readonly followLogs = signal(true);
  readonly logs = signal<ContainerLogEntry[]>([]);
  readonly initialFollowPending = signal(true);
  readonly isLoading = signal(true);
  readonly error = signal<string | null>(null);
  readonly displayOptions = signal<LogsDisplayOptions>({
    showTimestamps: this.localStorage.getBooleanWithDefault(LOGS_STORAGE_KEYS.GLOBAL_SHOW_TIMESTAMPS, false),
    wrapLines: this.localStorage.getBooleanWithDefault(LOGS_STORAGE_KEYS.GLOBAL_WRAP_LINES, true),
    localDates: this.localStorage.getBooleanWithDefault(LOGS_STORAGE_KEYS.GLOBAL_LOCAL_DATES, false)
  });
  readonly streamCount = signal(0);
  readonly streamStatus = computed(() => `${this.streamCount()} live stream${this.streamCount() === 1 ? '' : 's'}`);
  readonly perContainerTailLines = signal(this.maxLogEntries());

  /** Starts container discovery and log streaming. Safe to call multiple times. */
  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.dockerApi.onStreamEvent(event => this.onStreamEvent(event));

    void this.loadContainers();
    void this.startEventsStream();
  }

  async loadContainers(): Promise<void> {
    this.isLoading.set(true);
    try {
      const containers = await this.dockerApi.listContainers();
      this.containers.set(containers.sort((a, b) => a.Names[0].localeCompare(b.Names[0])));
      this.selectedContainerIds.update(current => {
        const availableIds = new Set(containers.map(container => container.Id));
        const availableSelection = [...current].filter(id => availableIds.has(id));
        if (!this.initializedSelection) {
          this.initializedSelection = true;
          if (!this.hasPersistedSelection || (current.size > 0 && availableSelection.length === 0)) {
            return new Set(availableIds);
          }
        }
        return new Set(availableSelection);
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

  addToSelection(containerIds: readonly string[]): void {
    this.selectedContainerIds.update(current => {
      const next = new Set(current);
      for (const id of containerIds) {
        next.add(id);
      }
      return next;
    });
    this.saveSelection();
    this.pruneLogsForSelection();
    void this.syncStreams();
  }

  removeFromSelection(containerIds: readonly string[]): void {
    const idsToRemove = new Set(containerIds);
    this.selectedContainerIds.update(current => new Set([...current].filter(id => !idsToRemove.has(id))));
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

  setFollowLogs(value: boolean): void {
    this.followLogs.set(value);
  }

  onMaxLogEntriesChange(maxEntries: number): void {
    if (!this.maxLogEntryOptions.includes(maxEntries as (typeof this.maxLogEntryOptions)[number])) {
      return;
    }

    this.maxLogEntries.set(maxEntries);
    this.localStorage.set(LOGS_STORAGE_KEYS.GLOBAL_MAX_LOG_ENTRIES, String(maxEntries));
    this.logs.set([]);
    this.chunkBuffers.clear();
    this.clearPendingEntries();
    this.followLogs.set(true);
    this.initialFollowPending.set(true);
    void this.restartStreams();
  }

  updateDisplayOptions(options: LogsDisplayOptions): void {
    this.displayOptions.set(options);
    this.localStorage.set(LOGS_STORAGE_KEYS.GLOBAL_SHOW_TIMESTAMPS, options.showTimestamps ? 'true' : 'false');
    this.localStorage.set(LOGS_STORAGE_KEYS.GLOBAL_WRAP_LINES, options.wrapLines ? 'true' : 'false');
    this.localStorage.set(LOGS_STORAGE_KEYS.GLOBAL_LOCAL_DATES, options.localDates ? 'true' : 'false');
  }

  containerName(container: DockerContainerInfo): string {
    return formatDockerNames(container.Names) || container.Id.slice(0, 12);
  }

  /** Lets the visible logs page preserve scroll position when trimming while paused. */
  setScrollAnchorHandlers(handlers: { capture: () => unknown; restore: (anchor: unknown) => void } | null): void {
    this.scrollAnchorHandlers = handlers;
  }

  containerColorClass(containerId: string): string {
    const colorCount = 16;
    let hash = 0;
    for (const character of containerId) {
      hash = (hash * 31 + character.charCodeAt(0)) | 0;
    }
    return `log-container-color-${Math.abs(hash) % colorCount}`;
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
      this.streamCount.set(this.streams.size);
      return;
    }
    if (event.type === 'end') {
      this.flushPending(stream, event.timestamp);
      this.streams.delete(event.streamId);
      this.streamCount.set(this.streams.size);
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
    this.streamCount.set(this.streams.size);
    const activeContainerIds = new Set([...this.streams.values()].map(stream => stream.containerId));
    const tailLines = this.tailLinesPerContainer(wanted.size);
    this.perContainerTailLines.set(tailLines);
    await Promise.all(
      [...wanted.values()]
        .filter(container => !activeContainerIds.has(container.Id) && !this.startingContainerIds.has(container.Id))
        .map(container => this.startContainerStream(container, tailLines))
    );
  }

  /** Splits the global cap across selected containers so we don't fetch `maxLogEntries` per container. */
  private tailLinesPerContainer(containerCount: number): number {
    if (containerCount <= 1) {
      return this.maxLogEntries();
    }
    const fairShare = Math.ceil(this.maxLogEntries() / containerCount);
    return Math.max(GlobalLogsService.MIN_TAIL_LINES_PER_CONTAINER, Math.min(fairShare, this.maxLogEntries()));
  }

  private async restartStreams(): Promise<void> {
    const streamIds = [...this.streams.keys()];
    this.streams.clear();
    this.streamCount.set(0);
    await Promise.all(streamIds.map(streamId => this.dockerApi.stopStream(streamId)));
    await this.syncStreams();
  }

  private async startContainerStream(container: DockerContainerInfo, tailLines: number): Promise<void> {
    this.startingContainerIds.add(container.Id);
    try {
      const result = await this.dockerApi.startLogsStream(container.Id, this.getClearedSince(container.Id), tailLines);
      const isStillWanted = this.containers().some(
        current =>
          current.Id === container.Id && current.State === 'running' && this.selectedContainerIds().has(container.Id)
      );
      if (!isStillWanted) {
        void this.dockerApi.stopStream(result.streamId);
        return;
      }
      this.streams.set(result.streamId, { containerId: container.Id, containerName: this.containerName(container) });
      this.streamCount.set(this.streams.size);
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
      const currentLogs = this.logs();
      const removedLineCount = Math.max(currentLogs.length + batch.length - this.maxLogEntries(), 0);
      const anchor = !this.followLogs() && removedLineCount > 0 ? (this.scrollAnchorHandlers?.capture() ?? null) : null;
      this.logs.update(current => {
        const merged = current.concat(batch);
        return merged.length > this.maxLogEntries() ? merged.slice(-this.maxLogEntries()) : merged;
      });
      if (anchor) {
        this.scrollAnchorHandlers?.restore(anchor);
      }
    });
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
}
