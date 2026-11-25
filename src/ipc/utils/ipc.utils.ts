import { ipcMain } from 'electron';
import { IpcResult, fail, ok } from '../contracts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerHandle<T>(channel: string, handler: (...args: any[]) => Promise<T>): void {
  ipcMain.removeHandler(channel);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipcMain.handle(channel, async (_event, ...args: any[]): Promise<IpcResult<T>> => {
    try {
      const result = await handler(...args);
      return ok(result);
    } catch (error) {
      return fail(error);
    }
  });
}
