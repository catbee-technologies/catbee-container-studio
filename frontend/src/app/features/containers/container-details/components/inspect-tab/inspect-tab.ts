import { CommonModule } from '@angular/common';
import { Component, ElementRef, computed, input, signal, viewChild } from '@angular/core';
import { SearchInputComponent } from '@components/search-input/search-input';
import { DockerContainerInspectInfo } from '@shared/types/docker-api.types';

interface InspectMatch {
  lineIndex: number;
  start: number;
  end: number;
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

  readonly inspectMatches = computed<InspectMatch[]>(() => {
    const term = this.inspectSearchTerm().trim();
    if (!term) {
      return [];
    }

    const needle = term.toLowerCase();
    const matches: InspectMatch[] = [];

    this.inspectLines().forEach((line, lineIndex) => {
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
          end: found + needle.length
        });

        fromIndex = found + needle.length;
      }
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

  readonly renderedInspectLinesHtml = computed<string[]>(() => {
    const current = this.currentMatch();

    return this.inspectLines().map((line, lineIndex) => {
      const marks = this.inspectMatches().filter(match => match.lineIndex === lineIndex);
      if (marks.length === 0) {
        return this.escapeHtml(line);
      }

      let cursor = 0;
      let html = '';

      for (const mark of marks) {
        if (cursor < mark.start) {
          html += this.escapeHtml(line.slice(cursor, mark.start));
        }

        const isCurrent =
          current !== null &&
          current.lineIndex === mark.lineIndex &&
          current.start === mark.start &&
          current.end === mark.end;
        const text = this.escapeHtml(line.slice(mark.start, mark.end));
        html += `<span class="search-match${isCurrent ? ' current' : ''}">${text}</span>`;
        cursor = mark.end;
      }

      if (cursor < line.length) {
        html += this.escapeHtml(line.slice(cursor));
      }

      return html;
    });
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

  private escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
}
