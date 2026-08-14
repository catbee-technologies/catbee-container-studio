import { CommonModule } from '@angular/common';
import {
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
import { SearchInputComponent } from '@components/search-input/search-input';
import { DockerStreamEventEnvelope } from '@shared/types/docker-api.types';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal } from '@xterm/xterm';

@Component({
  selector: 'catbee-container-studio-container-shell-tab',
  imports: [CommonModule, SearchInputComponent],
  templateUrl: './shell-tab.html',
  styleUrl: './shell-tab.scss'
})
export class ShellTabComponent {
  private readonly dockerApi = inject(DockerApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly shellTerminalHost = viewChild<ElementRef<HTMLElement>>('shellTerminalHost');
  private readonly shellFindInput = viewChild<SearchInputComponent>('shellFindInput');

  readonly containerId = input.required<string>();
  readonly active = input.required<boolean>();

  readonly unavailable = output<void>();
  readonly shellError = output<string>();

  readonly shellConnected = signal(false);
  readonly shellConnecting = signal(false);
  readonly shellStatus = signal('Disconnected');
  readonly findTerm = signal('');
  readonly hasFindResults = signal(false);
  readonly currentMatchIndex = signal(0);
  readonly findMatchCount = signal(0);
  readonly findMatchSummary = computed(() => {
    const total = this.findMatchCount();
    if (total === 0) {
      return '0/0';
    }
    return `${this.currentMatchIndex() + 1}/${total}`;
  });

  private static readonly SHELL_CANDIDATES = ['bash', 'sh', 'ash', 'zsh'];
  private static readonly SHELL_NOT_FOUND_RE =
    /executable file not found|no such file or directory|exec: "[^"]+": stat/i;
  private static readonly CONTAINER_STOPPED_OR_PAUSED_RE = /container (?:stopped\/paused|stopped|paused)/i;

  private readonly shellSessionId = signal<string | null>(null);
  private sessionContainerId: string | null = null;
  private isSessionReady = false;
  private shellCandidateIndex = 0;
  private shellTerminal: Terminal | null = null;
  private shellFitAddon: FitAddon | null = null;
  private shellSearchAddon: SearchAddon | null = null;
  private shellResizeObserver: ResizeObserver | null = null;
  private shellPromptRefreshPending = false;

  constructor() {
    const streamUnsubscribe = this.dockerApi.onStreamEvent(event => this.onStreamEvent(event));
    this.destroyRef.onDestroy(() => {
      streamUnsubscribe();
      void this.stopShellSession();
      this.disposeShellTerminal();
    });

    effect(() => {
      const containerId = this.containerId();
      if (!this.active()) {
        return;
      }

      queueMicrotask(() => {
        if (this.sessionContainerId && this.sessionContainerId !== containerId) {
          void this.reconnectShellSession();
          return;
        }

        this.initializeShellTerminal();
        this.fitShellTerminal();
        void this.ensureShellSession();
      });
    });
  }

  async reconnectShellSession(): Promise<void> {
    await this.stopShellSession();

    if (this.shellTerminal) {
      this.shellTerminal.clear();
      this.shellTerminal.writeln('[reconnecting shell...]');
    }

    await this.ensureShellSession();
  }

  async teardown(): Promise<void> {
    await this.stopShellSession();
    this.disposeShellTerminal();
  }

  openFindPanel(): void {
    queueMicrotask(() => {
      this.shellFindInput()?.focusAndSelect();
    });

    if (this.findTerm().trim()) {
      this.findNext();
    }
  }

  updateFindTerm(value: string): void {
    this.findTerm.set(value);
    this.currentMatchIndex.set(0);

    const term = value.trim();

    if (!term) {
      this.findMatchCount.set(0);
      this.hasFindResults.set(false);
      return;
    }

    this.resetShellSearchAddon();

    this.refreshFindResults();

    if (this.hasFindResults()) {
      this.shellSearchAddon?.findNext(term, {
        caseSensitive: false,
        incremental: false,
        regex: false
      });
    }
  }

  onFindKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.shellTerminal?.focus();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        this.findPrevious();
      } else {
        this.findNext();
      }
    }
  }

  findPrevious(): void {
    const term = this.findTerm().trim();

    if (!term || !this.shellSearchAddon) {
      this.hasFindResults.set(false);
      return;
    }

    this.refreshFindResults();

    const total = this.findMatchCount();

    if (total === 0) {
      return;
    }

    const found = this.shellSearchAddon.findPrevious(term, {
      caseSensitive: false,
      incremental: false,
      regex: false
    });

    if (!found) {
      this.hasFindResults.set(false);
      return;
    }

    this.currentMatchIndex.update(index => (index <= 0 ? total - 1 : index - 1));
  }

  findNext(): void {
    const term = this.findTerm().trim();

    if (!term || !this.shellSearchAddon) {
      this.hasFindResults.set(false);
      return;
    }

    this.refreshFindResults();

    const total = this.findMatchCount();

    if (total === 0) {
      return;
    }

    const found = this.shellSearchAddon.findNext(term, {
      caseSensitive: false,
      incremental: false,
      regex: false
    });

    if (!found) {
      this.hasFindResults.set(false);
      return;
    }

    this.currentMatchIndex.update(index => (index + 1 >= total ? 0 : index + 1));
  }

  getTerminalHostElement(): HTMLElement | null {
    return this.shellTerminalHost()?.nativeElement ?? null;
  }

  private onStreamEvent(event: DockerStreamEventEnvelope): void {
    if (event.kind !== 'exec') {
      return;
    }

    const sessionId = this.shellSessionId();
    if (!sessionId || event.streamId !== sessionId) {
      return;
    }

    if (event.type === 'error') {
      this.isSessionReady = false;
      const message = event.error ?? 'Shell stream failed.';

      if (ShellTabComponent.SHELL_NOT_FOUND_RE.test(message)) {
        this.shellCandidateIndex += 1;
        this.shellSessionId.set(null);
        this.shellConnected.set(false);
        this.shellConnecting.set(false);
        if (this.sessionContainerId) {
          queueMicrotask(() => void this.ensureShellSession());
        }
        return;
      }

      this.shellTerminal?.writeln(`\r\n[error] ${message}`);
      this.shellConnected.set(false);
      this.shellConnecting.set(false);
      this.shellStatus.set('Disconnected');
      this.shellSessionId.set(null);
      if (ShellTabComponent.CONTAINER_STOPPED_OR_PAUSED_RE.test(message)) {
        // Just ignore container stopped/paused errors, the user can reconnect when the container is running again
        return;
      }
      this.shellError.emit(message);
      return;
    }

    if (event.type === 'end') {
      this.isSessionReady = false;
      this.shellConnected.set(false);
      this.shellConnecting.set(false);
      this.shellStatus.set('Disconnected');
      this.shellSessionId.set(null);
      return;
    }

    if (event.type !== 'data') {
      return;
    }

    const text = typeof event.data === 'string' ? event.data : '';

    // If first data is a shell-not-found error, try the next candidate silently
    if (!this.isSessionReady && ShellTabComponent.SHELL_NOT_FOUND_RE.test(text)) {
      this.shellCandidateIndex += 1;
      this.shellSessionId.set(null);
      this.shellConnected.set(false);
      this.shellConnecting.set(false);
      if (this.sessionContainerId) {
        queueMicrotask(() => void this.ensureShellSession());
      }
      return;
    }

    // Mark as ready on first non-error data event
    if (!this.isSessionReady) {
      this.isSessionReady = true;
    }

    if (text.length > 0) {
      this.shellTerminal?.write(text);

      if (this.findTerm().trim()) {
        queueMicrotask(() => this.refreshFindResults());
      }
    }
  }

  private initializeShellTerminal(): void {
    const host = this.shellTerminalHost()?.nativeElement;
    if (!host) {
      return;
    }

    if (this.shellTerminal) {
      const isAlreadyAttached = host.querySelector('.xterm') !== null;
      if (isAlreadyAttached) {
        this.fitShellTerminal();
        return;
      }

      this.shellPromptRefreshPending = true;
      this.disposeShellTerminal();
    }

    this.shellFitAddon = new FitAddon();
    this.shellSearchAddon = new SearchAddon();
    this.shellTerminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      theme: {
        background: '#050d17',
        foreground: '#cce9ff',
        cursor: '#98f8dc'
      }
    });

    this.shellTerminal.loadAddon(this.shellFitAddon);
    this.shellTerminal.loadAddon(this.shellSearchAddon);
    this.shellTerminal.open(host);
    this.fitShellTerminal();

    this.shellTerminal.onData(data => {
      const sessionId = this.shellSessionId();
      if (!sessionId) {
        return;
      }

      void this.dockerApi.writeExecSession(sessionId, data);
    });

    this.shellTerminal.onResize(size => {
      const sessionId = this.shellSessionId();
      if (!sessionId || !this.isSessionReady) {
        return;
      }

      void this.dockerApi.resizeExecSession(sessionId, size.cols, size.rows);
    });

    this.shellResizeObserver?.disconnect();
    this.shellResizeObserver = new ResizeObserver(() => {
      this.fitShellTerminal();
    });
    this.shellResizeObserver.observe(host);
  }

  private disposeShellTerminal(): void {
    this.shellResizeObserver?.disconnect();
    this.shellResizeObserver = null;

    this.shellTerminal?.dispose();
    this.shellTerminal = null;
    this.shellFitAddon = null;
    this.shellSearchAddon = null;
  }

  private resetShellSearchAddon(): void {
    if (!this.shellTerminal) {
      return;
    }

    this.shellSearchAddon?.dispose();

    this.shellSearchAddon = new SearchAddon();
    this.shellTerminal.loadAddon(this.shellSearchAddon);
  }

  private fitShellTerminal(): void {
    if (!this.shellTerminal || !this.shellFitAddon) {
      return;
    }

    this.shellFitAddon.fit();
  }

  private countSearchMatches(term: string): number {
    if (!this.shellTerminal || !term) {
      return 0;
    }
    const buffer = this.shellTerminal.buffer.active;
    const needle = term.toLowerCase();
    let count = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index)?.translateToString(true) ?? '';
      const source = line.toLowerCase();
      let offset = 0;
      while (true) {
        const found = source.indexOf(needle, offset);
        if (found === -1) {
          break;
        }
        count++;
        offset = found + Math.max(needle.length, 1);
      }
    }
    return count;
  }

  private async ensureShellSession(): Promise<void> {
    if (!this.active() || this.shellConnecting()) {
      return;
    }

    if (this.shellSessionId()) {
      const existingSessionId = this.shellSessionId();
      this.fitShellTerminal();
      this.shellTerminal?.focus();

      if (existingSessionId && this.shellPromptRefreshPending) {
        this.shellPromptRefreshPending = false;
        await this.dockerApi.writeExecSession(existingSessionId, '\r');
      }

      return;
    }

    const containerId = this.containerId();
    if (!containerId) {
      return;
    }

    // Reset shell index when switching containers
    if (this.sessionContainerId !== containerId) {
      this.shellCandidateIndex = 0;
    }

    // All shell candidates exhausted
    if (this.shellCandidateIndex >= ShellTabComponent.SHELL_CANDIDATES.length) {
      this.initializeShellTerminal();
      this.shellTerminal?.writeln('\r\n[no shell found in container (tried bash, sh, ash, zsh)]');
      this.shellStatus.set('Unavailable');
      return;
    }

    this.initializeShellTerminal();
    this.fitShellTerminal();
    if (!this.shellTerminal) {
      return;
    }

    this.shellConnecting.set(true);
    this.shellStatus.set('Connecting...');

    try {
      const shell =
        ShellTabComponent.SHELL_CANDIDATES[this.shellCandidateIndex] ?? ShellTabComponent.SHELL_CANDIDATES[0]!;
      const session = await this.dockerApi.createExecSession(containerId, [shell, '-i'], true);
      this.shellSessionId.set(session.sessionId);
      this.sessionContainerId = containerId;
      this.shellConnected.set(true);
      this.shellStatus.set('Connected');
      this.shellTerminal.focus();

      const cols = Math.max(this.shellTerminal.cols, 20);
      const rows = Math.max(this.shellTerminal.rows, 8);
      try {
        await this.dockerApi.resizeExecSession(session.sessionId, cols, rows);
      } catch {
        // Initial resize may fail if process not fully started yet, that's ok
      }
    } catch (error) {
      this.shellConnected.set(false);
      this.shellStatus.set('Disconnected');
      const message = error instanceof Error ? error.message : 'Shell connect failed.';
      this.shellTerminal.writeln(`\r\n[error] ${message}`);

      if (this.isContainerUnavailableError(error)) {
        this.unavailable.emit();
      } else {
        if (ShellTabComponent.CONTAINER_STOPPED_OR_PAUSED_RE.test(message)) {
          // Just ignore container stopped/paused errors, the user can reconnect when the container is running again
          return;
        }
        this.shellError.emit(message);
      }
    } finally {
      this.shellConnecting.set(false);
    }
  }

  private refreshFindResults(): void {
    const term = this.findTerm().trim();

    if (!term) {
      this.findMatchCount.set(0);
      this.currentMatchIndex.set(0);
      this.hasFindResults.set(false);
      return;
    }

    const count = this.countSearchMatches(term);

    this.findMatchCount.set(count);

    if (count === 0) {
      this.currentMatchIndex.set(0);
      this.hasFindResults.set(false);
      return;
    }

    this.currentMatchIndex.update(index => Math.min(index, count - 1));

    this.hasFindResults.set(true);
  }

  private async stopShellSession(): Promise<void> {
    const sessionId = this.shellSessionId();
    this.shellSessionId.set(null);
    this.sessionContainerId = null;
    this.isSessionReady = false;
    this.shellConnected.set(false);
    this.shellConnecting.set(false);
    this.shellStatus.set('Disconnected');

    if (!sessionId) {
      return;
    }

    try {
      await this.dockerApi.closeExecSession(sessionId);
    } catch {
      // Ignore close errors when session is already gone.
    }
  }

  private isContainerUnavailableError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return /no such container|container not found|not found|removed/i.test(error.message);
  }
}
