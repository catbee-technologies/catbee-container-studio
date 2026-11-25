import { CommonModule } from '@angular/common';
import { Component, computed, DestroyRef, effect, HostListener, inject, OnInit, signal } from '@angular/core';
import { disabled, form, FormRoot } from '@angular/forms/signals';
import { ActivatedRoute, Router } from '@angular/router';
import { ConfirmDialogComponent } from '@components/dialog/confirm-dialog';
import { DialogComponent } from '@components/dialog/dialog';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { type TabItem } from '@components/tabs/tabs';
import { SearchInputComponent } from '@components/search-input/search-input';
import { type DiscreteSliderLabel } from '@components/discrete-slider/discrete-slider';
import { type DropdownOption } from '@components/dropdown/dropdown';
import { ElectronApiService } from '@core/electron-api.service';
import { PendingNavigation } from '@utils/pending-navigation.utils';
import { DockerApiService } from '@core/docker-api.service';
import { AppTheme, ThemeService } from '@shared/services/theme.service';
import { CatbeeLoaderComponent } from '@ng-catbee/loader';
import type {
  AutoUpdaterStatus,
  ReleaseNotesInfo,
  ContainersProxyConfig,
  DesktopProxyConfig,
  DockerBuilderInfo,
  DockerContextDetails,
  EmbeddedEngineStatus,
  EngineOperationProgress,
  EngineCapabilities,
  EngineSettings,
  K8sClusterInfo,
  K8sOperationProgress,
  KubernetesSettingsConfig,
  NetworkSettingsConfig,
  ResourceSettingsConfig
} from '@shared/types';
import { EngineMode, SettingsService } from '@features/settings/services/settings.service';
import { SETTINGS_SEARCH_INDEX, type SettingSearchItem } from '@features/settings/models/settings-search.model';
import { SETTINGS_PAGE_CONTEXT } from '@features/settings/services/settings-page.context';
import { SettingsGeneralComponent } from '@features/settings/components/settings-general/settings-general.component';
import { SettingsResourcesComponent } from '@features/settings/components/settings-resources/settings-resources.component';
import { SettingsDockerEngineComponent } from '@features/settings/components/settings-docker-engine/settings-docker-engine.component';
import { SettingsKubernetesComponent } from '@features/settings/components/settings-kubernetes/settings-kubernetes.component';
import { SettingsTroubleshootComponent } from '@features/settings/components/settings-troubleshoot/settings-troubleshoot.component';
import { SettingsUpdatesComponent } from '@features/settings/components/settings-updates/settings-updates.component';
import { SettingsAboutComponent } from '@features/settings/components/settings-about/settings-about.component';
import { K8sIconComponent } from '@shared/components/k8s-icon/k8s-icon.component';
import { formatDockerRelativeTime } from '@utils/docker-display.utils';
import { UI_STORAGE_KEYS } from '@utils/storage.utils';
import { LocalStorageService } from '@ng-catbee/storage';

export interface SettingsCategory {
  readonly id: 'general' | 'resources' | 'engine' | 'kubernetes' | 'troubleshoot' | 'updates' | 'about';
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
  freeDiskGb?: number | null;
}

interface VmResourceSlider {
  id: 'cpus' | 'memory' | 'swap' | 'disk';
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** Values above this are risky for the host and render in red. */
  dangerFrom: number;
  warning: string;
  minLabel: string;
  maxLabel: string;
}

export type ResourceSubTab = 'advanced' | 'file-sharing' | 'proxies' | 'network' | 'wsl';
export type SettingsTheme = 'light' | 'dark' | 'system';

function isValidIpv4Cidr(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value.trim());
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  return octets.every(o => o >= 0 && o <= 255) && prefix >= 8 && prefix <= 30;
}

function isValidProxyUrl(value?: string): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return true; // Optional field
  try {
    const parsed = new URL(trimmed);
    return ['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol) && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function isValidAbsolutePath(path: string, isWin: boolean): boolean {
  const trimmed = path.trim();
  if (!trimmed) return false;

  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(trimmed)) {
    return false;
  }

  if (isWin) {
    // Windows drive letter C:\... or UNC \\server\share (no wildcard or nested backtracking)
    return /^[a-zA-Z]:[\\/]/.test(trimmed) || /^\\\\[^\\/*?"<>|]+(\\[^\\/*?"<>|]+)+$/.test(trimmed);
  }
  // POSIX absolute path
  return trimmed.startsWith('/');
}

function resolveInitialTheme(themeService: ThemeService): SettingsTheme {
  if (themeService.isDeviceDefaultTheme()) {
    return 'system';
  }
  return themeService.currentTheme() === AppTheme.LIGHT ? 'light' : 'dark';
}

function normalizeK8sVersion(v?: string | null): string {
  if (!v) return '';
  return v.trim().replace(/^v/, '');
}

function computeSettingSearchScore(item: SettingSearchItem, query: string, tokens: readonly string[]): number {
  const titleLower = item.title.toLowerCase();
  const descLower = item.description.toLowerCase();
  const catLower = item.categoryLabel.toLowerCase();
  const subTabLower = item.subTabLabel?.toLowerCase() ?? '';
  const keywordsLower = item.keywords.map(k => k.toLowerCase());

  let score = 0;

  if (titleLower === query) {
    score += 200;
  } else if (titleLower.startsWith(query)) {
    score += 120;
  } else if (titleLower.includes(query)) {
    score += 80;
  }

  for (const kw of keywordsLower) {
    if (kw === query) {
      score += 100;
      break;
    }
    if (kw.includes(query)) {
      score += 60;
      break;
    }
  }

  if (subTabLower.includes(query)) score += 50;
  if (catLower.includes(query)) score += 30;
  if (descLower.includes(query)) score += 25;

  if (tokens.length > 1) {
    const fullHaystack = `${titleLower} ${descLower} ${catLower} ${subTabLower} ${keywordsLower.join(' ')}`;
    if (tokens.every(tok => fullHaystack.includes(tok))) {
      score += 70;
    }
  }

  return score;
}

@Component({
  selector: 'catbee-container-studio-settings-page',
  standalone: true,
  providers: [{ provide: SETTINGS_PAGE_CONTEXT, useExisting: SettingsPageComponent }],
  imports: [
    CommonModule,
    DialogComponent,
    ConfirmDialogComponent,
    ErrorBannerComponent,
    SearchInputComponent,
    CatbeeLoaderComponent,
    FormRoot,
    SettingsGeneralComponent,
    SettingsResourcesComponent,
    SettingsDockerEngineComponent,
    SettingsKubernetesComponent,
    SettingsTroubleshootComponent,
    SettingsUpdatesComponent,
    SettingsAboutComponent,
    K8sIconComponent
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
  private readonly destroyRef = inject(DestroyRef);
  private readonly localStorage = inject(LocalStorageService);

  readonly categories: readonly SettingsCategory[] = [
    { id: 'general', label: 'General', icon: 'tune' },
    { id: 'resources', label: 'Resources', icon: 'memory' },
    { id: 'engine', label: 'Docker Engine', icon: 'developer_board' },
    { id: 'kubernetes', label: 'Kubernetes', icon: 'hub' },
    { id: 'troubleshoot', label: 'Troubleshoot', icon: 'healing' },
    { id: 'updates', label: 'Software updates', icon: 'system_update' },
    { id: 'about', label: 'About', icon: 'info' }
  ];

  readonly activeCategory = signal<SettingsCategory['id']>('general');
  readonly searchQuery = signal('');
  readonly isSearchDropdownOpen = signal(false);
  readonly activeSearchIndex = signal(0);

  // Resources sub-tabs
  readonly activeResourceTab = signal<ResourceSubTab>('advanced');

  // Engine status & diagnostics
  readonly engineStatus = signal<EmbeddedEngineStatus | null>(null);
  /** Live install/uninstall progress pushed from the main process. */
  readonly engineOperation = signal<EngineOperationProgress | null>(null);

  readonly platformInfo = signal<PlatformDiagnostics | null>(null);
  readonly activeAction = signal<
    'start' | 'install' | 'stop' | 'restart' | 'reinstall' | 'uninstall' | 'check-updates' | null
  >(null);
  readonly isSavingSettings = signal(false);
  readonly isApplying = computed(() => this.isSavingSettings() || this.isRestarting());
  readonly isActionLoading = computed(() => this.activeAction() !== null || this.isApplying());
  readonly applySuccessMessage = signal<string | null>(null);

  // Error banners state
  readonly settingsErrorMessage = signal<string | null>(null);
  readonly engineErrorMessage = signal<string | null>(null);
  readonly updateErrorMessage = signal<string | null>(null);
  readonly updaterStatus = signal<AutoUpdaterStatus>({ status: 'idle' });
  readonly isMicrosoftStore = signal(false);
  readonly macosQuarantineCommand = 'xattr -d com.apple.quarantine "/Applications/CatBee Container Studio.app"';
  readonly copiedQuarantine = signal(false);
  readonly githubRepoUrl = 'https://github.com/catbee-technologies/catbee-container-studio';
  readonly microsoftStoreImageUrl = computed(
    () => `https://get.microsoft.com/images/en-us%20${this.themeService.isLightMode() ? 'light' : 'dark'}.svg`
  );

  // Release notes state
  readonly currentReleaseNotes = signal<ReleaseNotesInfo | null>(null);
  readonly isLoadingCurrentNotes = signal(false);
  readonly showCurrentNotes = signal(true);

  readonly updateReleaseNotes = signal<ReleaseNotesInfo | null>(null);
  readonly isLoadingUpdateNotes = signal(false);
  readonly showUpdateNotes = signal(true);
  readonly targetUpdateVersion = signal<string | null>(null);

  // Confirmation dialogs state
  readonly pendingStopEngine = signal(false);
  readonly pendingReinstallEngine = signal(false);
  readonly pendingUninstallEngine = signal(false);
  readonly pendingRestoreDefaults = signal(false);
  readonly pendingContextSwitch = signal<string | null>(null);
  readonly pendingActivateCatBeeContext = signal(false);
  readonly pendingDiscardChanges = signal(false);
  readonly pendingPruneBuildCache = signal(false);
  readonly pendingPurgeData = signal(false);
  readonly isPurgingData = signal(false);
  readonly isRestoringDefaults = signal(false);
  readonly purgeDataSuccessMessage = signal<string | null>(null);
  readonly pendingFactoryResetTeardown = signal(false);
  readonly showTeardownModal = signal(false);
  readonly isTeardownInProgress = signal(false);
  readonly teardownSuccess = signal(false);
  readonly teardownStageMessage = signal('Preparing teardown...');
  readonly teardownProgressPercent = signal(0);
  readonly pendingLeave = signal(false);
  private readonly pendingNavigation = new PendingNavigation();

  readonly pendingContextSwitchMessage = computed(() => {
    const ctx = this.pendingContextSwitch();
    if (!ctx) return '';
    return `Are you sure you want to switch the active Docker context to "${ctx}"?`;
  });
  readonly pendingContextSwitchNote = computed(() => {
    const ctx = this.pendingContextSwitch();
    if (!ctx) return null;
    const modeChange = this.contextModeChangeNote(ctx).trim();
    if (modeChange) {
      return `CatBee will reconnect and target all container operations to that endpoint. ${modeChange}`;
    }
    return `CatBee will reconnect and target all container operations to "${ctx}".`;
  });
  readonly activateCatBeeContextMessage = computed(
    () => `Are you sure you want to activate the CatBee Desktop context?`
  );
  // Docker CLI Context management
  readonly dockerContext = signal<DockerContextDetails | null>(null);
  readonly isContextSwitching = signal(false);
  readonly catbeeContextName = computed(() => this.dockerContext()?.catbeeContextName ?? '');

  readonly activateCatBeeContextNote = computed(() => {
    const modeChange = this.contextModeChangeNote(this.catbeeContextName()).trim();
    if (modeChange) {
      return `This will set CatBee's built-in engine as the active Docker context for your host Docker CLI and reconnect CatBee Studio to it. ${modeChange}`;
    }
    return `This will set CatBee's built-in engine as the active Docker context for your host Docker CLI and reconnect CatBee Studio to it.`;
  });
  readonly contextErrorMessage = signal<string | null>(null);

  // Builders & BuildKit state
  readonly builderInfo = signal<DockerBuilderInfo | null>(null);
  readonly isPruningBuildCache = signal(false);
  readonly pruneBuildCacheMessage = signal<string | null>(null);
  readonly expandedBuilderNames = signal<Set<string>>(new Set());
  private hasInitializedBuilderExpansion = false;

  // Form local state (staged before Apply via Signal Forms)
  private readonly formModel = signal({
    startAtLogin: this.settings.startAtLogin(),
    engineMode: this.settings.engineMode(),
    exposeTcp: this.settings.exposeTcp(),
    resourceSaverEnabled: this.settings.resourceSaverEnabled(),
    resourceSaverTimeout: this.settings.resourceSaverTimeout(),
    wslIntegrationEnabled: this.settings.wslIntegrationEnabled(),
    containerQuickSwitcherEnabled: this.settings.containerQuickSwitcherEnabled(),
    selectedTheme: resolveInitialTheme(this.themeService)
  });

  readonly settingsForm = form(
    this.formModel,
    path => {
      disabled(path.startAtLogin, { when: () => this.isMicrosoftStore() });
      disabled(path.exposeTcp, { when: () => this.isExternalMode() });
      disabled(path.resourceSaverEnabled, { when: () => this.isExternalMode() });
      disabled(path.resourceSaverTimeout, { when: () => this.isExternalMode() || !this.resourceSaverEnabled() });
      disabled(path.wslIntegrationEnabled, { when: () => this.isExternalMode() });
    },
    { submission: { action: async () => this.applySettings() } }
  );

  readonly startAtLogin = this.settingsForm.startAtLogin().value;
  readonly engineMode = this.settingsForm.engineMode().value;
  readonly exposeTcp = this.settingsForm.exposeTcp().value;
  readonly resourceSaverEnabled = this.settingsForm.resourceSaverEnabled().value;
  readonly resourceSaverTimeout = this.settingsForm.resourceSaverTimeout().value;
  readonly wslIntegrationEnabled = this.settingsForm.wslIntegrationEnabled().value;
  readonly containerQuickSwitcherEnabled = this.settingsForm.containerQuickSwitcherEnabled().value;
  readonly selectedTheme = this.settingsForm.selectedTheme().value;

  /**
   * External mode as it is actually applied. Selecting the radio alone changes nothing until Apply, and selecting
   * another mode while external is applied re-enables the built-in engine options right away so they can be set first.
   */
  readonly isExternalMode = computed(
    () => this.initialState().engineMode === 'external' && this.engineMode() === 'external'
  );
  readonly pendingEngineModeLabel = computed(() => {
    const mode = this.engineMode();
    return mode === this.initialState().engineMode ? null : this.engineModeLabel(mode);
  });

  // File sharing state
  readonly fileSharingPaths = signal<string[]>([...this.settings.fileSharingPaths()]);
  readonly newSharePath = signal<string>('');
  readonly sharePathError = signal<string | null>(null);

  // Proxies state
  readonly desktopProxy = signal<DesktopProxyConfig>({ ...this.settings.desktopProxy() });
  readonly containersProxy = signal<ContainersProxyConfig>({ ...this.settings.containersProxy() });

  // Network state
  readonly networkSettings = signal<NetworkSettingsConfig>({ ...this.settings.network() });

  // Field validations
  readonly dockerSubnetError = computed<string | null>(() => {
    const val = this.networkSettings().dockerSubnet?.trim() ?? '';
    if (!val) {
      return 'Docker subnet cannot be empty.';
    }
    if (!isValidIpv4Cidr(val)) {
      return 'Must be a valid IPv4 CIDR with prefix 8–30 (e.g. 192.168.65.0/24).';
    }
    return null;
  });

  readonly desktopHttpProxyError = computed<string | null>(() => {
    if (this.desktopProxy().mode !== 'manual') return null;
    const val = this.desktopProxy().httpProxy?.trim();
    if (val && !isValidProxyUrl(val)) {
      return 'Must be a valid URL starting with http://, https://, or socks5://';
    }
    return null;
  });

  readonly desktopHttpsProxyError = computed<string | null>(() => {
    if (this.desktopProxy().mode !== 'manual') return null;
    const val = this.desktopProxy().httpsProxy?.trim();
    if (val && !isValidProxyUrl(val)) {
      return 'Must be a valid URL starting with http://, https://, or socks5://';
    }
    return null;
  });

  readonly containersHttpProxyError = computed<string | null>(() => {
    if (this.containersProxy().mode !== 'manual') return null;
    const val = this.containersProxy().httpProxy?.trim();
    if (val && !isValidProxyUrl(val)) {
      return 'Must be a valid URL starting with http://, https://, or socks5://';
    }
    return null;
  });

  readonly containersHttpsProxyError = computed<string | null>(() => {
    if (this.containersProxy().mode !== 'manual') return null;
    const val = this.containersProxy().httpsProxy?.trim();
    if (val && !isValidProxyUrl(val)) {
      return 'Must be a valid URL starting with http://, https://, or socks5://';
    }
    return null;
  });

  readonly hasValidationErrors = computed<boolean>(() => {
    return Boolean(
      this.dockerSubnetError() ||
      this.desktopHttpProxyError() ||
      this.desktopHttpsProxyError() ||
      this.containersHttpProxyError() ||
      this.containersHttpsProxyError()
    );
  });

  // WSL integration state
  readonly installedWslDistros = signal<string[]>([]);
  readonly isLoadingDistros = signal(false);
  readonly wslAdditionalDistros = signal<string[]>([...this.settings.wslAdditionalDistros()]);

  // Initial values snapshot to compute pristine vs dirty state
  readonly initialState = signal({
    startAtLogin: this.settings.startAtLogin(),
    engineMode: this.settings.engineMode(),
    exposeTcp: this.settings.exposeTcp(),
    resourceSaverEnabled: this.settings.resourceSaverEnabled(),
    resourceSaverTimeout: this.settings.resourceSaverTimeout(),
    wslIntegrationEnabled: this.settings.wslIntegrationEnabled(),
    containerQuickSwitcherEnabled: this.settings.containerQuickSwitcherEnabled(),
    resources: { ...this.settings.resources() } as ResourceSettingsConfig,
    theme: resolveInitialTheme(this.themeService),
    fileSharingPaths: [...this.settings.fileSharingPaths()],
    desktopProxy: { ...this.settings.desktopProxy() },
    containersProxy: { ...this.settings.containersProxy() },
    networkSettings: { ...this.settings.network() },
    wslAdditionalDistros: [...this.settings.wslAdditionalDistros()],
    kubernetes: { ...this.settings.kubernetes() } as KubernetesSettingsConfig
  });

  // Kubernetes state
  readonly k8sEnabled = signal<boolean>(this.settings.kubernetes().enabled);
  readonly k8sProvisioner = signal<'kind' | 'kubeadm'>(this.settings.kubernetes().provisioner);
  readonly k8sVersion = signal<string>(this.settings.kubernetes().version);
  readonly k8sNodeCount = signal<number>(this.settings.kubernetes().nodeCount);
  readonly k8sShowSystemContainers = signal<boolean>(this.settings.kubernetes().showSystemContainers);

  readonly k8sClusterInfo = signal<K8sClusterInfo | null>(null);
  readonly k8sOperation = signal<K8sOperationProgress | null>(null);
  readonly isInstallingK8sRuntime = signal<boolean>(false);
  readonly isUninstallingK8sRuntime = signal<boolean>(false);
  readonly isStartingK8sCluster = signal<boolean>(false);
  readonly isStoppingK8sCluster = signal<boolean>(false);
  readonly isResettingK8sCluster = signal<boolean>(false);
  readonly pendingResetK8sCluster = signal<boolean>(false);
  readonly pendingUninstallK8sRuntime = signal<boolean>(false);
  readonly pendingCancelK8sOperation = signal<boolean>(false);
  readonly isCancellingK8sOperation = signal<boolean>(false);

  // Local Kubernetes errors (scoped to the Kubernetes tab, keeping the global settings error banner clean)
  readonly k8sClusterActionError = signal<string | null>(null);
  readonly k8sDismissedClusterError = signal<string | null>(null);
  readonly k8sRuntimeActionError = signal<string | null>(null);
  readonly k8sDismissedRuntimeError = signal<string | null>(null);

  readonly k8sClusterErrorMessage = computed<string | null>(() => {
    const actionErr = this.k8sClusterActionError();
    if (actionErr) return actionErr;
    const infoErr = this.k8sClusterInfo()?.error;
    if (infoErr && infoErr !== this.k8sDismissedClusterError()) {
      return infoErr;
    }
    return null;
  });

  readonly k8sRuntimeErrorMessage = computed<string | null>(() => {
    const actionErr = this.k8sRuntimeActionError();
    if (actionErr && actionErr !== this.k8sDismissedRuntimeError()) {
      return actionErr;
    }
    return null;
  });

  readonly k8sErrorMessage = computed<string | null>(() => {
    return this.k8sClusterErrorMessage() ?? this.k8sRuntimeErrorMessage();
  });

  dismissK8sClusterError(): void {
    const currentErr = this.k8sClusterErrorMessage();
    if (currentErr) {
      this.k8sDismissedClusterError.set(currentErr);
    }
    this.k8sClusterActionError.set(null);
    const current = this.k8sClusterInfo();
    if (current?.error) {
      this.k8sClusterInfo.set({ ...current, error: undefined });
    }
  }

  dismissK8sRuntimeError(): void {
    const currentErr = this.k8sRuntimeErrorMessage();
    if (currentErr) {
      this.k8sDismissedRuntimeError.set(currentErr);
    }
    this.k8sRuntimeActionError.set(null);
  }

  dismissK8sError(): void {
    this.dismissK8sClusterError();
    this.dismissK8sRuntimeError();
  }

  readonly isKindInstalled = computed(() => this.k8sClusterInfo()?.isKindInstalled === true);
  readonly isKindInstallationKnown = computed(() => typeof this.k8sClusterInfo()?.isKindInstalled === 'boolean');

  readonly k8sActualVersion = computed(() => {
    return this.k8sClusterInfo()?.version || this.k8sVersion();
  });

  readonly k8sActualNodeCount = computed(() => {
    return this.k8sClusterInfo()?.nodeCount ?? this.k8sNodeCount();
  });

  readonly isK8sRecreationPending = computed(() => {
    const info = this.k8sClusterInfo();
    if (info?.status !== 'running') return false;
    const versionChanged =
      !!info.version && normalizeK8sVersion(info.version) !== normalizeK8sVersion(this.k8sVersion());
    const nodeCountChanged = info.nodeCount !== undefined && info.nodeCount !== this.k8sNodeCount();
    return versionChanged || nodeCountChanged;
  });

  readonly isActiveEngineAvailable = computed(
    () => this.engineStatus()?.runtime?.source === 'external' || (this.isEngineInstalled() && this.isEngineRunning())
  );
  readonly isK8sEngineAvailable = computed(
    () =>
      this.isEngineInstalled() &&
      this.isEngineRunning() &&
      !this.isEngineBusy() &&
      this.engineStatus()?.runtime?.source === 'embedded' &&
      this.k8sClusterInfo()?.status !== 'unavailable'
  );

  readonly isEngineInstalling = computed(
    () =>
      this.engineState() === 'installing' ||
      this.activeAction() === 'install' ||
      this.engineOperation()?.operation === 'install'
  );

  readonly isEngineStarting = computed(() => this.engineState() === 'starting' || this.activeAction() === 'start');

  readonly k8sUnavailableReason = computed<
    'engine-installing' | 'engine-starting' | 'engine-not-installed' | 'engine-external' | 'engine-stopped' | null
  >(() => {
    if (this.isK8sEngineAvailable()) return null;
    if (this.isEngineInstalling()) return 'engine-installing';
    if (this.isEngineStarting()) return 'engine-starting';
    if (!this.isEngineInstalled()) return 'engine-not-installed';
    if (this.isEngineRunning() && this.engineStatus()?.runtime?.source !== 'embedded') return 'engine-external';
    return 'engine-stopped';
  });

  readonly k8sVersionOptions = signal<DropdownOption<string>[]>(
    this.k8sVersion()
      ? [
          {
            value: this.k8sVersion(),
            label: this.k8sVersion().replace(/^v/, '')
          }
        ]
      : []
  );

  readonly k8sNodeLabels: DiscreteSliderLabel[] = [
    { value: 1, label: '1' },
    { value: 2, label: '2' },
    { value: 3, label: '3' },
    { value: 4, label: '4' },
    { value: 5, label: '5' },
    { value: 6, label: '6' },
    { value: 7, label: '7' },
    { value: 8, label: '8' }
  ];

  readonly k8sStatus = computed<K8sClusterInfo['status']>(() => {
    if (!this.isK8sEngineAvailable()) return 'unavailable';
    const op = this.k8sOperation();
    if (op) {
      if (op.operation === 'stop') return 'stopping';
      if (op.operation === 'start' || op.operation === 'reset' || op.operation === 'install') return 'starting';
    }
    if (this.isStoppingK8sCluster()) return 'stopping';
    if (this.isStartingK8sCluster() || this.isResettingK8sCluster()) return 'starting';
    return this.k8sClusterInfo()?.status ?? 'stopped';
  });
  readonly isK8sRunning = computed(() => ['running', 'degraded'].includes(this.k8sStatus()) && !this.isK8sBusy());
  readonly isK8sStopping = computed(
    () => this.k8sStatus() === 'stopping' || this.isStoppingK8sCluster() || this.k8sOperation()?.operation === 'stop'
  );
  readonly isK8sBusy = computed(() => {
    const s = this.k8sStatus();
    return (
      s === 'starting' ||
      s === 'stopping' ||
      this.k8sOperation() !== null ||
      this.isStartingK8sCluster() ||
      this.isStoppingK8sCluster() ||
      this.isResettingK8sCluster() ||
      this.isInstallingK8sRuntime() ||
      this.isUninstallingK8sRuntime() ||
      this.isCancellingK8sOperation()
    );
  });
  readonly k8sStatusLabel = computed(() => {
    if (!this.isK8sEngineAvailable()) return 'Unavailable';
    const op = this.k8sOperation();
    if (op) {
      if (op.operation === 'stop') return 'Stopping';
      if (op.operation === 'reset') return 'Resetting';
      if (op.operation === 'start' || op.operation === 'install') return 'Starting';
    }
    if (this.isStoppingK8sCluster()) return 'Stopping';
    if (this.isResettingK8sCluster()) return 'Resetting';
    if (this.isStartingK8sCluster()) return 'Starting';
    const status = this.k8sStatus();
    switch (status) {
      case 'running':
        return 'Running';
      case 'degraded':
        return 'Degraded';
      case 'starting':
        return 'Starting';
      case 'stopping':
        return 'Stopping';
      case 'error':
        return 'Error';
      default:
        return 'Stopped';
    }
  });
  readonly k8sClusterName = computed(() => this.k8sClusterInfo()?.name ?? '—');
  readonly k8sRuntimeVersion = computed(() => this.k8sClusterInfo()?.runtimeVersion ?? '');
  readonly k8sStartedRelative = computed(() => {
    if (!this.isK8sRunning()) return null;
    const startedAt = this.k8sClusterInfo()?.startedAt;
    if (!startedAt) return null;
    return `Started ${formatDockerRelativeTime(new Date(startedAt))}`;
  });

  readonly draftKubernetesSettings = computed<KubernetesSettingsConfig>(() => ({
    enabled: this.k8sEnabled(),
    provisioner: this.k8sProvisioner(),
    version: this.k8sVersion(),
    nodeCount: this.k8sNodeCount(),
    showSystemContainers: this.k8sShowSystemContainers()
  }));

  readonly isK8sConfigDisabled = computed(() => {
    return (
      !this.k8sEnabled() ||
      !this.isK8sEngineAvailable() ||
      !this.isKindInstalled() ||
      this.isK8sBusy() ||
      this.isEngineBusy()
    );
  });

  toggleK8sShowSystemContainers(): void {
    this.k8sShowSystemContainers.update(v => !v);
  }

  requestResetK8sCluster(): void {
    this.pendingResetK8sCluster.set(true);
  }

  cancelResetK8sCluster(): void {
    this.pendingResetK8sCluster.set(false);
  }

  requestCancelK8sOperation(): void {
    this.pendingCancelK8sOperation.set(true);
  }

  cancelCancelK8sOperation(): void {
    this.pendingCancelK8sOperation.set(false);
  }

  async confirmCancelK8sOperation(): Promise<void> {
    this.pendingCancelK8sOperation.set(false);
    this.dismissK8sClusterError();
    this.isCancellingK8sOperation.set(true);
    try {
      const res = await this.electronApi.cancelK8sOperation();
      if (res.success) {
        this.flashSuccess('Kubernetes operation cancelled.', 4000);
        await this.refreshK8sStatus();
      } else {
        this.reportK8sClusterError('Failed to cancel Kubernetes operation.');
      }
    } catch (err) {
      this.reportK8sClusterError('Failed to cancel Kubernetes operation', err);
    } finally {
      this.isCancellingK8sOperation.set(false);
    }
  }

  async confirmResetK8sCluster(): Promise<void> {
    this.pendingResetK8sCluster.set(false);
    this.dismissK8sClusterError();
    this.isResettingK8sCluster.set(true);
    try {
      const res = await this.electronApi.resetK8sCluster();
      if (res.success) {
        this.flashSuccess('Kubernetes cluster reset successfully.', 4000);
      } else if (!res.cancelled) {
        this.reportK8sClusterError('Failed to reset Kubernetes cluster.');
      }
    } catch (err) {
      this.reportK8sClusterError('Failed to reset Kubernetes cluster', err);
    } finally {
      this.isResettingK8sCluster.set(false);
      await this.refreshK8sStatus();
    }
  }

  requestUninstallK8sRuntime(): void {
    this.pendingUninstallK8sRuntime.set(true);
  }

  cancelUninstallK8sRuntime(): void {
    this.pendingUninstallK8sRuntime.set(false);
  }

  async confirmUninstallK8sRuntime(): Promise<void> {
    this.pendingUninstallK8sRuntime.set(false);
    await this.uninstallK8sRuntime();
  }

  async installK8sRuntime(): Promise<void> {
    if (this.isInstallingK8sRuntime() || this.k8sOperation() !== null) return;
    this.dismissK8sRuntimeError();
    this.isInstallingK8sRuntime.set(true);
    try {
      const res = await this.electronApi.installK8sRuntime();
      if (res.success) {
        this.flashSuccess('Kubernetes kind runtime installed successfully.', 4000);
      } else {
        this.reportK8sRuntimeError('Failed to install Kubernetes kind runtime.');
      }
    } catch (err) {
      this.reportK8sRuntimeError('Failed to install Kubernetes kind runtime', err);
    } finally {
      this.isInstallingK8sRuntime.set(false);
      await this.refreshK8sStatus();
    }
  }

  async uninstallK8sRuntime(): Promise<void> {
    if (this.isUninstallingK8sRuntime() || this.k8sOperation() !== null) return;
    this.dismissK8sRuntimeError();
    this.isUninstallingK8sRuntime.set(true);
    try {
      const res = await this.electronApi.uninstallK8sRuntime();
      if (res.success) {
        this.flashSuccess('Kubernetes kind runtime uninstalled.', 4000);
      } else {
        this.reportK8sRuntimeError('Failed to uninstall Kubernetes kind runtime.');
      }
    } catch (err) {
      this.reportK8sRuntimeError('Failed to uninstall Kubernetes kind runtime', err);
    } finally {
      this.isUninstallingK8sRuntime.set(false);
      await this.refreshK8sStatus();
    }
  }

  async startK8sCluster(): Promise<void> {
    if (this.isStartingK8sCluster() || this.k8sOperation() !== null) return;
    this.dismissK8sClusterError();
    this.isStartingK8sCluster.set(true);
    try {
      const res = await this.electronApi.startK8sCluster(this.draftKubernetesSettings());
      this.adoptSavedKubernetesSettings(res.settings);
      if (res.success) {
        this.flashSuccess('Kubernetes API is ready.', 4000);
      } else if (!res.cancelled) {
        this.reportK8sClusterError('Failed to start Kubernetes cluster.');
      }
    } catch (err) {
      this.reportK8sClusterError('Failed to start Kubernetes cluster', err);
    } finally {
      this.isStartingK8sCluster.set(false);
      await this.refreshK8sStatus();
    }
  }

  async stopK8sCluster(): Promise<void> {
    if (this.isStoppingK8sCluster() || this.k8sOperation() !== null) return;
    this.dismissK8sClusterError();
    this.isStoppingK8sCluster.set(true);
    try {
      const res = await this.electronApi.stopK8sCluster();
      if (res.success) {
        this.flashSuccess('Kubernetes cluster stopped.', 4000);
      } else {
        this.reportK8sClusterError('Failed to stop Kubernetes cluster.');
      }
    } catch (err) {
      this.reportK8sClusterError('Failed to stop Kubernetes cluster', err);
    } finally {
      this.isStoppingK8sCluster.set(false);
      await this.refreshK8sStatus();
    }
  }

  async applyAndRecreateK8sCluster(): Promise<void> {
    if (this.isK8sBusy() || this.isEngineBusy()) return;
    this.dismissK8sClusterError();
    this.isResettingK8sCluster.set(true);
    try {
      this.flashSuccess('Recreating Kubernetes cluster with new configuration...', 4000);
      const res = await this.electronApi.resetK8sCluster(this.draftKubernetesSettings());
      this.adoptSavedKubernetesSettings(res.settings);
      if (res.success) {
        this.flashSuccess('Kubernetes cluster recreated successfully.', 4000);
      } else if (!res.cancelled) {
        this.reportK8sClusterError('Failed to recreate Kubernetes cluster.');
      }
      await this.refreshK8sStatus();
    } catch (err) {
      this.reportK8sClusterError('Failed to recreate Kubernetes cluster', err);
    } finally {
      this.isResettingK8sCluster.set(false);
    }
  }

  private adoptSavedKubernetesSettings(settings?: KubernetesSettingsConfig): void {
    if (!settings) return;
    this.settings.setKubernetes(settings);
    this.k8sEnabled.set(settings.enabled);
    this.k8sProvisioner.set(settings.provisioner);
    this.k8sVersion.set(settings.version);
    this.k8sNodeCount.set(settings.nodeCount);
    this.k8sShowSystemContainers.set(settings.showSystemContainers);
    this.localStorage.set(UI_STORAGE_KEYS.CONTAINERS_SHOW_K8S, String(settings.showSystemContainers));
    this.initialState.update(initial => ({ ...initial, kubernetes: { ...settings } }));
  }

  async refreshK8sStatus(): Promise<void> {
    try {
      const info = await this.electronApi.getK8sStatus();
      if (info) {
        this.k8sClusterInfo.set(info);
        if (info.operation !== undefined) {
          this.k8sOperation.set(info.operation);
        }
        if (info.operation?.operation === 'install') {
          this.isInstallingK8sRuntime.set(true);
        } else if (!info.operation) {
          this.isInstallingK8sRuntime.set(false);
        }
      }
    } catch {
      // Ignore if not supported
    }
    void this.loadK8sVersions();
  }

  async loadK8sVersions(): Promise<void> {
    try {
      const versions = await this.electronApi.getK8sVersions();
      if (versions && versions.length > 0) {
        const options: DropdownOption<string>[] = versions.map(v => ({
          value: v.startsWith('v') ? v : `v${v}`,
          label: v.replace(/^v/, '')
        }));

        const current = this.k8sVersion();
        if (current) {
          const currentNormalized = current.startsWith('v') ? current : `v${current}`;
          if (!options.some(o => o.value === currentNormalized)) {
            options.unshift({
              value: currentNormalized,
              label: current.replace(/^v/, '')
            });
          }
        }

        this.k8sVersionOptions.set(options);
      }
    } catch {
      // Ignored
    }
  }

  // Modal state for restart confirmation
  readonly showRestartModal = signal(false);
  readonly isRestarting = signal(false);

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

  /**
   * Toggles a boolean signal when the user clicks anywhere inside a switch-row card box,
   * while ignoring clicks directly on the switch component or labels to prevent double-toggling.
   */
  toggleSwitchRow(
    event: MouseEvent | KeyboardEvent | Event,
    targetSignal: { update: (fn: (v: boolean) => boolean) => void },
    disabled = false
  ): void {
    if (disabled) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('catbee-container-studio-switch-input, input, button, label')) {
      return;
    }
    targetSignal.update(v => !v);
  }

  toggleDistroRow(event: MouseEvent, distro: string): void {
    if (this.isExternalMode() || !this.wslIntegrationEnabled()) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('catbee-container-studio-switch-input, input, button, label')) {
      return;
    }
    void this.toggleDistroIntegration(distro);
  }

  // File Sharing actions
  onSharePathInput(value: string): void {
    this.newSharePath.set(value);
    if (this.sharePathError()) {
      this.sharePathError.set(null);
    }
  }

  async browseSharePath(): Promise<void> {
    try {
      const selected = await this.electronApi.selectDirectory();
      if (selected) {
        this.newSharePath.set(selected);
        this.sharePathError.set(null);
      }
    } catch (err) {
      console.error('Failed to select directory:', err);
    }
  }

  addSharePath(): void {
    const pathToAdd = this.newSharePath().trim();
    if (!pathToAdd) return;

    if (!isValidAbsolutePath(pathToAdd, this.isWindows())) {
      this.sharePathError.set(
        this.isWindows()
          ? String.raw`Path must be an absolute Windows path (e.g. C:\Users\... or \\server\share)`
          : 'Path must be an absolute path starting with /'
      );
      return;
    }

    const current = this.fileSharingPaths();
    if (current.includes(pathToAdd)) {
      this.sharePathError.set('This directory is already in your shared list.');
      return;
    }

    this.fileSharingPaths.set([...current, pathToAdd]);
    this.newSharePath.set('');
    this.sharePathError.set(null);
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

  updatePortBindingBehavior(behavior: 'open' | 'localhost'): void {
    this.networkSettings.update(prev => ({ ...prev, portBindingBehavior: behavior }));
  }

  updateDefaultNetworkingMode(mode: 'ipv4' | 'dualstack'): void {
    this.networkSettings.update(prev => ({ ...prev, defaultNetworkingMode: mode }));
  }

  // WSL integration actions
  async loadWslDistros(): Promise<void> {
    if (!this.isWindows()) return;
    this.isLoadingDistros.set(true);
    const start = Date.now();
    try {
      this.installedWslDistros.set(await this.electronApi.getWslDistros());
    } catch (err) {
      console.warn('Failed to list WSL distros:', err);
      this.installedWslDistros.set([]);
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 450) {
        await new Promise(r => setTimeout(r, 450 - elapsed));
      }
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
      // Integration is applied immediately, so persist it right away rather than waiting for Apply.
      await this.electronApi.saveEngineSettings({ wslAdditionalDistros: updated });
      this.settings.setWslAdditionalDistros(updated);
      this.initialState.update(init => ({ ...init, wslAdditionalDistros: [...updated] }));
    } catch (err) {
      this.wslAdditionalDistros.set(current);
      const msg = err instanceof Error ? err.message : String(err);
      this.settingsErrorMessage.set(`Failed to configure WSL integration for ${distro}: ${msg}`);
    }
  }

  readonly platform = signal<string>('');

  readonly engineInfo = computed(() => this.engineStatus()?.info ?? null);
  readonly capabilities = computed<EngineCapabilities | null>(() => this.engineInfo()?.capabilities ?? null);
  readonly dataLocation = computed(() => this.engineInfo()?.dataLocation ?? '');
  readonly engineState = computed(() => {
    const op = this.engineOperation();
    if (op) {
      if (op.operation === 'install') return 'installing';
      if (op.operation === 'uninstall') return 'uninstalling';
    }
    if (this.activeAction() === 'install' || this.activeAction() === 'reinstall') return 'installing';
    if (this.activeAction() === 'start') return 'starting';
    if (this.activeAction() === 'stop') return 'stopping';
    if (this.activeAction() === 'uninstall') return 'uninstalling';
    return this.engineStatus()?.state ?? 'not-installed';
  });
  readonly isEngineBusy = computed(
    () =>
      ['installing', 'starting', 'stopping', 'uninstalling'].includes(this.engineState()) ||
      this.engineOperation() !== null ||
      this.activeAction() === 'install' ||
      this.activeAction() === 'uninstall' ||
      this.activeAction() === 'restart' ||
      this.activeAction() === 'reinstall'
  );
  readonly isEngineRunning = computed(() => this.engineState() === 'running');
  /** The built-in engine is running, but CatBee is connected to a different (external) engine. */
  readonly isEngineIdle = computed(() => this.isEngineRunning() && this.engineStatus()?.runtime?.source !== 'embedded');
  readonly isCatBeeContextActive = computed(() => {
    const dc = this.dockerContext();
    if (dc) {
      return dc.isCatBeeActive;
    }
    return this.engineStatus()?.runtime?.source === 'embedded';
  });
  readonly canUseCatBeeEngine = computed(() => {
    if (!this.isEngineInstalled()) return false;
    if (this.isCatBeeContextActive()) return false;
    if (this.isActionLoading()) return false;
    if (this.isEngineBusy()) return false;
    if (this.engineOperation() !== null) return false;
    if (this.isContextSwitching()) return false;
    return true;
  });
  readonly isEngineInstalled = computed(() => this.engineStatus()?.isInstalled ?? false);
  /** True when in Auto mode while connected to an external Docker runtime */
  readonly isAutoExternalRuntime = computed(
    () => this.engineMode() === 'auto' && this.engineStatus()?.runtime?.source === 'external'
  );
  /** True when the built-in engine is not installed yet and not in external-only mode */
  readonly isEngineNotInstalled = computed(() => !this.isEngineInstalled() && !this.isExternalMode());
  readonly isStarting = computed(
    () =>
      this.activeAction() === 'start' ||
      this.activeAction() === 'install' ||
      this.engineOperation()?.operation === 'install'
  );
  readonly startButtonLabel = computed(() => {
    if (this.isEngineInstalling()) return 'Installing Engine...';
    if (this.isEngineStarting()) return 'Starting Engine...';
    return !this.isEngineInstalled() ? 'Install & Start' : 'Start';
  });
  readonly engineStateLabel = computed(() => {
    const labels: Record<string, string> = {
      'not-installed': 'Not installed',
      installing: 'Installing',
      stopped: 'Stopped',
      starting: 'Starting',
      running: 'Running',
      stopping: 'Stopping',
      uninstalling: 'Uninstalling',
      error: 'Error'
    };
    if (this.isEngineIdle()) return 'Running · Not in use';
    return labels[this.engineState()] ?? this.engineState();
  });
  readonly engineVersion = computed(() => this.engineStatus()?.manifest?.engineVersion ?? null);
  readonly dockerCliVersion = computed(() => this.engineStatus()?.cliVersion ?? null);
  readonly showVmResources = computed(() => this.capabilities()?.managesVmResources ?? false);
  readonly supportsResourceSaver = computed(() => this.capabilities()?.resourceSaver ?? false);
  readonly supportsRosetta = computed(() => this.capabilities()?.resources.rosetta ?? false);
  readonly supportsFileSharing = computed(() => this.capabilities()?.fileSharing ?? this.isMacOS());
  readonly supportsWslIntegration = computed(() => this.capabilities()?.wslIntegration ?? this.isWindows());

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
      return "Connects to Docker Desktop or Rancher Desktop if active; otherwise starts CatBee's built-in WSL 2 engine.";
    }
    if (this.isMacOS()) {
      return "Connects to Docker Desktop, OrbStack or Colima if active; otherwise starts CatBee's built-in Lima VM.";
    }
    if (this.isLinux()) {
      return "Connects to the host Docker/Podman daemon if active; otherwise starts CatBee's built-in rootless engine.";
    }
    return "Connects to an external engine if active; otherwise starts CatBee's built-in container engine.";
  });

  readonly builtInEngineLabel = computed(() => {
    if (this.isWindows()) return 'CatBee Built-in (WSL 2)';
    if (this.isMacOS()) return 'CatBee Built-in (Lima VM)';
    if (this.isLinux()) return 'CatBee Built-in (Rootless Docker)';
    return 'CatBee Built-in Engine';
  });

  engineModeLabel(mode: EngineMode): string {
    switch (mode) {
      case 'auto':
        return 'Auto (External First)';
      case 'embedded':
        return this.builtInEngineLabel();
      case 'external':
        return 'External Engine Only';
    }
  }

  /** Switching the CLI context also switches CatBee's engine, so the backend saves the matching engine mode. */
  private contextModeChangeNote(contextName: string): string {
    const isCatBee = Boolean(contextName && contextName === this.catbeeContextName());
    const target: EngineMode = isCatBee ? 'embedded' : 'external';
    const applied = this.initialState().engineMode;
    if (target === applied && this.engineMode() === applied) return '';
    return ` The engine mode under "Choose how to run Docker containers" changes to "${this.engineModeLabel(target)}".`;
  }

  /** Takes the engine mode the backend just saved as both the selection and the applied mode. */
  private adoptSavedEngineMode(): void {
    const mode = this.settings.engineMode();
    this.engineMode.set(mode);
    this.initialState.update(init => ({ ...init, engineMode: mode }));
  }

  readonly builtInEngineDesc = computed(() => {
    if (this.isWindows()) {
      return 'Runs Docker Engine in a dedicated Alpine Linux WSL 2 distribution, without any other software.';
    }
    if (this.isMacOS()) {
      return 'Runs Docker Engine in a lightweight Linux VM using Apple Virtualization.framework and virtiofs.';
    }
    if (this.isLinux()) {
      return 'Runs a rootless Docker Engine in your user namespace. No sudo or system service required.';
    }
    return 'Runs an isolated container engine.';
  });

  readonly engineBackendSubtitle = computed(() => this.capabilities()?.backendLabel ?? 'CatBee Container Daemon');

  readonly engineDistroLabel = computed(() => this.engineInfo()?.distribution ?? '—');

  readonly endpointLabel = computed(() => {
    const status = this.engineStatus();
    if (status?.endpoint) return status.endpoint;
    if (this.isEngineInstalling()) return 'Configuring during install...';
    return this.isEngineInstalled() ? 'Available when running' : 'Not installed';
  });

  readonly exposedTcpLabel = 'tcp://localhost:2375';

  readonly portBindingHint = computed(() => {
    if (this.isWindows()) {
      return 'Open binds published ports on all interfaces inside WSL 2. Windows forwards them to localhost only, unless networkingMode=mirrored is set in .wslconfig.';
    }
    return 'Open makes published ports reachable from your local network (default). Localhost only restricts them to this computer.';
  });

  readonly fileSharingDesc = computed(
    () =>
      this.capabilities()?.fileSharingNote ??
      'These directories (and their subdirectories) can be bind mounted into Docker containers.'
  );

  readonly defaultSharedPath = computed(() => {
    if (this.isWindows()) return String.raw`C:\Users`;
    if (this.isMacOS()) return '/Users';
    return '/home';
  });

  readonly maxCpus = computed(() => {
    return Math.max(2, this.platformInfo()?.cpuCount ?? 8);
  });

  readonly maxMemoryGb = computed(() => {
    return Math.max(4, this.platformInfo()?.totalMemory ?? 16);
  });

  /** The VM disk can only grow once the engine exists, so never offer a smaller size than what is applied. */
  readonly minDiskGb = computed(() =>
    this.isEngineInstalled() ? Math.max(16, this.initialState().resources.diskGb) : 16
  );

  /** Only the VM resources the active backend really applies, with the value past which the slider turns red. */
  readonly vmSliders = computed<VmResourceSlider[]>(() => {
    const supported = this.capabilities()?.resources;
    const maxCpus = this.maxCpus();
    const maxMemory = this.maxMemoryGb();
    const freeDisk = this.platformInfo()?.freeDiskGb ?? null;
    const sliders: VmResourceSlider[] = [];

    if (supported?.cpus ?? true) {
      sliders.push({
        id: 'cpus',
        label: 'CPUs',
        unit: 'CPUs',
        min: 1,
        max: maxCpus,
        step: 1,
        value: this.allocatedCpus(),
        dangerFrom: Math.max(1, Math.floor(maxCpus * 0.75)),
        warning: 'Leaves too few cores for your computer, which can become sluggish while containers are busy.',
        minLabel: '1 CPU',
        maxLabel: `${maxCpus} CPUs`
      });
    }
    if (supported?.memory ?? true) {
      sliders.push({
        id: 'memory',
        label: 'Memory',
        unit: 'GB',
        min: 1,
        max: maxMemory,
        step: 1,
        value: this.allocatedMemoryGb(),
        dangerFrom: Math.max(2, Math.floor(maxMemory * 0.75)),
        warning: 'Leaves too little memory for your computer and other apps, which can start swapping heavily.',
        minLabel: '1 GB',
        maxLabel: `${maxMemory} GB`
      });
    }
    if (supported?.swap ?? true) {
      sliders.push({
        id: 'swap',
        label: 'Swap',
        unit: 'GB',
        min: 0,
        max: 8,
        step: 1,
        value: this.allocatedSwapGb(),
        dangerFrom: 4,
        warning: 'Large swap files take space on the virtual disk, and heavy swapping is slow.',
        minLabel: 'Off',
        maxLabel: '8 GB'
      });
    }
    if (supported?.disk ?? true) {
      const min = this.minDiskGb();
      // The disk is sparse, but it can grow up to the limit, so warn once the limit exceeds the free space.
      sliders.push({
        id: 'disk',
        label: 'Virtual disk limit',
        unit: 'GB',
        min,
        max: 512,
        step: 8,
        value: this.virtualDiskLimitGb(),
        dangerFrom: freeDisk === null ? 512 : Math.max(min, Math.min(512, freeDisk)),
        warning: `More than the free space on this computer (${freeDisk ?? 0} GB). The disk could fill up as images and volumes grow.`,
        minLabel: `${min} GB`,
        maxLabel: '512 GB'
      });
    }
    return sliders;
  });

  private isSettingAvailable(item: SettingSearchItem): boolean {
    if (!this.isPlatformSupported(item.platform)) {
      return false;
    }
    return this.isCapabilitySupported(item);
  }

  private isPlatformSupported(platform?: 'win32' | 'darwin' | 'linux'): boolean {
    if (!platform) return true;
    switch (platform) {
      case 'win32':
        return this.isWindows();
      case 'darwin':
        return this.isMacOS();
      case 'linux':
        return this.isLinux();
      default:
        return true;
    }
  }

  private isCapabilitySupported(item: SettingSearchItem): boolean {
    switch (item.id) {
      case 'res-rosetta':
        return this.supportsRosetta();
      case 'res-wsl':
        return this.supportsWslIntegration();
      case 'resource-saver':
        return this.supportsResourceSaver();
      case 'res-file-sharing':
        return this.supportsFileSharing();
      default:
        if (item.subTab === 'advanced' && item.id.startsWith('res-')) {
          return this.showVmResources();
        }
        return true;
    }
  }

  /** Settings items available on the current platform and backend capabilities */
  readonly availableSearchIndex = computed<SettingSearchItem[]>(() =>
    SETTINGS_SEARCH_INDEX.filter(item => this.isSettingAvailable(item))
  );

  readonly searchMatches = computed<SettingSearchItem[]>(() => {
    const query = this.searchQuery().trim().toLowerCase();
    if (!query) return [];

    const tokens = query.split(/\s+/).filter(Boolean);
    return this.availableSearchIndex()
      .map(item => ({ item, score: computeSettingSearchScore(item, query, tokens) }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(entry => entry.item);
  });

  readonly categoryMatchCounts = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const match of this.searchMatches()) {
      counts[match.category] = (counts[match.category] ?? 0) + 1;
    }
    return counts;
  });

  readonly filteredCategories = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    if (!query) {
      return this.categories;
    }
    const counts = this.categoryMatchCounts();
    return this.categories.filter(c => c.label.toLowerCase().includes(query) || (counts[c.id] ?? 0) > 0);
  });

  sliderPercent(slider: VmResourceSlider, value: number): string {
    const range = slider.max - slider.min;
    const pct = range > 0 ? ((value - slider.min) / range) * 100 : 100;
    return `${Math.min(100, Math.max(0, pct))}%`;
  }

  setVmResource(id: VmResourceSlider['id'], value: number): void {
    switch (id) {
      case 'cpus':
        this.allocatedCpus.set(value);
        break;
      case 'memory':
        this.allocatedMemoryGb.set(value);
        break;
      case 'swap':
        this.allocatedSwapGb.set(value);
        break;
      case 'disk':
        this.virtualDiskLimitGb.set(value);
        break;
    }
  }

  readonly daemonConfigPreview = signal('{}');

  readonly resources = computed<ResourceSettingsConfig>(() => ({
    cpus: this.allocatedCpus(),
    memoryGb: this.allocatedMemoryGb(),
    swapGb: this.allocatedSwapGb(),
    diskGb: this.virtualDiskLimitGb(),
    rosetta: this.rosettaEnabled()
  }));

  private readonly draftEngineSettings = computed<Partial<EngineSettings>>(() => ({
    engineMode: this.engineMode(),
    exposeTcp: this.exposeTcp(),
    resourceSaverEnabled: this.resourceSaverEnabled(),
    resourceSaverTimeout: this.resourceSaverTimeout(),
    wslIntegrationEnabled: this.wslIntegrationEnabled(),
    fileSharingPaths: this.fileSharingPaths(),
    desktopProxy: this.desktopProxy(),
    containersProxy: this.containersProxy(),
    network: this.networkSettings(),
    resources: this.resources(),
    wslAdditionalDistros: this.wslAdditionalDistros(),
    kubernetes: this.draftKubernetesSettings()
  }));

  constructor() {
    effect(() => {
      const target = this.settings.requestedCategory();
      if (target && this.categories.some(c => c.id === target)) {
        this.selectCategory(target as SettingsCategory['id']);
        this.settings.requestedCategory.set(null);
      }
    });

    effect(onCleanup => {
      const draft = this.draftEngineSettings();
      const timer = setTimeout(() => {
        this.electronApi
          .getEngineDaemonConfig(draft)
          .then(config => this.daemonConfigPreview.set(JSON.stringify(config ?? {}, null, 2)))
          .catch(() => this.daemonConfigPreview.set('{}'));
      }, 250);
      onCleanup(() => clearTimeout(timer));
    });
  }

  private updateCheckStartedAt = 0;
  private pendingStatusTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly minCheckDurationMs = 500;

  readonly resourceTabItems = computed<TabItem[]>(() => {
    const tabs: TabItem[] = [{ id: 'advanced', label: 'Advanced' }];
    if (this.supportsFileSharing()) {
      tabs.push({ id: 'file-sharing', label: 'File sharing' });
    }
    tabs.push({ id: 'proxies', label: 'Proxies' }, { id: 'network', label: 'Network' });
    if (this.supportsWslIntegration()) {
      tabs.push({ id: 'wsl', label: 'WSL integration' });
    }
    return tabs;
  });

  onResourceTabChange(tabId: string): void {
    this.selectResourceTab(tabId as 'advanced' | 'file-sharing' | 'proxies' | 'network' | 'wsl');
  }

  // VM resource allocation (only honoured by VM-based backends, i.e. macOS)
  readonly allocatedCpus = signal(this.settings.resources().cpus);
  readonly allocatedMemoryGb = signal(this.settings.resources().memoryGb);
  readonly allocatedSwapGb = signal(this.settings.resources().swapGb);
  readonly virtualDiskLimitGb = signal(this.settings.resources().diskGb);
  readonly rosettaEnabled = signal(this.settings.resources().rosetta);

  readonly hasChanges = computed(() => {
    const init = this.initialState();
    return (
      this.startAtLogin() !== init.startAtLogin ||
      this.engineMode() !== init.engineMode ||
      this.exposeTcp() !== init.exposeTcp ||
      this.resourceSaverEnabled() !== init.resourceSaverEnabled ||
      this.resourceSaverTimeout() !== init.resourceSaverTimeout ||
      this.wslIntegrationEnabled() !== init.wslIntegrationEnabled ||
      this.containerQuickSwitcherEnabled() !== init.containerQuickSwitcherEnabled ||
      JSON.stringify(this.resources()) !== JSON.stringify(init.resources) ||
      this.selectedTheme() !== init.theme ||
      JSON.stringify(this.fileSharingPaths()) !== JSON.stringify(init.fileSharingPaths) ||
      JSON.stringify(this.desktopProxy()) !== JSON.stringify(init.desktopProxy) ||
      JSON.stringify(this.containersProxy()) !== JSON.stringify(init.containersProxy) ||
      JSON.stringify(this.networkSettings()) !== JSON.stringify(init.networkSettings) ||
      JSON.stringify(this.wslAdditionalDistros()) !== JSON.stringify(init.wslAdditionalDistros) ||
      JSON.stringify(this.draftKubernetesSettings()) !== JSON.stringify(init.kubernetes)
    );
  });

  readonly engineModeChanged = computed(() => this.engineMode() !== this.initialState().engineMode);

  /** Settings that only take effect after the built-in engine re-applies its configuration. */
  readonly engineConfigChanged = computed(() => {
    const init = this.initialState();
    const changed = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b);
    return (
      this.exposeTcp() !== init.exposeTcp ||
      changed(this.desktopProxy(), init.desktopProxy) ||
      changed(this.containersProxy(), init.containersProxy) ||
      changed(this.networkSettings(), init.networkSettings) ||
      (this.showVmResources() && changed(this.resources(), init.resources)) ||
      (this.supportsFileSharing() && changed(this.fileSharingPaths(), init.fileSharingPaths))
    );
  });

  readonly requiresEngineRestart = computed(
    () => this.engineModeChanged() || (this.isEngineRunning() && this.engineConfigChanged())
  );

  readonly isEngineModeSwitchToUninstalled = computed(
    () => this.engineModeChanged() && this.engineMode() === 'embedded' && !this.isEngineInstalled()
  );

  readonly restartDialogTitle = computed(() =>
    this.isEngineModeSwitchToUninstalled() ? 'Set Up Built-in Engine?' : 'Restart Docker Engine?'
  );

  readonly restartDialogConfirmLabel = computed(() =>
    this.isEngineModeSwitchToUninstalled() ? 'Install & Start' : 'Restart Now'
  );

  readonly restartDialogMessage = computed(() => {
    if (this.engineModeChanged()) {
      if (this.isEngineModeSwitchToUninstalled()) {
        return 'You switched to CatBee Built-in engine, which is not yet installed. CatBee will set up and start the built-in engine now.';
      }
      return 'You changed how CatBee runs Docker containers. CatBee needs to reconnect to the container engine for this to take effect.';
    }
    return 'Some of the changed settings (proxies, network, resources or file sharing) are applied by reconfiguring the running built-in engine. Running containers may be restarted.';
  });

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => this.pendingNavigation.resolve(false));
    const tab = this.route.snapshot.queryParamMap.get('tab');
    if (tab && this.categories.some(c => c.id === tab)) {
      this.activeCategory.set(tab as SettingsCategory['id']);
      if (tab === 'kubernetes') {
        void this.refreshK8sStatus();
      }
    }

    this.route.queryParamMap.subscribe(params => {
      const t = params.get('tab');
      if (t && this.categories.some(c => c.id === t)) {
        this.activeCategory.set(t as SettingsCategory['id']);
        if (t === 'kubernetes') {
          void this.refreshK8sStatus();
        }
        if (t === 'updates' && this.updaterStatus().status === 'idle') {
          void this.checkForUpdates();
        }
      }
    });

    void this.loadEngineSettings();
    void this.loadEngineStatus();
    void this.loadDockerContext();
    void this.loadWslDistros();
    void this.refreshK8sStatus();
    void this.loadPlatformInfo().then(() => this.loadCurrentReleaseNotes());

    // The engine switches the CLI to catbee-desktop in the background once it is running, so refresh both.
    const unsubscribe = this.electronApi.onDockerInitializationStatus(() => {
      void this.loadEngineStatus();
      void this.loadDockerContext();
    });
    const unsubscribeProgress = this.electronApi.onEngineOperationProgress(progress => {
      this.engineOperation.set(progress);
      if (!progress) {
        void this.loadEngineStatus();
        void this.loadDockerContext();
      }
    });
    const unsubscribeK8sProgress = this.electronApi.onK8sProgress(progress => {
      this.k8sOperation.set(progress);
      if (progress?.operation === 'install') {
        this.isInstallingK8sRuntime.set(true);
      } else if (!progress) {
        this.isInstallingK8sRuntime.set(false);
        void this.refreshK8sStatus();
      }
    });
    const applyStatus = (status: AutoUpdaterStatus) => {
      this.updaterStatus.set(status);
      if ('version' in status && status.version) {
        this.targetUpdateVersion.set(status.version);
      }
      if (status.status === 'available' || status.status === 'downloading' || status.status === 'downloaded') {
        const ver = 'version' in status && status.version ? status.version : this.targetUpdateVersion();
        if (ver) {
          void this.loadUpdateReleaseNotes(ver);
        }
      }
    };

    const unsubscribeUpdater = this.electronApi.onUpdaterStatus(status => {
      if (this.pendingStatusTimeout) {
        clearTimeout(this.pendingStatusTimeout);
        this.pendingStatusTimeout = null;
      }

      if (status.status === 'checking') {
        if (!this.updateCheckStartedAt) {
          this.updateCheckStartedAt = Date.now();
        }
        applyStatus(status);
        return;
      }

      const elapsed = this.updateCheckStartedAt > 0 ? Date.now() - this.updateCheckStartedAt : 0;
      const delay =
        this.updateCheckStartedAt > 0 && elapsed < this.minCheckDurationMs ? this.minCheckDurationMs - elapsed : 0;
      this.updateCheckStartedAt = 0;

      if (delay > 0) {
        this.pendingStatusTimeout = setTimeout(() => {
          this.pendingStatusTimeout = null;
          applyStatus(status);
        }, delay);
      } else {
        applyStatus(status);
      }
    });
    this.destroyRef.onDestroy(() => {
      if (this.pendingStatusTimeout) {
        clearTimeout(this.pendingStatusTimeout);
        this.pendingStatusTimeout = null;
      }
      unsubscribe?.();
      unsubscribeProgress();
      unsubscribeK8sProgress();
      unsubscribeUpdater();
    });
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
      this.applyResourcesToForm(this.settings.resources());
      this.startAtLogin.set(this.settings.startAtLogin());
      this.k8sEnabled.set(this.settings.kubernetes().enabled);
      this.k8sProvisioner.set(this.settings.kubernetes().provisioner);
      this.k8sVersion.set(this.settings.kubernetes().version);
      this.k8sNodeCount.set(this.settings.kubernetes().nodeCount);
      this.k8sShowSystemContainers.set(this.settings.kubernetes().showSystemContainers);
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
        // Picks up an install/uninstall that started before this page was opened.
        this.engineOperation.set(status.operation ?? null);
        if (this.activeResourceTab() === 'file-sharing' && !this.supportsFileSharing()) {
          this.activeResourceTab.set('advanced');
        }
      }
    } catch {
      // Ignored if engine status unavailable
    }
  }

  async loadDockerContext(): Promise<void> {
    try {
      const [details, builders] = await Promise.all([
        this.electronApi.getDockerContextInfo(),
        this.electronApi.getDockerBuilderInfo()
      ]);
      if (details) {
        this.dockerContext.set(details);
      }
      if (builders) {
        this.builderInfo.set(builders);
        if (!this.hasInitializedBuilderExpansion && builders.currentBuilder) {
          this.hasInitializedBuilderExpansion = true;
          this.expandedBuilderNames.set(new Set([builders.currentBuilder]));
        }
      }
    } catch {
      // Ignored if docker context details unavailable
    }
  }

  requestPruneBuildCache(): void {
    this.pendingPruneBuildCache.set(true);
  }

  cancelPruneBuildCache(): void {
    this.pendingPruneBuildCache.set(false);
  }

  async confirmPruneBuildCache(): Promise<void> {
    this.pendingPruneBuildCache.set(false);
    this.isPruningBuildCache.set(true);
    this.pruneBuildCacheMessage.set(null);
    try {
      await this.dockerApi.pruneBuildCache();
      await this.loadDockerContext();
      this.pruneBuildCacheMessage.set('Build cache was successfully cleared and reclaimed.');
      setTimeout(() => this.pruneBuildCacheMessage.set(null), 4000);
    } catch (err) {
      console.warn('Failed to prune build cache:', err);
    } finally {
      this.isPruningBuildCache.set(false);
    }
  }

  toggleBuilderExpansion(builderName: string): void {
    this.expandedBuilderNames.update(set => {
      const next = new Set(set);
      if (next.has(builderName)) {
        next.delete(builderName);
      } else {
        next.add(builderName);
      }
      return next;
    });
  }

  readonly copiedEndpoint = signal<string | null>(null);

  isBuilderExpanded(builderName: string): boolean {
    return this.expandedBuilderNames().has(builderName);
  }

  hasAvailableBuilders(bInfo?: DockerBuilderInfo | null): boolean {
    return !!bInfo?.builders?.some(b => !b.isCurrent);
  }

  copyEndpoint(endpoint?: string): void {
    if (!endpoint) return;
    navigator.clipboard
      .writeText(endpoint)
      .then(() => {
        this.copiedEndpoint.set(endpoint);
        setTimeout(() => {
          if (this.copiedEndpoint() === endpoint) {
            this.copiedEndpoint.set(null);
          }
        }, 2000);
      })
      .catch(() => {
        // Ignore clipboard write failure
      });
  }

  formatBytes(bytes?: number): string {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  requestSwitchDockerContext(contextName: string): void {
    const builder = this.builderInfo()?.builders.find(b => b.name === contextName);
    if (builder?.status === 'error' && contextName !== this.catbeeContextName()) {
      return;
    }
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
    this.contextErrorMessage.set(null);
    try {
      const updated = await this.electronApi.useDockerContext(contextName);
      if (updated) {
        this.dockerContext.set(updated);
        this.expandedBuilderNames.set(new Set([contextName]));
        await this.settings.syncFromBackend();
        this.adoptSavedEngineMode();
        await this.loadEngineStatus();
        await this.loadDockerContext();
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
    this.contextErrorMessage.set(null);
    try {
      const updated = await this.electronApi.setupCatBeeContext(true);
      if (updated) {
        this.dockerContext.set(updated);
        this.expandedBuilderNames.set(new Set([updated.currentContext ?? this.catbeeContextName()]));
        await this.settings.syncFromBackend();
        this.adoptSavedEngineMode();
        await this.loadEngineStatus();
        await this.loadDockerContext();
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
      const isMsStore = await this.electronApi.isMicrosoftStoreInstallation();
      this.isMicrosoftStore.set(isMsStore);
      const info = await this.electronApi.getPlatformInfo();
      if (info) {
        this.platformInfo.set(info);
        if (info.platform) {
          this.platform.set(info.platform);
        }
        if (info.platform === 'win32' && this.installedWslDistros().length === 0) {
          void this.loadWslDistros();
        }
        if (info.platform !== 'win32' && this.activeResourceTab() === 'wsl') {
          this.activeResourceTab.set('advanced');
        }
      }
    } catch {
      // Ignored
    }
  }

  onSearchInput(value: string): void {
    this.searchQuery.set(value);
    this.activeSearchIndex.set(0);
    this.isSearchDropdownOpen.set(value.trim().length > 0);
  }

  onSearchFocus(): void {
    if (this.searchQuery().trim().length > 0) {
      this.isSearchDropdownOpen.set(true);
    }
  }

  onSearchKeydown(event: KeyboardEvent): void {
    const matches = this.searchMatches();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.isSearchDropdownOpen.set(false);
      return;
    }

    if (!this.isSearchDropdownOpen() || matches.length === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeSearchIndex.update(i => (i + 1) % matches.length);
      this.scrollDropdownItemIntoView();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeSearchIndex.update(i => (i - 1 + matches.length) % matches.length);
      this.scrollDropdownItemIntoView();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const current = matches[this.activeSearchIndex()];
      if (current) {
        this.selectSearchResult(current);
      }
    }
  }

  private scrollDropdownItemIntoView(): void {
    queueMicrotask(() => {
      const activeEl = document.querySelector('.settings-search-dropdown .search-result-item.is-selected');
      activeEl?.scrollIntoView({ block: 'nearest' });
    });
  }

  selectSearchResult(item: SettingSearchItem): void {
    this.activeCategory.set(item.category);
    if (item.subTab) {
      this.activeResourceTab.set(item.subTab);
    }
    if (item.category === 'engine') {
      this.loadDockerContext().catch(() => undefined);
    }
    this.isSearchDropdownOpen.set(false);

    const tryHighlight = (attemptsLeft: number): void => {
      const el = document.getElementById(item.targetId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.remove('setting-highlight-pulse');
        // Force reflow
        el.getBoundingClientRect();
        el.classList.add('setting-highlight-pulse');
        setTimeout(() => el.classList.remove('setting-highlight-pulse'), 2600);
      } else if (attemptsLeft > 0) {
        setTimeout(() => tryHighlight(attemptsLeft - 1), 50);
      }
    };
    setTimeout(() => tryHighlight(6), 60);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const insideSearch = target.closest('.settings-search-wrapper');
    if (!insideSearch && this.isSearchDropdownOpen()) {
      this.isSearchDropdownOpen.set(false);
    }
  }

  selectCategory(id: SettingsCategory['id']): void {
    this.activeCategory.set(id);
    this.isSearchDropdownOpen.set(false);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: id },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
    if (id === 'engine') {
      void this.loadDockerContext();
    }
    if (id === 'kubernetes') {
      void this.refreshK8sStatus();
    }
    if (id === 'updates' && this.updaterStatus().status !== 'checking') {
      void this.checkForUpdates();
    }
  }

  selectResourceTab(tab: 'advanced' | 'file-sharing' | 'proxies' | 'network' | 'wsl'): void {
    if ((tab === 'wsl' && !this.supportsWslIntegration()) || (tab === 'file-sharing' && !this.supportsFileSharing())) {
      this.activeResourceTab.set('advanced');
      return;
    }
    this.activeResourceTab.set(tab);
    if (tab === 'wsl' && this.isWindows()) {
      void this.loadWslDistros();
    }
  }

  selectTheme(theme: SettingsTheme): void {
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
    this.activeAction.set(this.isEngineInstalled() ? 'start' : 'install');
    this.engineErrorMessage.set(null);
    try {
      if (this.isEngineInstalled()) {
        await this.electronApi.startEmbeddedEngine();
      } else {
        // Installing also switches to embedded mode and starts the engine.
        await this.electronApi.installEmbeddedEngine();
        await this.settings.syncFromBackend();
        this.adoptSavedEngineMode();
      }
      await this.loadEngineStatus();
    } catch (err) {
      console.error('Failed to start engine:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.engineErrorMessage.set(`Failed to start engine: ${msg}`);
    } finally {
      this.activeAction.set(null);
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
    this.activeAction.set('stop');
    this.engineErrorMessage.set(null);
    try {
      await this.electronApi.stopEmbeddedEngine();
      await this.loadEngineStatus();
    } catch (err) {
      console.error('Failed to stop engine:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.engineErrorMessage.set(`Failed to stop engine: ${msg}`);
    } finally {
      this.activeAction.set(null);
    }
  }

  async restartEngine(): Promise<void> {
    this.activeAction.set('restart');
    this.engineErrorMessage.set(null);
    try {
      await this.electronApi.restartEmbeddedEngine();
      await this.loadEngineStatus();
    } catch (err) {
      console.error('Failed to restart engine:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.engineErrorMessage.set(`Failed to restart engine: ${msg}`);
    } finally {
      this.activeAction.set(null);
    }
  }

  requestReinstallEngine(): void {
    if (!this.isEngineInstalled()) {
      return;
    }
    this.pendingReinstallEngine.set(true);
  }

  cancelReinstallEngine(): void {
    this.pendingReinstallEngine.set(false);
  }

  async confirmReinstallEngine(): Promise<void> {
    this.pendingReinstallEngine.set(false);
    this.activeAction.set('reinstall');
    this.engineErrorMessage.set(null);
    try {
      await this.electronApi.installEmbeddedEngine();
      await this.loadEngineStatus();
    } catch (err) {
      console.error('Failed to reinstall engine:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.engineErrorMessage.set(`Failed to reinstall engine: ${msg}`);
    } finally {
      this.activeAction.set(null);
    }
  }

  async revealDataLocation(): Promise<void> {
    const location = this.dataLocation();
    if (!location) return;
    try {
      await this.electronApi.showItemInFolder(location);
    } catch (err) {
      console.error('Failed to reveal data location:', err);
    }
  }

  requestUninstallEngine(): void {
    this.pendingUninstallEngine.set(true);
  }

  cancelUninstallEngine(): void {
    this.pendingUninstallEngine.set(false);
  }

  async confirmUninstallEngine(): Promise<void> {
    this.pendingUninstallEngine.set(false);
    this.activeAction.set('uninstall');
    this.engineErrorMessage.set(null);
    try {
      await this.electronApi.uninstallEmbeddedEngine();
      await this.settings.syncFromBackend();
      this.adoptSavedEngineMode();
      await this.loadEngineStatus();
      await this.loadDockerContext();
      this.applySuccessMessage.set('Built-in engine removed.');
      setTimeout(() => this.applySuccessMessage.set(null), 4000);
    } catch (err) {
      console.error('Failed to uninstall engine:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.engineErrorMessage.set(`Failed to uninstall engine: ${msg}`);
    } finally {
      this.activeAction.set(null);
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

  requestRestoreDefaults(): void {
    this.pendingRestoreDefaults.set(true);
  }

  cancelRestoreDefaults(): void {
    this.pendingRestoreDefaults.set(false);
  }

  async confirmRestoreDefaults(): Promise<void> {
    this.pendingRestoreDefaults.set(false);
    this.isRestoringDefaults.set(true);
    this.isSavingSettings.set(true);
    const wasRunning = this.isEngineRunning();
    try {
      await this.electronApi.resetEngineSettings();
      await this.loadEngineSettings();
      this.applySuccessMessage.set('Settings restored to factory defaults.');
      setTimeout(() => this.applySuccessMessage.set(null), 4000);
      if (wasRunning) {
        this.showRestartModal.set(true);
      }
    } catch (err) {
      console.error('Failed to restore default settings:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.settingsErrorMessage.set(`Failed to restore default settings: ${msg}`);
    } finally {
      this.isSavingSettings.set(false);
      this.isRestoringDefaults.set(false);
    }
  }

  requestPurgeData(): void {
    this.pendingPurgeData.set(true);
  }

  cancelPurgeData(): void {
    this.pendingPurgeData.set(false);
  }

  async confirmPurgeData(): Promise<void> {
    this.pendingPurgeData.set(false);
    this.isPurgingData.set(true);
    this.purgeDataSuccessMessage.set(null);
    try {
      const res = await this.electronApi.purgeData();
      const count = (res?.containersPruned ?? 0) + (res?.imagesPruned ?? 0) + (res?.volumesPruned ?? 0);
      const mb = res?.spaceReclaimed ? (res.spaceReclaimed / (1024 * 1024)).toFixed(1) : '0';
      this.purgeDataSuccessMessage.set(`Purge complete: ${count} items deleted, ~${mb} MB disk space reclaimed.`);
      setTimeout(() => this.purgeDataSuccessMessage.set(null), 6000);
    } catch (err) {
      this.reportSettingsError('Failed to purge data', err);
    } finally {
      this.isPurgingData.set(false);
    }
  }

  requestFactoryResetTeardown(): void {
    this.teardownProgressPercent.set(0);
    this.teardownStageMessage.set('Preparing teardown...');
    this.pendingFactoryResetTeardown.set(true);
  }

  cancelFactoryResetTeardown(): void {
    this.pendingFactoryResetTeardown.set(false);
  }

  async confirmFactoryResetTeardown(): Promise<void> {
    this.pendingFactoryResetTeardown.set(false);
    this.teardownProgressPercent.set(0);
    this.teardownStageMessage.set('Starting complete teardown...');
    this.teardownSuccess.set(false);
    this.isTeardownInProgress.set(true);
    this.showTeardownModal.set(true);

    const unsubscribe = this.electronApi.onEngineOperationProgress(progress => {
      if (progress?.operation === 'uninstall') {
        this.teardownProgressPercent.set(progress.progress);
        this.teardownStageMessage.set(progress.stage);
      }
    });

    try {
      await this.electronApi.factoryResetTeardown();
      this.teardownProgressPercent.set(100);
      this.teardownStageMessage.set('Teardown complete.');
      this.teardownSuccess.set(true);
      this.engineOperation.set(null);
    } catch (err) {
      this.reportSettingsError('Teardown failed', err);
      this.isTeardownInProgress.set(false);
      this.showTeardownModal.set(false);
      this.engineOperation.set(null);
    } finally {
      unsubscribe();
    }
  }

  async quitAppAfterTeardown(): Promise<void> {
    await this.electronApi.quitApp();
  }

  closeTeardownDialog(): void {
    this.showTeardownModal.set(false);
  }

  onTeardownDialogClosed(): void {
    this.isTeardownInProgress.set(false);
    this.teardownSuccess.set(false);
    this.teardownProgressPercent.set(0);
    this.teardownStageMessage.set('Preparing teardown...');
    void this.loadEngineStatus();
    void this.loadDockerContext();
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
    if (this.activeAction() === 'check-updates' || this.updaterStatus().status === 'checking') {
      return;
    }
    this.activeAction.set('check-updates');
    this.updateErrorMessage.set(null);
    this.updaterStatus.set({ status: 'checking' });
    this.updateCheckStartedAt = Date.now();
    try {
      await this.electronApi.checkForUpdates();
      const elapsed = this.updateCheckStartedAt > 0 ? Date.now() - this.updateCheckStartedAt : 0;
      const remaining = Math.max(0, this.minCheckDurationMs - elapsed);
      if (remaining > 0) {
        await new Promise(r => setTimeout(r, remaining));
      }
      if (this.updaterStatus().status === 'checking') {
        const ver = this.platformInfo()?.appVersion ?? '';
        this.updaterStatus.set({ status: 'not-available', version: ver });
      }
    } catch (err) {
      console.error('Failed to check for updates:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.updateErrorMessage.set(`Failed to check for updates: ${msg}`);
      this.updaterStatus.set({ status: 'error', message: msg });
    } finally {
      this.activeAction.set(null);
    }
  }

  async copyQuarantineCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.macosQuarantineCommand);
      this.copiedQuarantine.set(true);
      setTimeout(() => this.copiedQuarantine.set(false), 2000);
    } catch (err) {
      console.error('Failed to copy quarantine command:', err);
    }
  }

  async downloadUpdate(): Promise<void> {
    if (this.isMacOS() || this.isMicrosoftStore()) {
      return;
    }
    await this.electronApi.downloadUpdate();
  }

  restartAndInstall(): void {
    if (this.isMacOS()) {
      return;
    }
    this.electronApi.restartAndInstallUpdate();
  }

  openChangelog(currentVersion: string, newVersion: string): void {
    const changelogUrl = `${this.githubRepoUrl}/compare/v${currentVersion}...v${newVersion}`;
    this.electronApi.openExternalUrl(changelogUrl);
  }

  openGithubLatestRelease(): void {
    const status = this.updaterStatus();
    if (status.status !== 'available') {
      return;
    }
    this.electronApi.openExternalUrl(`${this.githubRepoUrl}/releases/tag/v${status.version}`);
  }

  openMicrosoftStorePage(): void {
    this.electronApi.openExternalUrl('ms-windows-store://pdp/?productid=9NX6H3J2RNX2');
  }

  async toggleCurrentReleaseNotes(): Promise<void> {
    const next = !this.showCurrentNotes();
    this.showCurrentNotes.set(next);
    if (next && !this.currentReleaseNotes() && !this.isLoadingCurrentNotes()) {
      await this.loadCurrentReleaseNotes();
    }
  }

  async loadCurrentReleaseNotes(): Promise<void> {
    let ver = this.platformInfo()?.appVersion;
    if (!ver) {
      const info = await this.electronApi.getPlatformInfo();
      if (info?.appVersion) {
        this.platformInfo.set(info);
        ver = info.appVersion;
      }
    }
    this.isLoadingCurrentNotes.set(true);
    try {
      const notes = await this.electronApi.getReleaseNotes(ver);
      this.currentReleaseNotes.set(notes);
    } catch (err) {
      console.warn('Failed to fetch current release notes:', err);
    } finally {
      this.isLoadingCurrentNotes.set(false);
    }
  }

  async loadUpdateReleaseNotes(version: string): Promise<void> {
    if (this.updateReleaseNotes()?.version === version || this.isLoadingUpdateNotes()) {
      return;
    }
    this.isLoadingUpdateNotes.set(true);
    try {
      const notes = await this.electronApi.getReleaseNotes(version);
      this.updateReleaseNotes.set(notes);
    } catch (err) {
      console.warn('Failed to fetch update release notes:', err);
    } finally {
      this.isLoadingUpdateNotes.set(false);
    }
  }

  toggleUpdateNotes(): void {
    this.showUpdateNotes.update(v => !v);
  }

  applySettings(): void {
    if (!this.hasChanges() || this.isActionLoading() || this.hasValidationErrors()) {
      return;
    }

    if (this.requiresEngineRestart()) {
      this.showRestartModal.set(true);
      return;
    }

    void this.persistSettings()
      .then(() => this.flashSuccess('Settings applied successfully!', 3000))
      .catch(err => this.reportSettingsError('Failed to apply settings', err));
  }

  private buildSettingsPayload(): Partial<EngineSettings> {
    return this.draftEngineSettings();
  }

  /** Saves everything to the backend and local storage, then marks the form as pristine. */
  private async persistSettings(): Promise<void> {
    this.isSavingSettings.set(true);
    this.settingsErrorMessage.set(null);
    try {
      const loginChanged = this.startAtLogin() !== this.initialState().startAtLogin;
      const saved = await this.electronApi.saveEngineSettings(this.buildSettingsPayload());
      this.saveSettingsToStorage(saved);
      if (loginChanged) {
        await this.settings.setStartAtLogin(this.startAtLogin());
        this.startAtLogin.set(this.settings.startAtLogin());
      }
      this.settings.setContainerQuickSwitcherEnabled(this.containerQuickSwitcherEnabled());
      if (saved) {
        // The backend clamps/normalises values; reflect what was actually stored.
        this.applyResourcesToForm(saved.resources);
        if (saved.network) this.networkSettings.set({ ...saved.network });
        if (saved.fileSharingPaths) this.fileSharingPaths.set([...saved.fileSharingPaths]);
      }
      this.commitInitialState();
    } finally {
      this.isSavingSettings.set(false);
    }
  }

  private saveSettingsToStorage(saved?: EngineSettings): void {
    this.settings.setEngineMode(this.engineMode());
    this.settings.setExposeTcp(this.exposeTcp());
    this.settings.setResourceSaverEnabled(this.resourceSaverEnabled());
    this.settings.setResourceSaverTimeout(this.resourceSaverTimeout());
    this.settings.setWslIntegrationEnabled(this.wslIntegrationEnabled());
    this.settings.setFileSharingPaths(saved?.fileSharingPaths ?? this.fileSharingPaths());
    this.settings.setDesktopProxy(this.desktopProxy());
    this.settings.setContainersProxy(this.containersProxy());
    this.settings.setNetwork(saved?.network ?? this.networkSettings());
    this.settings.setWslAdditionalDistros(this.wslAdditionalDistros());
    this.settings.setResources(saved?.resources ?? this.resources());
    this.settings.setKubernetes(saved?.kubernetes ?? this.draftKubernetesSettings());
    this.localStorage.set(
      UI_STORAGE_KEYS.CONTAINERS_SHOW_K8S,
      String(saved?.kubernetes?.showSystemContainers ?? this.k8sShowSystemContainers())
    );
  }

  private applyResourcesToForm(resources?: ResourceSettingsConfig): void {
    if (!resources) return;
    this.allocatedCpus.set(resources.cpus);
    this.allocatedMemoryGb.set(resources.memoryGb);
    this.allocatedSwapGb.set(resources.swapGb);
    this.virtualDiskLimitGb.set(resources.diskGb);
    this.rosettaEnabled.set(resources.rosetta);
  }

  private commitInitialState(): void {
    this.initialState.set({
      startAtLogin: this.startAtLogin(),
      engineMode: this.engineMode(),
      exposeTcp: this.exposeTcp(),
      resourceSaverEnabled: this.resourceSaverEnabled(),
      resourceSaverTimeout: this.resourceSaverTimeout(),
      wslIntegrationEnabled: this.wslIntegrationEnabled(),
      containerQuickSwitcherEnabled: this.containerQuickSwitcherEnabled(),
      resources: { ...this.resources() },
      theme: this.selectedTheme(),
      fileSharingPaths: [...this.fileSharingPaths()],
      desktopProxy: { ...this.desktopProxy() },
      containersProxy: { ...this.containersProxy() },
      networkSettings: { ...this.networkSettings() },
      wslAdditionalDistros: [...this.wslAdditionalDistros()],
      kubernetes: { ...this.draftKubernetesSettings() }
    });
  }

  private flashSuccess(message: string, durationMs: number): void {
    this.applySuccessMessage.set(message);
    setTimeout(() => this.applySuccessMessage.set(null), durationMs);
  }

  private formatErrorMessage(err?: unknown): string | null {
    if (!err) return null;
    if (err instanceof Error) {
      return err.message;
    }
    if (typeof err === 'string') {
      return err;
    }
    if (typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
      return (err as { message: string }).message;
    }
    return '';
  }

  private reportSettingsError(prefix: string, err?: unknown): void {
    if (err) {
      console.error(`${prefix}:`, err);
    }
    const msg = this.formatErrorMessage(err);
    this.settingsErrorMessage.set(msg ? `${prefix}: ${msg}` : prefix);
  }

  private reportK8sClusterError(prefix: string, err?: unknown): void {
    if (err) {
      console.error(`${prefix}:`, err);
    }
    const msg = this.formatErrorMessage(err);
    this.k8sClusterActionError.set(msg ? `${prefix}: ${msg}` : prefix);
  }

  private reportK8sRuntimeError(prefix: string, err?: unknown): void {
    if (err) {
      console.error(`${prefix}:`, err);
    }
    const msg = this.formatErrorMessage(err);
    this.k8sRuntimeActionError.set(msg ? `${prefix}: ${msg}` : prefix);
  }

  async confirmRestartNow(): Promise<void> {
    if (this.isActionLoading()) return;
    this.isRestarting.set(true);
    const modeChanged = this.engineModeChanged();
    const isSwitchToUninstalled = this.isEngineModeSwitchToUninstalled();
    try {
      await this.persistSettings();
    } catch (err) {
      this.reportSettingsError('Failed to save settings', err);
      this.showRestartModal.set(false);
      this.isRestarting.set(false);
      return;
    }

    if (isSwitchToUninstalled) {
      this.showRestartModal.set(false);
      this.isRestarting.set(false);
      this.selectCategory('engine');
      this.flashSuccess('Settings saved. Installing CatBee Built-in Container Engine...', 4000);
      void this.startEngine();
      return;
    }

    try {
      if (modeChanged) {
        await this.electronApi.restartEmbeddedEngine(this.engineMode());
      } else {
        await this.electronApi.applyEngineSettings();
      }
      await this.loadEngineStatus();
      await this.dockerApi.pingDockerEngine().catch(() => false);
      await this.loadDockerContext();
      this.showRestartModal.set(false);
      this.flashSuccess(
        modeChanged ? 'Settings applied and Docker Engine restarted.' : 'Settings applied to the running engine.',
        4000
      );
    } catch (err) {
      this.reportSettingsError('Settings saved, but applying them to the engine failed', err);
      this.showRestartModal.set(false);
      await this.loadEngineStatus();
    } finally {
      this.isRestarting.set(false);
    }
  }

  confirmRestartLater(): void {
    if (this.isActionLoading()) return;
    void this.persistSettings()
      .then(() => {
        this.showRestartModal.set(false);
        this.flashSuccess('Settings saved. Changes will take effect the next time the engine starts.', 4000);
      })
      .catch(err => {
        this.reportSettingsError('Failed to save settings', err);
        this.showRestartModal.set(false);
      });
  }

  cancelRestartModal(): void {
    if (this.isApplying()) return;
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

  canDeactivate(): boolean | Promise<boolean> {
    if (!this.hasChanges()) {
      return true;
    }
    this.pendingLeave.set(true);
    return this.pendingNavigation.request();
  }

  confirmLeave(): void {
    this.pendingLeave.set(false);
    this.discardChanges();
    this.pendingNavigation.resolve(true);
  }

  cancelLeave(): void {
    this.pendingLeave.set(false);
    this.pendingNavigation.resolve(false);
  }

  discardChanges(): void {
    const init = this.initialState();
    this.startAtLogin.set(init.startAtLogin);
    this.engineMode.set(init.engineMode);
    this.exposeTcp.set(init.exposeTcp);
    this.resourceSaverEnabled.set(init.resourceSaverEnabled);
    this.resourceSaverTimeout.set(init.resourceSaverTimeout);
    this.wslIntegrationEnabled.set(init.wslIntegrationEnabled);
    this.containerQuickSwitcherEnabled.set(init.containerQuickSwitcherEnabled);
    this.applyResourcesToForm(init.resources);
    this.fileSharingPaths.set([...init.fileSharingPaths]);
    this.desktopProxy.set({ ...init.desktopProxy });
    this.containersProxy.set({ ...init.containersProxy });
    this.networkSettings.set({ ...init.networkSettings });
    this.wslAdditionalDistros.set([...init.wslAdditionalDistros]);
    this.selectTheme(init.theme);
    this.k8sEnabled.set(init.kubernetes.enabled);
    this.k8sProvisioner.set(init.kubernetes.provisioner);
    this.k8sVersion.set(init.kubernetes.version);
    this.k8sNodeCount.set(init.kubernetes.nodeCount);
    this.k8sShowSystemContainers.set(init.kubernetes.showSystemContainers);
    this.newSharePath.set('');
    this.sharePathError.set(null);
  }

  close(): void {
    void this.router.navigate(['/containers']);
  }
}
