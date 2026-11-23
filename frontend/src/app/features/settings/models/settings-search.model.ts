export interface SettingSearchItem {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly category: 'general' | 'resources' | 'engine' | 'updates' | 'about';
  readonly categoryLabel: string;
  readonly subTab?: 'advanced' | 'file-sharing' | 'proxies' | 'network' | 'wsl';
  readonly subTabLabel?: string;
  readonly targetId: string;
  readonly platform?: 'win32' | 'darwin' | 'linux';
  readonly icon?: string;
}

type SettingItemDraft = Omit<SettingSearchItem, 'category' | 'categoryLabel' | 'subTab' | 'subTabLabel'>;

const generalItem = (draft: SettingItemDraft): SettingSearchItem => ({
  ...draft,
  category: 'general',
  categoryLabel: 'General'
});

const resourceItem = (
  subTab: NonNullable<SettingSearchItem['subTab']>,
  subTabLabel: string,
  draft: SettingItemDraft
): SettingSearchItem => ({
  ...draft,
  category: 'resources',
  categoryLabel: 'Resources',
  subTab,
  subTabLabel
});

const engineItem = (draft: SettingItemDraft): SettingSearchItem => ({
  ...draft,
  category: 'engine',
  categoryLabel: 'Docker Engine'
});

const updateItem = (draft: SettingItemDraft): SettingSearchItem => ({
  ...draft,
  category: 'updates',
  categoryLabel: 'Software updates'
});

const aboutItem = (draft: SettingItemDraft): SettingSearchItem => ({
  ...draft,
  category: 'about',
  categoryLabel: 'About'
});

export const SETTINGS_SEARCH_INDEX: readonly SettingSearchItem[] = [
  // GENERAL
  generalItem({
    id: 'start-at-login',
    title: 'Start at login',
    description: 'Start CatBee Container Studio when you sign in to your computer',
    keywords: ['autostart', 'boot', 'startup', 'launch', 'login', 'system', 'sign in'],
    targetId: 'setting-start-at-login',
    icon: 'tune'
  }),
  generalItem({
    id: 'theme-selection',
    title: 'Theme selection',
    description: 'Choose theme for CatBee Studio (Light, Dark, or Sync with system)',
    keywords: ['theme', 'dark mode', 'light mode', 'appearance', 'color scheme', 'sync with system', 'manual theme'],
    targetId: 'setting-theme-selection',
    icon: 'palette'
  }),
  generalItem({
    id: 'engine-mode',
    title: 'How to run Docker containers (Engine mode)',
    description: 'Configure container engine mode: Auto (External First), Built-in Embedded Engine, or External Engine',
    keywords: [
      'engine mode',
      'auto',
      'embedded',
      'external',
      'built-in',
      'docker daemon',
      'runtime',
      'wsl2',
      'virtual machine',
      'colima',
      'docker desktop'
    ],
    targetId: 'setting-engine-mode',
    icon: 'settings_suggest'
  }),
  generalItem({
    id: 'engine-tcp',
    title: 'Expose daemon over TCP',
    description: 'Expose Docker Engine daemon on tcp://localhost:2375 without TLS for local developer tools',
    keywords: [
      'tcp',
      '2375',
      'tcp://localhost:2375',
      'expose daemon',
      'tls',
      'unencrypted',
      'remote api',
      'socket',
      'port 2375'
    ],
    targetId: 'setting-expose-tcp',
    icon: 'settings_ethernet'
  }),
  generalItem({
    id: 'resource-saver',
    title: 'Resource Saver mode',
    description: 'Automatically pause container engine after an idle timeout to conserve CPU, memory and battery',
    keywords: [
      'resource saver',
      'pause engine',
      'idle timeout',
      'sleep',
      'battery',
      'energy',
      'eco',
      'power saving',
      'timeout'
    ],
    targetId: 'setting-resource-saver',
    icon: 'eco'
  }),

  // RESOURCES > ADVANCED
  resourceItem('advanced', 'Advanced', {
    id: 'res-cpus',
    title: 'CPUs limit',
    description: 'Set maximum CPU core allocation for the container virtual machine',
    keywords: ['cpu', 'cores', 'processors', 'hardware', 'threads', 'vm', 'virtual machine', 'resources', 'limit'],
    targetId: 'setting-res-cpus',
    icon: 'memory'
  }),
  resourceItem('advanced', 'Advanced', {
    id: 'res-memory',
    title: 'Memory (RAM) allocation',
    description: 'Set maximum RAM allocated to the CatBee container virtual machine',
    keywords: ['memory', 'ram', 'gigabytes', 'allocation', 'limit', 'virtual machine', 'resources', 'performance'],
    targetId: 'setting-res-memory',
    icon: 'memory'
  }),
  resourceItem('advanced', 'Advanced', {
    id: 'res-swap',
    title: 'Swap file size',
    description: 'Configure swap memory size for the container virtual machine',
    keywords: ['swap', 'virtual memory', 'pagefile', 'buffer', 'resources'],
    targetId: 'setting-res-swap',
    icon: 'memory'
  }),
  resourceItem('advanced', 'Advanced', {
    id: 'res-disk',
    title: 'Virtual disk limit',
    description: 'Maximum disk storage capacity allocated for the CatBee container virtual machine',
    keywords: ['disk', 'storage', 'capacity', 'drive', 'virtual disk', 'gb', 'resources', 'hdd', 'ssd'],
    targetId: 'setting-res-disk',
    icon: 'storage'
  }),
  resourceItem('advanced', 'Advanced', {
    id: 'res-rosetta',
    title: 'Rosetta 2 emulation',
    description: 'Use Rosetta for x86/amd64 emulation on Apple Silicon for accelerated multi-arch image builds',
    keywords: ['rosetta', 'apple silicon', 'm1', 'm2', 'm3', 'm4', 'arm', 'x86', 'amd64', 'emulation', 'macos'],
    targetId: 'setting-res-rosetta',
    platform: 'darwin',
    icon: 'speed'
  }),
  resourceItem('advanced', 'Advanced', {
    id: 'res-disk-location',
    title: 'Disk image location',
    description:
      'Inspect host storage location for the container virtual machine disk image and reveal in file manager',
    keywords: [
      'disk location',
      'path',
      'storage location',
      'image location',
      'vmdk',
      'qcow2',
      'vhdx',
      'reveal',
      'folder'
    ],
    targetId: 'setting-disk-location',
    icon: 'folder_open'
  }),

  // RESOURCES > FILE SHARING
  resourceItem('file-sharing', 'File sharing', {
    id: 'res-file-sharing',
    title: 'File sharing directories (virtiofs)',
    description: 'Configure host directories and folders shared with containers',
    keywords: [
      'file sharing',
      'mounts',
      'directories',
      'folders',
      'host paths',
      'virtiofs',
      'bind mount',
      'volumes',
      'sharing'
    ],
    targetId: 'setting-res-file-sharing',
    icon: 'folder_shared'
  }),

  // RESOURCES > PROXIES
  resourceItem('proxies', 'Proxies', {
    id: 'res-desktop-proxy',
    title: 'Desktop HTTP/HTTPS Proxy',
    description: 'Configure corporate or network proxy settings for the CatBee Studio desktop app',
    keywords: ['desktop proxy', 'proxy', 'http proxy', 'https proxy', 'pac', 'no proxy', 'corporate', 'network'],
    targetId: 'setting-res-desktop-proxy',
    icon: 'vpn_lock'
  }),
  resourceItem('proxies', 'Proxies', {
    id: 'res-containers-proxy',
    title: 'Containers HTTP/HTTPS Proxy',
    description: 'Configure HTTP/HTTPS proxy passed into container runtimes and image builds',
    keywords: [
      'containers proxy',
      'container proxy',
      'docker proxy',
      'build proxy',
      'http_proxy',
      'https_proxy',
      'no_proxy'
    ],
    targetId: 'setting-res-containers-proxy',
    icon: 'vpn_lock'
  }),

  // RESOURCES > NETWORK
  resourceItem('network', 'Network', {
    id: 'res-network-subnet',
    title: 'Docker subnet (bridge CIDR)',
    description: 'Configure IP address range allocated to the default Docker bridge network (bip)',
    keywords: ['subnet', 'cidr', 'bip', 'bridge', 'ip range', 'ip address', '172.17', 'network range'],
    targetId: 'setting-res-network-subnet',
    icon: 'lan'
  }),
  resourceItem('network', 'Network', {
    id: 'res-network-port-binding',
    title: 'Port binding behavior',
    description: 'Set whether published container ports bind to all interfaces (0.0.0.0) or loopback only (127.0.0.1)',
    keywords: ['port binding', 'ports', 'localhost', '127.0.0.1', '0.0.0.0', 'listen', 'interfaces', 'loopback'],
    targetId: 'setting-res-network-port-binding',
    icon: 'input'
  }),
  resourceItem('network', 'Network', {
    id: 'res-network-mode',
    title: 'Default networking mode',
    description: 'Configure default container network driver (bridge, host, none)',
    keywords: ['networking mode', 'network mode', 'bridge', 'host network', 'driver', 'none'],
    targetId: 'setting-res-network-mode',
    icon: 'hub'
  }),

  // RESOURCES > WSL INTEGRATION
  resourceItem('wsl', 'WSL Integration', {
    id: 'res-wsl',
    title: 'WSL 2 distribution integration',
    description: 'Enable CatBee Docker CLI and engine integration with additional installed WSL 2 distributions',
    keywords: [
      'wsl',
      'wsl2',
      'wsl integration',
      'distro',
      'distros',
      'ubuntu',
      'debian',
      'alpine',
      'windows subsystem for linux'
    ],
    targetId: 'setting-res-wsl',
    platform: 'win32',
    icon: 'terminal'
  }),

  // DOCKER ENGINE
  engineItem({
    id: 'engine-built-in',
    title: 'CatBee Built-in Container Engine',
    description: 'Manage CatBee embedded container engine lifecycle (Start, Stop, Restart, Reinstall, Status)',
    keywords: [
      'built-in engine',
      'embedded engine',
      'docker cli',
      'cli version',
      'start engine',
      'stop engine',
      'restart engine',
      'reinstall engine',
      'uninstall engine',
      'dockerd',
      'rootless',
      'wsl2',
      'status',
      'use catbee engine'
    ],
    targetId: 'setting-engine-built-in',
    icon: 'developer_board'
  }),
  engineItem({
    id: 'engine-builders',
    title: 'Builders & BuildKit instances',
    description:
      'Inspect available BuildKit builders, drivers, platforms, endpoints, and switch active Docker CLI context',
    keywords: [
      'builders',
      'buildkit',
      'buildx',
      'contexts',
      'docker context',
      'catbee-desktop',
      'default',
      'platforms',
      'switch context',
      'cli context'
    ],
    targetId: 'setting-engine-builders',
    icon: 'build_circle'
  }),
  engineItem({
    id: 'engine-prune-cache',
    title: 'Clear build cache',
    description: 'Prune unused BuildKit cache and build layers to reclaim host disk space',
    keywords: [
      'clear build cache',
      'prune cache',
      'buildkit cache',
      'clean cache',
      'free disk space',
      'layers',
      'cache size'
    ],
    targetId: 'setting-engine-prune-cache',
    icon: 'delete_sweep'
  }),
  engineItem({
    id: 'engine-daemon-config',
    title: 'Daemon configuration (daemon.json)',
    description: 'Inspect and review active daemon.json configuration generated from current settings',
    keywords: [
      'daemon.json',
      'configuration',
      'config json',
      'registry-mirrors',
      'insecure-registries',
      'log-driver',
      'storage-driver'
    ],
    targetId: 'setting-engine-daemon-config',
    icon: 'code'
  }),

  // SOFTWARE UPDATES
  updateItem({
    id: 'updates-auto',
    title: 'Software updates',
    description: 'Automatically check for updates and review CatBee Container Studio release channels',
    keywords: [
      'software updates',
      'update',
      'check for updates',
      'upgrade',
      'new version',
      'release notes',
      'changelog'
    ],
    targetId: 'setting-updates-auto',
    icon: 'system_update'
  }),

  // ABOUT
  aboutItem({
    id: 'about-diagnostics',
    title: 'About CatBee Studio & Diagnostics',
    description:
      'Inspect CatBee version, Electron, Node.js, OS kernel, CPU architecture, memory, and system diagnostics',
    keywords: [
      'about',
      'version',
      'diagnostics',
      'electron version',
      'node version',
      'os release',
      'system info',
      'specs',
      'license',
      'github'
    ],
    targetId: 'setting-about',
    icon: 'info'
  }),
  aboutItem({
    id: 'about-maintenance-reset',
    title: 'Restore Default Settings',
    description: 'Restore container engine configuration, resource allocations, and preferences back to defaults',
    keywords: [
      'restore defaults',
      'reset settings',
      'factory reset',
      'default settings',
      'reset to default',
      'maintenance',
      'restore'
    ],
    targetId: 'setting-about-maintenance',
    icon: 'restart_alt'
  })
];
