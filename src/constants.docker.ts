/** Primary application and runtime identifier (Docker context, pipe name, cluster name). */
export const CATBEE_APP_ID = 'catbee-desktop';

/** Embedded WSL distribution identifier for CatBee container engine. */
export const CATBEE_ENGINE_DISTRO = 'catbee-container-engine';

/** Embedded Lima VM instance identifier on macOS. */
export const CATBEE_LIMA_INSTANCE = 'catbee';

/** Docker context name for CatBee built-in engine. */
export const CATBEE_CONTEXT_NAME = CATBEE_APP_ID;

/** Named pipe identifier for Docker engine on Windows. */
export const CATBEE_WINDOWS_PIPE_NAME = CATBEE_APP_ID;

/** Windows named pipe path. */
export const CATBEE_WINDOWS_PIPE_PATH = `//./pipe/${CATBEE_WINDOWS_PIPE_NAME}`;

/** Default Kubernetes cluster name provisioned by CatBee. */
export const CATBEE_K8S_CLUSTER_NAME = CATBEE_APP_ID;

/** WSL distribution name alias. */
export const CATBEE_WSL_DISTRO = CATBEE_ENGINE_DISTRO;

/** Port the daemon is exposed on when "Expose daemon on TCP" is enabled (Docker Desktop parity). */
export const CATBEE_EXPOSED_TCP_PORT = 2375;

/** Loopback TCP port dockerd listens on inside WSL 2 (accessible via localhost forwarding on Windows). */
export const CATBEE_WSL_DOCKER_TCP_PORT = 23750;

/** Default Kubernetes runtime tool binary version (kind). */
export const KIND_RELEASE_VERSION = 'v0.33.0';

/** Official standalone host Docker CLI release version. */
export const DOCKER_CLI_RELEASE_VERSION = '29.10.0';

/** Companion container image for Kind Cloud Controller Manager (type: LoadBalancer support). */
export const KIND_CLOUD_PROVIDER_IMAGE = 'docker.io/docker/desktop-cloud-provider-kind:v0.6.0';

/** Companion container name for Kind Cloud Controller Manager. */
export const KIND_CLOUD_PROVIDER_CONTAINER = 'kind-cloud-provider';

export const DEFAULT_K8S_VERSION = 'v1.37.0';

/** Curated stable Kubernetes release versions for kind. */
export const DEFAULT_K8S_VERSIONS: readonly string[] = [
  'v1.37.0',
  'v1.36.4',
  'v1.36.1',
  'v1.35.8',
  'v1.35.5',
  'v1.35.1',
  'v1.35.0',
  'v1.34.11',
  'v1.34.8',
  'v1.33.12',
  'v1.32.2',
  'v1.31.4',
  'v1.31.2',
  'v1.30.8',
  'v1.29.12'
];
