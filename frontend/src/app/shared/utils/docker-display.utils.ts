export function formatDockerNames(names: string[]): string {
  return names.map(name => name.replace(/^\//, '')).join(', ');
}

export function formatDockerBytes(value: number, precision = 2): string {
  if (!Number.isFinite(value) || value < 0) {
    return '--';
  }

  if (value < 1024) {
    return `${value} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let current = value / 1024;
  let unitIndex = 0;

  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex++;
  }

  const formatted = Number(current.toFixed(precision));

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

export function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);

  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
