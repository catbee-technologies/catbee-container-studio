import { dialog } from 'electron';
import { APP_VERSION } from './constants';

export async function showAboutDialog(): Promise<void> {
  await dialog.showMessageBox({
    type: 'info',
    title: 'About CatBee Container Studio',
    message: 'CatBee Container Studio',
    detail: [
      `Version ${APP_VERSION}`,
      '',
      `Electron ${process.versions.electron}`,
      `Chromium ${process.versions.chrome}`,
      `Node.js ${process.versions.node}`,
      `Platform ${process.platform} ${process.arch}`,
      '',
      `© ${new Date().getFullYear()} Catbee Technologies`
    ].join('\n'),
    buttons: ['OK']
  });
}
