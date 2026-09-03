export const DATE_FORMAT = 'MMM d, y, h:mm:ss a';

export function formatDockerNames(names: string[]): string {
  return names.map(name => name.replace(/^\//, '')).join(', ');
}

export function formatDockerBytes(value: number, precision = 2): string {
  if (!Number.isFinite(value) || value < 0) {
    return '--';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const formatted = Number(value.toFixed(precision));
  return `${formatted} ${units[unitIndex]}`;
}

export function formatDockerRelativeTime(date: string | Date | undefined): string {
  if (!date) {
    return '--';
  }

  const timestamp = date instanceof Date ? date.getTime() : Date.parse(date);
  if (!Number.isFinite(timestamp)) {
    return '--';
  }

  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) {
    return 'just now';
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return seconds <= 1 ? '1 second ago' : `${seconds} seconds ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }

  const days = Math.floor(hours / 24);
  if (days < 30) {
    return days === 1 ? '1 day ago' : `${days} days ago`;
  }

  const months = Math.floor(days / 30);
  if (months < 12) {
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }

  const years = Math.floor(months / 12);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

export function formatMode(mode: string | null): string {
  if (!mode || !/^[0-7]{3,4}$/.test(mode)) {
    return mode || '--';
  }

  const permissions = mode.slice(-3);
  return permissions
    .split('')
    .map(value => {
      const bits = Number.parseInt(value, 8);
      return `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
    })
    .join('');
}
