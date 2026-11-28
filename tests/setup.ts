import { vi } from 'vitest';

vi.mock('../src/main/logger', () => {
  const base = {
    trace: vi.fn<(...args: unknown[]) => void>(),
    debug: vi.fn<(...args: unknown[]) => void>(),
    info: vi.fn<(...args: unknown[]) => void>(),
    warn: vi.fn<(...args: unknown[]) => void>(),
    error: vi.fn<(...args: unknown[]) => void>(),
    fatal: vi.fn<(...args: unknown[]) => void>(),
    flush: (cb?: () => void) => cb?.()
  };

  const createChild = (parentPrefix = '') => {
    const child = (_bindings?: Record<string, unknown>, options?: { msgPrefix?: string }) => {
      const prefix = `${parentPrefix}${options?.msgPrefix ?? ''}`;
      if (!prefix) {
        return { ...base, child: createChild() };
      }

      const forward =
        (fn: (...args: unknown[]) => void) =>
        (first: unknown, ...rest: unknown[]) =>
          typeof first === 'string'
            ? fn(`${prefix}${first}`, ...rest)
            : typeof rest[0] === 'string'
              ? fn(first, `${prefix}${rest[0]}`, ...rest.slice(1))
              : fn(first, ...rest);

      return {
        trace: forward(base.trace),
        debug: forward(base.debug),
        info: forward(base.info),
        warn: forward(base.warn),
        error: forward(base.error),
        fatal: forward(base.fatal),
        flush: base.flush,
        child: createChild(prefix)
      };
    };

    return child;
  };

  return { logger: { ...base, child: createChild() } };
});
