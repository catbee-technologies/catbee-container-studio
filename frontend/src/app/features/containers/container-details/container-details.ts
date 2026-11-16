import { CommonModule } from '@angular/common';
import { Component, DestroyRef, ElementRef, OnDestroy, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { combineLatest } from 'rxjs';
import { DockerApiService } from '@core/docker-api.service';
import {
  DockerContainerInfo,
  DockerContainerInspectInfo,
  DockerContainerStats,
  DockerStreamEventEnvelope,
  RecreateContainerOptions
} from '@shared/types/docker-api.types';
import { formatDockerNames } from '@utils/docker-display.utils';
import { ContainerDetailsPrefetch } from './container-details.resolver';
import { OverviewCardComponent } from './components/overview-card/overview-card';
import { EnvTabComponent } from './components/env-tab/env-tab';
import { MountsTabComponent } from './components/mounts-tab/mounts-tab';
import { StatsTabComponent } from './components/stats-tab/stats-tab';
import { InspectTabComponent } from './components/inspect-tab/inspect-tab';
import { LogsTabComponent } from './components/logs-tab/logs-tab';
import { ShellTabComponent } from './components/shell-tab/shell-tab';
import { FilesTabComponent } from './components/files-tab/files-tab';
import { TabsComponent, TabItem } from '@components/tabs/tabs';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { SessionStorageService } from '@ng-catbee/storage';
import { UI_STORAGE_KEYS } from '@utils/storage.utils';
import { CopyButtonComponent } from '@components/copy-button/copy-button';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { ConfirmDialogComponent } from '@components/dialog/confirm-dialog';
import { DialogComponent } from '@components/dialog/dialog';
import { PortMappingsEditorComponent } from '@components/port-mappings-editor/port-mappings-editor';
import {
  PortMappingRow,
  arePortMappingsEqual,
  dockerPortsToRows,
  findDuplicateHostPorts,
  rowsToDockerPortBindings
} from '@utils/port.utils';

enum ContainerTab {
  Logs = 'logs',
  Inspect = 'inspect',
  Env = 'env',
  Mounts = 'mounts',
  Files = 'files',
  Shell = 'shell',
  Stats = 'stats'
}

@Component({
  selector: 'catbee-container-studio-container-details-page',
  imports: [
    CommonModule,
    OverviewCardComponent,
    EnvTabComponent,
    MountsTabComponent,
    StatsTabComponent,
    InspectTabComponent,
    LogsTabComponent,
    ShellTabComponent,
    FilesTabComponent,
    TabsComponent,
    EmptyStateComponent,
    ErrorBannerComponent,
    CopyButtonComponent,
    CatbeeTooltip,
    ConfirmDialogComponent,
    DialogComponent,
    PortMappingsEditorComponent
  ],
  templateUrl: './container-details.html',
  styleUrl: './container-details.scss',
  // encapsulation: ViewEncapsulation.None,
  host: {
    '(window:keydown)': 'onWindowKeydown($event)'
  }
})
export class ContainerDetailsPage implements OnDestroy {
  private readonly dockerApi = inject(DockerApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly sessionStorage = inject(SessionStorageService);

  private readonly tabScrollArea = viewChild<ElementRef<HTMLElement>>('tabScrollArea');
  private readonly logsTab = viewChild(LogsTabComponent);
  private readonly inspectTab = viewChild(InspectTabComponent);
  private readonly envTab = viewChild(EnvTabComponent);
  private readonly shellTab = viewChild(ShellTabComponent);

  readonly tooltipDelay = 300;

  readonly tabs: readonly TabItem[] = [
    { id: 'logs', label: 'Logs', icon: 'article' },
    { id: 'inspect', label: 'Inspect', icon: 'data_object' },
    { id: 'env', label: 'Env', icon: 'token' },
    { id: 'mounts', label: 'Mounts', icon: 'folder_open' },
    { id: 'files', label: 'Files', icon: 'folder_copy' },
    { id: 'shell', label: 'Shell', icon: 'terminal' },
    { id: 'stats', label: 'Stats', icon: 'monitoring' }
  ];

  readonly showAllPorts = signal(false);

  readonly containerId = signal<string>('');
  readonly activeTab = signal<ContainerTab>(ContainerTab.Logs);

  readonly container = signal<DockerContainerInfo | null>(null);
  readonly inspectData = signal<DockerContainerInspectInfo | null>(null);
  readonly stats = signal<DockerContainerStats | null>(null);
  readonly isLoading = signal(false);
  readonly error = signal<string | null>(null);

  readonly name = computed(() => {
    const current = this.container();
    if (!current) {
      return this.containerId();
    }
    return this.formatNames(current.Names);
  });

  readonly showDeleteConfirm = signal(false);
  readonly isDeleting = signal(false);
  readonly showRecreateConfirm = signal(false);
  readonly isRecreating = signal(false);
  readonly showEditPortsDialog = signal(false);
  readonly initialPorts = signal<PortMappingRow[]>([]);
  readonly editablePorts = signal<PortMappingRow[]>([]);
  readonly hasDuplicatePorts = computed(() => findDuplicateHostPorts(this.editablePorts()).size > 0);
  readonly isPortsChanged = computed(() => !arePortMappingsEqual(this.initialPorts(), this.editablePorts()));

  readonly deleteMessage = computed(() => {
    return `Delete ${this.name()} permanently? \n This action cannot be undone.`;
  });

  readonly recreateMessage = computed(() => {
    const isCompose = Boolean(
      this.container()?.Labels?.['com.docker.compose.service'] ??
      this.inspectData()?.Config?.Labels?.['com.docker.compose.service']
    );
    if (isCompose) {
      return `Force recreate compose service container "${this.name()}"? \n This will rebuild and recreate the container instance using Docker Compose.`;
    }
    return `Force recreate container "${this.name()}"? \n This will stop, remove, and recreate the container using the same configuration.`;
  });

  readonly imageRouteRef = computed(() => {
    const current = this.container();
    const imageIdFromList = current?.ImageID;
    if (typeof imageIdFromList === 'string' && imageIdFromList.length > 0) {
      return imageIdFromList;
    }

    const inspectImage = this.getInspectImageRef(this.inspectData());
    if (inspectImage) {
      return inspectImage;
    }

    return current?.Image ?? '';
  });

  private isDisposed = false;
  private isRedirectingToList = false;
  private eventsStreamId: string | null = null;
  private eventsRefreshDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const routeSub = combineLatest([this.route.paramMap, this.route.data]).subscribe(([params, data]) => {
      const id = params.get('id') ?? '';
      if (!id) {
        return;
      }

      this.activeTab.set(
        this.sessionStorage.getEnumWithDefault<ContainerTab>(
          `${UI_STORAGE_KEYS.CONTAINERS_SELECTED_TAB_PREFIX}${id}`,
          ContainerTab.Logs,
          Object.values(ContainerTab)
        )
      );

      const preloaded = (data['preloadedContainerDetails'] ?? null) as ContainerDetailsPrefetch | null;
      void this.loadContainer(id, false, preloaded);
    });

    void this.startEventStream();
    const streamUnsubscribe = this.dockerApi.onStreamEvent(event => this.onDockerEvent(event));

    this.destroyRef.onDestroy(() => {
      routeSub.unsubscribe();
      streamUnsubscribe();
      if (this.eventsRefreshDebounce) {
        clearTimeout(this.eventsRefreshDebounce);
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
      // Docker events unavailable; the header status will only refresh after manual actions.
    }
  }

  private onDockerEvent(event: DockerStreamEventEnvelope): void {
    if (
      event.kind !== 'events' ||
      event.type !== 'data' ||
      !this.eventsStreamId ||
      event.streamId !== this.eventsStreamId
    ) {
      return;
    }

    const data = event.data as Record<string, unknown> | null | undefined;
    if (!data || data['Type'] !== 'container') {
      return;
    }

    const actor = data['Actor'] as Record<string, unknown> | undefined;
    const eventContainerId = String(data['id'] ?? actor?.['ID'] ?? '');
    if (eventContainerId !== this.containerId()) {
      return;
    }

    const action = String(data['Action'] ?? '');
    const triggers = ['start', 'stop', 'die', 'pause', 'unpause', 'restart', 'kill'];
    if (!triggers.includes(action)) {
      return;
    }

    if (this.eventsRefreshDebounce) {
      clearTimeout(this.eventsRefreshDebounce);
    }

    this.eventsRefreshDebounce = setTimeout(() => {
      void this.refreshContainerState();
    }, 400);
  }

  private async refreshContainerState(): Promise<void> {
    const id = this.containerId();
    if (!id || this.isDisposed || this.isRecreating() || this.isDeleting()) {
      return;
    }

    try {
      const containers = await this.dockerApi.listContainers();
      const found = containers.find(item => item.Id === id) ?? null;

      if (!found) {
        this.redirectToContainers();
        return;
      }

      this.container.set(found);
    } catch (error) {
      if (this.isContainerUnavailableError(error)) {
        this.redirectToContainers();
      }
    }
  }

  onWindowKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      if (this.activeTab() === 'logs') {
        event.preventDefault();
        queueMicrotask(() => {
          this.logsTab()?.focusAndSelectSearch();
        });
        return;
      }

      if (this.activeTab() === 'inspect') {
        event.preventDefault();
        queueMicrotask(() => {
          this.inspectTab()?.focusAndSelectSearch();
        });
        return;
      }

      if (this.activeTab() === 'env') {
        event.preventDefault();
        queueMicrotask(() => {
          this.envTab()?.focusAndSelectSearch();
        });
        return;
      }

      if (this.activeTab() === 'shell') {
        event.preventDefault();
        queueMicrotask(() => {
          this.shellTab()?.openFindPanel();
        });
      }
    }
  }

  onStatsUpdate(stats: DockerContainerStats): void {
    this.stats.set(stats);
  }

  setActiveTab(tab: string): void {
    const allowedTabs = Object.values(ContainerTab);
    if (!allowedTabs.includes(tab as ContainerTab)) {
      return;
    }
    this.activeTab.set(tab as ContainerTab);
    this.sessionStorage.set(`${UI_STORAGE_KEYS.CONTAINERS_SELECTED_TAB_PREFIX}${this.containerId()}`, tab);
    this.scrollTabPanelToTop();
  }

  async refresh(): Promise<void> {
    const id = this.containerId();
    if (!id) {
      return;
    }

    await this.loadContainer(id, true);
  }

  async start(): Promise<void> {
    await this.runAction(async () => {
      await this.dockerApi.startContainer(this.containerId());
      await this.refresh();
    });
  }

  async stop(): Promise<void> {
    await this.runAction(async () => {
      await this.dockerApi.stopContainer(this.containerId());
      await this.refresh();
    });
  }

  async restart(): Promise<void> {
    await this.runAction(async () => {
      await this.dockerApi.restartContainer(this.containerId());
      await this.refresh();
    });
  }

  async pause(): Promise<void> {
    await this.runAction(async () => {
      await this.dockerApi.pauseContainer(this.containerId());
      await this.refresh();
    });
  }

  async unpause(): Promise<void> {
    await this.runAction(async () => {
      await this.dockerApi.unpauseContainer(this.containerId());
      await this.refresh();
    });
  }

  requestDelete(): void {
    this.showDeleteConfirm.set(true);
  }

  cancelDelete(): void {
    this.showDeleteConfirm.set(false);
  }

  requestRecreate(): void {
    this.showRecreateConfirm.set(true);
  }

  cancelRecreate(): void {
    this.showRecreateConfirm.set(false);
  }

  async confirmRecreate(): Promise<void> {
    this.showRecreateConfirm.set(false);
    await this.executeRecreate();
  }

  async recreateContainerWithEnv(env: string[]): Promise<void> {
    await this.executeRecreate({ env });
  }

  async recreateContainerWithMounts(options: { binds: string[] }): Promise<void> {
    await this.executeRecreate({ binds: options.binds });
  }

  openEditPortsDialog(): void {
    const inspect = this.inspectData();
    const currentContainer = this.container();
    const rows = dockerPortsToRows(
      inspect?.Config?.ExposedPorts,
      inspect?.HostConfig?.PortBindings,
      inspect?.NetworkSettings?.Ports,
      currentContainer?.Ports
    );
    this.initialPorts.set(rows.map(r => ({ ...r })));
    this.editablePorts.set(rows);
    this.showEditPortsDialog.set(true);
  }

  closeEditPortsDialog(): void {
    if (this.isRecreating()) {
      return;
    }
    this.showEditPortsDialog.set(false);
  }

  async confirmSavePortsAndRecreate(): Promise<void> {
    if (this.isRecreating() || this.hasDuplicatePorts() || !this.isPortsChanged()) {
      return;
    }
    const { exposedPorts, portBindings } = rowsToDockerPortBindings(this.editablePorts());
    try {
      await this.executeRecreate({ exposedPorts, portBindings });
      this.showEditPortsDialog.set(false);
    } catch {
      // Recreate error will be surfaced by runAction banner,
      // dialog remains open for the user to adjust or cancel.
    }
  }

  async updateRestartPolicy(policy: string): Promise<void> {
    const id = this.containerId();
    if (!id) {
      return;
    }

    await this.runAction(async () => {
      await this.dockerApi.updateContainer(id, { restartPolicy: policy });
      await this.refresh();
    });
  }

  private async executeRecreate(options?: RecreateContainerOptions): Promise<void> {
    const id = this.containerId();
    if (!id) {
      return;
    }

    this.isRecreating.set(true);
    await this.runAction(async () => {
      try {
        const result = await this.dockerApi.recreateContainer(id, options);
        const targetId = result.containerId || id;
        if (result.containerId && result.containerId !== id) {
          void this.shellTab()?.teardown();
          await this.router.navigate(['/containers', targetId], { replaceUrl: true });
        }
        await this.loadContainer(targetId, true);
      } finally {
        this.isRecreating.set(false);
      }
    });
  }

  async confirmDelete(): Promise<void> {
    const id = this.containerId();
    if (!id) {
      return;
    }

    this.showDeleteConfirm.set(false);
    this.isDeleting.set(true);
    await this.runAction(async () => {
      await this.dockerApi.removeContainer(id, true);
      void this.shellTab()?.teardown();
      this.backToContainers();
    });
    this.isDeleting.set(false);
  }

  backToContainers(): void {
    void this.router.navigateByUrl(this.getReturnTo('/containers'));
  }

  openImageDetails(imageRef: string): void {
    if (!imageRef) {
      return;
    }

    void this.router.navigate(['/images', imageRef], { state: { returnTo: this.router.url } });
  }

  onShellUnavailable(): void {
    this.redirectToContainers();
  }

  setShowAllPorts(expanded: boolean): void {
    this.showAllPorts.set(expanded);
  }

  formatNames(names: string[]): string {
    return formatDockerNames(names);
  }

  private async loadContainer(
    containerId: string,
    _skipResetLogs = false,
    preloaded: ContainerDetailsPrefetch | null = null
  ): Promise<void> {
    if (this.containerId() !== containerId) {
      this.containerId.set(containerId);
      this.container.set(null);
      this.inspectData.set(null);
      this.stats.set(null);
      this.error.set(null);
      this.showAllPorts.set(false);

      await this.shellTab()?.teardown();
    }

    const isValidPreloaded =
      preloaded !== null && preloaded.container?.Id === containerId && preloaded.inspectData?.Id === containerId;

    const shouldShowLoading = !isValidPreloaded;
    this.isLoading.set(shouldShowLoading);

    try {
      if (isValidPreloaded && preloaded !== null) {
        if (preloaded.error) {
          if (this.isContainerUnavailableMessage(preloaded.error)) {
            this.redirectToContainers();
          } else {
            this.error.set(preloaded.error);
          }
          return;
        }

        this.container.set(preloaded.container);
        this.inspectData.set(preloaded.inspectData);

        if (!preloaded.container) {
          this.redirectToContainers();
          return;
        }
      } else {
        const containers = await this.dockerApi.listContainers();
        const found = containers.find(item => item.Id === containerId) ?? null;
        this.container.set(found);

        if (!found) {
          this.redirectToContainers();
          return;
        }

        const inspectData = await this.dockerApi.inspectContainer(containerId);
        this.inspectData.set(inspectData);
      }

      void containerId; // streams (logs, shell, stats) are owned by child components
    } catch (error) {
      if (this.isContainerUnavailableError(error)) {
        this.redirectToContainers();
      } else {
        this.error.set(error instanceof Error ? error.message : 'Failed to load container details.');
      }
    } finally {
      this.isLoading.set(false);
    }
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    try {
      this.error.set(null);
      await action();
    } catch (error) {
      if (this.isContainerUnavailableError(error)) {
        this.redirectToContainers();
      } else {
        this.error.set(error instanceof Error ? error.message : 'Container action failed.');
      }
    }
  }

  private scrollTabPanelToTop(): void {
    const element = this.tabScrollArea()?.nativeElement;
    if (!element) {
      return;
    }

    element.scrollTop = 0;
  }

  private isContainerUnavailableError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return this.isContainerUnavailableMessage(error.message);
  }

  private isContainerUnavailableMessage(message: string | null | undefined): boolean {
    if (!message) {
      return false;
    }

    return /no such container|container not found|not found|removed/i.test(message);
  }

  private getInspectImageRef(inspectData: DockerContainerInspectInfo | null): string | null {
    if (!inspectData || typeof inspectData !== 'object') {
      return null;
    }

    const image = inspectData.ImageID ?? inspectData.Image;
    return typeof image === 'string' && image.length > 0 ? image : null;
  }

  private getReturnTo(fallback: string): string {
    const state = window.history.state as { returnTo?: string } | null;
    return typeof state?.returnTo === 'string' && state.returnTo.length > 0 ? state.returnTo : fallback;
  }

  private redirectToContainers(): void {
    if (this.isRedirectingToList || this.isDisposed) {
      return;
    }
    this.isRedirectingToList = true;
    this.error.set('Container no longer exists. Redirecting to container list...');
    void this.shellTab()?.teardown();
    void this.router.navigate(['/containers']);
  }

  ngOnDestroy(): void {
    this.isDisposed = true;
    void this.shellTab()?.teardown();
  }
}
