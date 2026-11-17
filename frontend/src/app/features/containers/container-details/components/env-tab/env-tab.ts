import { CommonModule } from '@angular/common';
import { Component, ElementRef, computed, effect, input, output, signal, viewChild } from '@angular/core';
import { apply, disabled, form, FormRoot } from '@angular/forms/signals';
import { CopyButtonComponent } from '@components/copy-button/copy-button';
import { SearchInputComponent } from '@components/search-input/search-input';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { ConfirmDialogComponent } from '@components/dialog/confirm-dialog';
import { EnvVariablesEditorComponent } from '@components/env-variables-editor/env-variables-editor';
import { EditHeadingComponent } from '@components/edit-heading/edit-heading';
import { DockerContainerInfo, DockerContainerInspectInfo } from '@shared/types/docker-api.types';
import { EnvVarRow, areEnvVarsEqual, dockerEnvToRows, rowsToDockerEnv } from '@utils/env.utils';
import { envRowsSchema, resetFormRows } from '@utils/configuration-form.utils';
import {
  escapeSearchHtml,
  findVisibleMatchIndex,
  getSearchNavigationDirection,
  normalizeSearchMatchIndex
} from '@utils/search-navigation.utils';

interface EnvMatch {
  rowIndex: number;
  field: 'key' | 'value';
  start: number;
  end: number;
}

@Component({
  selector: 'catbee-container-studio-container-env-tab',
  imports: [
    CommonModule,
    SearchInputComponent,
    CopyButtonComponent,
    EmptyStateComponent,
    ConfirmDialogComponent,
    EnvVariablesEditorComponent,
    EditHeadingComponent,
    FormRoot
  ],
  templateUrl: './env-tab.html',
  styleUrl: './env-tab.scss'
})
export class EnvTabComponent {
  private readonly envSearchInput = viewChild<SearchInputComponent>('envSearchInput');
  private readonly envScrollArea = viewChild<ElementRef<HTMLElement>>('envScrollArea');
  private readonly envEditor = viewChild(EnvVariablesEditorComponent);

  readonly inspectData = input<DockerContainerInspectInfo | null>(null);
  readonly container = input<DockerContainerInfo | null>(null);
  readonly isRecreating = input(false);
  readonly recreate = output<string[]>();

  readonly envSearchTerm = signal('');
  readonly currentMatchIndex = signal(0);

  readonly isEditing = signal(false);
  readonly initialEnvVars = signal<EnvVarRow[]>([]);
  readonly editableEnvVars = signal<EnvVarRow[]>([]);
  readonly envForm = form(
    this.editableEnvVars,
    path => {
      apply(path, envRowsSchema);
      disabled(path, { when: () => this.isRecreating() });
    },
    { submission: { action: async () => this.requestSave() } }
  );
  readonly isEnvChanged = computed(() => !areEnvVarsEqual(this.initialEnvVars(), this.editableEnvVars()));
  readonly hasUnsavedChanges = computed(
    () =>
      this.isEditing() &&
      (this.isEnvChanged() || this.editableEnvVars().some(row => !row.key.trim() && row.value.length > 0))
  );
  readonly showConfirmRecreate = signal(false);
  readonly showConfirmClear = signal(false);
  readonly showConfirmReset = signal(false);
  readonly showConfirmDiscard = signal(false);
  private afterDiscard: (() => void) | undefined;

  readonly envRows = computed<EnvVarRow[]>(() => {
    const inspectData = this.inspectData();
    if (!inspectData || typeof inspectData !== 'object') {
      return [];
    }
    return dockerEnvToRows(inspectData.Config?.Env);
  });

  readonly confirmMessage = computed(() => {
    const name =
      this.container()?.Names?.[0]?.replace(/^\//, '') ||
      this.inspectData()?.Name?.replace(/^\//, '') ||
      'this container';

    const isCompose = Boolean(
      this.container()?.Labels?.['com.docker.compose.service'] ??
      this.inspectData()?.Config?.Labels?.['com.docker.compose.service']
    );

    if (isCompose) {
      return `Force recreate compose container "${name}" with updated environment variables? \n This will stop, remove, and recreate the container using Docker Engine with your updated variables. \n\nNote: Running "docker compose up" from CLI in the future will reset environment variables to the compose file definition.`;
    }

    return `Force recreate container "${name}" with updated environment variables? \n This will stop, remove, and recreate the container using the same configuration with your updated variables.`;
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

    const idx = normalizeSearchMatchIndex(this.currentMatchIndex(), matches.length);
    return matches[idx] ?? null;
  });

  readonly matchSummary = computed(() => {
    const total = this.envMatches().length;
    if (total === 0) {
      return '0/0';
    }

    return `${normalizeSearchMatchIndex(this.currentMatchIndex(), total) + 1}/${total}`;
  });

  readonly hasMatches = computed(() => this.envMatches().length > 0);

  private isSearchNavigationPrimed = false;

  constructor() {
    effect(() => {
      this.inspectData();
      queueMicrotask(() => this.selectNearestMatchFromViewport());
    });
  }

  startEditing(): void {
    const current = this.envRows().map(row => ({ key: row.key, value: row.value }));
    this.initialEnvVars.set(current.map(row => ({ ...row })));
    this.envForm().reset(current.length > 0 ? current : [{ key: '', value: '' }]);
    this.isEditing.set(true);
  }

  resetEditing(): void {
    if (this.isRecreating()) {
      return;
    }
    if (this.hasUnsavedChanges()) {
      this.showConfirmReset.set(true);
      return;
    }
    this.confirmResetEditing();
  }

  confirmResetEditing(): void {
    if (this.isRecreating()) {
      return;
    }
    this.showConfirmReset.set(false);
    resetFormRows(this.envForm, this.initialEnvVars());
  }

  cancelEditing(afterDiscard?: () => void): void {
    this.afterDiscard = afterDiscard;
    if (this.hasUnsavedChanges()) {
      this.showConfirmDiscard.set(true);
      return;
    }
    this.confirmDiscardEditing();
  }

  cancelDiscardEditing(): void {
    this.showConfirmDiscard.set(false);
    this.afterDiscard = undefined;
  }

  confirmDiscardEditing(): void {
    const afterDiscard = this.afterDiscard;
    this.finishEditing();
    afterDiscard?.();
  }

  finishEditing(): void {
    this.isEditing.set(false);
    this.envForm().reset([]);
    this.showConfirmDiscard.set(false);
    this.showConfirmClear.set(false);
    this.showConfirmReset.set(false);
    this.showConfirmRecreate.set(false);
    this.afterDiscard = undefined;
  }

  addEnvVar(): void {
    this.editableEnvVars.update(rows => [...rows, { key: '', value: '' }]);
    this.envForm().markAsDirty();
    this.envEditor()?.scrollToBottomAndFocus();
  }

  clearEnvVars(): void {
    if (this.editableEnvVars().some(row => row.key.length > 0 || row.value.length > 0)) {
      this.showConfirmClear.set(true);
      return;
    }
    this.confirmClearEnvVars();
  }

  confirmClearEnvVars(): void {
    this.showConfirmClear.set(false);
    this.editableEnvVars.set([]);
    this.envForm().markAsDirty();
  }

  requestSave(): void {
    if (this.isRecreating()) {
      return;
    }
    this.envForm().markAsTouched();
    if (this.envForm().invalid() || !this.isEnvChanged()) {
      return;
    }
    this.showConfirmRecreate.set(true);
  }

  cancelSave(): void {
    this.showConfirmRecreate.set(false);
  }

  confirmSaveAndRecreate(): void {
    if (this.isRecreating() || this.envForm().invalid() || !this.isEnvChanged()) {
      return;
    }
    this.showConfirmRecreate.set(false);
    const env = rowsToDockerEnv(this.editableEnvVars());
    this.recreate.emit(env);
  }

  focusAndSelectSearch(): void {
    this.envSearchInput()?.focusAndSelect();
  }

  setSearch(value: string): void {
    this.envSearchTerm.set(value);
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
    const total = this.envMatches().length;
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
    const total = this.envMatches().length;
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

  renderHighlightedValue(rowIndex: number, field: 'key' | 'value', value: string): string {
    const marks = this.envMatches().filter(match => match.rowIndex === rowIndex && match.field === field);
    if (marks.length === 0) {
      return escapeSearchHtml(value);
    }

    const current = this.currentMatch();
    let cursor = 0;
    let html = '';

    for (const mark of marks) {
      if (cursor < mark.start) {
        html += escapeSearchHtml(value.slice(cursor, mark.start));
      }

      const isCurrent =
        current !== null &&
        current.rowIndex === mark.rowIndex &&
        current.field === mark.field &&
        current.start === mark.start &&
        current.end === mark.end;
      const text = escapeSearchHtml(value.slice(mark.start, mark.end));
      html += `<span class="search-match${isCurrent ? ' current' : ''}">${text}</span>`;
      cursor = mark.end;
    }

    if (cursor < value.length) {
      html += escapeSearchHtml(value.slice(cursor));
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

  private selectNearestMatchFromViewport(): void {
    const matches = this.envMatches();
    const panel = this.envScrollArea()?.nativeElement;
    if (matches.length === 0 || !panel) {
      this.currentMatchIndex.set(0);
      this.isSearchNavigationPrimed = false;
      return;
    }

    const rows = panel.querySelectorAll<HTMLElement>('tbody tr');
    const headerHeight = panel.querySelector<HTMLElement>('thead')?.getBoundingClientRect().height ?? 0;
    const visibleMatch = findVisibleMatchIndex(matches, rows, match => match.rowIndex, panel, headerHeight);

    this.currentMatchIndex.set(Math.max(visibleMatch, 0));
    this.isSearchNavigationPrimed = true;
    if (visibleMatch < 0) {
      this.scrollCurrentMatchIntoView();
    }
  }
}
