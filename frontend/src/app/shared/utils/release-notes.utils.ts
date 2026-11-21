/**
 * Structured model for parsed release notes
 */
export interface ParsedReleaseNotes {
  /** Cleaned body markdown containing only categorized change sections */
  body: string;
  /** Full comparison changelog URL if found (e.g. https://github.com/.../compare/v0.6.0...v1.0.0-alpha.0) */
  compareUrl?: string;
  /** GitHub username handles for release contributors */
  contributors: string[];
}

/**
 * Parses and extracts structured sections (body, compare URL, contributors) from raw GitHub release notes.
 * Strips out sections not relevant to the desktop application (Downloads, Installation, Updates).
 */
export function parseAppReleaseNotes(rawMarkdown: string): ParsedReleaseNotes {
  if (!rawMarkdown) {
    return { body: '', contributors: [] };
  }

  // Normalize CRLF to LF
  let cleaned = rawMarkdown.replaceAll('\r\n', '\n');

  // 1. Remove obsolete text if present in older release notes
  cleaned = cleaned.replace(/Use\s+\*\*Help\s*→\s*Check for Updates\.\.\.\*\*[^.\n]*\.?/gi, '');

  // 2. Remove Downloads, Installation, and Updates sections up to Contributors or end
  cleaned = cleaned.replace(/###\s*(?:📦\s*)?Downloads[\s\S]*?(?=(###\s*(?:👥\s*)?Contributors|$))/i, '');
  cleaned = cleaned.replace(/###\s*(?:🛠️\s*)?Installation[\s\S]*?(?=(###\s*(?:👥\s*)?Contributors|$))/i, '');
  cleaned = cleaned.replace(/###\s*(?:🔄\s*)?Updates[\s\S]*?(?=(###\s*(?:👥\s*)?Contributors|$))/i, '');

  // 3. Extract Full Changelog comparison URL (handles with/without emoji, bullets, bold, header or bare link)
  let compareUrl: string | undefined;
  const changelogRegex = /^[^\n]*Full Changelog[^\n]*:\s*(https?:\/\/\S+)/im;
  const changelogMatch = changelogRegex.exec(cleaned);
  if (changelogMatch) {
    compareUrl = changelogMatch[1].trim();
    cleaned = cleaned.replace(changelogMatch[0], '');
  }
  // Strip any remaining Full Changelog line if present
  cleaned = cleaned.replace(/(?:^|\n)[^\n]*?Full Changelog[^\n]*(?:\n|$)/gi, '\n');

  // 4. Extract Contributors
  const contributors: string[] = [];
  const contribRegex = /(?:###\s*)?(?:👥\s*)?Contributors[\s\S]*?(?=(###|$))/i;
  const contribMatch = contribRegex.exec(cleaned);
  if (contribMatch) {
    const lines = contribMatch[0].split('\n');
    const userRegex = /@([a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38})\b/;
    for (const line of lines) {
      const match = userRegex.exec(line);
      if (match && !contributors.includes(match[1])) {
        contributors.push(match[1]);
      }
    }
    cleaned = cleaned.replace(contribMatch[0], '');
  }

  // 5. Clean up any trailing empty sections or orphaned separator lines
  cleaned = cleaned.replace(/(?:^|\n)---+(?=\n|$)/g, '');

  return {
    body: cleaned.trim(),
    compareUrl,
    contributors
  };
}

function formatInlineMarkdown(body: string): string {
  // Escape Markdown text before using it in markup, including links' quoted attributes.
  let sanitized = body
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

  // 2. Headers: Convert ### [Emoji] Title into badge-style section headings
  sanitized = sanitized.replace(/^#### (.*$)/gim, '<h6 class="notes-heading-4">$1</h6>');
  sanitized = sanitized.replace(
    /^### (.*$)/gim,
    '<div class="release-section-badge-wrapper"><span class="release-section-badge">$1</span></div>'
  );
  sanitized = sanitized.replace(/^## (.*$)/gim, '<h4 class="notes-heading-2">$1</h4>');
  sanitized = sanitized.replace(/^# (.*$)/gim, '<h3 class="notes-heading-1">$1</h3>');

  // 3. Bold & inline code
  sanitized = sanitized.replace(/\*\*(.*?)\*\*/g, '<strong class="notes-strong">$1</strong>');
  sanitized = sanitized.replace(/`([^`]+)`/g, '<code class="notes-code">$1</code>');

  const linkStart = /(?:\[([^[\]\n]+)\]\(|^|[^"'>])(https?:\/\/)/gm;
  const urlSuffix = /[^\s<)]+/y;
  const parts: string[] = [];
  let cursor = 0;
  let start: RegExpExecArray | null;

  // Consume each URL once, including URLs in incomplete Markdown links.
  while ((start = linkStart.exec(sanitized)) !== null) {
    urlSuffix.lastIndex = linkStart.lastIndex;
    const suffix = urlSuffix.exec(sanitized)?.[0];
    if (!suffix) continue;

    const url = start[2] + suffix;
    const urlEnd = urlSuffix.lastIndex;
    const label = sanitized[urlEnd] === ')' ? start[1] : undefined;
    const linkIndex = label === undefined ? linkStart.lastIndex - start[2].length : start.index;
    parts.push(sanitized.slice(cursor, linkIndex), `<a href="${url}" class="notes-link">${label ?? url}</a>`);
    cursor = label === undefined ? urlEnd : urlEnd + 1;
    linkStart.lastIndex = cursor;
  }

  parts.push(sanitized.slice(cursor));
  return parts.join('');
}

function formatMarkdownLines(lines: string[]): string[] {
  const result: string[] = [];
  let inList = false;
  let inSubList = false;

  const closeSubList = (): void => {
    if (inSubList) {
      result.push('</ul>');
      inSubList = false;
    }
  };

  const closeAllLists = (): void => {
    closeSubList();
    if (inList) {
      result.push('</ul>');
      inList = false;
    }
  };

  for (const line of lines) {
    const isSubItem = /^\s{2,}[-*]\s+/.test(line);
    const isTopItem = !isSubItem && /^[-*]\s+/.test(line.trimStart());
    const trimmed = line.trim();

    if (isSubItem) {
      if (!inList) {
        result.push('<ul class="notes-list">');
        inList = true;
      }
      if (!inSubList) {
        result.push('<ul class="notes-sublist">');
        inSubList = true;
      }
      result.push(`<li>${trimmed.substring(2)}</li>`);
    } else if (isTopItem) {
      closeSubList();
      if (!inList) {
        result.push('<ul class="notes-list">');
        inList = true;
      }
      result.push(`<li>${trimmed.substring(2)}</li>`);
    } else {
      closeAllLists();
      if (trimmed.length > 0) {
        const isBlockTag = /^<\/?(?:div|h[1-6])/i.test(trimmed);
        result.push(isBlockTag ? trimmed : `<p class="notes-p">${trimmed}</p>`);
      }
    }
  }

  closeAllLists();
  return result;
}

/**
 * Renders categorized release notes Markdown into HTML for Angular's sanitized innerHTML binding.
 */
export function renderReleaseNotesMarkdown(rawMarkdown: string): string {
  if (!rawMarkdown) return '';

  const { body } = parseAppReleaseNotes(rawMarkdown);
  if (!body) return '';

  const sanitized = formatInlineMarkdown(body);
  const result = formatMarkdownLines(sanitized.split('\n'));
  return result.join('\n');
}
