/** Keep live PiPs and window-creation churn bounded even if the owner is compromised. */
export const MAX_PIP_WINDOWS = 12;
const PIP_OPEN_BURST = 8;
const PIP_OPEN_WINDOW_MS = 3_000;
let openedAt: number[] = [];

export function consumePipOpenToken(now = performance.now()): boolean {
  openedAt = openedAt.filter((time) => now - time < PIP_OPEN_WINDOW_MS);
  if (openedAt.length >= PIP_OPEN_BURST) return false;
  openedAt.push(now);
  return true;
}

export function _resetPipOpenBudgetForTesting(): void {
  openedAt = [];
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
  if (typeof opts.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(opts.id)) return false;
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
