export const GLOBAL_STORAGE_PREFIX = 'catbee.docker.logs.';

export const UI_STORAGE_PREFIX = 'catbee.docker.ui.';

export const LOGS_STORAGE_KEYS = {
  TAIL_LINES: `${GLOBAL_STORAGE_PREFIX}tail-lines`,
  SHOW_TIMESTAMPS: `${GLOBAL_STORAGE_PREFIX}show-timestamps`,
  WRAP_LINES: `${GLOBAL_STORAGE_PREFIX}wrap-lines`,
  CLEARED_SINCE_PREFIX: `${GLOBAL_STORAGE_PREFIX}cleared-since.`
};

export const UI_STORAGE_KEYS = {
  SIDEBAR_COLLAPSED: `${UI_STORAGE_PREFIX}sidebar-collapsed`,
  CONTAINERS_SORT_KEY: `${UI_STORAGE_PREFIX}containers.sort-key`,
  CONTAINERS_SORT_DIRECTION: `${UI_STORAGE_PREFIX}containers.sort-direction`,
  CONTAINERS_RUNNING_ONLY: `${UI_STORAGE_PREFIX}containers.running-only`,
  IMAGES_SORT_KEY: `${UI_STORAGE_PREFIX}images.sort-key`,
  IMAGES_SORT_DIRECTION: `${UI_STORAGE_PREFIX}images.sort-direction`,
  IMAGES_USAGE_FILTER: `${UI_STORAGE_PREFIX}images.usage-filter`,
  VOLUMES_SORT_KEY: `${UI_STORAGE_PREFIX}volumes.sort-key`,
  VOLUMES_SORT_DIRECTION: `${UI_STORAGE_PREFIX}volumes.sort-direction`,
  VOLUMES_USAGE_FILTER: `${UI_STORAGE_PREFIX}volumes.usage-filter`
};
