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
    unitIndex += 1;
  }

  return `${current.toFixed(precision)} ${units[unitIndex]}`;
}
