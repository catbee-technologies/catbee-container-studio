import { applyEach, FieldTree, ReadonlyFieldState, required, schema, validate } from '@angular/forms/signals';
import { EnvVarRow, getEnvVarError } from './env.utils';
import { VolumeMappingRow, getVolumeMappingError } from './volume.utils';
import { PortMappingRow, findDuplicateHostPorts, isValidHostPort, isValidPort } from './port.utils';

export function fieldError(field: Pick<ReadonlyFieldState<unknown>, 'touched' | 'errors'>): string | null {
  return field.touched() ? (field.errors()[0]?.message ?? null) : null;
}

export function resetFormRows<T extends object>(fields: FieldTree<T[]>, rows: readonly T[]): void {
  const current = fields().value();
  // Preserve existing row identities while resetting values and touched/dirty state.
  fields().reset(rows.map((row, index) => ({ ...current[index], ...row })));
}

export const resourceNameSchema = schema<string>(path => {
  const message = 'Name is required.';
  required(path, { message });
  validate(path, ({ value }) => (value().length > 0 && !value().trim() ? { kind: 'required', message } : undefined));
});

export const envRowsSchema = schema<EnvVarRow[]>(path => {
  applyEach(path, row => {
    validate(row.key, ({ valueOf }) => {
      const message = getEnvVarError(valueOf(row));
      return message ? { kind: 'required', message } : undefined;
    });
  });
});

export const volumeRowsSchema = schema<VolumeMappingRow[]>(path => {
  applyEach(path, row => {
    validate(row.hostPath, ({ value, valueOf }) =>
      !value().trim() && getVolumeMappingError(valueOf(row))
        ? { kind: 'required', message: 'Host path or volume is required.' }
        : undefined
    );
    validate(row.containerPath, ({ value, valueOf }) =>
      !value().trim() && getVolumeMappingError(valueOf(row))
        ? { kind: 'required', message: 'Container path is required.' }
        : undefined
    );
  });
});

export const portMappingSchema = schema<PortMappingRow>(path => {
  required(path.containerPort, { message: 'Container port is required.' });
  validate(path.hostPort, ({ value }) =>
    isValidHostPort(value()) ? undefined : { kind: 'range', message: 'Host port must be between 0 and 65535.' }
  );
  validate(path.containerPort, ({ value }) =>
    value().length === 0 || isValidPort(value())
      ? undefined
      : { kind: 'range', message: 'Container port must be between 1 and 65535.' }
  );
});

export const portRowsSchema = schema<PortMappingRow[]>(path => {
  applyEach(path, row => {
    // Container ports are read-only here; Docker supplies them or the add form validates them.
    validate(row.hostPort, ({ value, valueOf }) => {
      if (!isValidHostPort(value())) {
        return { kind: 'range', message: 'Host port must be between 0 and 65535.' };
      }
      const port = valueOf(row);
      return findDuplicateHostPorts(valueOf(path)).has(`${port.hostPort.trim()}/${port.protocol}`)
        ? { kind: 'duplicate', message: `Host port ${port.hostPort} is already assigned to another port mapping.` }
        : undefined;
    });
  });
});
