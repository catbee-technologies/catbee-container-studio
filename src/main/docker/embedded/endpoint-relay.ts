import net from 'node:net';
import { rm } from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import { logger } from '../../logger';
import type { DockerConnection } from '../types/connection.types';
import { connectionToUri, toNodeSocketPath } from './engine-utils';

const PEER_CLOSE_GRACE_MS = 10_000;

/** Where the relay listens: a named pipe / unix socket path, or a loopback TCP port. */
export type RelayListenAddress = { type: 'npipe' | 'unix'; path: string } | { type: 'tcp'; host: string; port: number };

export interface EndpointRelayOptions {
  /** Optional per-connection transform applied to client -> target bytes (e.g. Windows path translation). */
  createRequestTransform?: () => Duplex;
}

/**
 * Relay that exposes a Docker endpoint at another address
 * (e.g. \\.\pipe\catbee-desktop -> WSL dockerd, or tcp://127.0.0.1:2375 -> engine socket).
 */
export class EndpointRelay {
  private server: net.Server | null = null;
  private key: string | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(
    private readonly name: string,
    private readonly options: EndpointRelayOptions = {}
  ) {}

  get isRunning(): boolean {
    return this.server !== null;
  }

  async start(listen: RelayListenAddress, target: DockerConnection): Promise<boolean> {
    const key = `${describe(listen)}->${connectionToUri(target)}`;
    if (this.server && this.key === key) {
      return true;
    }
    await this.stop();

    if (listen.type === 'unix') {
      // A stale socket file from a previous crash would make listen() fail with EADDRINUSE.
      await rm(listen.path, { force: true }).catch(() => undefined);
    }

    return await new Promise<boolean>(resolve => {
      // Half-open sockets: Docker clients close their write side after sending stdin on hijacked
      // attach/exec streams and still expect the daemon's remaining output.
      const server = net.createServer({ allowHalfOpen: true }, client => this.handleClient(client, target));

      server.once('error', err => {
        logger.warn({ err }, `[EndpointRelay:${this.name}] Failed to listen on ${describe(listen)}.`);
        resolve(false);
      });

      const onListening = (): void => {
        logger.debug(`[EndpointRelay:${this.name}] Relaying ${key}`);
        server.on('error', err => logger.warn({ err }, `[EndpointRelay:${this.name}] Server error.`));
        this.server = server;
        this.key = key;
        resolve(true);
      };

      if (listen.type === 'tcp') {
        server.listen(listen.port, listen.host, onListening);
      } else {
        server.listen(listen.type === 'npipe' ? listen.path.replaceAll('/', '\\') : listen.path, onListening);
      }
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    const server = this.server;
    this.server = null;
    this.key = null;
    if (server) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  private handleClient(client: net.Socket, target: DockerConnection): void {
    const upstream =
      target.type === 'tcp'
        ? net.connect({ host: target.host, port: target.port, allowHalfOpen: true })
        : net.connect({ path: toNodeSocketPath(target), allowHalfOpen: true });

    this.sockets.add(client);
    this.sockets.add(upstream);

    const destroyBoth = (): void => {
      this.sockets.delete(client);
      this.sockets.delete(upstream);
      client.destroy();
      upstream.destroy();
    };

    // Once one side is fully closed, flush whatever is still queued for the other before closing it.
    const closeAfter = (closed: net.Socket, peer: net.Socket): void => {
      this.sockets.delete(closed);
      if (peer.destroyed) {
        this.sockets.delete(peer);
        return;
      }
      peer.end();
      setTimeout(() => {
        this.sockets.delete(peer);
        peer.destroy();
      }, PEER_CLOSE_GRACE_MS).unref();
    };

    const transform = this.options.createRequestTransform?.();
    if (transform) {
      transform.on('error', err => {
        logger.debug({ err }, `[EndpointRelay:${this.name}] Request transform error.`);
        destroyBoth();
      });
      client.pipe(transform).pipe(upstream);
    } else {
      client.pipe(upstream);
    }
    upstream.pipe(client);
    client.on('error', destroyBoth);
    upstream.on('error', err => {
      logger.debug({ err }, `[EndpointRelay:${this.name}] Upstream connection error.`);
      destroyBoth();
    });
    client.on('close', () => closeAfter(client, upstream));
    upstream.on('close', () => closeAfter(upstream, client));
  }
}

function describe(listen: RelayListenAddress): string {
  return listen.type === 'tcp' ? `tcp://${listen.host}:${listen.port}` : `${listen.type}://${listen.path}`;
}
