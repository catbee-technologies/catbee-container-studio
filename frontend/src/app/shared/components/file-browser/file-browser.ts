import { Component, ElementRef, HostListener, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { DockerFileEntry } from '@shared/types/docker-api.types';
import { BreadcrumbsComponent } from '@components/breadcrumbs/breadcrumbs';
import { SearchInputComponent } from '@components/search-input/search-input';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { ConfirmDialogComponent } from '@components/dialog/confirm-dialog';
import { CatbeeMonacoEditor, MonacoEditorOptions } from '@ng-catbee/monaco-editor';
import { SortDirection } from '@shared/types';
import { TableSortHeaderComponent } from '@components/table-sort-header/table-sort-header';
import { formatDockerBytes, formatDockerRelativeTime, formatMode } from '@utils/docker-display.utils';
import { SessionStorageService } from '@ng-catbee/storage';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { TooltipDateComponent } from '@components/tooltip-date/tooltip-date';

type FileSortKey = 'name' | 'size' | 'mode' | 'modified';

export interface FileBrowserDataSource {
  list(path: string): Promise<DockerFileEntry[]>;
  read(path: string): Promise<Uint8Array>;
  write?(path: string, data: Uint8Array): Promise<void>;
  delete?(path: string): Promise<void>;
  getUnavailableState?(error: unknown): FileBrowserUnavailableState | null;
}

export interface FileBrowserUnavailableState {
  message: string;
  hint?: string;
}

const MAX_PREVIEW_MB = 10;
const MAX_PREVIEW_BYTES = MAX_PREVIEW_MB * 1024 * 1024;
const DIRECTORY_LOAD_TIMEOUT_SECONDS = 15;
const DIRECTORY_LOAD_TIMEOUT_MS = DIRECTORY_LOAD_TIMEOUT_SECONDS * 1000;

@Component({
  selector: 'catbee-container-studio-file-browser',
  imports: [
    BreadcrumbsComponent,
    SearchInputComponent,
    EmptyStateComponent,
    ErrorBannerComponent,
    ConfirmDialogComponent,
    CatbeeMonacoEditor,
    TableSortHeaderComponent,
    CatbeeTooltip,
    TooltipDateComponent
  ],
  templateUrl: './file-browser.html',
  styleUrl: './file-browser.scss'
})
export class FileBrowserComponent {
  private readonly sessionStorage = inject(SessionStorageService);

  private readonly browserContent = viewChild<ElementRef<HTMLElement>>('browserContent');
  private readonly directoryPanel = viewChild<ElementRef<HTMLElement>>('directoryPanel');
  private readonly fileSearchInput = viewChild<SearchInputComponent>('fileSearchInput');

  readonly dataSource = input.required<FileBrowserDataSource>();
  readonly rootPath = input('/');
  readonly ariaLabel = input('File browser');
  readonly storageKey = input<string | null>(null);

  readonly tooltipDelay = 300;

  readonly currentPath = signal('/');
  readonly entries = signal<readonly DockerFileEntry[]>([]);
  readonly query = signal('');
  readonly selectedEntry = signal<DockerFileEntry | null>(null);
  readonly previewText = signal<string | null>(null);
  readonly previewMessage = signal<{ message: string; hint?: string }>({
    message: 'Select a file to preview its contents.'
  });
  readonly isLoading = signal(false);
  readonly isPreviewLoading = signal(false);
  readonly error = signal<string | null>(null);
  readonly unavailableState = signal<FileBrowserUnavailableState | null>(null);
  readonly isEditing = signal(false);
  readonly editorText = signal('');
  readonly isSaving = signal(false);
  readonly isDeleting = signal(false);
  readonly deleteDialogOpen = signal(false);
  readonly entryPendingDelete = signal<DockerFileEntry | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly directoryPanePercent = signal(60);
  readonly isResizingPanes = signal(false);
  readonly sortKey = signal<FileSortKey>('name');
  readonly sortDirection = signal<SortDirection>('asc');

  readonly visibleEntries = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    const sortKey = this.sortKey();
    return this.entries()
      .filter(entry => !query || entry.name.toLocaleLowerCase().includes(query))
      .slice()
      .sort((left, right) => {
        // Only group directories first when browsing by name; other columns sort files and folders together.
        if (sortKey === 'name') {
          const leftRank = left.type === 'directory' ? 0 : 1;
          const rightRank = right.type === 'directory' ? 0 : 1;
          if (leftRank !== rightRank) {
            return leftRank - rightRank;
          }
        }

        const comparison = this.compareEntries(left, right, sortKey);
        const directedComparison = this.sortDirection() === 'asc' ? comparison : -comparison;
        return directedComparison || left.name.localeCompare(right.name, undefined, { numeric: true });
      });
  });

  readonly canGoUp = computed(() => this.currentPath() !== this.normalizePath(this.rootPath()));
  readonly canEdit = computed(
    () => this.dataSource().write !== undefined && this.selectedEntry()?.type === 'file' && this.previewText() !== null
  );
  readonly canDeleteEntries = computed(() => this.dataSource().delete !== undefined);
  readonly hasUnsavedChanges = computed(() => this.isEditing() && this.editorText() !== this.previewText());
  readonly editorLanguage = computed(() => this.getMonacoLanguage(this.selectedEntry()?.name ?? ''));
  readonly editorOptions = computed<MonacoEditorOptions>(() => ({
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    renderWhitespace: this.isEditing() ? 'selection' : 'none',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 13,
    lineHeight: 20,
    padding: { top: 12, bottom: 12 },
    folding: true,
    glyphMargin: false,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true
  }));
  readonly deleteMessage = computed(() => {
    const entry = this.entryPendingDelete();
    if (!entry) {
      return '';
    }
    return entry.type === 'directory'
      ? `Delete "${entry.name}" and everything inside it? This cannot be undone.`
      : `Delete "${entry.name}" from the container? This cannot be undone.`;
  });
  readonly paneColumns = computed(() => {
    const directoryPercent = this.directoryPanePercent();
    return `${directoryPercent}fr 0.4rem ${100 - directoryPercent}fr`;
  });

  private loadRequest = 0;
  private previewRequest = 0;

  constructor() {
    effect(() => {
      this.dataSource();
      const rootPath = this.normalizePath(this.rootPath());
      const storageKey = this.storageKey();
      const storedPath = storageKey ? this.sessionStorage.getWithDefault(storageKey, rootPath) : rootPath;
      const initialPath = this.isPathWithinRoot(storedPath, rootPath) ? this.normalizePath(storedPath) : rootPath;
      this.currentPath.set(initialPath);
      void this.loadDirectory(initialPath);
    });
  }

  async loadDirectory(path: string): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    const request = ++this.loadRequest;
    this.isLoading.set(true);
    if (this.directoryPanel()?.nativeElement) {
      this.directoryPanel()!.nativeElement.scrollTop = 0;
    }
    this.error.set(null);
    this.unavailableState.set(null);
    if (normalizedPath !== this.currentPath()) {
      this.query.set('');
    }

    try {
      const entries = await this.listWithTimeout(normalizedPath);
      if (request !== this.loadRequest) {
        return;
      }
      this.currentPath.set(normalizedPath);
      this.entries.set(entries);
      this.clearSelection();
      const storageKey = this.storageKey();
      if (storageKey) {
        this.sessionStorage.set(storageKey, normalizedPath);
      }
    } catch (error) {
      if (request === this.loadRequest) {
        this.entries.set([]);
        const unavailableState = this.dataSource().getUnavailableState?.(error) ?? null;
        if (unavailableState) {
          this.unavailableState.set(unavailableState);
          this.clearSelection();
        } else {
          this.error.set(error instanceof Error ? error.message : 'Unable to load this directory.');
        }
      }
    } finally {
      if (request === this.loadRequest) {
        this.isLoading.set(false);
      }
    }
  }

  openEntry(entry: DockerFileEntry): void {
    if (entry.type === 'directory') {
      void this.loadDirectory(entry.path);
      return;
    }

    if (entry.type === 'symlink') {
      this.selectedEntry.set(entry);
      this.previewText.set(null);
      this.previewMessage.set({ message: 'Symlinks cannot be previewed.' });
      this.isPreviewLoading.set(false);
      this.isEditing.set(false);
      return;
    }

    void this.previewFile(entry);
  }

  goUp(): void {
    if (!this.canGoUp()) {
      return;
    }

    const currentPath = this.currentPath();
    const parentPath = currentPath.slice(0, currentPath.lastIndexOf('/')) || '/';
    void this.loadDirectory(parentPath);
  }

  refresh(): void {
    void this.loadDirectory(this.currentPath());
  }

  @HostListener('window:keydown', ['$event'])
  onWindowKeydown(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') {
      return;
    }

    // Let Monaco keep its own find widget when the preview editor has focus.
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('.monaco-editor')) {
      return;
    }

    event.preventDefault();
    this.fileSearchInput()?.focusAndSelect();
  }

  isSortActive(key: FileSortKey): boolean {
    return this.sortKey() === key;
  }

  sortIndicator(key: FileSortKey): string {
    if (!this.isSortActive(key)) {
      return 'unfold_more';
    }
    return this.sortDirection() === 'asc' ? 'north' : 'south';
  }

  ariaSort(key: FileSortKey): 'ascending' | 'descending' | 'none' {
    if (!this.isSortActive(key)) {
      return 'none';
    }
    return this.sortDirection() === 'asc' ? 'ascending' : 'descending';
  }

  toggleSort(key: FileSortKey): void {
    if (this.isSortActive(key)) {
      this.sortDirection.update(direction => (direction === 'asc' ? 'desc' : 'asc'));
      return;
    }

    this.sortKey.set(key);
    this.sortDirection.set(key === 'size' || key === 'modified' ? 'desc' : 'asc');
  }

  startPaneResize(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.isResizingPanes.set(true);
    this.resizePanes(event.clientX);
  }

  continuePaneResize(event: PointerEvent): void {
    if (this.isResizingPanes()) {
      this.resizePanes(event.clientX);
    }
  }

  stopPaneResize(event: PointerEvent): void {
    const splitter = event.currentTarget as HTMLElement;
    if (splitter.hasPointerCapture(event.pointerId)) {
      splitter.releasePointerCapture(event.pointerId);
    }
    this.isResizingPanes.set(false);
  }

  resizePanesWithKeyboard(event: KeyboardEvent): void {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.directoryPanePercent.update(value => this.clampPanePercent(value - step));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.directoryPanePercent.update(value => this.clampPanePercent(value + step));
    } else if (event.key === 'Home') {
      event.preventDefault();
      this.directoryPanePercent.set(25);
    } else if (event.key === 'End') {
      event.preventDefault();
      this.directoryPanePercent.set(75);
    }
  }

  startEditing(): void {
    const text = this.previewText();
    if (!this.canEdit() || text === null) {
      return;
    }
    this.editorText.set(text);
    this.actionError.set(null);
    this.isEditing.set(true);
  }

  cancelEditing(): void {
    this.editorText.set(this.previewText() ?? '');
    this.actionError.set(null);
    this.isEditing.set(false);
  }

  async saveFile(): Promise<void> {
    const entry = this.selectedEntry();
    const write = this.dataSource().write;
    if (!entry || !write || !this.hasUnsavedChanges() || this.isSaving()) {
      return;
    }

    this.isSaving.set(true);
    this.actionError.set(null);
    try {
      const text = this.editorText();
      const data = new TextEncoder().encode(text);
      await write(entry.path, data);
      this.previewText.set(text);
      const updatedEntry = { ...entry, size: data.byteLength, modifiedAt: new Date().toISOString() };
      this.selectedEntry.set(updatedEntry);
      this.entries.update(entries => entries.map(item => (item.path === entry.path ? updatedEntry : item)));
      this.isEditing.set(false);
    } catch (error) {
      this.actionError.set(this.getActionError(error, 'Unable to save this file.'));
    } finally {
      this.isSaving.set(false);
    }
  }

  requestDeleteEntry(entry: DockerFileEntry): void {
    if (this.canDeleteEntries() && !this.isDeleting()) {
      this.entryPendingDelete.set(entry);
      this.deleteDialogOpen.set(true);
    }
  }

  cancelDelete(): void {
    this.deleteDialogOpen.set(false);
    this.entryPendingDelete.set(null);
  }

  onEditorInitError(error: unknown): void {
    this.actionError.set(error instanceof Error ? error.message : 'Unable to initialize the file editor.');
  }

  async confirmDelete(): Promise<void> {
    const entry = this.entryPendingDelete();
    const deleteEntry = this.dataSource().delete;
    this.deleteDialogOpen.set(false);
    this.entryPendingDelete.set(null);
    if (!entry || !deleteEntry || this.isDeleting()) {
      return;
    }

    this.isDeleting.set(true);
    this.actionError.set(null);
    try {
      await deleteEntry(entry.path);
      if (this.selectedEntry()?.path === entry.path) {
        this.clearSelection();
      }
      await this.loadDirectory(this.currentPath());
    } catch (error) {
      this.actionError.set(this.getActionError(error, 'Unable to delete this file.'));
    } finally {
      this.isDeleting.set(false);
    }
  }

  iconFor(entry: DockerFileEntry): string {
    if (entry.type === 'directory') {
      return 'folder';
    }
    if (entry.type === 'symlink') {
      return 'link';
    }
    return 'draft';
  }

  formatSize(entry: DockerFileEntry): string {
    if (entry.type === 'directory') {
      return '--';
    }
    return formatDockerBytes(entry.size);
  }

  formatMode(mode: string | null): string {
    return formatMode(mode);
  }

  formatModifiedTime(modifiedAt: string | null): string {
    return modifiedAt ? formatDockerRelativeTime(modifiedAt) : '--';
  }

  private async previewFile(entry: DockerFileEntry): Promise<void> {
    const request = ++this.previewRequest;
    this.selectedEntry.set(entry);
    this.previewText.set(null);
    this.previewMessage.set({ message: 'Loading preview...' });
    this.isPreviewLoading.set(true);
    this.isEditing.set(false);
    this.actionError.set(null);

    if (entry.size > MAX_PREVIEW_BYTES) {
      this.previewMessage.set({ message: `Preview is limited to files smaller than ${MAX_PREVIEW_MB} MB.` });
      this.isPreviewLoading.set(false);
      return;
    }

    try {
      const data = await this.dataSource().read(entry.path);
      if (request !== this.previewRequest) {
        return;
      }
      if (this.isBinary(data)) {
        this.previewMessage.set({ message: 'Binary files cannot be previewed as text.' });
        return;
      }
      const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
      this.previewText.set(text);
      this.editorText.set(text);
      this.previewMessage.set({ message: '' });
    } catch (error) {
      if (request === this.previewRequest) {
        const unavailableState = this.dataSource().getUnavailableState?.(error) ?? null;
        const message =
          unavailableState?.message ?? (error instanceof Error ? error.message : 'Unable to preview this file.');
        this.previewMessage.set({ message: message, hint: unavailableState?.hint ?? '' });
      }
    } finally {
      if (request === this.previewRequest) {
        this.isPreviewLoading.set(false);
      }
    }
  }

  private clearSelection(): void {
    this.previewRequest += 1;
    this.selectedEntry.set(null);
    this.previewText.set(null);
    this.previewMessage.set({ message: 'Select a file to preview its contents.' });
    this.isPreviewLoading.set(false);
    this.isEditing.set(false);
    this.editorText.set('');
    this.actionError.set(null);
  }

  private async listWithTimeout(path: string): Promise<DockerFileEntry[]> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        this.dataSource().list(path),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new Error(
                `Directory loading timed out after ${DIRECTORY_LOAD_TIMEOUT_SECONDS} seconds. Check that the container is running and try again.`
              )
            );
          }, DIRECTORY_LOAD_TIMEOUT_MS);
        })
      ]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  private isBinary(data: Uint8Array): boolean {
    const sampleLength = Math.min(data.length, 8000);
    for (let index = 0; index < sampleLength; index += 1) {
      if (data[index] === 0) {
        return true;
      }
    }
    return false;
  }

  private getActionError(error: unknown, fallback: string): string {
    const unavailableState = this.dataSource().getUnavailableState?.(error) ?? null;
    return unavailableState?.message ?? (error instanceof Error ? error.message : fallback);
  }

  private compareEntries(left: DockerFileEntry, right: DockerFileEntry, key: FileSortKey): number {
    switch (key) {
      case 'size':
        return left.size - right.size;
      case 'mode':
        return this.parseMode(left.mode) - this.parseMode(right.mode);
      case 'modified':
        return this.parseModifiedAt(left.modifiedAt) - this.parseModifiedAt(right.modifiedAt);
      case 'name':
        return left.name.localeCompare(right.name, undefined, { numeric: true });
    }
  }

  private parseMode(mode: string | null): number {
    return mode && /^[0-7]{3,4}$/.test(mode) ? Number.parseInt(mode, 8) : -1;
  }

  private parseModifiedAt(modifiedAt: string | null): number {
    if (!modifiedAt) {
      return -1;
    }
    const timestamp = Date.parse(modifiedAt);
    return Number.isNaN(timestamp) ? -1 : timestamp;
  }

  private resizePanes(clientX: number): void {
    const bounds = this.browserContent()?.nativeElement.getBoundingClientRect();
    if (!bounds || bounds.width === 0) {
      return;
    }

    const percent = ((clientX - bounds.left) / bounds.width) * 100;
    this.directoryPanePercent.set(this.clampPanePercent(percent));
  }

  private clampPanePercent(value: number): number {
    return Math.min(75, Math.max(25, value));
  }

  private normalizePath(path: string): string {
    const normalized = `/${path}`.replace(/\/+/g, '/').replace(/\/$/, '');
    return normalized || '/';
  }

  private isPathWithinRoot(path: string, rootPath: string): boolean {
    const normalizedPath = this.normalizePath(path);
    const normalizedRoot = this.normalizePath(rootPath);
    return (
      normalizedRoot === '/' || normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
    );
  }

  private getMonacoLanguage(fileName: string): string {
    const normalized = fileName.toLowerCase();
    const exactNames: Record<string, string> = {
      dockerfile: 'dockerfile',
      makefile: 'makefile',
      '.gitignore': 'plaintext',
      '.env': 'ini'
    };
    const exactLanguage = exactNames[normalized];
    if (exactLanguage) {
      return exactLanguage;
    }

    const extension = normalized.includes('.') ? normalized.slice(normalized.lastIndexOf('.') + 1) : '';
    const languages: Record<string, string> = {
      // Shell
      bash: 'shell',
      sh: 'shell',
      zsh: 'shell',
      fish: 'shell',

      // C / C++
      c: 'c',
      h: 'c',
      cc: 'cpp',
      cpp: 'cpp',
      cxx: 'cpp',
      hpp: 'cpp',
      hxx: 'cpp',

      // C#
      cs: 'csharp',

      // Web
      html: 'html',
      htm: 'html',
      ejs: 'html',
      css: 'css',
      scss: 'scss',
      less: 'less',
      sass: 'scss',
      vue: 'vue',
      svelte: 'svelte',

      // JavaScript / TypeScript
      js: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      jsx: 'javascript',
      ts: 'typescript',
      mts: 'typescript',
      cts: 'typescript',
      tsx: 'typescript',

      // JVM
      java: 'java',
      kt: 'kotlin',
      kts: 'kotlin',
      scala: 'scala',
      groovy: 'plaintext', // Monaco doesn't provide a built-in Groovy language

      // Systems / compiled
      go: 'go',
      rs: 'rust',
      swift: 'swift',

      // Scripting
      py: 'python',
      rb: 'ruby',
      php: 'php',
      lua: 'lua',

      // Data / config
      json: 'json',
      jsonc: 'json',
      json5: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      toml: 'ini',
      ini: 'ini',
      conf: 'ini',
      properties: 'ini',
      env: 'ini',

      // Database
      sql: 'sql',

      // Documentation
      md: 'markdown',
      markdown: 'markdown',

      // PowerShell
      ps1: 'powershell',

      // XML
      xml: 'xml'
    };
    return languages[extension] ?? 'plaintext';
  }
}
