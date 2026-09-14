import net from 'node:net';
import { logger } from '../../../logger';

export class WindowsPipeRelay {
  private server: net.Server | null = null;
  private currentPipe: string | null = null;
  private currentHost: string | null = null;
  private currentPort: number | null = null;
  private readonly activeSockets = new Set<net.Socket>();

  async start(pipeName: string, targetHost: string, targetPort: number): Promise<boolean> {
    if (
      this.server &&
      this.currentPipe === pipeName &&
      this.currentHost === targetHost &&
      this.currentPort === targetPort
    ) {
      logger.debug('[WindowsPipeRelay] Pipe relay is already running with matching configuration.');
      return true;
    }

    this.stop();

    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    return new Promise(resolve => {
      const server = net.createServer(clientSocket => {
        this.activeSockets.add(clientSocket);

        const targetSocket = net.connect({ host: targetHost, port: targetPort }, () => {
          clientSocket.pipe(targetSocket);
          targetSocket.pipe(clientSocket);
        });

        this.activeSockets.add(targetSocket);

        const cleanup = (): void => {
          this.activeSockets.delete(clientSocket);
          this.activeSockets.delete(targetSocket);
          try {
            clientSocket.destroy();
          } catch {
            // Ignore
          }
          try {
            targetSocket.destroy();
          } catch {
            // Ignore
          }
        };

        targetSocket.on('error', err => {
          logger.debug({ err }, '[WindowsPipeRelay] Target connection error.');
          cleanup();
        });

        clientSocket.on('error', err => {
          logger.debug({ err }, '[WindowsPipeRelay] Client connection error.');
          cleanup();
        });

        targetSocket.on('close', cleanup);
        clientSocket.on('close', cleanup);
      });

      server.on('error', err => {
        logger.warn({ err }, `[WindowsPipeRelay] Failed to listen on named pipe ${pipePath}`);
        resolve(false);
      });

      server.listen(pipePath, () => {
        logger.info(`[WindowsPipeRelay] Named pipe relay listening on: ${pipePath} -> ${targetHost}:${targetPort}`);
        this.server = server;
        this.currentPipe = pipeName;
        this.currentHost = targetHost;
        this.currentPort = targetPort;
        resolve(true);
      });
    });
  }

  stop(): void {
    this.currentPipe = null;
    this.currentHost = null;
    this.currentPort = null;
    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {
        // Ignore
      }
    }
    this.activeSockets.clear();

    if (this.server) {
      try {
        this.server.close();
      } catch {
        // Ignore
      }
      this.server = null;
    }
  }
}
