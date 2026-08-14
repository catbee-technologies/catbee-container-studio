import { CommonModule } from '@angular/common';
import { Component, ElementRef, computed, input, signal, viewChild } from '@angular/core';
import { CopyButtonComponent } from '@components/copy-button/copy-button';
import { SearchInputComponent } from '@components/search-input/search-input';
import { EmptyStateComponent } from '@components/empty-state/empty-state';

interface EnvVarRow {
  key: string;
  value: string;
}

interface EnvMatch {
  rowIndex: number;
  field: 'key' | 'value';
  start: number;
  end: number;
}

@Component({
  selector: 'catbee-container-studio-container-env-tab',
  imports: [CommonModule, SearchInputComponent, CopyButtonComponent, EmptyStateComponent],
  templateUrl: './env-tab.html',
  styleUrl: './env-tab.scss'
})
export class EnvTabComponent {
  private readonly envSearchInput = viewChild<SearchInputComponent>('envSearchInput');
  private readonly envScrollArea = viewChild<ElementRef<HTMLElement>>('envScrollArea');

  readonly inspectData = input<unknown>(null);
  readonly envSearchTerm = signal('');
  readonly currentMatchIndex = signal(0);

  readonly envRows = computed<EnvVarRow[]>(() => {
    const inspectData = this.inspectData();
    if (!inspectData || typeof inspectData !== 'object') {
      return [];
    }

    const record = inspectData as { Config?: { Env?: unknown } };
    const env = Array.isArray(record.Config?.Env) ? record.Config?.Env : [];

    return env
      .map(value => String(value))
      .map(entry => {
        const separator = entry.indexOf('=');
        if (separator < 0) {
          return { key: entry, value: '' };
        }

        return {
          key: entry.slice(0, separator),
          value: entry.slice(separator + 1)
        };
      })
      .sort((a, b) => a.key.localeCompare(b.key));
  });

  readonly envMatches = computed<EnvMatch[]>(() => {
    const term = this.envSearchTerm().trim();
    if (!term) {
      return [];
    }

    const needle = term.toLowerCase();
    const matches: EnvMatch[] = [];

    this.envRows().forEach((row, rowIndex) => {
      for (const field of ['key', 'value'] as const) {
        const value = row[field] ?? '';
        const source = value.toLowerCase();

        let fromIndex = 0;
        while (fromIndex <= source.length - needle.length) {
          const found = source.indexOf(needle, fromIndex);
          if (found < 0) {
            break;
          }

          matches.push({
            rowIndex,
            field,
            start: found,
            end: found + needle.length
          });

          fromIndex = found + needle.length;
        }
      }
    });

    return matches;
  });

  readonly currentMatch = computed<EnvMatch | null>(() => {
    const matches = this.envMatches();
    if (matches.length === 0) {
      return null;
    }

    const idx = this.normalizeMatchIndex(this.currentMatchIndex(), matches.length);
    return matches[idx] ?? null;
  });

  readonly matchSummary = computed(() => {
    const total = this.envMatches().length;
    if (total === 0) {
      return '0/0';
    }

    return `${this.normalizeMatchIndex(this.currentMatchIndex(), total) + 1}/${total}`;
  });

  readonly hasMatches = computed(() => this.envMatches().length > 0);

  private isSearchNavigationPrimed = false;

  focusAndSelectSearch(): void {
    this.envSearchInput()?.focusAndSelect();
  }

  setSearch(value: string): void {
    this.envSearchTerm.set(value);
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
    const total = this.envMatches().length;
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
    const total = this.envMatches().length;
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

  renderHighlightedValue(rowIndex: number, field: 'key' | 'value', value: string): string {
    const marks = this.envMatches().filter(match => match.rowIndex === rowIndex && match.field === field);
    if (marks.length === 0) {
      return this.escapeHtml(value);
    }

    const current = this.currentMatch();
    let cursor = 0;
    let html = '';

    for (const mark of marks) {
      if (cursor < mark.start) {
        html += this.escapeHtml(value.slice(cursor, mark.start));
      }

      const isCurrent =
        current !== null &&
        current.rowIndex === mark.rowIndex &&
        current.field === mark.field &&
        current.start === mark.start &&
        current.end === mark.end;
      const text = this.escapeHtml(value.slice(mark.start, mark.end));
      html += `<span class="search-match${isCurrent ? ' current' : ''}">${text}</span>`;
      cursor = mark.end;
    }

    if (cursor < value.length) {
      html += this.escapeHtml(value.slice(cursor));
    }

    return html;
  }

  private scrollCurrentMatchIntoView(): void {
    const panel = this.envScrollArea()?.nativeElement;
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
