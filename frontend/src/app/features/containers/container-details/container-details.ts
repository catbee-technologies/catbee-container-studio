import { CommonModule } from '@angular/common';
import { Component, DestroyRef, ElementRef, OnDestroy, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { combineLatest } from 'rxjs';
import { DockerApiService } from '@core/docker-api.service';
import { DockerContainerInfo, DockerContainerStats } from '@shared/types/docker-api.types';
import { formatDockerNames } from '@utils/docker-display.utils';
import { ContainerDetailsPrefetch } from './container-details.resolver';
import { OverviewCardComponent } from './components/overview-card/overview-card';
import { EnvTabComponent } from './components/env-tab/env-tab';
import { MountsTabComponent } from './components/mounts-tab/mounts-tab';
import { StatsTabComponent } from './components/stats-tab/stats-tab';
import { InspectTabComponent } from './components/inspect-tab/inspect-tab';
import { LogsTabComponent } from './components/logs-tab/logs-tab';
import { ShellTabComponent } from './components/shell-tab/shell-tab';
import { TabsComponent, TabItem } from '@components/tabs/tabs';
import { EmptyStateComponent } from '@components/empty-state/empty-state';

enum ContainerTab {
  Logs = 'logs',
  Inspect = 'inspect',
  Env = 'env',
  Mounts = 'mounts',
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
    TabsComponent,
    EmptyStateComponent
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

  private readonly tabScrollArea = viewChild<ElementRef<HTMLElement>>('tabScrollArea');
  private readonly logsTab = viewChild(LogsTabComponent);
  private readonly inspectTab = viewChild(InspectTabComponent);
  private readonly envTab = viewChild(EnvTabComponent);
  private readonly shellTab = viewChild(ShellTabComponent);

  readonly tabs: readonly TabItem[] = [
    { id: 'logs', label: 'Logs', icon: 'article' },
    { id: 'inspect', label: 'Inspect', icon: 'data_object' },
    { id: 'env', label: 'Env', icon: 'token' },
    { id: 'mounts', label: 'Mounts', icon: 'folder_open' },
    { id: 'shell', label: 'Shell', icon: 'terminal' },
    { id: 'stats', label: 'Stats', icon: 'monitoring' }
  ];

  readonly activeTab = signal<ContainerTab>(ContainerTab.Logs);
  readonly showAllPorts = signal(false);

  readonly containerId = signal<string>('');
  readonly container = signal<DockerContainerInfo | null>(null);
  readonly inspectData = signal<unknown>(null);
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

  constructor() {
    const routeSub = combineLatest([this.route.paramMap, this.route.data]).subscribe(([params, data]) => {
      const id = params.get('id') ?? '';
      if (!id) {
        return;
      }

      const preloaded = (data['preloadedContainerDetails'] ?? null) as ContainerDetailsPrefetch | null;
      void this.loadContainer(id, false, preloaded);
    });

    this.destroyRef.onDestroy(() => {
      routeSub.unsubscribe();
    });
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

    const shouldShowLoading = preloaded === null;
    this.isLoading.set(shouldShowLoading);

    try {
      if (preloaded !== null) {
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

  private getInspectImageRef(inspectData: unknown): string | null {
    if (!inspectData || typeof inspectData !== 'object') {
      return null;
    }

    const image = (inspectData as { Image?: unknown }).Image;
    return typeof image === 'string' && image.length > 0 ? image : null;
  }

  private getReturnTo(fallback: string): string {
    const state = window.history.state as { returnTo?: unknown } | null;
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
