import type { ConnectionId } from '../shared/connectionIdentity';

/** Keep live PiPs and window-creation churn bounded even if an owner is compromised. */
export const MAX_PIP_WINDOWS = 12;
/**
 * #86 RT5: the most live PiPs one connection may hold, under the process-wide
 * MAX_PIP_WINDOWS. Half the ceiling, so one connection can never leave a second
 * without a PiP; six still covers the voice controls, the frames grid and four
 * screen-share pop-outs.
 */
export const MAX_PIP_WINDOWS_PER_CONNECTION = 6;
const PIP_OPEN_BURST = 8;
const PIP_OPEN_WINDOW_MS = 3_000;
/** #86 RT5: one rolling window per connection, so one connection's opens never spend another's. */
const openedAtByConnection = new Map<ConnectionId, number[]>();

export function consumePipOpenToken(connectionId: ConnectionId, now = performance.now()): boolean {
  const openedAt = (openedAtByConnection.get(connectionId) ?? []).filter(
    (time) => now - time < PIP_OPEN_WINDOW_MS
  );
  const admitted = openedAt.length < PIP_OPEN_BURST;
  if (admitted) openedAt.push(now);
  openedAtByConnection.set(connectionId, openedAt);
  return admitted;
}

/** Drop a disposed connection's open history. Connection ids are never minted twice. */
export function releasePipOpenBudget(connectionId: ConnectionId): void {
  openedAtByConnection.delete(connectionId);
}

export function _resetPipOpenBudgetForTesting(): void {
  openedAtByConnection.clear();
}

export function _pipOpenBudgetHeldForTesting(connectionId: ConnectionId): boolean {
  return openedAtByConnection.has(connectionId);
}

/**
 * A renderer-chosen PiP id. The alphabet has no ':', which keeps main's
 * `<connectionId>:<id>` registry key unambiguous (#86 RT4).
 */
export function isPipId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export interface PipOpenOptions {
  id: string;
  width?: number;
  height?: number;
  title?: string;
}

export function isPipOpenOptions(value: unknown): value is PipOpenOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const opts = value as Record<string, unknown>;
  if (Object.keys(opts).some((key) => !['id', 'width', 'height', 'title'].includes(key))) {
    return false;
  }
  if (!isPipId(opts.id)) return false;
  for (const dimension of [opts.width, opts.height]) {
    if (
      dimension !== undefined &&
      (typeof dimension !== 'number' ||
        !Number.isInteger(dimension) ||
        dimension < 1 ||
        dimension > 4096)
    )
      return false;
  }
  return (
    opts.title === undefined ||
    (typeof opts.title === 'string' &&
      opts.title.length <= 128 &&
      !/[\u0000-\u001f\u007f]/.test(opts.title))
  );
}
