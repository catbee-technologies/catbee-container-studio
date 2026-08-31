import { net, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const frontendPath = path.resolve(__dirname, '../../../app');

export function registerAppProtocol(): void {
  protocol.handle('catbee', async request => {
    const url = new URL(request.url);

    let relativePath = decodeURIComponent(url.pathname);

    if (relativePath === '/' || relativePath === '') {
      relativePath = '/index.html';
    }

    const filePath = path.normalize(path.join(frontendPath, relativePath));

    if (filePath !== frontendPath && !filePath.startsWith(`${frontendPath}${path.sep}`)) {
      return new Response('Forbidden', { status: 403 });
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
}
