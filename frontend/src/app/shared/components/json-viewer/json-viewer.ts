import { CommonModule } from '@angular/common';
import { Component, ElementRef, computed, effect, input, signal, viewChild } from '@angular/core';
import { CopyButtonComponent } from '@components/copy-button/copy-button';
import { SearchInputComponent } from '@components/search-input/search-input';
import { getSearchNavigationDirection, normalizeSearchMatchIndex } from '@utils/search-navigation.utils';
import hljs from 'highlight.js/lib/core';
import json from 'highlight.js/lib/languages/json';

hljs.registerLanguage('json', json);

export interface JsonSearchMatch {
  lineIndex: number;
  start: number;
  end: number;
  globalStart: number;
  globalEnd: number;
}

@Component({
  selector: 'catbee-container-studio-json-viewer',
  imports: [CommonModule, SearchInputComponent, CopyButtonComponent],
  templateUrl: './json-viewer.html',
  styleUrl: './json-viewer.scss'
})
export class JsonViewerComponent {
  private readonly searchInput = viewChild<SearchInputComponent>('searchInput');
  private readonly scrollArea = viewChild<ElementRef<HTMLElement>>('scrollArea');

  readonly data = input<unknown>(null);
  readonly searchable = input(true);
  readonly searchPlaceholder = input('Search JSON output...');
  readonly searchInputWidth = input('20rem');
  readonly maxHeight = input<string | null>(null);
  readonly showCopy = input(true);

  readonly searchTerm = signal('');
  readonly currentMatchIndex = signal(0);

  readonly jsonText = computed(() => {
    const raw = this.data();
    if (raw === null || raw === undefined) {
      return '{}';
    }

    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) {
        return '{}';
      }
      try {
        const parsed = JSON.parse(trimmed);
        return JSON.stringify(parsed, null, 2);
      } catch {
        return trimmed;
      }
    }

    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  });

  readonly jsonLines = computed(() => this.jsonText().split('\n'));

  readonly highlightedJsonHtml = computed(() => {
    try {
      return hljs.highlight(this.jsonText(), {
        language: 'json'
      }).value;
    } catch {
      return this.jsonText();
    }
  });

  readonly searchMatches = computed<JsonSearchMatch[]>(() => {
    const term = this.searchTerm().trim();
    if (!term) {
      return [];
    }

    const needle = term.toLowerCase();
    const lines = this.jsonLines();
    const matches: JsonSearchMatch[] = [];

    let lineOffset = 0;

    lines.forEach((line, lineIndex) => {
      const source = line.toLowerCase();
      let fromIndex = 0;

      while (fromIndex <= source.length - needle.length) {
        const found = source.indexOf(needle, fromIndex);
        if (found < 0) {
          break;
        }

        matches.push({
          lineIndex,
          start: found,
          end: found + needle.length,
          globalStart: lineOffset + found,
          globalEnd: lineOffset + found + needle.length
        });

        fromIndex = found + needle.length;
      }
      lineOffset += line.length + 1;
    });

    return matches;
  });

  readonly currentMatch = computed<JsonSearchMatch | null>(() => {
    const matches = this.searchMatches();
    if (matches.length === 0) {
      return null;
    }

    const idx = normalizeSearchMatchIndex(this.currentMatchIndex(), matches.length);
    return matches[idx] ?? null;
  });

  readonly renderedJsonHtml = computed(() => {
    const html = this.highlightedJsonHtml();
    const matches = this.searchMatches();
    const current = this.currentMatch();

    if (matches.length === 0) {
      return html;
    }
    return this.applySearchHighlights(html, matches, current);
  });

  readonly matchSummary = computed(() => {
    const total = this.searchMatches().length;
    if (total === 0) {
      return '0/0';
    }

    return `${normalizeSearchMatchIndex(this.currentMatchIndex(), total) + 1}/${total}`;
  });

  readonly hasMatches = computed(() => this.searchMatches().length > 0);

  private isSearchNavigationPrimed = false;

  constructor() {
    effect(() => {
      this.data();
      queueMicrotask(() => this.selectNearestMatchFromViewport());
    });
  }

  focusAndSelectSearch(): void {
    this.searchInput()?.focusAndSelect();
  }

  setSearch(value: string): void {
    this.searchTerm.set(value);
    this.selectNearestMatchFromViewport();
  }

  onSearchKeydown(event: KeyboardEvent): void {
    const direction = getSearchNavigationDirection(event);
    if (direction === null) {
      return;
    }

    event.preventDefault();
    if (direction < 0) {
      this.prevMatch();
      return;
    }

    this.nextMatch();
  }

  nextMatch(): void {
    const total = this.searchMatches().length;
    if (total === 0) {
      return;
    }

    if (!this.isSearchNavigationPrimed) {
      this.isSearchNavigationPrimed = true;
      this.currentMatchIndex.set(normalizeSearchMatchIndex(this.currentMatchIndex(), total));
      this.scrollCurrentMatchIntoView();
      return;
    }

    this.currentMatchIndex.set(normalizeSearchMatchIndex(this.currentMatchIndex() + 1, total));
    this.scrollCurrentMatchIntoView();
  }

  prevMatch(): void {
    const total = this.searchMatches().length;
    if (total === 0) {
      return;
    }

    if (!this.isSearchNavigationPrimed) {
      this.isSearchNavigationPrimed = true;
      this.currentMatchIndex.set(normalizeSearchMatchIndex(this.currentMatchIndex(), total));
      this.scrollCurrentMatchIntoView();
      return;
    }

    this.currentMatchIndex.set(normalizeSearchMatchIndex(this.currentMatchIndex() - 1, total));
    this.scrollCurrentMatchIntoView();
  }

  private applySearchHighlights(
    highlightedHtml: string,
    matches: JsonSearchMatch[],
    current: JsonSearchMatch | null
  ): string {
    const container = document.createElement('div');
    container.innerHTML = highlightedHtml;
    const textNodes = this.collectTextNodes(container);
    let globalOffset = 0;

    for (const textNode of textNodes) {
      const text = textNode.nodeValue ?? '';
      const textLength = text.length;

      if (textLength === 0) {
        continue;
      }

      const nodeStart = globalOffset;
      const nodeEnd = nodeStart + textLength;

      const overlappingMatches = matches.filter(match => match.globalStart < nodeEnd && match.globalEnd > nodeStart);

      if (overlappingMatches.length === 0) {
        globalOffset = nodeEnd;
        continue;
      }

      const fragment = document.createDocumentFragment();
      let cursor = 0;

      for (const match of overlappingMatches) {
        const start = Math.max(match.globalStart - nodeStart, 0);
        const end = Math.min(match.globalEnd - nodeStart, textLength);
        if (start > cursor) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, start)));
        }
        if (end > start) {
          const span = document.createElement('span');
          const isCurrent =
            current !== null && current.globalStart === match.globalStart && current.globalEnd === match.globalEnd;
          span.className = isCurrent ? 'search-match current' : 'search-match';
          span.textContent = text.slice(start, end);
          fragment.appendChild(span);
          cursor = end;
        }
      }
      if (cursor < textLength) {
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
      }
      textNode.replaceWith(fragment);
      globalOffset = nodeEnd;
    }

    return container.innerHTML;
  }

  private collectTextNodes(root: Node): Text[] {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      nodes.push(node as Text);
    }
    return nodes;
  }

  private scrollCurrentMatchIntoView(): void {
    const panel = this.scrollArea()?.nativeElement;
    if (!panel) {
      return;
    }

    requestAnimationFrame(() => {
      const current = panel.querySelector<HTMLElement>('.search-match.current');
      current?.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
  }

  private selectNearestMatchFromViewport(): void {
    const matches = this.searchMatches();
    const panel = this.scrollArea()?.nativeElement;
    if (matches.length === 0 || !panel) {
      this.currentMatchIndex.set(0);
      this.isSearchNavigationPrimed = false;
      return;
    }

    const code = panel.querySelector<HTMLElement>('code');
    const lineHeight = Number.parseFloat(code ? getComputedStyle(code).lineHeight : '');
    const paddingTop = Number.parseFloat(getComputedStyle(panel).paddingTop) || 0;
    const visibleScrollTop = Math.max(panel.scrollTop - paddingTop, 0);
    const firstVisibleLine =
      Number.isFinite(lineHeight) && lineHeight > 0 ? Math.floor(visibleScrollTop / lineHeight) : 0;
    const lastVisibleLine =
      Number.isFinite(lineHeight) && lineHeight > 0
        ? Math.ceil((visibleScrollTop + panel.clientHeight) / lineHeight)
        : firstVisibleLine;
    const visibleMatch = matches.findIndex(
      match => match.lineIndex >= firstVisibleLine && match.lineIndex <= lastVisibleLine
    );

    this.currentMatchIndex.set(Math.max(visibleMatch, 0));
    this.isSearchNavigationPrimed = true;
    if (visibleMatch < 0) {
      this.scrollCurrentMatchIntoView();
    }
  }
}
