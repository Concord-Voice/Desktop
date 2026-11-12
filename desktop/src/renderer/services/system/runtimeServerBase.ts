import { API_BASE, WS_BASE } from '../../config';
import { bootConnection, type BootConnection } from './bootConnection';

// #86 §3.10: the base this document boots with. A connection document is pinned to
// its identity's apiOrigin; an unavailable one gets an address that can never resolve
// (RFC 6761 `.invalid`), because it must never fall back to the build-time API_BASE.
// Only a legacy (pre-v34 shell) document starts from API_BASE and may change it.
const boot = bootConnection();
const UNAVAILABLE_API_BASE = 'https://connection-unavailable.invalid';
function bootApiBaseFor(connection: BootConnection): string {
  if (connection.mode === 'connection') return connection.identity.apiOrigin;
  if (connection.mode === 'unavailable') return UNAVAILABLE_API_BASE;
  return API_BASE;
}
const bootApiBase = bootApiBaseFor(boot);

let runtimeApiBase = bootApiBase;
let runtimeWsBase = boot.mode === 'legacy' ? WS_BASE : deriveWsBase(bootApiBase);
let runtimeServerSelectionEpoch = 0;
const runtimeServerSelectionListeners = new Set<() => void>();

export interface RuntimeServerSelection {
  readonly apiBase: string;
  readonly epoch: number;
}

export function onRuntimeServerSelectionChange(listener: () => void): () => void {
  runtimeServerSelectionListeners.add(listener);
  return () => runtimeServerSelectionListeners.delete(listener);
}

function notifyRuntimeServerSelectionChange(): void {
  for (const listener of runtimeServerSelectionListeners) listener();
}

function normalizeHttpBase(base: string): string {
  const parsed = new URL(base);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Runtime server base must use HTTP or HTTPS.');
  }
  return parsed.origin;
}

function deriveWsBase(apiBase: string): string {
  const parsed = new URL(apiBase);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return parsed.origin;
}

export function getApiBase(): string {
  return runtimeApiBase;
}

export function getWsBase(): string {
  return runtimeWsBase;
}

export function captureRuntimeServerSelection(): RuntimeServerSelection {
  return { apiBase: runtimeApiBase, epoch: runtimeServerSelectionEpoch };
}

export function runtimeServerSelectionIsCurrent(selection: RuntimeServerSelection): boolean {
  return selection.apiBase === runtimeApiBase && selection.epoch === runtimeServerSelectionEpoch;
}

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${runtimeApiBase}${normalizedPath}`;
}

export function mediaUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('/')) return apiUrl(url);
  if (url.startsWith('data:') || url.startsWith('blob:') || /^https?:\/\//i.test(url)) {
    return url;
  }
  return undefined;
}

function assertRuntimeServerBaseMutable(): void {
  if (boot.mode !== 'legacy') {
    throw new Error(`runtimeServerBase is boot-immutable in ${boot.mode} mode`);
  }
}

export function setRuntimeServerBase(base: string): void {
  assertRuntimeServerBaseMutable();
  const apiBase = normalizeHttpBase(base);
  const wsBase = deriveWsBase(apiBase);
  runtimeApiBase = apiBase;
  runtimeWsBase = wsBase;
  runtimeServerSelectionEpoch += 1;
  notifyRuntimeServerSelectionChange();
}

export function resetRuntimeServerBase(): void {
  assertRuntimeServerBaseMutable();
  runtimeApiBase = API_BASE;
  runtimeWsBase = WS_BASE;
  runtimeServerSelectionEpoch += 1;
  notifyRuntimeServerSelectionChange();
}
