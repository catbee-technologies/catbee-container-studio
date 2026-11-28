import { Transform, type TransformCallback } from 'node:stream';
import { logger as appLogger } from '../../logger';

const logger = appLogger.child({}, { msgPrefix: '[WindowsPathRewriter] ' });

/**
 * Translates Windows host paths (C:\Users\me\app) in Docker API requests into the WSL 2 mount
 * namespace (/mnt/c/Users/me/app) so bind mounts from Windows clients work against the Linux dockerd.
 */

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_CHUNK_LINE_BYTES = 4 * 1024;
const MAX_CAPTURED_BODY_BYTES = 16 * 1024 * 1024;
const MAX_METHOD_LENGTH = 16;
const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');

const API_PREFIX = String.raw`(?:/v\d+(?:\.\d+)?)?`;
const CONTAINER_CREATE = new RegExp(`^${API_PREFIX}/containers/create$`);
const VOLUME_CREATE = new RegExp(`^${API_PREFIX}/volumes/create$`);
const CONTAINER_ATTACH = new RegExp(`^${API_PREFIX}/containers/[^/]+/attach$`);
const EXEC_START = new RegExp(`^${API_PREFIX}/exec/[^/]+/start$`);

/** `<windows source>:<absolute container path>[:options]`; the leading `/` keeps `c:/data:ro` (named volume "c") intact. */
const WINDOWS_BIND = /^((?:\\\\\?\\)?[A-Za-z]:[\\/][^:]*):(\/.*)$/;

/** `C:\Users\me` -> `/mnt/c/Users/me`; returns null for anything that is not a drive-letter path. */
export function windowsToWslPath(value: string): string | null {
  const clean = value.startsWith('\\\\?\\') ? value.slice(4) : value;
  if (clean.length < 2 || clean[1] !== ':' || !/^[A-Za-z]$/.test(clean[0])) {
    return null;
  }
  const drive = clean[0].toLowerCase();
  const rest = clean
    .slice(2)
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/');
  const restSuffix = rest ? `/${rest}` : '';
  return `/mnt/${drive}${restSuffix}`;
}

/** Rewrites the host part of a `HostConfig.Binds` entry when it is a Windows path. */
export function translateBind(bind: string): string {
  const match = WINDOWS_BIND.exec(bind);
  if (!match) return bind;
  const source = windowsToWslPath(match[1]);
  return source ? `${source}:${match[2]}` : bind;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns true when any bind source in a `POST /containers/create` body was rewritten. */
export function translateContainerCreateBody(body: JsonObject): boolean {
  const hostConfig = body.HostConfig;
  if (!isObject(hostConfig)) return false;
  let changed = false;

  if (Array.isArray(hostConfig.Binds)) {
    hostConfig.Binds = hostConfig.Binds.map(bind => {
      if (typeof bind !== 'string') return bind;
      const translated = translateBind(bind);
      changed ||= translated !== bind;
      return translated;
    });
  }

  if (Array.isArray(hostConfig.Mounts)) {
    for (const mount of hostConfig.Mounts) {
      if (!isObject(mount) || mount.Type !== 'bind' || typeof mount.Source !== 'string') continue;
      const translated = windowsToWslPath(mount.Source);
      if (translated) {
        mount.Source = translated;
        changed = true;
      }
    }
  }
  return changed;
}

/** Returns true when a bind-style local volume (`-o o=bind -o device=C:\...`) was rewritten. */
export function translateVolumeCreateBody(body: JsonObject): boolean {
  const opts = body.DriverOpts;
  if (!isObject(opts) || typeof opts.device !== 'string' || typeof opts.o !== 'string') return false;
  if (!opts.o.split(',').some(option => option.trim() === 'bind')) return false;
  const translated = windowsToWslPath(opts.device);
  if (!translated) return false;
  opts.device = translated;
  return true;
}

interface RequestHead {
  method: string;
  path: string;
  requestLine: string;
  headerLines: string[];
  headers: Map<string, string>;
}

interface CaptureResult {
  /** Replacement body, or null to forward the original bytes untouched. */
  body: Buffer | null;
  /** Whether the connection is hijacked once this request has been sent. */
  rawAfter: boolean;
}

interface Capture {
  head: RequestHead;
  headBytes: Buffer;
  raw: Buffer[];
  decoded: Buffer[];
  rawBytes: number;
  handle: (body: Buffer) => CaptureResult;
}

type Mode = 'headers' | 'length-body' | 'chunked-body' | 'raw';
type ChunkState = 'size' | 'data' | 'data-crlf' | 'trailer';

function parseHead(text: string): RequestHead | null {
  const lines = text.split('\r\n');
  const requestLine = lines[0];
  const match = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(requestLine);
  if (!match) return null;
  const headerLines: string[] = [];
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
    headerLines.push(line);
  }
  return { method: match[1], path: match[2].split('?')[0], requestLine, headerLines, headers };
}

function rebuildHead(head: RequestHead, contentLength: number): Buffer {
  const lines = head.headerLines.filter(line => !/^(content-length|transfer-encoding)\s*:/i.test(line));
  const clHeader = `Content-Length: ${contentLength}`;
  const fullText = [head.requestLine, ...lines, clHeader].join('\r\n') + '\r\n\r\n';
  return Buffer.from(fullText, 'latin1');
}

function jsonRewrite(rewrite: (body: JsonObject) => boolean, label: string): (body: Buffer) => CaptureResult {
  return body => {
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      if (isObject(parsed) && rewrite(parsed)) {
        logger.debug(`Translated Windows host paths in ${label}.`);
        return { body: Buffer.from(JSON.stringify(parsed), 'utf8'), rawAfter: false };
      }
    } catch {
      // Not JSON we understand; forward it untouched and let dockerd report any error.
    }
    return { body: null, rawAfter: false };
  };
}

function execStartHijacks(body: Buffer): CaptureResult {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return { body: null, rawAfter: !(isObject(parsed) && parsed.Detach === true) };
  } catch {
    return { body: null, rawAfter: true };
  }
}

/**
 * Streaming, fail-safe HTTP/1.1 request rewriter for the client -> dockerd direction of the relay.
 * Only `containers/create` and `volumes/create` bodies are buffered and rewritten; everything else is
 * forwarded as it arrives. Once a connection is hijacked (attach, interactive exec, BuildKit session,
 * any `Upgrade`) or anything unparseable is seen, the rest of the connection is passed through raw.
 */
export class DockerRequestRewriter extends Transform {
  private buffer: Buffer = Buffer.alloc(0);
  private mode: Mode = 'headers';
  private remaining = 0;
  private chunkState: ChunkState = 'size';
  private capture: Capture | null = null;
  private rawAfterRequest = false;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    try {
      this.process();
    } catch (err) {
      logger.debug({ err }, 'Unexpected parser error; switching to passthrough.');
      this.switchToRaw();
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.releaseCapture();
    if (this.buffer.length) this.push(this.buffer);
    this.buffer = Buffer.alloc(0);
    callback();
  }

  private process(): void {
    for (;;) {
      switch (this.mode) {
        case 'raw':
          if (this.buffer.length) this.push(this.buffer);
          this.buffer = Buffer.alloc(0);
          return;
        case 'headers':
          if (!this.readHead()) return;
          break;
        case 'length-body':
          if (!this.readLengthBody()) return;
          break;
        case 'chunked-body':
          if (!this.readChunkedBody()) return;
          break;
      }
    }
  }

  private readHead(): boolean {
    if (!this.buffer.length) return false;
    if (!this.looksLikeRequest()) {
      this.switchToRaw();
      return true;
    }
    const end = this.buffer.indexOf(HEADER_END);
    if (end < 0) {
      if (this.buffer.length > MAX_HEADER_BYTES) this.switchToRaw();
      return this.mode === 'raw';
    }
    const headBytes = this.buffer.subarray(0, end + HEADER_END.length);
    const head = parseHead(headBytes.toString('latin1'));
    if (!head) {
      this.switchToRaw();
      return true;
    }
    this.buffer = this.buffer.subarray(headBytes.length);
    this.beginRequest(head, headBytes);
    return true;
  }

  private resolveCaptureHandle(head: RequestHead, contentLength: number, chunked: boolean): Capture['handle'] | null {
    const isPost = head.method === 'POST';
    const capturable = !head.headers.has('expect') && (chunked || contentLength <= MAX_CAPTURED_BODY_BYTES);
    if (!capturable || !isPost) {
      return null;
    }
    if (CONTAINER_CREATE.test(head.path)) {
      return jsonRewrite(translateContainerCreateBody, 'container create');
    }
    if (VOLUME_CREATE.test(head.path)) {
      return jsonRewrite(translateVolumeCreateBody, 'volume create');
    }
    const upgrade = head.headers.has('upgrade') || /\bupgrade\b/i.test(head.headers.get('connection') ?? '');
    if (EXEC_START.test(head.path) && !upgrade && !chunked) {
      return execStartHijacks;
    }
    return null;
  }

  private beginRequest(head: RequestHead, headBytes: Buffer): void {
    const transferEncoding = head.headers.get('transfer-encoding')?.toLowerCase() ?? '';
    const contentLengthHeader = head.headers.get('content-length');
    const chunked = transferEncoding.includes('chunked');
    const contentLength = contentLengthHeader === undefined ? 0 : Number(contentLengthHeader);
    if (!chunked && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
      this.push(headBytes);
      this.switchToRaw();
      return;
    }

    const upgrade = head.headers.has('upgrade') || /\bupgrade\b/i.test(head.headers.get('connection') ?? '');
    const isPost = head.method === 'POST';
    const isExecStart = isPost && EXEC_START.test(head.path);
    const handle = this.resolveCaptureHandle(head, contentLength, chunked);

    // Hijacked streams carry raw stdin right after the head, so they must never wait on body framing.
    if (upgrade || (isPost && CONTAINER_ATTACH.test(head.path)) || (isExecStart && !handle)) {
      this.push(headBytes);
      this.switchToRaw();
      return;
    }

    this.rawAfterRequest = false;
    if (handle) {
      this.capture = { head, headBytes, raw: [], decoded: [], rawBytes: 0, handle };
    } else {
      this.push(headBytes);
    }

    if (chunked) {
      this.mode = 'chunked-body';
      this.chunkState = 'size';
    } else {
      this.mode = 'length-body';
      this.remaining = contentLength;
    }
  }

  private readLengthBody(): boolean {
    if (this.remaining === 0) {
      this.finishRequest();
      return true;
    }
    if (!this.buffer.length) return false;
    const take = Math.min(this.remaining, this.buffer.length);
    const piece = this.buffer.subarray(0, take);
    this.buffer = this.buffer.subarray(take);
    this.remaining -= take;
    this.emitBody(piece, piece);
    return true;
  }

  private handleChunkSize(): boolean {
    const line = this.takeLine();
    if (!line) return this.mode === 'raw';
    const sizeText = line
      .toString('latin1', 0, line.length - CRLF.length)
      .split(';')[0]
      .trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) {
      this.failToRaw(line);
      return true;
    }
    this.emitBody(line, null);
    this.remaining = Number.parseInt(sizeText, 16);
    this.chunkState = this.remaining === 0 ? 'trailer' : 'data';
    return true;
  }

  private handleChunkData(): boolean {
    if (!this.buffer.length) return false;
    const take = Math.min(this.remaining, this.buffer.length);
    const piece = this.buffer.subarray(0, take);
    this.buffer = this.buffer.subarray(take);
    this.remaining -= take;
    this.emitBody(piece, piece);
    if (this.remaining === 0) this.chunkState = 'data-crlf';
    return true;
  }

  private handleChunkDataCrlf(): boolean {
    if (this.buffer.length < CRLF.length) return false;
    if (!this.buffer.subarray(0, CRLF.length).equals(CRLF)) {
      this.failToRaw(Buffer.alloc(0));
      return true;
    }
    this.emitBody(this.buffer.subarray(0, CRLF.length), null);
    this.buffer = this.buffer.subarray(CRLF.length);
    this.chunkState = 'size';
    return true;
  }

  private handleChunkTrailer(): boolean {
    const line = this.takeLine();
    if (!line) return this.mode === 'raw';
    this.emitBody(line, null);
    if (line.length === CRLF.length) this.finishRequest();
    return true;
  }

  private readChunkedBody(): boolean {
    switch (this.chunkState) {
      case 'size':
        return this.handleChunkSize();
      case 'data':
        return this.handleChunkData();
      case 'data-crlf':
        return this.handleChunkDataCrlf();
      case 'trailer':
        return this.handleChunkTrailer();
    }
  }

  /** Removes and returns the next CRLF-terminated line, or null when more data is needed. */
  private takeLine(): Buffer | null {
    const index = this.buffer.indexOf(CRLF);
    if (index < 0) {
      if (this.buffer.length > MAX_CHUNK_LINE_BYTES) this.failToRaw(Buffer.alloc(0));
      return null;
    }
    const line = this.buffer.subarray(0, index + CRLF.length);
    this.buffer = this.buffer.subarray(line.length);
    return line;
  }

  private emitBody(raw: Buffer, decoded: Buffer | null): void {
    const capture = this.capture;
    if (!capture) {
      this.push(raw);
      return;
    }
    capture.raw.push(raw);
    capture.rawBytes += raw.length;
    if (decoded) capture.decoded.push(decoded);
    if (capture.rawBytes > MAX_CAPTURED_BODY_BYTES) {
      this.releaseCapture();
    }
  }

  private finishRequest(): void {
    const capture = this.capture;
    this.capture = null;
    if (capture) {
      const result = capture.handle(Buffer.concat(capture.decoded));
      if (result.body) {
        this.push(rebuildHead(capture.head, result.body.length));
        this.push(result.body);
      } else {
        this.push(capture.headBytes);
        for (const part of capture.raw) this.push(part);
      }
      this.rawAfterRequest = result.rawAfter;
    }
    this.mode = this.rawAfterRequest ? 'raw' : 'headers';
    this.rawAfterRequest = false;
  }

  /** Forwards a captured request untouched (too large, malformed, or connection ending). */
  private releaseCapture(): void {
    const capture = this.capture;
    this.capture = null;
    if (!capture) return;
    this.push(capture.headBytes);
    for (const part of capture.raw) this.push(part);
  }

  private failToRaw(consumed: Buffer): void {
    this.releaseCapture();
    if (consumed.length) this.push(consumed);
    this.switchToRaw();
  }

  private switchToRaw(): void {
    this.releaseCapture();
    this.mode = 'raw';
  }

  /** Cheap check that the buffered bytes can still be the start of an HTTP request line. */
  private looksLikeRequest(): boolean {
    const limit = Math.min(this.buffer.length, MAX_METHOD_LENGTH + 1);
    for (let i = 0; i < limit; i++) {
      const byte = this.buffer[i];
      if (byte === 0x20) return i > 0;
      if (byte < 0x41 || byte > 0x5a) return false;
    }
    return this.buffer.length <= MAX_METHOD_LENGTH;
  }
}
