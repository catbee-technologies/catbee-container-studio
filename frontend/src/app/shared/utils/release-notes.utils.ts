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

/**
 * Renders categorized release notes markdown safely into semantic HTML markup.
 * Sanitizes all input characters first to ensure XSS safety.
 */
export function renderReleaseNotesMarkdown(rawMarkdown: string): string {
  if (!rawMarkdown) return '';

  const { body } = parseAppReleaseNotes(rawMarkdown);
  if (!body) return '';

  // 1. Sanitize HTML tags
  let sanitized = body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

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

  // 4. Markdown links: [text](url) -> formatted with data-url for Angular delegation
  sanitized = sanitized.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" class="notes-link" data-url="$2">$1</a>'
  );

  // 5. Autolink bare URLs
  sanitized = sanitized.replace(
    /(^|[^"'>])(https?:\/\/[^\s<)]+)/g,
    '$1<a href="$2" class="notes-link" data-url="$2">$2</a>'
  );

  // 6. List items and paragraphs (supports nested sub-bullets)
  const lines = sanitized.split('\n');
  const result: string[] = [];
  let inList = false;
  let inSubList = false;

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
      if (inSubList) {
        result.push('</ul>');
        inSubList = false;
      }
      if (!inList) {
        result.push('<ul class="notes-list">');
        inList = true;
      }
      result.push(`<li>${trimmed.substring(2)}</li>`);
    } else {
      if (inSubList) {
        result.push('</ul>');
        inSubList = false;
      }
      if (inList) {
        result.push('</ul>');
        inList = false;
      }
      if (trimmed.length > 0) {
        if (
          !trimmed.startsWith('<div') &&
          !trimmed.startsWith('</div') &&
          !trimmed.startsWith('<h') &&
          !trimmed.startsWith('</h')
        ) {
          result.push(`<p class="notes-p">${trimmed}</p>`);
        } else {
          result.push(trimmed);
        }
      }
    }
  }
  if (inSubList) {
    result.push('</ul>');
  }
  if (inList) {
    result.push('</ul>');
  }

  return result.join('\n');
}
