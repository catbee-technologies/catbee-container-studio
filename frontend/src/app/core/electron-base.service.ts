import { ElectronBridge, IpcResult } from '@shared/types';

export class ElectronBaseService {
  get bridge(): ElectronBridge {
    const maybeBridge = (globalThis as unknown as { electron?: ElectronBridge }).electron;
    if (!maybeBridge) {
      throw new Error('Electron bridge is unavailable. Ensure preload is loaded.');
    }
    return maybeBridge;
  }

  protected unwrapResult<T>(payload: unknown): T {
    if (!this.isIpcResult<T>(payload)) {
      throw new Error('Invalid IPC response payload.');
    }
    const result = payload;
    if (result.ok === false) {
      throw new Error(result.error.message);
    }
    return result.data;
  }

  protected isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  protected isIpcResult<T>(value: unknown): value is IpcResult<T> {
    if (!this.isRecord(value)) {
      return false;
    }
    return typeof value['ok'] === 'boolean';
  }
}
