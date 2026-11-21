import { inject, Injectable, signal } from '@angular/core';
import { LocalStorageService } from '@ng-catbee/storage';
import { UI_STORAGE_DEFAULTS, UI_STORAGE_KEYS } from '@utils/storage.utils';
import { ElectronApiService } from '@core/electron-api.service';
import type {
  DesktopProxyConfig,
  ContainersProxyConfig,
  EngineSettings,
  NetworkSettingsConfig,
  ResourceSettingsConfig
} from '@shared/types';

export type EngineMode = 'auto' | 'embedded' | 'external';

@Injectable({
  providedIn: 'root'
})
export class SettingsService {
  private readonly localStorage = inject(LocalStorageService);
  private readonly electronApi = inject(ElectronApiService);

  async syncFromBackend(): Promise<void> {
    try {
      const backendSettings = await this.electronApi.getEngineSettings();
      if (backendSettings) {
        this.syncGeneralSettings(backendSettings);
        this.syncAdvancedSettings(backendSettings);
      }
    } catch {
      // Running in environment where electron API is not ready
    }

    try {
      const loginItem = await this.electronApi.getStartAtLogin();
      if (loginItem !== undefined) {
        this.startAtLogin.set(loginItem);
        this.localStorage.set(UI_STORAGE_KEYS.SETTINGS_START_AT_LOGIN, String(loginItem));
      }
    } catch {
      // Login items are unsupported in this environment
    }
  }

  private syncGeneralSettings(backendSettings: EngineSettings): void {
    if (backendSettings.engineMode) {
      this.engineMode.set(backendSettings.engineMode);
      this.localStorage.set(UI_STORAGE_KEYS.SETTINGS_ENGINE_MODE, backendSettings.engineMode);
    }
    if (backendSettings.exposeTcp !== undefined) {
      this.exposeTcp.set(backendSettings.exposeTcp);
      this.localStorage.set(UI_STORAGE_KEYS.SETTINGS_EXPOSE_TCP, String(backendSettings.exposeTcp));
    }
    if (backendSettings.resourceSaverEnabled !== undefined) {
      this.resourceSaverEnabled.set(backendSettings.resourceSaverEnabled);
      this.localStorage.set(
        UI_STORAGE_KEYS.SETTINGS_RESOURCE_SAVER_ENABLED,
        String(backendSettings.resourceSaverEnabled)
      );
    }
    if (backendSettings.resourceSaverTimeout !== undefined) {
      this.resourceSaverTimeout.set(backendSettings.resourceSaverTimeout);
      this.localStorage.set(
        UI_STORAGE_KEYS.SETTINGS_RESOURCE_SAVER_TIMEOUT,
        String(backendSettings.resourceSaverTimeout)
      );
    }
  }

  private syncAdvancedSettings(backendSettings: EngineSettings): void {
    if (backendSettings.wslIntegrationEnabled !== undefined) {
      this.wslIntegrationEnabled.set(backendSettings.wslIntegrationEnabled);
      this.localStorage.set(
        UI_STORAGE_KEYS.SETTINGS_WSL_INTEGRATION_ENABLED,
        String(backendSettings.wslIntegrationEnabled)
      );
    }
    if (backendSettings.fileSharingPaths !== undefined) {
      this.fileSharingPaths.set(backendSettings.fileSharingPaths);
    }
    if (backendSettings.desktopProxy !== undefined) {
      this.desktopProxy.set(backendSettings.desktopProxy);
    }
    if (backendSettings.containersProxy !== undefined) {
      this.containersProxy.set(backendSettings.containersProxy);
    }
    if (backendSettings.network !== undefined) {
      this.network.set(backendSettings.network);
    }
    if (backendSettings.wslAdditionalDistros !== undefined) {
      this.wslAdditionalDistros.set(backendSettings.wslAdditionalDistros);
    }
    if (backendSettings.resources !== undefined) {
      this.resources.set(backendSettings.resources);
    }
  }

  readonly engineMode = signal<EngineMode>(
    (this.localStorage.get(UI_STORAGE_KEYS.SETTINGS_ENGINE_MODE) as EngineMode) ??
      UI_STORAGE_DEFAULTS.SETTINGS_ENGINE_MODE
  );

  readonly startAtLogin = signal<boolean>(
    this.localStorage.getBooleanWithDefault(
      UI_STORAGE_KEYS.SETTINGS_START_AT_LOGIN,
      UI_STORAGE_DEFAULTS.SETTINGS_START_AT_LOGIN
    )
  );

  readonly exposeTcp = signal<boolean>(
    this.localStorage.getBooleanWithDefault(
      UI_STORAGE_KEYS.SETTINGS_EXPOSE_TCP,
      UI_STORAGE_DEFAULTS.SETTINGS_EXPOSE_TCP
    )
  );

  readonly resourceSaverEnabled = signal<boolean>(
    this.localStorage.getBooleanWithDefault(
      UI_STORAGE_KEYS.SETTINGS_RESOURCE_SAVER_ENABLED,
      UI_STORAGE_DEFAULTS.SETTINGS_RESOURCE_SAVER_ENABLED
    )
  );

  readonly resourceSaverTimeout = signal<number>(
    Number(
      this.localStorage.get(UI_STORAGE_KEYS.SETTINGS_RESOURCE_SAVER_TIMEOUT) ??
        UI_STORAGE_DEFAULTS.SETTINGS_RESOURCE_SAVER_TIMEOUT
    )
  );

  readonly wslIntegrationEnabled = signal<boolean>(
    this.localStorage.getBooleanWithDefault(
      UI_STORAGE_KEYS.SETTINGS_WSL_INTEGRATION_ENABLED,
      UI_STORAGE_DEFAULTS.SETTINGS_WSL_INTEGRATION_ENABLED
    )
  );

  readonly fileSharingPaths = signal<string[]>([]);

  readonly desktopProxy = signal<DesktopProxyConfig>({
    mode: 'system',
    httpProxy: '',
    httpsProxy: '',
    noProxy: 'localhost,127.0.0.1,docker.internal'
  });

  readonly containersProxy = signal<ContainersProxyConfig>({
    mode: 'same-as-host',
    httpProxy: '',
    httpsProxy: '',
    noProxy: 'localhost,127.0.0.1'
  });

  readonly network = signal<NetworkSettingsConfig>({
    dockerSubnet: ['192', '168', '65', '0/24'].join('.'),
    portBindingBehavior: 'open',
    defaultNetworkingMode: 'ipv4'
  });

  readonly wslAdditionalDistros = signal<string[]>([]);

  readonly resources = signal<ResourceSettingsConfig>({
    cpus: 2,
    memoryGb: 4,
    swapGb: 1,
    diskGb: 64,
    rosetta: false
  });

  setEngineMode(mode: EngineMode): void {
    this.engineMode.set(mode);
    this.localStorage.set(UI_STORAGE_KEYS.SETTINGS_ENGINE_MODE, mode);
    void this.electronApi.saveEngineSettings({ engineMode: mode }).catch(() => undefined);
  }

  async setStartAtLogin(value: boolean): Promise<void> {
    const applied = (await this.electronApi.setStartAtLogin(value)) ?? value;
    this.startAtLogin.set(applied);
    this.localStorage.set(UI_STORAGE_KEYS.SETTINGS_START_AT_LOGIN, String(applied));
  }

  setExposeTcp(value: boolean): void {
    this.exposeTcp.set(value);
    this.localStorage.set(UI_STORAGE_KEYS.SETTINGS_EXPOSE_TCP, String(value));
  }

  setResourceSaverEnabled(value: boolean): void {
    this.resourceSaverEnabled.set(value);
    this.localStorage.set(UI_STORAGE_KEYS.SETTINGS_RESOURCE_SAVER_ENABLED, String(value));
  }

  setResourceSaverTimeout(seconds: number): void {
    this.resourceSaverTimeout.set(seconds);
    this.localStorage.set(UI_STORAGE_KEYS.SETTINGS_RESOURCE_SAVER_TIMEOUT, String(seconds));
  }

  setWslIntegrationEnabled(value: boolean): void {
    this.wslIntegrationEnabled.set(value);
    this.localStorage.set(UI_STORAGE_KEYS.SETTINGS_WSL_INTEGRATION_ENABLED, String(value));
  }

  setFileSharingPaths(paths: string[]): void {
    this.fileSharingPaths.set(paths);
  }

  setDesktopProxy(config: DesktopProxyConfig): void {
    this.desktopProxy.set(config);
  }

  setContainersProxy(config: ContainersProxyConfig): void {
    this.containersProxy.set(config);
  }

  setNetwork(config: NetworkSettingsConfig): void {
    this.network.set(config);
  }

  setWslAdditionalDistros(distros: string[]): void {
    this.wslAdditionalDistros.set(distros);
  }

  setResources(config: ResourceSettingsConfig): void {
    this.resources.set(config);
  }
}
