import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import semver from 'semver';

const DEFAULT_REPO = 'catbee-technologies/catbee-container-studio';

/**
 * Extracts the pre-release channel identifier according to release rules.
 * Non-numeric sequence up to the first numeric version component constitutes the channel.
 * e.g.:
 * - 'alpha.1' -> 'alpha'
 * - 'alpha.beta.1' -> 'alpha.beta'
 * - 'rc.0' -> 'rc'
 * - 'beta' -> 'beta'
 */
export function extractPrereleaseChannel(preParts) {
  if (!preParts || preParts.length === 0) return '';
  const nonNumeric = [];
  for (const part of preParts) {
    if (typeof part === 'string' && !/^\d+$/.test(part)) {
      nonNumeric.push(part);
    } else {
      break;
    }
  }
  return nonNumeric.length > 0 ? nonNumeric.join('.') : String(preParts[0]);
}

/**
 * Parses semantic version string into comparable components according to SemVer 2.0.0.
 * Uses official 'semver' package for strict validation and comparison.
 * Build metadata (after +) is ignored for precedence per SemVer 2.0.0 Section 10.
 * e.g. "v1.0.0-alpha.10+build.42" -> { major: 1, minor: 0, patch: 0, prerelease: "alpha.10", prereleaseChannel: "alpha" }
 * Non-semver tags return null so they are safely filtered out.
 */
export function parseSemver(rawTag) {
  if (!rawTag || typeof rawTag !== 'string') return null;
  const tag = rawTag.replace(/^refs\/tags\//, '').trim();

  // Validate strictly with official semver
  const validVersion = semver.valid(tag);
  if (!validVersion) {
    return null;
  }

  const parsed = semver.parse(validVersion);
  if (!parsed) {
    return null;
  }

  const prereleaseParts = parsed.prerelease || [];
  const prerelease = prereleaseParts.join('.');
  const prereleaseChannel = extractPrereleaseChannel(prereleaseParts);

  return {
    tag,
    version: parsed.version,
    baseVersion: `${parsed.major}.${parsed.minor}.${parsed.patch}`,
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease,
    prereleaseParts,
    prereleaseChannel,
    isPrerelease: prereleaseParts.length > 0
  };
}

/**
 * Compares two parsed semver objects or version strings according to SemVer 2.0.0 using official semver.compare:
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
export function compareSemver(a, b) {
  const versionA = typeof a === 'string' ? a : a?.version;
  const versionB = typeof b === 'string' ? b : b?.version;
  return semver.compare(versionA, versionB);
}

/**
 * Determines previous tag for a given tag according to release rules:
 *
 * Rules:
 *   Main release:
 *     - Previous main release strictly older than currentTag (skips prereleases).
 *   Prerelease:
 *     - First looks for previous prerelease with same base version and prerelease identifier.
 *     - If none, falls back to previous main release strictly older than currentTag.
 *   Fallback:
 *     - Git ancestry describe (if SemVer tags list is empty or tag is non-standard).
 */
export function getPreviousTag(currentTag) {
  if (!currentTag) return '';

  const current = parseSemver(currentTag);
  let allTags = [];

  try {
    const output = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' });
    allTags = output
      .split('\n')
      .map(t => t.trim())
      .filter(Boolean)
      .map(parseSemver)
      .filter(Boolean);
  } catch {
    allTags = [];
  }

  if (current && allTags.length > 0) {
    // Filter tags strictly older than currentTag and sort descending
    const olderTags = allTags.filter(t => compareSemver(t, current) < 0).sort((a, b) => compareSemver(b, a));

    if (!current.isPrerelease) {
      const prevMain = olderTags.find(t => !t.isPrerelease);
      if (prevMain) return prevMain.tag;
    } else {
      // 1. Same base version & same prerelease channel
      const prevSameChannel = olderTags.find(
        t =>
          t.isPrerelease && t.baseVersion === current.baseVersion && t.prereleaseChannel === current.prereleaseChannel
      );
      if (prevSameChannel) return prevSameChannel.tag;

      // 2. Fallback to previous main release
      const prevMain = olderTags.find(t => !t.isPrerelease);
      if (prevMain) return prevMain.tag;
    }
  }

  // Fallback: Git ancestry describe (closest ancestor tag)
  try {
    const cleanTag = currentTag.replace(/^refs\/tags\//, '').trim();
    const ancestryTag = execFileSync('git', ['describe', '--tags', '--abbrev=0', `${cleanTag}^`], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    if (ancestryTag) return ancestryTag;
  } catch {
    // Genesis commit or root tag has no parent
  }

  return '';
}

/**
 * Determines if a commit should be omitted from user-facing release notes.
 */
export function shouldIgnoreCommit(subject) {
  const trimmed = subject.trim();
  if (!trimmed) return true;

  // 1. Git temporary/workflow commits (fixup, squash, amend, wip)
  if (/^(?:fixup!|squash!|amend!)\s+/i.test(trimmed)) return true;
  if (/^wip\b/i.test(trimmed)) return true;

  // 2. Release & version bookkeeping
  if (/^\d+\.\d+\.\d+([.-].*)?$/.test(trimmed)) return true;
  if (/^v\d+\.\d+\.\d+([.-].*)?$/.test(trimmed)) return true;
  if (/^(?:release|version)\s*v?\d+\.\d+/i.test(trimmed)) return true;

  // 3. Merge commits
  if (/^Merge\s+(?:branch|remote-tracking branch|pull request)/i.test(trimmed)) return true;

  // 4. Housekeeping & internal commits (always skip chores, ci, docs, test, build)
  if (/^chore(?:\([^)]*\))?:/i.test(trimmed)) return true;
  if (/^ci(?:\([^)]*\))?:/i.test(trimmed)) return true;
  if (/^docs(?:\([^)]*\))?:/i.test(trimmed)) return true;
  if (/^test(?:\([^)]*\))?:/i.test(trimmed)) return true;
  if (/^build(?:\([^)]*\))?:/i.test(trimmed)) return true;

  return false;
}

/**
 * Checks if a commit represents a breaking change.
 */
export function isBreakingChange(subject, body = '') {
  // Conventional commits: feat!: or feat(scope)!:
  if (/^[a-z]+(?:\([^)]*\))?!:/i.test(subject)) return true;
  // BREAKING CHANGE in commit message or body
  if (/(?:^|\n)BREAKING[ -]CHANGE:\s*/i.test(subject) || /(?:^|\n)BREAKING[ -]CHANGE:\s*/i.test(body)) {
    return true;
  }
  return false;
}

/**
 * Formats a single commit message into clean release markdown:
 * - Extracts scope
 * - Splits compound commit subjects with inline bullet lists
 * - Normalizes scope
 * - Links PR numbers (#123)
 * - Ensures single trailing period
 */
export function formatCommitMessage(rawSubject, repo = DEFAULT_REPO) {
  let subject = rawSubject.trim();

  // If there are inline bullet points " - ", keep the primary headline
  if (subject.includes(' - ')) {
    const parts = subject.split(' - ');
    if (parts[0] && parts[0].trim().length > 10) {
      subject = parts[0].trim();
    }
  }

  // Conventional commit matcher:
  // type(scope)!: message OR type: message
  let type = '';
  let scope = '';
  let message = subject;

  const colonIdx = subject.indexOf(':');
  if (colonIdx !== -1) {
    const header = subject.slice(0, colonIdx).trim();
    const rawMsg = subject.slice(colonIdx + 1).trim();
    const match = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?$/.exec(header);
    if (match) {
      type = match[1].toLowerCase();
      scope = (match[2] || '').trim();
      message = rawMsg;
    }
  }

  // Capitalize first character of message
  if (message.length > 0) {
    message = message.charAt(0).toUpperCase() + message.slice(1);
  }

  // Auto-link PR references: (#51) or #51 -> [#51](url)
  // Avoid double-linking already linked markdown
  message = message.replace(/(^|[^[])#(\d+)\b/g, (m, prefix, prNumber) => {
    return `${prefix}[#${prNumber}](https://github.com/${repo}/pull/${prNumber})`;
  });

  // Normalize ending punctuation
  while (message.endsWith('.')) {
    message = message.slice(0, -1);
  }
  message = message.trimEnd();
  if (!/[?!.]$/.test(message)) {
    message += '.';
  }

  return {
    type,
    scope,
    message
  };
}

/**
 * Classifies a commit into a release notes section.
 */
export function classifyCommit(type, scope, subject, body = '') {
  if (isBreakingChange(subject, body)) {
    return 'breaking';
  }

  if (scope.toLowerCase() === 'docs' || type === 'docs') {
    return 'docs';
  }

  if (type === 'style') {
    return 'styles';
  }

  switch (type) {
    case 'feat':
    case 'feature':
      return 'features';
    case 'fix':
    case 'bugfix':
      return 'fixes';
    case 'perf':
      return 'performance';
    case 'refactor':
      return 'refactor';
    case 'security':
    case 'sec':
      return 'security';
    default:
      return 'other';
  }
}

/**
 * Builds the bullet markdown string for a classified commit.
 */
export function renderCommitBullet(type, scope, message, sectionKey) {
  // Omit scope if scope is just 'docs' in the Documentation section
  if (sectionKey === 'docs' && scope.toLowerCase() === 'docs') {
    return `- ${message}`;
  }

  if (scope) {
    const cleanedScope = scope
      .split(',')
      .map(s => s.trim())
      .join(', ');
    return `- **${cleanedScope}:** ${message}`;
  }

  return `- ${message}`;
}

/**
 * Generates markdown changelog from a commit range.
 */
export function generateChangelog({ range, repo = DEFAULT_REPO }) {
  const sections = {
    breaking: { title: '### ⚠️ Breaking Changes', items: [] },
    features: { title: '### ✨ Features', items: [] },
    fixes: { title: '### 🐛 Bug Fixes', items: [] },
    performance: { title: '### ⚡ Performance Improvements', items: [] },
    security: { title: '### 🔒 Security Fixes', items: [] },
    refactor: { title: '### ♻️ Refactoring', items: [] },
    styles: { title: '### 💄 UI & Styling', items: [] },
    docs: { title: '### 📚 Documentation', items: [] },
    other: { title: '### 🧹 Other Changes', items: [] }
  };

  let rawOutput = '';
  try {
    rawOutput = execFileSync('git', ['log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', range], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (error) {
    const errorMsg = `Failed to run git log for range "${range}": ${error.message}`;
    console.error(`Error: ${errorMsg}`);
    throw new Error(errorMsg);
  }

  const rawCommits = rawOutput
    .split('\x1e')
    .map(c => c.trim())
    .filter(Boolean);
  const seenMessages = new Set();

  for (const raw of rawCommits) {
    const [, subject = '', body = ''] = raw.split('\x1f');
    if (!subject.trim()) continue;

    if (shouldIgnoreCommit(subject)) {
      continue;
    }

    const { type, scope, message } = formatCommitMessage(subject, repo);
    const sectionKey = classifyCommit(type, scope, subject, body);

    // Deduplicate identical items
    const dedupKey = `${sectionKey}:::${scope}:::${message}`;
    if (seenMessages.has(dedupKey)) {
      continue;
    }
    seenMessages.add(dedupKey);

    sections[sectionKey].items.push({ type, scope, message });
  }

  // Build markdown output with scope grouping
  const outputBlocks = [];
  let totalItems = 0;

  for (const [, section] of Object.entries(sections)) {
    if (section.items.length === 0) continue;
    totalItems += section.items.length;

    const groups = new Map();

    for (const item of section.items) {
      const cleanedScope = item.scope
        ? item.scope
            .split(',')
            .map(s => s.trim())
            .join(', ')
        : '';
      if (!groups.has(cleanedScope)) {
        groups.set(cleanedScope, []);
      }
      groups.get(cleanedScope).push(item.message);
    }

    // Sort order:
    // 1. Scopes with >= 2 items (major feature areas)
    // 2. Scopes with 1 item
    // 3. Unscoped items (at the bottom)
    const sortedScopes = Array.from(groups.keys()).sort((a, b) => {
      if (!a) return 1;
      if (!b) return -1;
      const countA = groups.get(a).length;
      const countB = groups.get(b).length;
      if (countA >= 2 && countB < 2) return -1;
      if (countB >= 2 && countA < 2) return 1;
      return a.localeCompare(b);
    });

    const lines = [];

    for (const scope of sortedScopes) {
      const messages = groups.get(scope);
      if (!scope) {
        // Unscoped
        for (const msg of messages) {
          lines.push(`- ${msg}`);
        }
      } else if (messages.length > 1) {
        // Multiple items sharing same scope -> sub-bullets
        lines.push(`- **${scope}:**`);
        for (const msg of messages) {
          lines.push(`  - ${msg}`);
        }
      } else {
        // Single item in this scope -> clean inline bullet
        lines.push(`- **${scope}:** ${messages[0]}`);
      }
    }

    outputBlocks.push(`${section.title}\n\n${lines.join('\n')}`);
  }

  // Graceful fallback if no user-facing items exist in range
  if (totalItems === 0) {
    return '*No user-facing changes in this release.*';
  }

  return outputBlocks.join('\n\n');
}

/**
 * CLI Argument parser
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    tag: process.env.TAG || '',
    from: process.env.PREVIOUS_TAG || '',
    repo: process.env.REPOSITORY || DEFAULT_REPO,
    output: '',
    range: ''
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--tag' && i + 1 < args.length) {
      options.tag = args[++i];
    } else if (arg === '--from' && i + 1 < args.length) {
      options.from = args[++i];
    } else if (arg === '--repo' && i + 1 < args.length) {
      options.repo = args[++i];
    } else if (arg === '--output' && i + 1 < args.length) {
      options.output = args[++i];
    } else if (arg.includes('..')) {
      options.range = arg;
    }
  }

  return options;
}

// Direct CLI execution
if (process.argv[1]?.endsWith('generate-changelog.mjs')) {
  const options = parseArgs();

  let tag = options.tag.replace(/^refs\/tags\//, '');
  let fromTag = options.from.replace(/^refs\/tags\//, '');
  let range = options.range;

  if (range?.includes('..')) {
    const [f, t] = range.split('..');
    if (!fromTag) fromTag = f;
    if (!tag) tag = t;
  } else if (!range) {
    if (tag && !fromTag) {
      fromTag = getPreviousTag(tag);
    }
    if (fromTag && tag) {
      range = `${fromTag}..${tag}`;
    } else if (tag) {
      range = tag;
    } else {
      console.error('Error: Either --range, --tag, or <from>..<to> must be provided.');
      process.exit(1);
    }
  }

  const fullChangelogUrl = fromTag
    ? `https://github.com/${options.repo}/compare/${fromTag}...${tag || range}`
    : `https://github.com/${options.repo}/commits/${tag || range}`;

  console.log(`Generating changelog for range: ${range} (repo: ${options.repo})`);
  let changelog = '';
  try {
    changelog = generateChangelog({ range, repo: options.repo });
  } catch (error) {
    console.error(`Fatal: Failed to generate changelog: ${error.message}`);
    process.exit(1);
  }

  if (options.output) {
    fs.writeFileSync(options.output, `${changelog}\n`, 'utf8');
    console.log(`Wrote changelog to ${options.output}`);
  } else {
    console.log('\n--- GENERATED CHANGELOG ---\n');
    console.log(changelog);
    console.log(`\nFull changelog URL: ${fullChangelogUrl}`);
  }

  // Export to GITHUB_ENV if running inside GitHub Actions
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      `PREVIOUS_TAG=${fromTag}\nFULL_CHANGELOG_URL=${fullChangelogUrl}\n`,
      'utf8'
    );
  }
}
