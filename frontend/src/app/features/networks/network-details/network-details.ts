import { CommonModule, DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { combineLatest } from 'rxjs';
import { CopyButtonComponent } from '@components/copy-button/copy-button';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { TabsComponent, TabItem } from '@components/tabs/tabs';
import { DockerApiService } from '@core/docker-api.service';
import { LocalStorageService } from '@ng-catbee/storage';
import { DockerContainerInfo, DockerNetworkInfo } from '@shared/types/docker-api.types';
import { DATE_FORMAT } from '@utils/docker-display.utils';
import { UI_STORAGE_KEYS } from '@utils/storage.utils';
import { NetworkDetailsPrefetch } from './network-details.resolver';
import { resolveConnectedContainers } from './network-details.utils';
import { ConnectedContainersTableComponent } from '@components/connected-containers-table/connected-containers-table';

enum NetworkDetailsTab {
  Containers = 'containers',
  Configuration = 'configuration'
}

@Component({
  selector: 'catbee-container-studio-network-details-page',
  imports: [
    CommonModule,
    CopyButtonComponent,
    EmptyStateComponent,
    ErrorBannerComponent,
    TabsComponent,
    ConnectedContainersTableComponent
  ],
  templateUrl: './network-details.html',
  styleUrl: './network-details.scss'
})
export class NetworkDetailsPage {
  private readonly dockerApi = inject(DockerApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly datePipe = inject(DatePipe);
  private readonly localStorage = inject(LocalStorageService);

  readonly networkId = signal('');
  readonly network = signal<DockerNetworkInfo | null>(null);
  readonly connectedContainers = signal<DockerContainerInfo[]>([]);
  readonly isLoading = signal(false);
  readonly error = signal<string | null>(null);
  readonly activeTab = signal<NetworkDetailsTab>(NetworkDetailsTab.Containers);
  readonly tabs: readonly TabItem[] = [
    { id: NetworkDetailsTab.Containers, label: 'Connected containers', icon: 'deployed_code' },
    { id: NetworkDetailsTab.Configuration, label: 'Configuration', icon: 'settings_ethernet' }
  ];

  readonly summaryItems = computed(() => {
    const network = this.network();
    if (!network) return [] as { label: string; value: string }[];
    return [
      { label: 'Driver', value: network.Driver },
      {
        label: 'Created',
        value: network.Created ? (this.datePipe.transform(network.Created, DATE_FORMAT) ?? '--') : '--'
      },
      { label: 'Containers', value: String(this.connectedContainers().length || Object.keys(network.Containers ?? {}).length) },
      { label: 'Internal', value: network.Internal ? 'Yes' : 'No' },
      { label: 'Attachable', value: network.Attachable ? 'Yes' : 'No' }
    ];
  });
  readonly ipamConfig = computed(() => this.network()?.IPAM?.Config ?? []);
  readonly labels = computed(() => Object.entries(this.network()?.Labels ?? {}));
  readonly options = computed(() => Object.entries(this.network()?.Options ?? {}));
  readonly networkSettings = computed(() => {
    const network = this.network();
    if (!network) {
      return [] as { label: string; value: string }[];
    }

    return [
      { label: 'Scope', value: network.Scope },
      { label: 'Internal', value: network.Internal ? 'Enabled' : 'Disabled' },
      { label: 'Attachable', value: network.Attachable ? 'Enabled' : 'Disabled' },
      { label: 'Ingress', value: network.Ingress ? 'Enabled' : 'Disabled' },
      { label: 'IPv4', value: network.EnableIPv4 === false ? 'Disabled' : 'Enabled' },
      { label: 'IPv6', value: network.EnableIPv6 ? 'Enabled' : 'Disabled' },
      { label: 'Config only', value: network.ConfigOnly ? 'Yes' : 'No' },
      { label: 'Config from', value: network.ConfigFrom?.Network || '--' }
    ];
  });

  constructor() {
    const routeSub = combineLatest([this.route.paramMap, this.route.data]).subscribe(([params, data]) => {
      const networkId = params.get('id') ?? '';
      this.networkId.set(networkId);
      this.activeTab.set(
        this.localStorage.getEnumWithDefault(
          `${UI_STORAGE_KEYS.NETWORKS_SELECTED_TAB_PREFIX}${networkId}`,
          NetworkDetailsTab.Containers,
          Object.values(NetworkDetailsTab)
        )
      );
      void this.load((data['preloadedNetworkDetails'] ?? null) as NetworkDetailsPrefetch | null);
    });
    this.destroyRef.onDestroy(() => routeSub.unsubscribe());
  }

  backToNetworks(): void {
    void this.router.navigateByUrl(this.getReturnTo('/networks'));
  }
  shortId(id: string): string {
    return id.replace('sha256:', '').slice(0, 12);
  }

  endpointAddress(containerId: string): string {
    const endpoint = Object.entries(this.network()?.Containers ?? {}).find(
      ([id]) => id === containerId || id.startsWith(containerId)
    )?.[1];
    return endpoint?.IPv4Address || endpoint?.IPv6Address || '--';
  }

  readonly getEndpointAddress = (id: string): string => this.endpointAddress(id);

  setActiveTab(tab: string): void {
    if (!Object.values(NetworkDetailsTab).includes(tab as NetworkDetailsTab)) return;
    this.activeTab.set(tab as NetworkDetailsTab);
    this.localStorage.set(`${UI_STORAGE_KEYS.NETWORKS_SELECTED_TAB_PREFIX}${this.networkId()}`, tab);
  }

  private getReturnTo(fallback: string): string {
    const state = window.history.state as { returnTo?: string } | null;
    return typeof state?.returnTo === 'string' && state.returnTo.length > 0 ? state.returnTo : fallback;
  }

  private async load(preloaded: NetworkDetailsPrefetch | null): Promise<void> {
    if (!this.networkId()) {
      this.error.set('Invalid network id.');
      return;
    }
    this.isLoading.set(preloaded === null);
    this.error.set(null);
    try {
      if (preloaded) {
        this.network.set(preloaded.network);
        this.connectedContainers.set(preloaded.connectedContainers);
        this.error.set(preloaded.error);
        return;
      }
      const [network, containers] = await Promise.all([
        this.dockerApi.inspectNetwork(this.networkId()),
        this.dockerApi.listContainers()
      ]);
      const connectedContainers = await resolveConnectedContainers(this.dockerApi, network, containers);
      this.network.set(network);
      this.connectedContainers.set(connectedContainers);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to load network details.');
    } finally {
      this.isLoading.set(false);
    }
  }
}
