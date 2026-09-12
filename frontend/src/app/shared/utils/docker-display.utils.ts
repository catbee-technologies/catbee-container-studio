export const DATE_FORMAT = 'MMM d, y, h:mm:ss a';

export function formatDockerNames(names: string[]): string {
  return names.map(name => name.replace(/^\//, '')).join(', ');
}

const compactCountFormatter = new Intl.NumberFormat('en', { notation: 'compact' });

export function formatCompactCount(value: number): string {
  return compactCountFormatter.format(value);
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

const DOCKER_TIME_UNITS: Record<string, [string, string]> = {
  second: ['sec', 'secs'],
  minute: ['min', 'mins'],
  hour: ['hr', 'hrs'],
  day: ['day', 'days'],
  week: ['wk', 'wks'],
  month: ['mon', 'mons'],
  year: ['yr', 'yrs']
};

function formatTimeUnit(count: number, unit: string): string {
  const normalizedUnit = unit.toLowerCase().replace(/s$/, '');
  const units = DOCKER_TIME_UNITS[normalizedUnit];

  if (!units) {
    return `${count} ${unit}`;
  }

  return `${count} ${count === 1 ? units[0] : units[1]}`;
}

export function formatDockerStatus(status: string | null | undefined): string {
  if (!status?.trim()) {
    return '--';
  }

  let formatted = status.trim();

  // Removal in progress -> Removing
  formatted = formatted.replace(/^removal\s+in\s+progress$/i, 'Removing');

  // Exited (143) / Restarting (1) -> Exited(143) / Restarting(1)
  formatted = formatted.replace(
    /\b(Exited|Restarting)\s*\(\s*(-?\d+)\s*\)/gi,
    (_match, action: string, code: string) => {
      const normalizedAction = action.charAt(0).toUpperCase() + action.slice(1).toLowerCase();

      return `${normalizedAction}(${code})`;
    }
  );

  formatted = formatted.replace(/\(paused\)/gi, ' (Paused)');
  formatted = formatted.replace(/^paused$/i, 'Paused');

  // (health: starting) -> (starting)
  formatted = formatted.replace(/\(\s*health:\s*starting\s*\)/gi, '(starting)');

  // Less than a second -> < 1 sec
  formatted = formatted.replace(/\bless\s+than\s+a\s+second\b/gi, '< 1 sec');

  // About a/an <unit> -> ~1 <unit>
  formatted = formatted.replace(
    /\babout\s+an?\s+(second|minute|hour|day|week|month|year)\b/gi,
    (_match, unit: string) => `~${formatTimeUnit(1, unit)}`
  );

  // a/an <unit> -> 1 <unit>
  formatted = formatted.replace(/\ban?\s+(second|minute|hour|day|week|month|year)\b/gi, (_match, unit: string) =>
    formatTimeUnit(1, unit)
  );

  // <number> <unit> -> abbreviated unit
  formatted = formatted.replace(
    /(\d+)\s+(second|minute|hour|day|week|month|year)s?\b/gi,
    (_match, countStr: string, unit: string) => formatTimeUnit(Number.parseInt(countStr, 10), unit)
  );

  return formatted.replace(/\s+/g, ' ').trim();
}

export type DockerHealthStatus = 'healthy' | 'unhealthy' | 'starting';

export interface DockerHealthInfo {
  status: DockerHealthStatus;
  label: string;
}

export interface ParsedDockerStatus {
  statusText: string;
  health: DockerHealthInfo | null;
  paused: boolean;
}

export function parseDockerStatus(status: string | null | undefined): ParsedDockerStatus {
  if (!status?.trim()) {
    return { statusText: '--', health: null, paused: false };
  }

  let text = status.trim();
  let health: DockerHealthInfo | null = null;
  const paused = /\(paused\)/i.test(text) || /^paused$/i.test(text);

  if (/\(\s*(?:health:\s*)?starting\s*\)/i.test(text)) {
    health = { status: 'starting', label: 'Health: Starting' };
    text = text.replace(/\(\s*(?:health:\s*)?starting\s*\)/gi, '').trim();
  } else if (/\(\s*unhealthy\s*\)/i.test(text)) {
    health = { status: 'unhealthy', label: 'Unhealthy' };
    text = text.replace(/\(\s*unhealthy\s*\)/gi, '').trim();
  } else if (/\(\s*healthy\s*\)/i.test(text)) {
    health = { status: 'healthy', label: 'Healthy' };
    text = text.replace(/\(\s*healthy\s*\)/gi, '').trim();
  }

  text = text.replace(/\(paused\)/gi, '').trim();

  const statusText = formatDockerStatus(text || (paused ? 'Paused' : '--'));

  return { statusText, health, paused };
}
