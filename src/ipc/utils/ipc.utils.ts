import { ipcMain } from 'electron';
import { IpcResult, fail, ok } from '../contracts';

export function registerHandle<T>(channel: string, handler: (...args: any[]) => Promise<T>): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (_event, ...args: any[]): Promise<IpcResult<T>> => {
    try {
      const result = await handler(...args);
      return ok(result);
    } catch (error) {
      return fail(error);
    }
  });
}
