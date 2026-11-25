import { randomUUID } from 'node:crypto';
import { dialog, type BrowserWindow, type IpcMainEvent } from 'electron';
import { IPC_CHANNELS } from '../../ipc/channels';

const RENDERER_ACK_TIMEOUT_MS = 1_500;

export async function requestQuitConfirmation(window: BrowserWindow | null): Promise<boolean> {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();

    const contents = window.webContents;
    if (!contents.isDestroyed() && !contents.isCrashed() && !contents.isLoadingMainFrame()) {
      try {
        const confirmed = await requestRendererConfirmation(window);
        if (confirmed !== undefined) return confirmed;
      } catch {
        // The main frame may disappear while setting up the renderer request.
      }
    }
  }

  const options: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: ['Quit', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Quit CatBee Container Studio',
    message: 'Are you sure you want to quit CatBee Container Studio?',
    detail: 'Running containers and background services may be stopped.'
  };
  const { response } =
    window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
  return response === 0;
}

function requestRendererConfirmation(window: BrowserWindow): Promise<boolean | undefined> {
  const contents = window.webContents;
  const ipc = contents.mainFrame.ipc;
  const { Request, Response } = IPC_CHANNELS.App.QuitConfirmation;
  const requestId = randomUUID();

  return new Promise(resolve => {
    // Limit the wait for the renderer to respond, but give the user time to decide.
    const ackTimeout = setTimeout(onRendererUnavailable, RENDERER_ACK_TIMEOUT_MS);

    function finish(confirmed?: boolean): void {
      clearTimeout(ackTimeout);
      ipc.off(Response, onResponse);
      contents.off('did-start-navigation', onNavigation);
      contents.off('render-process-gone', onRendererUnavailable);
      contents.off('unresponsive', onRendererUnavailable);
      window.off('closed', onRendererUnavailable);
      resolve(confirmed);
    }

    function onResponse(_event: IpcMainEvent, id: unknown, response: unknown): void {
      if (id !== requestId) return;
      if (response === 'shown') clearTimeout(ackTimeout);
      if (typeof response === 'boolean') finish(response);
    }

    function onRendererUnavailable(): void {
      finish();
      if (!window.isDestroyed() && !contents.isDestroyed() && !contents.isCrashed()) {
        // Dismiss a request that may still be queued in a slow or unresponsive renderer.
        try {
          contents.send(Request, null);
        } catch {
          // The renderer may have closed while switching to the native prompt.
        }
      }
    }

    function onNavigation(details: Electron.WebContentsDidStartNavigationEventParams): void {
      if (details.isMainFrame && !details.isSameDocument) onRendererUnavailable();
    }

    ipc.on(Response, onResponse);
    contents.on('did-start-navigation', onNavigation);
    contents.once('render-process-gone', onRendererUnavailable);
    contents.once('unresponsive', onRendererUnavailable);
    window.once('closed', onRendererUnavailable);

    try {
      contents.send(Request, requestId);
    } catch {
      finish();
    }
  });
}
