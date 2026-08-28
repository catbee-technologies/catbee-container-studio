import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild
} from '@angular/core';
import { DockerApiService } from '@core/docker-api.service';
import { MenuComponent } from '@components/menu/menu';
import { SearchInputComponent } from '@components/search-input/search-input';
import { DockerLogChannel, DockerStreamEventEnvelope } from '@shared/types/docker-api.types';
import { LOGS_STORAGE_DEFAULTS, LOGS_STORAGE_KEYS } from '@utils/storage.utils';
import { LocalStorageService } from '@ng-catbee/storage';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { LOG_TAIL_OPTIONS } from '@shared/types';
import { ElectronApiService } from '@core/electron-api.service';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';

export interface LogsSearchMode {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface ContainerLogEntry {
  raw: string;
  channel: DockerLogChannel;
  timestamp: string;
}

interface DisplayLogLine {
  prefix: string;
  ansiRaw: string;
  plainWithPrefix: string;
  htmlWithPrefix: string;
}

interface StyledTextSegment {
  text: string;
  fgClass: string | null;
  fgColorHex: string | null;
  bold: boolean;
}

interface LogMatch {
  logIndex: number;
  start: number;
  end: number;
}

@Component({
  selector: 'catbee-container-studio-container-logs-tab',
  imports: [CommonModule, SearchInputComponent, MenuComponent, EmptyStateComponent, CatbeeTooltip],
  templateUrl: './logs-tab.html',
  styleUrl: './logs-tab.scss'
})
export class LogsTabComponent implements AfterViewInit {
  // private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly LOGS_BOOTSTRAP_SETTLE_MS = 500;

  private static readonly ESC = String.fromCharCode(27);

  private readonly dockerApi = inject(DockerApiService);
  private readonly electronApi = inject(ElectronApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly localStorage = inject(LocalStorageService);

  private readonly ansiCodePattern = new RegExp(`${LogsTabComponent.ESC}\\[([0-9;]*)m`, 'g');
  private readonly ansiStripPattern = new RegExp(`${LogsTabComponent.ESC}\\[[0-9;]*m`, 'g');
  private readonly urlPattern = /\bhttps?(?:\\?:\/\/)[^\s<>"'`]+/gi;

  private readonly logsSearchInput = viewChild<SearchInputComponent>('logsSearchInput');
  private readonly tabScrollArea = viewChild<ElementRef<HTMLElement>>('tabScrollArea');

  readonly tooltipDelay = 300;

  readonly containerId = input.required<string>();
  readonly active = input(false);
  private hasActivatedLogs = false;

  readonly unavailable = output<void>();
  readonly streamError = output<string>();

  readonly logsSearchTerm = signal('');
  readonly logsSearchMode = signal<LogsSearchMode>({
    caseSensitive: false,
    wholeWord: false,
    regex: false
  });
  readonly currentMatchIndex = signal(0);

  readonly showLogOptions = signal(false);
  readonly logTailLines = signal(
    Number.parseInt(
      this.localStorage.getEnumWithDefault(
        LOGS_STORAGE_KEYS.TAIL_LINES,
        String(LOGS_STORAGE_DEFAULTS.TAIL_LINES),
        LOG_TAIL_OPTIONS.map(String)
      ),
      10
    )
  );
  readonly logTailLineOptions = LOG_TAIL_OPTIONS;
  readonly showLogTimestamps = signal(
    this.localStorage.getBooleanWithDefault(LOGS_STORAGE_KEYS.SHOW_TIMESTAMPS, LOGS_STORAGE_DEFAULTS.SHOW_TIMESTAMPS)
  );
  readonly wrapLogLines = signal(
    this.localStorage.getBooleanWithDefault(LOGS_STORAGE_KEYS.WRAP_LINES, LOGS_STORAGE_DEFAULTS.WRAP_LINES)
  );
  readonly isNearBottom = signal(true);
  readonly logs = signal<ContainerLogEntry[]>([]);
  readonly isLoading = signal(false);

  readonly copyButtonLabel = signal('Copy');
  readonly clearButtonLabel = signal('Clear Logs');

  readonly logsStreamId = signal<string | null>(null);

  private readonly chunkBufferByChannel: Record<'stdout' | 'stderr' | 'unknown', string> = {
    stdout: '',
    stderr: '',
    unknown: ''
  };

  private reconnectLogsTimer: ReturnType<typeof setTimeout> | null = null;
  private logsBootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  private isDisposed = false;
  private reconnectAttempts = 0;
  private forceScrollToBottomOnNextBatch = true;
  private isBootstrappingLogs = false;
  private currentContainerId: string | null = null;

  private copyResetTimer: ReturnType<typeof setTimeout> | null = null;
  private clearResetTimer: ReturnType<typeof setTimeout> | null = null;
  private isSearchNavigationPrimed = false;

  constructor() {
    const streamUnsubscribe = this.dockerApi.onStreamEvent(event => this.onStreamEvent(event));
    this.destroyRef.onDestroy(() => {
      this.isDisposed = true;
      streamUnsubscribe();
      this.clearReconnectTimer();
      this.clearLogsBootstrapTimer();
      this.clearActionTimers();
      void this.stopLogsStream();
    });

    effect(() => {
      const containerId = this.containerId();
      if (!containerId) {
        return;
      }

      queueMicrotask(() => {
        void this.bindContainer(containerId);
      });
    });

    effect(() => {
      if (!this.active()) {
        return;
      }

      const firstActivation = !this.hasActivatedLogs;
      this.hasActivatedLogs = true;

      requestAnimationFrame(() => {
        if (this.isDisposed || !this.active()) {
          return;
        }
        if (firstActivation) {
          this.scrollToBottom();
        } else {
          this.onPanelScroll();
        }
      });
    });
  }

  readonly displayLogLines = computed<DisplayLogLine[]>(() => {
    return this.logs().map(entry => {
      const prefix = this.showLogTimestamps()
        ? `[${new Date(entry.timestamp).toLocaleTimeString()}] (${entry.channel === 'stderr' ? 'err' : 'out'}) `
        : '';
      const sanitizedRaw = this.stripDockerTimestampPrefix(entry.raw);

      return {
        prefix,
        ansiRaw: sanitizedRaw,
        plainWithPrefix: `${prefix}${this.stripAnsi(sanitizedRaw)}`,
        htmlWithPrefix: `${this.escapeHtml(prefix)}${this.ansiToHtml(sanitizedRaw)}`
      };
    });
  });

  readonly logMatches = computed<LogMatch[]>(() => {
    const term = this.logsSearchTerm().trim();
    if (!term) {
      return [];
    }

    const lines = this.displayLogLines().map(line => line.plainWithPrefix);
    const mode = this.logsSearchMode();

    if (mode.regex) {
      try {
        const regex = new RegExp(term, mode.caseSensitive ? 'g' : 'gi');
        const matches: LogMatch[] = [];

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex] ?? '';
          regex.lastIndex = 0;
          let result = regex.exec(line);

          while (result) {
            const text = result[0] ?? '';
            if (text.length === 0) {
              regex.lastIndex += 1;
              result = regex.exec(line);
              continue;
            }

            matches.push({
              logIndex: lineIndex,
              start: result.index,
              end: result.index + text.length
            });

            result = regex.exec(line);
          }
        }

        return matches;
      } catch {
        return [];
      }
    }

    const sourceNeedle = mode.caseSensitive ? term : term.toLowerCase();
    const matches: LogMatch[] = [];

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? '';
      const source = mode.caseSensitive ? line : line.toLowerCase();

      let fromIndex = 0;
      while (fromIndex <= source.length - sourceNeedle.length) {
        const found = source.indexOf(sourceNeedle, fromIndex);
        if (found < 0) {
          break;
        }

        const start = found;
        const end = found + sourceNeedle.length;
        if (mode.wholeWord && !this.isWholeWordBoundary(line, start, end)) {
          fromIndex = start + 1;
          continue;
        }

        matches.push({ logIndex: lineIndex, start, end });
        fromIndex = end;
      }
    }

    return matches;
  });

  readonly hasRegexError = computed(() => {
    if (!this.logsSearchMode().regex) {
      return false;
    }

    const term = this.logsSearchTerm().trim();
    if (!term) {
      return false;
    }

    try {
      void new RegExp(term, this.logsSearchMode().caseSensitive ? 'g' : 'gi');
      return false;
    } catch {
      return true;
    }
  });

  readonly currentMatch = computed<LogMatch | null>(() => {
    const matches = this.logMatches();
    if (matches.length === 0) {
      return null;
    }

    const idx = this.normalizeMatchIndex(this.currentMatchIndex(), matches.length);
    return matches[idx] ?? null;
  });

  readonly renderedLogLinesHtml = computed<string[]>(() => {
    const lines = this.displayLogLines();
    const term = this.logsSearchTerm().trim();
    const hasSearch = term.length > 0 && !this.hasRegexError();
    const current = this.currentMatch();

    if (!hasSearch) {
      return lines.map(line => line.htmlWithPrefix);
    }

    const byLine = new Map<number, { start: number; end: number; current: boolean }[]>();
    for (const match of this.logMatches()) {
      const list = byLine.get(match.logIndex) ?? [];
      const isCurrent =
        current !== null &&
        match.logIndex === current.logIndex &&
        match.start === current.start &&
        match.end === current.end;
      list.push({ start: match.start, end: match.end, current: isCurrent });
      byLine.set(match.logIndex, list);
    }

    return lines.map((line, index) => {
      const marks = byLine.get(index) ?? [];
      return this.renderHighlightedAnsiLine(line, marks);
    });
  });

  readonly matchSummary = computed(() => {
    const total = this.logMatches().length;
    if (total === 0) {
      return '0/0';
    }

    return `${this.normalizeMatchIndex(this.currentMatchIndex(), total) + 1}/${total}`;
  });

  readonly hasMatches = computed(() => this.logMatches().length > 0);

  readonly isScrollable = signal(false);

  ngAfterViewInit(): void {
    this.onPanelScroll();
  }

  focusAndSelectSearch(): void {
    this.logsSearchInput()?.focusAndSelect();
  }

  setSearch(value: string): void {
    this.logsSearchTerm.set(value);
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

  toggleCaseSensitive(): void {
    this.logsSearchMode.update(mode => ({ ...mode, caseSensitive: !mode.caseSensitive }));
    this.currentMatchIndex.set(0);
    this.isSearchNavigationPrimed = false;
  }

  toggleWholeWord(): void {
    this.logsSearchMode.update(mode => ({ ...mode, wholeWord: !mode.wholeWord }));
    this.currentMatchIndex.set(0);
    this.isSearchNavigationPrimed = false;
  }

  toggleRegex(): void {
    this.logsSearchMode.update(mode => ({ ...mode, regex: !mode.regex }));
    this.currentMatchIndex.set(0);
    this.isSearchNavigationPrimed = false;
  }

  nextMatch(): void {
    const total = this.logMatches().length;
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
    const total = this.logMatches().length;
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

  toggleLogOptions(event?: MouseEvent): void {
    event?.stopPropagation();
    this.showLogOptions.update(value => !value);
  }

  closeLogOptions(): void {
    this.showLogOptions.set(false);
  }

  toggleLogTimestamps(): void {
    this.showLogTimestamps.update(value => {
      const next = !value;
      this.localStorage.set(LOGS_STORAGE_KEYS.SHOW_TIMESTAMPS, next ? 'true' : 'false');
      return next;
    });
  }

  toggleWrapLines(): void {
    this.wrapLogLines.update(value => {
      const next = !value;
      this.localStorage.set(LOGS_STORAGE_KEYS.WRAP_LINES, next ? 'true' : 'false');
      return next;
    });
  }

  async onTailLinesChange(event: Event): Promise<void> {
    const target = event.target as HTMLSelectElement | null;
    const nextValue = Number.parseInt(target?.value ?? '', 10);

    if (!LOG_TAIL_OPTIONS.includes(nextValue as (typeof LOG_TAIL_OPTIONS)[number])) {
      if (target) {
        target.value = String(this.logTailLines());
      }
      return;
    }

    if (nextValue === this.logTailLines()) {
      return;
    }

    this.logTailLines.set(nextValue);
    this.localStorage.set(LOGS_STORAGE_KEYS.TAIL_LINES, String(nextValue));
    this.logs.set([]);
    this.currentMatchIndex.set(0);
    this.isSearchNavigationPrimed = false;
    this.clearChannelBuffers();

    const id = this.currentContainerId;
    if (!id) {
      return;
    }

    this.clearReconnectTimer();
    await this.restartLogsStream(id, this.getClearedSince(id));
  }

  async copyLogs(): Promise<void> {
    const content = this.displayLogLines()
      .map(line => line.plainWithPrefix)
      .join('\n');
    if (!content) {
      this.copyButtonLabel.set('No Logs');
      this.scheduleCopyButtonReset();
      return;
    }

    try {
      await navigator.clipboard.writeText(content);
      this.copyButtonLabel.set('Copied');
    } catch {
      this.copyButtonLabel.set('Copy Failed');
    }

    this.scheduleCopyButtonReset();
  }

  clearLogs(): void {
    if (this.logs().length === 0) {
      this.clearButtonLabel.set('No Logs');
      this.scheduleClearButtonReset();
      return;
    }

    this.logs.set([]);
    this.clearChannelBuffers();

    const id = this.containerId();
    if (id) {
      const since = Math.floor(Date.now() / 1000);
      this.localStorage.set(`${LOGS_STORAGE_KEYS.CLEARED_SINCE_PREFIX}${id}`, String(since));
      this.clearReconnectTimer();
      void this.restartLogsStream(id, since);
    }

    this.currentMatchIndex.set(0);
    this.isSearchNavigationPrimed = false;
    this.clearButtonLabel.set('Cleared');
    this.scheduleClearButtonReset();
  }

  onPanelScroll(): void {
    const area = this.tabScrollArea()?.nativeElement;
    if (!area || this.logs().length === 0) {
      this.isScrollable.set(false);
      return;
    }
    this.isScrollable.set(area.scrollHeight > area.clientHeight);
    this.isNearBottom.set(this.isPanelNearBottom());
  }

  scrollToTop(): void {
    const area = this.tabScrollArea()?.nativeElement;
    if (!area) {
      return;
    }

    area.scrollTop = 0;
    this.isNearBottom.set(false);
  }

  getScrollAreaElement(): HTMLElement | null {
    return this.tabScrollArea()?.nativeElement ?? null;
  }

  scrollToBottom(): void {
    const area = this.tabScrollArea()?.nativeElement;
    if (!area) {
      return;
    }

    area.scrollTop = area.scrollHeight;
    this.isNearBottom.set(true);
  }

  private scrollCurrentMatchIntoView(): void {
    const panel = this.tabScrollArea()?.nativeElement;
    if (!panel) {
      return;
    }

    requestAnimationFrame(() => {
      const current = panel.querySelector<HTMLElement>('.search-match.current');
      if (!current) {
        return;
      }

      const panelRect = panel.getBoundingClientRect();
      const currentRect = current.getBoundingClientRect();
      const offsetInPanel = currentRect.top - panelRect.top + panel.scrollTop;
      const targetTop = offsetInPanel - panel.clientHeight / 2 + currentRect.height / 2;
      const maxTop = Math.max(panel.scrollHeight - panel.clientHeight, 0);
      panel.scrollTop = Math.max(0, Math.min(targetTop, maxTop));
      this.onPanelScroll();
    });
  }

  private isPanelNearBottom(): boolean {
    const element = this.tabScrollArea()?.nativeElement;
    if (!element) {
      return this.isNearBottom();
    }

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    return distanceFromBottom < 28;
  }

  private renderHighlightedAnsiLine(
    line: DisplayLogLine,
    marks: { start: number; end: number; current: boolean }[]
  ): string {
    if (marks.length === 0) {
      return line.htmlWithPrefix;
    }

    const prefixSegment: StyledTextSegment = {
      text: line.prefix,
      fgClass: null,
      fgColorHex: null,
      bold: false
    };

    const styledSegments: StyledTextSegment[] = [prefixSegment, ...this.ansiToStyledSegments(line.ansiRaw)];

    const normalizedMarks = [...marks].sort((a, b) => a.start - b.start);
    let markIndex = 0;
    let globalOffset = 0;
    let html = '';

    for (const segment of styledSegments) {
      const segmentLength = segment.text.length;
      if (segmentLength === 0) {
        continue;
      }

      const segmentStart = globalOffset;
      const segmentEnd = segmentStart + segmentLength;
      let localCursor = 0;

      while (localCursor < segmentLength) {
        const absoluteCursor = segmentStart + localCursor;

        while (markIndex < normalizedMarks.length && normalizedMarks[markIndex]!.end <= absoluteCursor) {
          markIndex += 1;
        }

        const activeMark = normalizedMarks[markIndex];
        if (!activeMark || activeMark.start >= segmentEnd) {
          html += this.renderStyledText(segment.text.slice(localCursor), segment);
          break;
        }

        if (activeMark.start > absoluteCursor) {
          const nextLocal = Math.min(segmentLength, activeMark.start - segmentStart);
          html += this.renderStyledText(segment.text.slice(localCursor, nextLocal), segment);
          localCursor = nextLocal;
          continue;
        }

        const markedEndLocal = Math.min(segmentLength, activeMark.end - segmentStart);
        const markedClass = activeMark.current ? 'search-match current' : 'search-match';
        html += this.renderStyledText(segment.text.slice(localCursor, markedEndLocal), segment, markedClass);
        localCursor = markedEndLocal;

        if (segmentStart + localCursor >= activeMark.end) {
          markIndex += 1;
        }
      }

      globalOffset = segmentEnd;
    }

    return html;
  }

  private renderStyledText(segmentText: string, style: StyledTextSegment, markClass?: string): string {
    if (!segmentText) {
      return '';
    }

    const classes: string[] = ['ansi'];
    if (style.fgClass) {
      classes.push(style.fgClass);
    }
    if (style.bold) {
      classes.push('ansi-bold');
    }

    const hasStyle = style.fgClass !== null || style.fgColorHex !== null || style.bold;
    const styleAttribute = style.fgColorHex ? ` style="color:${style.fgColorHex}"` : '';

    const renderPart = (text: string): string => {
      if (!text) {
        return '';
      }

      const escaped = this.escapeHtml(text);

      const styled = hasStyle ? `<span class="${classes.join(' ')}"${styleAttribute}>${escaped}</span>` : escaped;

      return markClass ? `<mark class="${markClass}">${styled}</mark>` : styled;
    };

    return this.renderUrls(segmentText, renderPart);
  }

  private renderUrls(text: string, renderText: (text: string) => string): string {
    this.urlPattern.lastIndex = 0;

    let html = '';
    let lastIndex = 0;
    let match = this.urlPattern.exec(text);

    while (match) {
      const rawUrl = match[0];
      const urlStart = match.index;

      let url = rawUrl.replace(/\\:\/\//, '://');

      // Remove punctuation that is usually not part of the URL.
      const trailingMatch = /[.,;:!?)}\]]+$/.exec(url);
      const trailing = trailingMatch?.[0] ?? '';

      if (trailing) {
        url = url.slice(0, -trailing.length);
      }

      html += renderText(text.slice(lastIndex, urlStart));

      if (url) {
        const escapedUrl = this.escapeHtml(url);

        html += `<a class="log-url" href="${escapedUrl}">${escapedUrl}<span class="mat-icon-filled" aria-hidden="true">open_in_new</span></a>`;
      }

      if (trailing) {
        html += renderText(trailing);
      }

      lastIndex = urlStart + rawUrl.length;
      match = this.urlPattern.exec(text);
    }

    html += renderText(text.slice(lastIndex));

    return html;
  }

  onLogClick(event: MouseEvent): void {
    const target = event.target;

    if (!(target instanceof HTMLElement)) {
      return;
    }

    const link = target.closest<HTMLAnchorElement>('a.log-url');
    if (!link) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const url = link.getAttribute('href');
    if (!url) {
      return;
    }

    this.electronApi.openExternalUrl(url);
  }

  private ansiToStyledSegments(value: string): StyledTextSegment[] {
    const pattern = this.ansiCodePattern;
    let fgClass: string | null = null;
    let fgColorHex: string | null = null;
    let bold = false;
    let lastIndex = 0;
    const segments: StyledTextSegment[] = [];

    const pushText = (text: string): void => {
      if (!text) {
        return;
      }

      segments.push({ text, fgClass, fgColorHex, bold });
    };

    let match = pattern.exec(value);
    while (match) {
      pushText(value.slice(lastIndex, match.index));

      const codes = (match[1] ?? '0')
        .split(';')
        .filter(part => part.length > 0)
        .map(part => Number.parseInt(part, 10))
        .filter(code => Number.isFinite(code));

      const normalizedCodes = codes.length === 0 ? [0] : codes;
      for (let idx = 0; idx < normalizedCodes.length; idx += 1) {
        const code = normalizedCodes[idx] ?? 0;
        if (code === 0) {
          fgClass = null;
          fgColorHex = null;
          bold = false;
          continue;
        }

        if (code === 1) {
          bold = true;
          continue;
        }

        if (code === 22) {
          bold = false;
          continue;
        }

        if (code === 39) {
          fgClass = null;
          fgColorHex = null;
          continue;
        }

        if (code === 38) {
          const mode = normalizedCodes[idx + 1];
          if (mode === 5) {
            const colorIndex = normalizedCodes[idx + 2];
            if (Number.isFinite(colorIndex)) {
              fgClass = null;
              fgColorHex = this.xtermColorToHex(colorIndex);
            }

            idx += 2;
          }

          if (mode === 2) {
            const r = normalizedCodes[idx + 2];
            const g = normalizedCodes[idx + 3];
            const b = normalizedCodes[idx + 4];
            if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
              fgClass = null;
              fgColorHex = this.rgbToHex(r, g, b);
            }

            idx += 4;
          }

          continue;
        }

        if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
          fgClass = `ansi-fg-${code}`;
          fgColorHex = null;
        }
      }

      lastIndex = match.index + match[0].length;
      match = pattern.exec(value);
    }

    pushText(value.slice(lastIndex));
    return segments;
  }

  private normalizeMatchIndex(index: number, total: number): number {
    if (total <= 0) {
      return 0;
    }

    return ((index % total) + total) % total;
  }

  private isWholeWordBoundary(line: string, start: number, end: number): boolean {
    const before = start > 0 ? (line[start - 1] ?? '') : '';
    const after = end < line.length ? (line[end] ?? '') : '';

    const wordChar = /[A-Za-z0-9_]/;
    const leftOk = before === '' || !wordChar.test(before);
    const rightOk = after === '' || !wordChar.test(after);

    return leftOk && rightOk;
  }

  private stripAnsi(value: string): string {
    return value.replace(this.ansiStripPattern, '');
  }

  private stripDockerTimestampPrefix(value: string): string {
    return value.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/, '');
  }

  private ansiToHtml(value: string): string {
    return this.ansiToStyledSegments(value)
      .map(segment => this.renderStyledText(segment.text, segment))
      .join('');
  }

  private rgbToHex(r: number, g: number, b: number): string {
    const clamp = (value: number) => Math.max(0, Math.min(255, Math.trunc(value)));
    const toHex = (value: number) => clamp(value).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  private xtermColorToHex(index: number): string {
    const systemPalette: string[] = [
      '#000000',
      '#800000',
      '#008000',
      '#808000',
      '#000080',
      '#800080',
      '#008080',
      '#c0c0c0',
      '#808080',
      '#ff0000',
      '#00ff00',
      '#ffff00',
      '#0000ff',
      '#ff00ff',
      '#00ffff',
      '#ffffff'
    ];

    if (index >= 0 && index <= 15) {
      return systemPalette[index] ?? '#ffffff';
    }

    if (index >= 16 && index <= 231) {
      const i = index - 16;
      const r = Math.floor(i / 36);
      const g = Math.floor((i % 36) / 6);
      const b = i % 6;
      const levels = [0, 95, 135, 175, 215, 255];
      return this.rgbToHex(levels[r] ?? 0, levels[g] ?? 0, levels[b] ?? 0);
    }

    if (index >= 232 && index <= 255) {
      const level = 8 + (index - 232) * 10;
      return this.rgbToHex(level, level, level);
    }

    return '#ffffff';
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private async bindContainer(containerId: string): Promise<void> {
    if (this.currentContainerId === containerId) {
      return;
    }

    this.currentContainerId = containerId;
    this.resetLogsBootstrapState();
    this.logs.set([]);
    this.currentMatchIndex.set(0);
    this.isSearchNavigationPrimed = false;
    this.clearChannelBuffers();
    this.forceScrollToBottomOnNextBatch = true;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.isLoading.set(true);

    try {
      await this.stopLogsStream();
      await this.startLogsStreamForContainer(containerId);
    } catch {
      this.isLoading.set(false);
      this.scheduleLogsReconnect();
    }
  }

  private onStreamEvent(event: DockerStreamEventEnvelope): void {
    if (event.kind !== 'logs') {
      return;
    }

    this.handleLogsEvent(event);
  }

  private handleLogsEvent(event: DockerStreamEventEnvelope): void {
    const expectedStreamId = this.logsStreamId();
    if (!expectedStreamId || event.streamId !== expectedStreamId) {
      return;
    }

    if (event.type === 'error') {
      this.isLoading.set(false);
      if (this.isContainerUnavailableMessage(event.error)) {
        this.unavailable.emit();
        return;
      }

      this.streamError.emit(event.error ?? 'Log stream error.');
      this.logsStreamId.set(null);
      this.resetLogsBootstrapState();
      this.scheduleLogsReconnect();
      return;
    }

    if (event.type === 'end') {
      this.isLoading.set(false);
      this.flushChannelBuffer('stdout', event.timestamp, this.shouldStickBottom());
      this.flushChannelBuffer('stderr', event.timestamp, this.shouldStickBottom());
      this.flushChannelBuffer('unknown', event.timestamp, this.shouldStickBottom());
      this.logsStreamId.set(null);
      this.scheduleLogsBootstrapSettle();
      this.scheduleLogsReconnect();
      return;
    }

    if (event.type !== 'data') {
      return;
    }

    const text = typeof event.data === 'string' ? event.data : '';
    if (text.length === 0) {
      return;
    }

    this.isLoading.set(false);
    this.scheduleLogsBootstrapSettle();
    const channel = event.channel ?? 'stdout';
    this.appendLogChunk(channel, text, event.timestamp);
  }

  private appendLogChunk(channel: DockerLogChannel, chunk: string, timestamp: string): void {
    const key = channel === 'stderr' ? 'stderr' : 'stdout';
    const combined = `${this.chunkBufferByChannel[key]}${chunk}`;
    const lines = combined.split(/\r?\n/);
    this.chunkBufferByChannel[key] = lines.pop() ?? '';

    const shouldStickBottom = this.shouldStickBottom();
    const entries: ContainerLogEntry[] = lines.map(line => ({
      raw: line,
      channel,
      timestamp
    }));

    if (entries.length > 0) {
      this.appendLogEntries(entries, shouldStickBottom);
    }
  }

  private flushChannelBuffer(
    key: 'stdout' | 'stderr' | 'unknown',
    timestamp: string,
    shouldStickBottom: boolean
  ): void {
    const pending = this.chunkBufferByChannel[key];
    if (!pending) {
      return;
    }

    this.chunkBufferByChannel[key] = '';
    const channel: DockerLogChannel = key === 'stderr' ? 'stderr' : 'stdout';
    this.appendLogEntries([{ raw: pending, channel, timestamp }], shouldStickBottom);
  }

  private shouldStickBottom(): boolean {
    return this.forceScrollToBottomOnNextBatch || this.isBootstrappingLogs || this.isPanelNearBottom();
  }

  private appendLogEntries(entries: ContainerLogEntry[], shouldStickBottom: boolean): void {
    this.logs.update(current => {
      const merged = [...current, ...entries];
      const maxLines = Math.max(this.logTailLines(), 1);
      return merged.slice(Math.max(merged.length - maxLines, 0));
    });

    if (shouldStickBottom) {
      this.requestScrollToBottom();
    }
  }

  private requestScrollToBottom(): void {
    const element = this.getScrollAreaElement();
    if (!element) {
      this.forceScrollToBottomOnNextBatch = true;
      return;
    }

    this.forceScrollToBottomOnNextBatch = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        element.scrollTop = element.scrollHeight;
        this.isNearBottom.set(true);
      });
    });
  }

  private clearChannelBuffers(): void {
    this.chunkBufferByChannel['stdout'] = '';
    this.chunkBufferByChannel['stderr'] = '';
    this.chunkBufferByChannel['unknown'] = '';
  }

  private scheduleLogsReconnect(): void {
    if (this.isDisposed) {
      return;
    }

    if (this.logsStreamId()) {
      return;
    }

    // if(this.reconnectAttempts >= LogsTabComponent.MAX_RECONNECT_ATTEMPTS) {
    //   this.streamError.emit('Log stream lost after multiple attempts. Please refresh the page or restart the container.');
    //   return;
    // }

    this.reconnectAttempts += 1;
    this.clearReconnectTimer();
    this.reconnectLogsTimer = setTimeout(() => {
      void this.tryReconnectLogsStream();
    }, 1200);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectLogsTimer) {
      clearTimeout(this.reconnectLogsTimer);
      this.reconnectLogsTimer = null;
    }
  }

  private beginLogsBootstrap(): void {
    this.isBootstrappingLogs = true;
    this.forceScrollToBottomOnNextBatch = true;
    this.scheduleLogsBootstrapSettle();
  }

  private scheduleLogsBootstrapSettle(): void {
    if (this.isDisposed) {
      return;
    }
    this.clearLogsBootstrapTimer();
    this.logsBootstrapTimer = setTimeout(() => {
      this.isBootstrappingLogs = false;
      this.logsBootstrapTimer = null;
      this.isLoading.set(false);
      this.onPanelScroll();
    }, LogsTabComponent.LOGS_BOOTSTRAP_SETTLE_MS);
  }

  private clearLogsBootstrapTimer(): void {
    if (!this.logsBootstrapTimer) {
      return;
    }

    clearTimeout(this.logsBootstrapTimer);
    this.logsBootstrapTimer = null;
  }

  private resetLogsBootstrapState(): void {
    this.clearLogsBootstrapTimer();
    this.isBootstrappingLogs = false;
  }

  private async startLogsStreamForContainer(containerId: string): Promise<void> {
    if (this.logsStreamId()) {
      return;
    }

    this.beginLogsBootstrap();
    const since = this.getClearedSince(containerId);
    const logs = await this.dockerApi.startLogsStream(containerId, since, this.logTailLines());
    this.logsStreamId.set(logs.streamId);
    this.reconnectAttempts = 0;
  }

  private async stopLogsStream(): Promise<void> {
    const logsStreamId = this.logsStreamId();
    this.logsStreamId.set(null);
    this.resetLogsBootstrapState();

    if (logsStreamId) {
      await this.dockerApi.stopStream(logsStreamId);
    }
  }

  private async restartLogsStream(containerId: string, since?: number): Promise<void> {
    try {
      const currentStream = this.logsStreamId();
      if (currentStream) {
        await this.dockerApi.stopStream(currentStream);
      }

      this.logsStreamId.set(null);
      this.beginLogsBootstrap();

      const logs = await this.dockerApi.startLogsStream(containerId, since, this.logTailLines());
      this.logsStreamId.set(logs.streamId);
      this.clearChannelBuffers();
      this.reconnectAttempts = 0;
    } catch {
      this.scheduleLogsReconnect();
    }
  }

  private async tryReconnectLogsStream(): Promise<void> {
    if (this.isDisposed || this.logsStreamId()) {
      return;
    }

    const id = this.currentContainerId;
    if (!id) {
      return;
    }

    try {
      const containers = await this.dockerApi.listContainers();
      const current = containers.find(item => item.Id === id);

      if (!current) {
        this.unavailable.emit();
        return;
      }

      if (current.State !== 'running') {
        this.scheduleLogsReconnect();
        return;
      }

      const since = this.getClearedSince(id);
      const logs = await this.dockerApi.startLogsStream(id, since, this.logTailLines());
      this.logsStreamId.set(logs.streamId);
      this.clearChannelBuffers();
      this.reconnectAttempts = 0;
    } catch {
      this.scheduleLogsReconnect();
    }
  }

  private isContainerUnavailableMessage(message: string | null | undefined): boolean {
    if (!message) {
      return false;
    }

    return /no such container|container not found|not found|removed/i.test(message);
  }

  private getClearedSince(containerId: string): number | undefined {
    const key = `${LOGS_STORAGE_KEYS.CLEARED_SINCE_PREFIX}${containerId}`;
    const raw = this.localStorage.getNumber(key);
    if (!raw) {
      return undefined;
    }
    const parsed = Number.parseInt(String(raw), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private scheduleCopyButtonReset(): void {
    if (this.copyResetTimer) {
      clearTimeout(this.copyResetTimer);
    }

    this.copyResetTimer = setTimeout(() => {
      this.copyButtonLabel.set('Copy');
    }, 1200);
  }

  private scheduleClearButtonReset(): void {
    if (this.clearResetTimer) {
      clearTimeout(this.clearResetTimer);
    }

    this.clearResetTimer = setTimeout(() => {
      this.clearButtonLabel.set('Clear Logs');
    }, 1200);
  }

  private clearActionTimers(): void {
    if (this.copyResetTimer) {
      clearTimeout(this.copyResetTimer);
      this.copyResetTimer = null;
    }

    if (this.clearResetTimer) {
      clearTimeout(this.clearResetTimer);
      this.clearResetTimer = null;
    }
  }
}
