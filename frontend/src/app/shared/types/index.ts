export * from './docker-api.types';
export * from './electron.types';

export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export const CONTAINER_SORT_KEYS = [
  'name',
  'image',
  'ports',
  'state',
  'cpu',
  'memory',
  'disk',
  'network',
  'pids'
] as const;
export type ContainerSortKey = (typeof CONTAINER_SORT_KEYS)[number];

export const LOG_TAIL_OPTIONS = [200, 500, 1000, 2000, 5000] as const;
export type LogTailOption = (typeof LOG_TAIL_OPTIONS)[number];

export const IMAGE_SORT_KEYS = ['used', 'repository', 'tag', 'id', 'size', 'created'] as const;
export type ImageSortKey = (typeof IMAGE_SORT_KEYS)[number];

export const IMAGE_USAGE_FILTERS = ['all', 'used', 'unused', 'dangling'] as const;
export type ImageUsageFilter = (typeof IMAGE_USAGE_FILTERS)[number];

export const VOLUME_SORT_KEYS = ['used', 'name', 'driver', 'scope', 'size', 'created'] as const;
export type VolumeSortKey = (typeof VOLUME_SORT_KEYS)[number];

export const VOLUME_USAGE_FILTERS = ['all', 'used', 'unused'] as const;
export type VolumeUsageFilter = (typeof VOLUME_USAGE_FILTERS)[number];
