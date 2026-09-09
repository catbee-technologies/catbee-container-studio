import { Component, DestroyRef, computed, inject, signal, viewChild } from '@angular/core';
import { DockerContainerInfo } from '@shared/types/docker-api.types';
import { LogsTabComponent } from '@docker-containers/container-details/components/logs-tab/logs-tab';
import { ConfirmDialogComponent } from '@components/dialog/confirm-dialog';
import { MenuComponent } from '@components/menu/menu';
import { SearchInputComponent } from '@components/search-input/search-input';
import { TableCheckboxComponent } from '@components/table-checkbox/table-checkbox';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { LOGS_STORAGE_KEYS } from '@utils/storage.utils';
import { formatCompactCount } from '@utils/docker-display.utils';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { GlobalLogsService } from '@features/logs/services/global-logs.service';

@Component({
  selector: 'catbee-container-studio-logs-page',
  imports: [
    LogsTabComponent,
    ConfirmDialogComponent,
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
  readonly globalLogs = inject(GlobalLogsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly logsTab = viewChild(LogsTabComponent);

  readonly logsSearchStorageKey = LOGS_STORAGE_KEYS.GLOBAL_SEARCH_QUERY;
  readonly logsSearchModeStorageKeys = {
    caseSensitive: LOGS_STORAGE_KEYS.GLOBAL_SEARCH_CASE_SENSITIVE,
    wholeWord: LOGS_STORAGE_KEYS.GLOBAL_SEARCH_WHOLE_WORD,
    regex: LOGS_STORAGE_KEYS.GLOBAL_SEARCH_REGEX,
    filterToMatchesOnly: LOGS_STORAGE_KEYS.GLOBAL_FILTER_TO_MATCHES_ONLY
  };
  readonly tooltipDelay = 300;
  readonly globalMaxLogEntryOptions = this.globalLogs.maxLogEntryOptions;

  readonly containerSearch = signal('');
  readonly showContainerMenu = signal(false);
  readonly confirmClearLogsOpen = signal(false);

  readonly visibleContainers = computed(() => {
    const search = this.containerSearch().trim().toLowerCase();
    const containers = this.globalLogs.containers();
    if (!search) {
      return containers;
    }
    return containers.filter(container => {
      const name = this.containerName(container).toLowerCase();
      return name.includes(search) || container.Id.toLowerCase().includes(search);
    });
  });
  readonly selectedCount = computed(() => this.globalLogs.selectedContainerIds().size);
  readonly hasContainerSearch = computed(() => this.containerSearch().trim().length > 0);
  readonly hasVisibleContainers = computed(() => this.visibleContainers().length > 0);
  readonly allVisibleSelected = computed(() => {
    const visible = this.visibleContainers();
    return visible.length > 0 && visible.every(container => this.globalLogs.selectedContainerIds().has(container.Id));
  });
  readonly hasSelectedVisibleContainers = computed(() => {
    const selected = this.globalLogs.selectedContainerIds();
    return this.visibleContainers().some(container => selected.has(container.Id));
  });

  constructor() {
    this.globalLogs.setScrollAnchorHandlers({
      capture: () => this.logsTab()?.captureScrollAnchor() ?? null,
      restore: anchor =>
        this.logsTab()?.restoreScrollAnchor(anchor as Parameters<LogsTabComponent['restoreScrollAnchor']>[0])
    });
    this.destroyRef.onDestroy(() => this.globalLogs.setScrollAnchorHandlers(null));
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
    this.globalLogs.toggleContainer(containerId);
  }

  toggleSelectAllVisible(): void {
    this.globalLogs.addToSelection(this.visibleContainers().map(container => container.Id));
  }

  removeFilteredContainers(): void {
    this.globalLogs.removeFromSelection(this.visibleContainers().map(container => container.Id));
  }

  selectAllContainers(): void {
    this.globalLogs.selectAllContainers();
  }

  clearSelection(): void {
    this.globalLogs.clearSelection();
  }

  requestClearLogs(): void {
    if (this.globalLogs.logs().length > 0) {
      this.confirmClearLogsOpen.set(true);
    }
  }

  cancelClearLogs(): void {
    this.confirmClearLogsOpen.set(false);
  }

  confirmClearLogs(): void {
    this.confirmClearLogsOpen.set(false);
    this.globalLogs.clearLogs();
  }

  completeInitialFollow(): void {
    this.globalLogs.completeInitialFollow();
  }

  setFollowLogs(value: boolean): void {
    this.globalLogs.setFollowLogs(value);
  }

  onMaxLogEntriesChange(maxEntries: number): void {
    this.globalLogs.onMaxLogEntriesChange(maxEntries);
  }

  updateDisplayOptions(options: Parameters<GlobalLogsService['updateDisplayOptions']>[0]): void {
    this.globalLogs.updateDisplayOptions(options);
  }

  async loadContainers(): Promise<void> {
    await this.globalLogs.loadContainers();
  }

  containerName(container: DockerContainerInfo): string {
    return this.globalLogs.containerName(container);
  }

  containerColorClass(containerId: string): string {
    return this.globalLogs.containerColorClass(containerId);
  }

  formatCount(value: number): string {
    return formatCompactCount(value);
  }
}
