import { LogTailOption } from './../types/index';
import {
  ContainerSortKey,
  ImageSortKey,
  ImageUsageFilter,
  SortDirection,
  VolumeSortKey,
  VolumeUsageFilter
} from '@shared/types';

export const GLOBAL_STORAGE_PREFIX = 'catbee.docker.logs.';

export const UI_STORAGE_PREFIX = 'catbee.docker.ui.';

export const LOGS_STORAGE_KEYS = {
  TAIL_LINES: `${GLOBAL_STORAGE_PREFIX}tail-lines`,
  SHOW_TIMESTAMPS: `${GLOBAL_STORAGE_PREFIX}show-timestamps`,
  WRAP_LINES: `${GLOBAL_STORAGE_PREFIX}wrap-lines`,
  CLEARED_SINCE_PREFIX: `${GLOBAL_STORAGE_PREFIX}cleared-since.`
} as const;

export const LOGS_STORAGE_DEFAULTS = {
  TAIL_LINES: 500 as LogTailOption,
  SHOW_TIMESTAMPS: false,
  WRAP_LINES: true
} as const;

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
  VOLUMES_USAGE_FILTER: `${UI_STORAGE_PREFIX}volumes.usage-filter`,

  // Session storage keys
  CONTAINERS_SEARCH_QUERY: `${UI_STORAGE_PREFIX}containers.search-query`,
  CONTAINERS_SELECTED_TAB_PREFIX: `${UI_STORAGE_PREFIX}containers.selected-tab.`,
  CONTAINERS_FILES_PATH_PREFIX: `${UI_STORAGE_PREFIX}containers.files-path.`,
  IMAGES_SEARCH_QUERY: `${UI_STORAGE_PREFIX}images.search-query`,
  IMAGES_SELECTED_TAB_PREFIX: `${UI_STORAGE_PREFIX}images.selected-tab.`,
  VOLUMES_SEARCH_QUERY: `${UI_STORAGE_PREFIX}volumes.search-query`,
  VOLUMES_SELECTED_TAB_PREFIX: `${UI_STORAGE_PREFIX}volumes.selected-tab.`,
  VOLUMES_FILES_PATH_PREFIX: `${UI_STORAGE_PREFIX}volumes.files-path.`,
  DOCKER_INIT_STATUS: `${UI_STORAGE_PREFIX}docker-init-status`
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
