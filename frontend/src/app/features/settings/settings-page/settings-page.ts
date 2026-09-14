import { CommonModule } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ConfirmDialogComponent } from '@components/dialog/confirm-dialog';
import { DialogComponent } from '@components/dialog/dialog';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { TabsComponent, type TabItem } from '@components/tabs/tabs';
import { SwitchInputComponent } from '@components/switch-input/switch-input';
import { SearchInputComponent } from '@components/search-input/search-input';
import { DiscreteSliderComponent, type DiscreteSliderLabel } from '@components/discrete-slider/discrete-slider';
import { ElectronApiService } from '@core/electron-api.service';
import { DockerApiService } from '@core/docker-api.service';
import { AppTheme, ThemeService } from '@shared/services/theme.service';
import type {
  ContainersProxyConfig,
  DesktopProxyConfig,
  DockerContextDetails,
  NetworkSettingsConfig
} from '@shared/types';
import { EngineMode, SettingsService } from '../services/settings.service';

export interface SettingsCategory {
  readonly id: 'general' | 'resources' | 'engine' | 'updates' | 'about';
  readonly label: string;
  readonly icon: string;
}

export interface PlatformDiagnostics {
  platform: string;
  arch: string;
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  osRelease: string;
  osType: string;
  totalMemory: number;
  cpuCount: number;
}

@Component({
  selector: 'catbee-container-studio-settings-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    DialogComponent,
    ConfirmDialogComponent,
    ErrorBannerComponent,
    TabsComponent,
    SwitchInputComponent,
    SearchInputComponent,
    DiscreteSliderComponent
  ],
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.scss'
})
export class SettingsPageComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly settings = inject(SettingsService);
  readonly themeService = inject(ThemeService);
  private readonly electronApi = inject(ElectronApiService);
  private readonly dockerApi = inject(DockerApiService);

  readonly categories: readonly SettingsCategory[] = [
    { id: 'general', label: 'General', icon: 'tune' },
    { id: 'resources', label: 'Resources', icon: 'memory' },
    { id: 'engine', label: 'Docker Engine', icon: 'developer_board' },
    { id: 'updates', label: 'Software updates', icon: 'system_update' },
    { id: 'about', label: 'About', icon: 'info' }
  ];

  readonly activeCategory = signal<SettingsCategory['id']>('general');
  readonly searchQuery = signal('');

  // Resources sub-tabs
  readonly activeResourceTab = signal<'advanced' | 'file-sharing' | 'proxies' | 'network' | 'wsl'>('advanced');

  // Engine status & diagnostics
  readonly engineStatus = signal<{
    isInstalled: boolean;
    state: string;
    manifest: unknown;
    runtime: unknown;
  } | null>(null);

  readonly platformInfo = signal<PlatformDiagnostics | null>(null);
  readonly isActionLoading = signal(false);
  readonly applySuccessMessage = signal<string | null>(null);

  // Error banners state
  readonly settingsErrorMessage = signal<string | null>(null);
  readonly engineErrorMessage = signal<string | null>(null);
  readonly updateErrorMessage = signal<string | null>(null);

  // Confirmation dialogs state
  readonly pendingStopEngine = signal(false);
  readonly pendingReinstallEngine = signal(false);
  readonly pendingContextSwitch = signal<string | null>(null);
  readonly pendingActivateCatBeeContext = signal(false);
  readonly pendingDiscardChanges = signal(false);

  readonly pendingContextSwitchMessage = computed(() => {
    const ctx = this.pendingContextSwitch();
    if (!ctx) return '';
    return `Switching active Docker context to "${ctx}" will reconnect CatBee Container Studio and target all container operations to that endpoint. Are you sure you want to switch?`;
  });

  // Docker CLI Context management
  readonly dockerContext = signal<DockerContextDetails | null>(null);
  readonly isContextSwitching = signal(false);
  readonly contextSuccessMessage = signal<string | null>(null);
  readonly contextErrorMessage = signal<string | null>(null);

  // Form local state (staged before Apply)
  readonly startAtLogin = signal(this.settings.startAtLogin());
  readonly openDashboard = signal(this.settings.openDashboard());
  readonly engineMode = signal<EngineMode>(this.settings.engineMode());
  readonly exposeTcp = signal(this.settings.exposeTcp());
  readonly resourceSaverEnabled = signal(this.settings.resourceSaverEnabled());
  readonly resourceSaverTimeout = signal(this.settings.resourceSaverTimeout());
  readonly wslIntegrationEnabled = signal(this.settings.wslIntegrationEnabled());

  readonly isExternalMode = computed(() => this.engineMode() === 'external');

  // File sharing state
  readonly fileSharingPaths = signal<string[]>([...this.settings.fileSharingPaths()]);
  readonly newSharePath = signal<string>('');

  // Proxies state
  readonly desktopProxy = signal<DesktopProxyConfig>({ ...this.settings.desktopProxy() });
  readonly containersProxy = signal<ContainersProxyConfig>({ ...this.settings.containersProxy() });

  // Network state
  readonly networkSettings = signal<NetworkSettingsConfig>({ ...this.settings.network() });

  // WSL integration state
  readonly installedWslDistros = signal<string[]>([]);
  readonly isLoadingDistros = signal(false);
  readonly wslAdditionalDistros = signal<string[]>([...this.settings.wslAdditionalDistros()]);

  readonly selectedTheme = signal<'light' | 'dark' | 'system'>(
    this.themeService.isDeviceDefaultTheme()
      ? 'system'
      : this.themeService.currentTheme() === AppTheme.LIGHT
        ? 'light'
        : 'dark'
  );

  // Initial values snapshot to compute pristine vs dirty state
  readonly initialState = signal({
    startAtLogin: this.settings.startAtLogin(),
    openDashboard: this.settings.openDashboard(),
    engineMode: this.settings.engineMode(),
    exposeTcp: this.settings.exposeTcp(),
    resourceSaverEnabled: this.settings.resourceSaverEnabled(),
    resourceSaverTimeout: this.settings.resourceSaverTimeout(),
    wslIntegrationEnabled: this.settings.wslIntegrationEnabled(),
    allocatedCpus: 2,
    allocatedMemoryGb: 4,
    allocatedSwapGb: 1,
    virtualDiskLimitGb: 64,
    theme: this.themeService.isDeviceDefaultTheme()
      ? ('system' as const)
      : this.themeService.currentTheme() === AppTheme.LIGHT
        ? ('light' as const)
        : ('dark' as const),
    fileSharingPaths: [...this.settings.fileSharingPaths()],
    desktopProxy: { ...this.settings.desktopProxy() },
    containersProxy: { ...this.settings.containersProxy() },
    networkSettings: { ...this.settings.network() },
    wslAdditionalDistros: [...this.settings.wslAdditionalDistros()]
  });

  // Modal state for restart confirmation
  readonly showRestartModal = signal(false);
  readonly isRestarting = signal(false);

  readonly filteredCategories = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    if (!query) {
      return this.categories;
    }
    return this.categories.filter(c => c.label.toLowerCase().includes(query));
  });

  // Discrete Slider steps for Resource Saver (30s to 60m with 5m step)
  readonly saverSteps = [30, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700, 3000, 3300, 3600];

  readonly resourceSaverLabels: DiscreteSliderLabel[] = [
    { value: 0, label: '30 sec' },
    { value: 3, label: '15 min' },
    { value: 6, label: '30 min' },
    { value: 9, label: '45 min' },
    { value: 12, label: '60 min' }
  ];

  readonly resourceSaverSliderIndex = computed(() => {
    const current = this.resourceSaverTimeout();
    let closestIndex = 0;
    let minDiff = Infinity;
    for (let i = 0; i < this.saverSteps.length; i++) {
      const diff = Math.abs(this.saverSteps[i] - current);
      if (diff < minDiff) {
        minDiff = diff;
        closestIndex = i;
      }
    }
    return closestIndex;
  });

  readonly saverTimeoutLabel = computed(() => {
    const seconds = this.resourceSaverTimeout();
    if (seconds <= 30) return '30 seconds';
    if (seconds < 60) return `${seconds} seconds`;
    return `${Math.round(seconds / 60)} minutes`;
  });

  onResourceSaverSliderChange(val: number | string): void {
    const index = Number(val);
    const step = this.saverSteps[index];
    if (step !== undefined) {
      this.resourceSaverTimeout.set(step);
    }
  }

  // File Sharing actions
  async browseSharePath(): Promise<void> {
    try {
      const selected = await this.electronApi.selectDirectory();
      if (selected) {
        this.newSharePath.set(selected);
      }
    } catch (err) {
      console.error('Failed to select directory:', err);
    }
  }

  addSharePath(): void {
    const pathToAdd = this.newSharePath().trim();
    if (!pathToAdd) return;
    const current = this.fileSharingPaths();
    if (!current.includes(pathToAdd)) {
      this.fileSharingPaths.set([...current, pathToAdd]);
    }
    this.newSharePath.set('');
  }

  removeSharePath(pathToRemove: string): void {
    this.fileSharingPaths.set(this.fileSharingPaths().filter(p => p !== pathToRemove));
  }

  // Proxies actions
  setDesktopProxyMode(mode: 'system' | 'none' | 'manual'): void {
    this.desktopProxy.update(prev => ({ ...prev, mode }));
  }

  updateDesktopProxyField(field: 'httpProxy' | 'httpsProxy' | 'noProxy', value: string): void {
    this.desktopProxy.update(prev => ({ ...prev, [field]: value }));
  }

  setContainersProxyMode(mode: 'same-as-host' | 'system' | 'none' | 'manual'): void {
    this.containersProxy.update(prev => ({ ...prev, mode }));
  }

  updateContainersProxyField(field: 'httpProxy' | 'httpsProxy' | 'noProxy', value: string): void {
    this.containersProxy.update(prev => ({ ...prev, [field]: value }));
  }

  // Network actions
  updateDockerSubnet(subnet: string): void {
    this.networkSettings.update(prev => ({ ...prev, dockerSubnet: subnet }));
  }

  toggleHostNetworking(): void {
    this.networkSettings.update(prev => ({ ...prev, enableHostNetworking: !prev.enableHostNetworking }));
  }

  updatePortBindingBehavior(behavior: 'open' | 'localhost'): void {
    this.networkSettings.update(prev => ({ ...prev, portBindingBehavior: behavior }));
  }

  updateDefaultNetworkingMode(mode: 'ipv4' | 'dualstack'): void {
    this.networkSettings.update(prev => ({ ...prev, defaultNetworkingMode: mode }));
  }

  updateDnsResolution(dns: 'auto' | 'never' | 'always'): void {
    this.networkSettings.update(prev => ({ ...prev, dnsResolution: dns }));
  }

  // WSL integration actions
  async loadWslDistros(): Promise<void> {
    if (!this.isWindows()) return;
    this.isLoadingDistros.set(true);
    try {
      const distros = await this.electronApi.getWslDistros();
      if (distros && distros.length > 0) {
        this.installedWslDistros.set(distros);
      } else {
        this.installedWslDistros.set(['catbee-container-engine', 'rancher-desktop', 'rancher-desktop-data']);
      }
    } catch {
      this.installedWslDistros.set(['catbee-container-engine', 'rancher-desktop', 'rancher-desktop-data']);
    } finally {
      this.isLoadingDistros.set(false);
    }
  }

  isDistroIntegrated(distro: string): boolean {
    return this.wslAdditionalDistros().includes(distro);
  }

  async toggleDistroIntegration(distro: string): Promise<void> {
    const current = this.wslAdditionalDistros();
    const isIntegrated = current.includes(distro);
    const updated = isIntegrated ? current.filter(d => d !== distro) : [...current, distro];
    this.wslAdditionalDistros.set(updated);
    try {
      await this.electronApi.applyWslDistroIntegration(distro, !isIntegrated);
    } catch (err) {
      console.warn(`Failed to configure WSL integration for distro ${distro}:`, err);
    }
  }

  readonly platform = signal<string>('win32');
  readonly diskLocation = signal<string>('C:\\Users\\AppData\\Local\\CatBee\\engine\\wsl');

  readonly isWindows = computed(() => {
    const p = this.platformInfo()?.platform ?? this.platform();
    return p === 'win32';
  });

  readonly isMacOS = computed(() => {
    const p = this.platformInfo()?.platform ?? this.platform();
    return p === 'darwin';
  });

  readonly isLinux = computed(() => {
    const p = this.platformInfo()?.platform ?? this.platform();
    return p === 'linux';
  });

  readonly autoModeDesc = computed(() => {
    if (this.isWindows()) {
      return "Connects to Docker Desktop or Rancher Desktop if active; otherwise starts CatBee's built-in WSL2 engine.";
    }
    if (this.isMacOS()) {
      return "Connects to Docker Desktop or Colima if active; otherwise starts CatBee's built-in Apple Virtualization microVM.";
    }
    if (this.isLinux()) {
      return "Connects to host Docker/Podman daemon if active; otherwise starts CatBee's built-in Rootless engine.";
    }
    return "Connects to external engine if active; otherwise starts CatBee's built-in container engine.";
  });

  readonly builtInEngineLabel = computed(() => {
    if (this.isWindows()) return 'CatBee Built-in (WSL2)';
    if (this.isMacOS()) return 'CatBee Built-in (Apple Virtualization)';
    if (this.isLinux()) return 'CatBee Built-in (Rootless Container)';
    return 'CatBee Built-in Engine';
  });

  readonly builtInEngineDesc = computed(() => {
    if (this.isWindows()) {
      return 'Runs an isolated Alpine Linux Moby engine in WSL2 independently without external software.';
    }
    if (this.isMacOS()) {
      return 'Runs an isolated Alpine Linux microVM using native Apple Virtualization.framework.';
    }
    if (this.isLinux()) {
      return 'Runs a native RootlessKit container daemon in your user namespace without sudo.';
    }
    return 'Runs an isolated container engine.';
  });

  readonly engineBackendSubtitle = computed(() => {
    if (this.isWindows()) return 'WSL2 Alpine Linux Moby Daemon';
    if (this.isMacOS()) return 'Apple VZ Alpine Linux MicroVM';
    if (this.isLinux()) return 'RootlessKit User Container Daemon';
    return 'CatBee Container Daemon';
  });

  readonly engineDistroLabel = computed(() => {
    if (this.isWindows()) return 'Alpine Linux (WSL2)';
    if (this.isMacOS()) return 'Alpine Linux (Apple VZ)';
    if (this.isLinux()) return 'Native Linux (RootlessKit)';
    return 'Alpine Linux';
  });

  readonly defaultEndpointLabel = computed(() => {
    if (this.isWindows()) return 'npipe:////./pipe/catbee-desktop';
    return 'unix:///var/run/docker.sock';
  });

  readonly fileSharingDesc = computed(() => {
    if (this.isWindows()) {
      return 'Configure directory mounts shared into container execution contexts. Windows drives (C:\\, D:\\) are mounted automatically via /mnt/c.';
    }
    if (this.isMacOS()) {
      return 'Configure directory mounts shared into container execution contexts. macOS volumes are shared automatically into the microVM via VirtioFS.';
    }
    return 'Configure directory mounts shared into container execution contexts. Host user directories are mounted automatically.';
  });

  readonly defaultSharedPath = computed(() => {
    if (this.isWindows()) return 'C:\\Users';
    if (this.isMacOS()) return '/Users';
    return '/home';
  });

  readonly maxCpus = computed(() => {
    return Math.max(2, this.platformInfo()?.cpuCount ?? 8);
  });

  readonly maxMemoryGb = computed(() => {
    return Math.max(4, this.platformInfo()?.totalMemory ?? 16);
  });

  readonly daemonConfigPreview = computed(() => {
    if (this.isWindows()) {
      return JSON.stringify(
        {
          builder: {
            gc: {
              defaultKeepStorage: '20GB',
              enabled: true
            }
          },
          experimental: false,
          hosts: ['unix:///var/run/docker.sock', 'tcp://0.0.0.0:23750'],
          iptables: false
        },
        null,
        2
      );
    }
    if (this.isMacOS()) {
      return JSON.stringify(
        {
          builder: {
            gc: {
              defaultKeepStorage: '20GB',
              enabled: true
            }
          },
          experimental: false,
          features: {
            buildkit: true
          }
        },
        null,
        2
      );
    }
    return JSON.stringify(
      {
        builder: {
          gc: {
            defaultKeepStorage: '20GB',
            enabled: true
          }
        },
        experimental: false,
        rootless: true
      },
      null,
      2
    );
  });

  readonly resourceTabItems = computed<TabItem[]>(() => {
    const tabs: TabItem[] = [
      { id: 'advanced', label: 'Advanced' },
      { id: 'file-sharing', label: 'File sharing' },
      { id: 'proxies', label: 'Proxies' },
      { id: 'network', label: 'Network' }
    ];
    if (this.isWindows()) {
      tabs.push({ id: 'wsl', label: 'WSL integration' });
    }
    return tabs;
  });

  onResourceTabChange(tabId: string): void {
    this.selectResourceTab(tabId as 'advanced' | 'file-sharing' | 'proxies' | 'network' | 'wsl');
  }

  // Non-WSL VM resource allocation state (for macOS / Linux)
  readonly allocatedCpus = signal(2);
  readonly allocatedMemoryGb = signal(4);
  readonly allocatedSwapGb = signal(1);
  readonly virtualDiskLimitGb = signal(64);

  readonly hasChanges = computed(() => {
    const init = this.initialState();
    return (
      this.startAtLogin() !== init.startAtLogin ||
      this.openDashboard() !== init.openDashboard ||
      this.engineMode() !== init.engineMode ||
      this.exposeTcp() !== init.exposeTcp ||
      this.resourceSaverEnabled() !== init.resourceSaverEnabled ||
      this.resourceSaverTimeout() !== init.resourceSaverTimeout ||
      this.wslIntegrationEnabled() !== init.wslIntegrationEnabled ||
      this.allocatedCpus() !== init.allocatedCpus ||
      this.allocatedMemoryGb() !== init.allocatedMemoryGb ||
      this.allocatedSwapGb() !== init.allocatedSwapGb ||
      this.virtualDiskLimitGb() !== init.virtualDiskLimitGb ||
      this.selectedTheme() !== init.theme ||
      JSON.stringify(this.fileSharingPaths()) !== JSON.stringify(init.fileSharingPaths) ||
      JSON.stringify(this.desktopProxy()) !== JSON.stringify(init.desktopProxy) ||
      JSON.stringify(this.containersProxy()) !== JSON.stringify(init.containersProxy) ||
      JSON.stringify(this.networkSettings()) !== JSON.stringify(init.networkSettings) ||
      JSON.stringify(this.wslAdditionalDistros()) !== JSON.stringify(init.wslAdditionalDistros)
    );
  });

  readonly requiresEngineRestart = computed(() => {
    const init = this.initialState();
    return this.engineMode() !== init.engineMode || this.exposeTcp() !== init.exposeTcp;
  });

  ngOnInit(): void {
    const tab = this.route.snapshot.queryParamMap.get('tab');
    if (tab && this.categories.some(c => c.id === tab)) {
      this.activeCategory.set(tab as SettingsCategory['id']);
    }

    this.route.queryParamMap.subscribe(params => {
      const t = params.get('tab');
      if (t && this.categories.some(c => c.id === t)) {
        this.activeCategory.set(t as SettingsCategory['id']);
      }
    });

    void this.loadEngineSettings();
    void this.loadEngineStatus();
    void this.loadPlatformInfo();
    void this.loadDockerContext();
    void this.loadWslDistros();
  }

  async loadEngineSettings(): Promise<void> {
    try {
      await this.settings.syncFromBackend();
      this.engineMode.set(this.settings.engineMode());
      this.exposeTcp.set(this.settings.exposeTcp());
      this.resourceSaverEnabled.set(this.settings.resourceSaverEnabled());
      this.resourceSaverTimeout.set(this.settings.resourceSaverTimeout());
      this.wslIntegrationEnabled.set(this.settings.wslIntegrationEnabled());
      this.fileSharingPaths.set([...this.settings.fileSharingPaths()]);
      this.desktopProxy.set({ ...this.settings.desktopProxy() });
      this.containersProxy.set({ ...this.settings.containersProxy() });
      this.networkSettings.set({ ...this.settings.network() });
      this.wslAdditionalDistros.set([...this.settings.wslAdditionalDistros()]);
      this.commitInitialState();
    } catch {
      // Ignored
    }
  }

  async loadEngineStatus(): Promise<void> {
    try {
      const status = await this.electronApi.getEmbeddedEngineStatus();
      if (status) {
        this.engineStatus.set(status);
      }
    } catch {
      // Ignored if engine status unavailable
    }
  }

  async loadDockerContext(): Promise<void> {
    try {
      const details = await this.electronApi.getDockerContextInfo();
      if (details) {
        this.dockerContext.set(details);
      }
    } catch {
      // Ignored if docker context details unavailable
    }
  }

  requestSwitchDockerContext(contextName: string): void {
    this.pendingContextSwitch.set(contextName);
  }

  cancelSwitchDockerContext(): void {
    this.pendingContextSwitch.set(null);
  }

  async confirmSwitchDockerContext(): Promise<void> {
    const ctx = this.pendingContextSwitch();
    this.pendingContextSwitch.set(null);
    if (!ctx) return;
    await this.switchDockerContext(ctx);
  }

  requestActivateCatBeeContext(): void {
    this.pendingActivateCatBeeContext.set(true);
  }

  cancelActivateCatBeeContext(): void {
    this.pendingActivateCatBeeContext.set(false);
  }

  async confirmActivateCatBeeContext(): Promise<void> {
    this.pendingActivateCatBeeContext.set(false);
    await this.createOrActivateCatBeeContext();
  }

  async switchDockerContext(contextName: string): Promise<void> {
    this.isContextSwitching.set(true);
    this.contextSuccessMessage.set(null);
    this.contextErrorMessage.set(null);
    try {
      const updated = await this.electronApi.useDockerContext(contextName);
      if (updated) {
        this.dockerContext.set(updated);
        this.contextSuccessMessage.set(`Switched active context to "${contextName}". Connected to engine.`);
        setTimeout(() => this.contextSuccessMessage.set(null), 4000);
        await this.settings.syncFromBackend();
        await this.loadEngineStatus();
      }
    } catch (err) {
      console.error('Failed to switch Docker context:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.contextErrorMessage.set(msg);
      setTimeout(() => this.contextErrorMessage.set(null), 8000);
    } finally {
      this.isContextSwitching.set(false);
    }
  }

  async createOrActivateCatBeeContext(): Promise<void> {
    this.isContextSwitching.set(true);
    this.contextSuccessMessage.set(null);
    this.contextErrorMessage.set(null);
    try {
      const updated = await this.electronApi.setupCatBeeContext(true);
      if (updated) {
        this.dockerContext.set(updated);
        this.contextSuccessMessage.set('Activated "catbee-desktop" context. Connected to CatBee Built-in Engine.');
        setTimeout(() => this.contextSuccessMessage.set(null), 4000);
        await this.settings.syncFromBackend();
        await this.loadEngineStatus();
      }
    } catch (err) {
      console.error('Failed to setup catbee context:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.contextErrorMessage.set(msg);
      setTimeout(() => this.contextErrorMessage.set(null), 8000);
    } finally {
      this.isContextSwitching.set(false);
    }
  }

  async loadPlatformInfo(): Promise<void> {
    try {
      const p = await this.electronApi.getPlatform();
      if (p) {
        this.platform.set(p);
      }
      const info = await this.electronApi.getPlatformInfo();
      if (info) {
        this.platformInfo.set(info);
        if (info.platform) {
          this.platform.set(info.platform);
        }
        if (info.platform === 'darwin') {
          this.diskLocation.set('~/Library/Application Support/CatBee/engine/disk.raw');
          this.allocatedCpus.set(Math.min(4, Math.max(1, Math.floor(info.cpuCount / 2))));
          this.allocatedMemoryGb.set(Math.min(8, Math.max(2, Math.floor(info.totalMemory / 2))));
          if (this.activeResourceTab() === 'wsl') {
            this.activeResourceTab.set('advanced');
          }
        } else if (info.platform === 'linux') {
          this.diskLocation.set('~/.local/share/catbee/engine');
          this.allocatedCpus.set(Math.min(4, Math.max(1, Math.floor(info.cpuCount / 2))));
          this.allocatedMemoryGb.set(Math.min(8, Math.max(2, Math.floor(info.totalMemory / 2))));
          if (this.activeResourceTab() === 'wsl') {
            this.activeResourceTab.set('advanced');
          }
        }
      }
    } catch {
      // Ignored
    }
  }

  selectCategory(id: SettingsCategory['id']): void {
    this.activeCategory.set(id);
  }

  selectResourceTab(tab: 'advanced' | 'file-sharing' | 'proxies' | 'network' | 'wsl'): void {
    if (tab === 'wsl' && !this.isWindows()) {
      this.activeResourceTab.set('advanced');
      return;
    }
    this.activeResourceTab.set(tab);
  }

  selectTheme(theme: 'light' | 'dark' | 'system'): void {
    this.selectedTheme.set(theme);
    if (theme === 'system') {
      this.themeService.toggleToDeviceDefaultTheme();
    } else if (theme === 'light') {
      this.themeService.setTheme(AppTheme.LIGHT);
    } else {
      this.themeService.setTheme(AppTheme.DARK);
    }
  }

  async startEngine(): Promise<void> {
    this.isActionLoading.set(true);
    this.engineErrorMessage.set(null);
    try {
      await this.electronApi.startEmbeddedEngine();
      await this.loadEngineStatus();
    } catch (err) {
      console.error('Failed to start engine:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.engineErrorMessage.set(`Failed to start engine: ${msg}`);
    } finally {
      this.isActionLoading.set(false);
    }
  }

  requestStopEngine(): void {
    this.pendingStopEngine.set(true);
  }

  cancelStopEngine(): void {
    this.pendingStopEngine.set(false);
  }

  async confirmStopEngine(): Promise<void> {
    this.pendingStopEngine.set(false);
    this.isActionLoading.set(true);
    this.engineErrorMessage.set(null);
    try {
      await this.electronApi.stopEmbeddedEngine();
      await this.loadEngineStatus();
    } catch (err) {
      console.error('Failed to stop engine:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.engineErrorMessage.set(`Failed to stop engine: ${msg}`);
    } finally {
      this.isActionLoading.set(false);
    }
  }

  async restartEngine(): Promise<void> {
    this.isActionLoading.set(true);
    this.engineErrorMessage.set(null);
    try {
      await this.electronApi.restartEmbeddedEngine();
      await this.loadEngineStatus();
    } catch (err) {
      console.error('Failed to restart engine:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.engineErrorMessage.set(`Failed to restart engine: ${msg}`);
    } finally {
      this.isActionLoading.set(false);
    }
  }

  requestReinstallEngine(): void {
    this.pendingReinstallEngine.set(true);
  }

  cancelReinstallEngine(): void {
    this.pendingReinstallEngine.set(false);
  }

  async confirmReinstallEngine(): Promise<void> {
    this.pendingReinstallEngine.set(false);
    this.isActionLoading.set(true);
    this.engineErrorMessage.set(null);
    try {
      await this.electronApi.installEmbeddedEngine();
      await this.loadEngineStatus();
    } catch (err) {
      console.error('Failed to reinstall engine:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.engineErrorMessage.set(`Failed to reinstall engine: ${msg}`);
    } finally {
      this.isActionLoading.set(false);
    }
  }

  async browseDiskLocation(): Promise<void> {
    try {
      const selected = await this.electronApi.selectDirectory();
      if (selected) {
        this.diskLocation.set(selected);
      }
    } catch (err) {
      console.error('Failed to select directory:', err);
    }
  }

  async openLogsFolder(): Promise<void> {
    try {
      await this.electronApi.openLogsFolder();
    } catch (err) {
      console.error('Failed to open logs:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.settingsErrorMessage.set(`Failed to open logs folder: ${msg}`);
    }
  }

  async openEngineDirectory(): Promise<void> {
    try {
      await this.electronApi.openEngineDirectory();
    } catch (err) {
      console.error('Failed to open engine directory:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.settingsErrorMessage.set(`Failed to open engine directory: ${msg}`);
    }
  }

  async checkForUpdates(): Promise<void> {
    this.isActionLoading.set(true);
    this.updateErrorMessage.set(null);
    try {
      await this.electronApi.checkForUpdates();
    } catch (err) {
      console.error('Failed to check for updates:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.updateErrorMessage.set(`Failed to check for updates: ${msg}`);
    } finally {
      this.isActionLoading.set(false);
    }
  }

  applySettings(): void {
    if (!this.hasChanges()) {
      return;
    }

    if (this.requiresEngineRestart()) {
      this.showRestartModal.set(true);
      return;
    }

    this.settingsErrorMessage.set(null);
    this.saveSettingsToStorage();
    void this.electronApi
      .saveEngineSettings({
        engineMode: this.engineMode(),
        exposeTcp: this.exposeTcp(),
        resourceSaverEnabled: this.resourceSaverEnabled(),
        resourceSaverTimeout: this.resourceSaverTimeout(),
        wslIntegrationEnabled: this.wslIntegrationEnabled(),
        fileSharingPaths: this.fileSharingPaths(),
        desktopProxy: this.desktopProxy(),
        containersProxy: this.containersProxy(),
        network: this.networkSettings(),
        wslAdditionalDistros: this.wslAdditionalDistros()
      })
      .then(() => {
        this.commitInitialState();
        this.applySuccessMessage.set('Settings applied successfully!');
        setTimeout(() => {
          this.applySuccessMessage.set(null);
        }, 3000);
      })
      .catch(err => {
        console.error('Failed to apply settings:', err);
        const msg = err instanceof Error ? err.message : String(err);
        this.settingsErrorMessage.set(`Failed to apply settings: ${msg}`);
      });
  }

  private saveSettingsToStorage(): void {
    this.settings.setStartAtLogin(this.startAtLogin());
    this.settings.setOpenDashboard(this.openDashboard());
    this.settings.setEngineMode(this.engineMode());
    this.settings.setExposeTcp(this.exposeTcp());
    this.settings.setResourceSaverEnabled(this.resourceSaverEnabled());
    this.settings.setResourceSaverTimeout(this.resourceSaverTimeout());
    this.settings.setWslIntegrationEnabled(this.wslIntegrationEnabled());
    this.settings.setFileSharingPaths(this.fileSharingPaths());
    this.settings.setDesktopProxy(this.desktopProxy());
    this.settings.setContainersProxy(this.containersProxy());
    this.settings.setNetwork(this.networkSettings());
    this.settings.setWslAdditionalDistros(this.wslAdditionalDistros());
  }

  private commitInitialState(): void {
    this.initialState.set({
      startAtLogin: this.startAtLogin(),
      openDashboard: this.openDashboard(),
      engineMode: this.engineMode(),
      exposeTcp: this.exposeTcp(),
      resourceSaverEnabled: this.resourceSaverEnabled(),
      resourceSaverTimeout: this.resourceSaverTimeout(),
      wslIntegrationEnabled: this.wslIntegrationEnabled(),
      allocatedCpus: this.allocatedCpus(),
      allocatedMemoryGb: this.allocatedMemoryGb(),
      allocatedSwapGb: this.allocatedSwapGb(),
      virtualDiskLimitGb: this.virtualDiskLimitGb(),
      theme: this.selectedTheme(),
      fileSharingPaths: [...this.fileSharingPaths()],
      desktopProxy: { ...this.desktopProxy() },
      containersProxy: { ...this.containersProxy() },
      networkSettings: { ...this.networkSettings() },
      wslAdditionalDistros: [...this.wslAdditionalDistros()]
    });
  }

  async confirmRestartNow(): Promise<void> {
    this.isRestarting.set(true);
    this.settingsErrorMessage.set(null);
    this.saveSettingsToStorage();

    try {
      await this.electronApi.saveEngineSettings({
        engineMode: this.engineMode(),
        exposeTcp: this.exposeTcp(),
        resourceSaverEnabled: this.resourceSaverEnabled(),
        resourceSaverTimeout: this.resourceSaverTimeout(),
        wslIntegrationEnabled: this.wslIntegrationEnabled(),
        fileSharingPaths: this.fileSharingPaths(),
        desktopProxy: this.desktopProxy(),
        containersProxy: this.containersProxy(),
        network: this.networkSettings(),
        wslAdditionalDistros: this.wslAdditionalDistros()
      });

      await this.electronApi.restartEmbeddedEngine(this.engineMode());
      await this.loadEngineStatus();
      await this.dockerApi.pingDockerEngine().catch(() => false);
      await this.loadDockerContext();

      this.commitInitialState();
      this.showRestartModal.set(false);
      this.applySuccessMessage.set('Settings applied and Docker Engine restarted successfully!');
      setTimeout(() => {
        this.applySuccessMessage.set(null);
      }, 4000);
    } catch (err) {
      console.error('Failed to restart engine:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.settingsErrorMessage.set(`Settings saved, but restarting the engine failed: ${msg}`);
      this.showRestartModal.set(false);
    } finally {
      this.isRestarting.set(false);
    }
  }

  confirmRestartLater(): void {
    this.saveSettingsToStorage();
    this.settingsErrorMessage.set(null);
    void this.electronApi
      .saveEngineSettings({
        engineMode: this.engineMode(),
        exposeTcp: this.exposeTcp(),
        resourceSaverEnabled: this.resourceSaverEnabled(),
        resourceSaverTimeout: this.resourceSaverTimeout(),
        wslIntegrationEnabled: this.wslIntegrationEnabled(),
        fileSharingPaths: this.fileSharingPaths(),
        desktopProxy: this.desktopProxy(),
        containersProxy: this.containersProxy(),
        network: this.networkSettings(),
        wslAdditionalDistros: this.wslAdditionalDistros()
      })
      .then(() => {
        this.commitInitialState();
        this.showRestartModal.set(false);
        this.applySuccessMessage.set('Settings saved. Changes will take effect on next restart.');
        setTimeout(() => {
          this.applySuccessMessage.set(null);
        }, 4000);
      })
      .catch(err => {
        console.error('Failed to save settings:', err);
        const msg = err instanceof Error ? err.message : String(err);
        this.settingsErrorMessage.set(`Failed to save settings: ${msg}`);
        this.showRestartModal.set(false);
      });
  }

  cancelRestartModal(): void {
    this.showRestartModal.set(false);
  }

  requestDiscardChanges(): void {
    if (!this.hasChanges()) {
      return;
    }
    this.pendingDiscardChanges.set(true);
  }

  cancelDiscardChanges(): void {
    this.pendingDiscardChanges.set(false);
  }

  confirmDiscardChanges(): void {
    this.pendingDiscardChanges.set(false);
    this.discardChanges();
  }

  discardChanges(): void {
    const init = this.initialState();
    this.startAtLogin.set(init.startAtLogin);
    this.openDashboard.set(init.openDashboard);
    this.engineMode.set(init.engineMode);
    this.exposeTcp.set(init.exposeTcp);
    this.resourceSaverEnabled.set(init.resourceSaverEnabled);
    this.resourceSaverTimeout.set(init.resourceSaverTimeout);
    this.wslIntegrationEnabled.set(init.wslIntegrationEnabled);
    this.allocatedCpus.set(init.allocatedCpus);
    this.allocatedMemoryGb.set(init.allocatedMemoryGb);
    this.allocatedSwapGb.set(init.allocatedSwapGb);
    this.virtualDiskLimitGb.set(init.virtualDiskLimitGb);
    this.fileSharingPaths.set([...init.fileSharingPaths]);
    this.desktopProxy.set({ ...init.desktopProxy });
    this.containersProxy.set({ ...init.containersProxy });
    this.networkSettings.set({ ...init.networkSettings });
    this.wslAdditionalDistros.set([...init.wslAdditionalDistros]);
    this.selectTheme(init.theme);
  }

  close(): void {
    void this.router.navigate(['/containers']);
  }
}
