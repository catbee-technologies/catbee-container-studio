import { CommonModule } from '@angular/common';
import { Component, ElementRef, computed, input, signal, viewChild } from '@angular/core';
import { SearchInputComponent } from '@components/search-input/search-input';
import { DockerContainerInspectInfo } from '@shared/types/docker-api.types';
import hljs from 'highlight.js/lib/core';
import json from 'highlight.js/lib/languages/json';

hljs.registerLanguage('json', json);

interface InspectMatch {
  lineIndex: number;
  start: number;
  end: number;
  globalStart: number;
  globalEnd: number;
}

@Component({
  selector: 'catbee-container-studio-container-inspect-tab',
  imports: [CommonModule, SearchInputComponent],
  templateUrl: './inspect-tab.html',
  styleUrl: './inspect-tab.scss'
})
export class InspectTabComponent {
  private readonly inspectSearchInput = viewChild<SearchInputComponent>('inspectSearchInput');
  private readonly inspectScrollArea = viewChild<ElementRef<HTMLElement>>('inspectScrollArea');

  readonly inspectData = input<DockerContainerInspectInfo | null>(null);
  readonly inspectSearchTerm = signal('');
  readonly currentMatchIndex = signal(0);

  readonly inspectJson = computed(() => {
    const inspectData = this.inspectData();
    if (!inspectData) {
      return '{}';
    }

    return JSON.stringify(inspectData, null, 2);
  });

  readonly inspectLines = computed(() => this.inspectJson().split('\n'));

  readonly highlightedInspectHtml = computed(() => {
    return hljs.highlight(this.inspectJson(), {
      language: 'json'
    }).value;
  });

  readonly inspectMatches = computed<InspectMatch[]>(() => {
    const term = this.inspectSearchTerm().trim();
    if (!term) {
      return [];
    }

    const needle = term.toLowerCase();
    const lines = this.inspectLines();
    const matches: InspectMatch[] = [];

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

  readonly currentMatch = computed<InspectMatch | null>(() => {
    const matches = this.inspectMatches();
    if (matches.length === 0) {
      return null;
    }

    const idx = this.normalizeMatchIndex(this.currentMatchIndex(), matches.length);
    return matches[idx] ?? null;
  });

  readonly renderedInspectHtml = computed(() => {
    const html = this.highlightedInspectHtml();
    const matches = this.inspectMatches();
    const current = this.currentMatch();

    if (matches.length === 0) {
      return html;
    }
    return this.applySearchHighlights(html, matches, current);
  });

  readonly matchSummary = computed(() => {
    const total = this.inspectMatches().length;
    if (total === 0) {
      return '0/0';
    }

    return `${this.normalizeMatchIndex(this.currentMatchIndex(), total) + 1}/${total}`;
  });

  readonly hasMatches = computed(() => this.inspectMatches().length > 0);

  private isSearchNavigationPrimed = false;

  focusAndSelectSearch(): void {
    this.inspectSearchInput()?.focusAndSelect();
  }

  setSearch(value: string): void {
    this.inspectSearchTerm.set(value);
    this.currentMatchIndex.set(0);
    this.isSearchNavigationPrimed = false;
  }

  onSearchKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') {
      return;
    }

    event.preventDefault();
    if (event.shiftKey) {
      this.prevMatch();
      return;
    }

    this.nextMatch();
  }

  nextMatch(): void {
    const total = this.inspectMatches().length;
    if (total === 0) {
      return;
    }

    if (!this.isSearchNavigationPrimed) {
      this.isSearchNavigationPrimed = true;
      this.currentMatchIndex.set(this.normalizeMatchIndex(this.currentMatchIndex(), total));
      this.scrollCurrentMatchIntoView();
      return;
    }

    this.currentMatchIndex.set(this.normalizeMatchIndex(this.currentMatchIndex() + 1, total));
    this.scrollCurrentMatchIntoView();
  }

  prevMatch(): void {
    const total = this.inspectMatches().length;
    if (total === 0) {
      return;
    }

    if (!this.isSearchNavigationPrimed) {
      this.isSearchNavigationPrimed = true;
      this.currentMatchIndex.set(this.normalizeMatchIndex(this.currentMatchIndex(), total));
      this.scrollCurrentMatchIntoView();
      return;
    }

    this.currentMatchIndex.set(this.normalizeMatchIndex(this.currentMatchIndex() - 1, total));
    this.scrollCurrentMatchIntoView();
  }

  private applySearchHighlights(
    highlightedHtml: string,
    matches: InspectMatch[],
    current: InspectMatch | null
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
    const panel = this.inspectScrollArea()?.nativeElement;
    if (!panel) {
      return;
    }

    requestAnimationFrame(() => {
      const current = panel.querySelector<HTMLElement>('.search-match.current');
      current?.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
  }

  private normalizeMatchIndex(index: number, total: number): number {
    if (total === 0) {
      return 0;
    }

    return ((index % total) + total) % total;
  }
}
