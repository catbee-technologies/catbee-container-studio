import { EventEmitter } from 'node:events';
import { dialog, type BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/ipc/channels';
import { requestQuitConfirmation } from '../../../src/main/app/quit-confirmation';

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }));

const { Request, Response } = IPC_CHANNELS.App.QuitConfirmation;

function createWindow() {
  const ipc = new EventEmitter();
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: { ipc },
    isCrashed: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    isLoadingMainFrame: vi.fn(() => false),
    send: vi.fn<(channel: string, requestId: string | null) => void>()
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn()
  }) as unknown as BrowserWindow;
  return { window, contents, ipc };
}

describe('Quit confirmation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it.each([true, false])('uses the themed dialog’s decision (%s)', async confirmed => {
    const { window, contents, ipc } = createWindow();
    const decision = requestQuitConfirmation(window);
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();

    const [[channel, requestId]] = contents.send.mock.calls;
    expect(channel).toBe(Request);
    expect(requestId).toEqual(expect.any(String));
    ipc.emit(Response, {}, requestId, 'shown');
    ipc.emit(Response, {}, 'stale-request', !confirmed);
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();

    ipc.emit(Response, {}, requestId, confirmed);
    await expect(decision).resolves.toBe(confirmed);
    expect(ipc.listenerCount(Response)).toBe(0);
    expect(contents.listenerCount('unresponsive')).toBe(0);
  });

  it('falls back to the native dialog when the renderer does not acknowledge the request', async () => {
    const { window, contents, ipc } = createWindow();
    const decision = requestQuitConfirmation(window);
    await vi.runAllTimersAsync();

    expect(contents.send).toHaveBeenLastCalledWith(Request, null);
    expect(ipc.listenerCount(Response)).toBe(0);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({ buttons: ['Quit', 'Cancel'] })
    );
    await expect(decision).resolves.toBe(false);
  });

  it('falls back if the renderer exits after showing the dialog', async () => {
    const { window, contents, ipc } = createWindow();
    const decision = requestQuitConfirmation(window);
    const [[, requestId]] = contents.send.mock.calls;
    ipc.emit(Response, {}, requestId, 'shown');
    contents.isCrashed.mockReturnValue(true);
    contents.emit('render-process-gone');

    await expect(decision).resolves.toBe(false);
    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
    expect(ipc.listenerCount(Response)).toBe(0);
  });

  it('uses the native dialog directly when there is no app window', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
    await expect(requestQuitConfirmation(null)).resolves.toBe(true);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['Quit', 'Cancel'] }));
  });
});
