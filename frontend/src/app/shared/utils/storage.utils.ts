import { LogTailOption } from './../types/index';
import {
  ContainerSortKey,
  ImageSortKey,
  ImageUsageFilter,
  SortDirection,
  VolumeSortKey,
  VolumeUsageFilter
} from '@shared/types';

export const APP_PREFIX = 'catbee.app.';
export const APP_UI_STORAGE_PREFIX = `${APP_PREFIX}ui.`;
export const LOGS_STORAGE_PREFIX = 'catbee.docker.logs.';
export const DOCKER_UI_STORAGE_PREFIX = 'catbee.docker.ui.';

export const LOGS_STORAGE_KEYS = {
  TAIL_LINES: `${LOGS_STORAGE_PREFIX}tail-lines`,
  SHOW_TIMESTAMPS: `${LOGS_STORAGE_PREFIX}show-timestamps`,
  WRAP_LINES: `${LOGS_STORAGE_PREFIX}wrap-lines`,
  LOCAL_DATES: `${LOGS_STORAGE_PREFIX}local-dates`,
  CLEARED_SINCE_PREFIX: `${LOGS_STORAGE_PREFIX}cleared-since.`,
  GLOBAL_CLEARED_SINCE_PREFIX: `${LOGS_STORAGE_PREFIX}global-cleared-since.`,
  GLOBAL_SELECTED_CONTAINERS: `${LOGS_STORAGE_PREFIX}global-selected-containers`,
  GLOBAL_SELECTION_INITIALIZED: `${LOGS_STORAGE_PREFIX}global-selection-initialized`,
  GLOBAL_TAIL_LINES: `${LOGS_STORAGE_PREFIX}global-tail-lines`,
  GLOBAL_SHOW_TIMESTAMPS: `${LOGS_STORAGE_PREFIX}global-show-timestamps`,
  GLOBAL_WRAP_LINES: `${LOGS_STORAGE_PREFIX}global-wrap-lines`,
  GLOBAL_LOCAL_DATES: `${LOGS_STORAGE_PREFIX}global-local-dates`
} as const;

export const LOGS_STORAGE_DEFAULTS = {
  TAIL_LINES: 500 as LogTailOption,
  SHOW_TIMESTAMPS: false,
  WRAP_LINES: true,
  LOCAL_DATES: false
} as const;

export const UI_STORAGE_KEYS = {
  SIDEBAR_COLLAPSED: `${APP_UI_STORAGE_PREFIX}sidebar-collapsed`,
  THEME: `${APP_UI_STORAGE_PREFIX}theme`,
  IS_DEFAULT_THEME: `${APP_UI_STORAGE_PREFIX}default`,

  CONTAINERS_SORT_KEY: `${DOCKER_UI_STORAGE_PREFIX}containers.sort-key`,
  CONTAINERS_SORT_DIRECTION: `${DOCKER_UI_STORAGE_PREFIX}containers.sort-direction`,
  CONTAINERS_RUNNING_ONLY: `${DOCKER_UI_STORAGE_PREFIX}containers.running-only`,
  CONTAINERS_VISIBLE_COLUMNS: `${DOCKER_UI_STORAGE_PREFIX}containers.visible-columns`,
  IMAGES_SORT_KEY: `${DOCKER_UI_STORAGE_PREFIX}images.sort-key`,
  IMAGES_SORT_DIRECTION: `${DOCKER_UI_STORAGE_PREFIX}images.sort-direction`,
  IMAGES_USAGE_FILTER: `${DOCKER_UI_STORAGE_PREFIX}images.usage-filter`,
  IMAGES_VISIBLE_COLUMNS: `${DOCKER_UI_STORAGE_PREFIX}images.visible-columns`,
  VOLUMES_SORT_KEY: `${DOCKER_UI_STORAGE_PREFIX}volumes.sort-key`,
  VOLUMES_SORT_DIRECTION: `${DOCKER_UI_STORAGE_PREFIX}volumes.sort-direction`,
  VOLUMES_USAGE_FILTER: `${DOCKER_UI_STORAGE_PREFIX}volumes.usage-filter`,
  VOLUMES_VISIBLE_COLUMNS: `${DOCKER_UI_STORAGE_PREFIX}volumes.visible-columns`,

  // Session storage keys
  CONTAINERS_SEARCH_QUERY: `${DOCKER_UI_STORAGE_PREFIX}containers.search-query`,
  CONTAINERS_SELECTED_TAB_PREFIX: `${DOCKER_UI_STORAGE_PREFIX}containers.selected-tab.`,
  CONTAINERS_FILES_PATH_PREFIX: `${DOCKER_UI_STORAGE_PREFIX}containers.files-path.`,
  IMAGES_SEARCH_QUERY: `${DOCKER_UI_STORAGE_PREFIX}images.search-query`,
  IMAGES_SELECTED_TAB_PREFIX: `${DOCKER_UI_STORAGE_PREFIX}images.selected-tab.`,
  VOLUMES_SEARCH_QUERY: `${DOCKER_UI_STORAGE_PREFIX}volumes.search-query`,
  VOLUMES_SELECTED_TAB_PREFIX: `${DOCKER_UI_STORAGE_PREFIX}volumes.selected-tab.`,
  VOLUMES_FILES_PATH_PREFIX: `${DOCKER_UI_STORAGE_PREFIX}volumes.files-path.`,
  DOCKER_INIT_STATUS: `${DOCKER_UI_STORAGE_PREFIX}docker-init-status`
} as const;

export const UI_STORAGE_DEFAULTS = {
  SIDEBAR_COLLAPSED: false,
  CONTAINERS_RUNNING_ONLY: false,
  CONTAINERS_SORT_KEY: 'name' as ContainerSortKey,
  CONTAINERS_SORT_DIRECTION: 'asc' as SortDirection,
  IMAGES_SORT_KEY: 'used' as ImageSortKey,
  IMAGES_SORT_DIRECTION: 'desc' as SortDirection,
  IMAGES_USAGE_FILTER: 'all' as ImageUsageFilter,
  VOLUMES_SORT_KEY: 'used' as VolumeSortKey,
  VOLUMES_SORT_DIRECTION: 'desc' as SortDirection,
  VOLUMES_USAGE_FILTER: 'all' as VolumeUsageFilter
} as const;
