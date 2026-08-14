export function formatDockerNames(names: string[]): string {
  return names.map(name => name.replace(/^\//, '')).join(', ');
}

export function formatDockerBytes(value: number, precision = 2): string {
  if (!Number.isFinite(value) || value < 0) {
    return '--';
  }

  if (value < 1000) {
    return `${value} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let current = value / 1000; // Intentionally using 1000 instead of 1024 to match Docker's output
  let unitIndex = 0;

  while (current >= 1000 && unitIndex < units.length - 1) {
    current /= 1000;
    unitIndex++;
  }

  return `${current.toFixed(precision)} ${units[unitIndex]}`;
}
