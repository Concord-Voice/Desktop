import {
  parseConnectionIdentity,
  type ConnectionIdentity,
} from '../../../shared/connectionIdentity';

/**
 * #86 §3.10 renderer boot contract: which connection this document belongs to.
 *
 * - `legacy`: the shell exposes no `connection.whoAmI` (a pre-v34 shell). The
 *   single-connection path applies and `runtimeServerBase` stays mutable.
 * - `connection`: the preload's cached identity, re-validated with the shared
 *   exact-key codec. The document's server base is fixed to `identity.apiOrigin`.
 * - `unavailable`: the method exists but answered `null`, threw, or returned
 *   anything the codec refuses (an extra key included). Fatal; this document never
 *   falls back to the build-time `API_BASE`.
 *
 * Read once and memoised: the identity is the document's for its lifetime.
 */
export type BootConnection =
  | { mode: 'connection'; identity: ConnectionIdentity }
  | { mode: 'legacy' }
  | { mode: 'unavailable' };

let memo: BootConnection | undefined;

function readBootConnection(): BootConnection {
  // Typed as always present, but a pre-v34 shell has no `connection` namespace and
  // a plain browser has no bridge at all. Only an absent method selects legacy.
  const bridge = globalThis.electron as { connection?: { whoAmI?: unknown } } | undefined;
  const whoAmI = bridge?.connection?.whoAmI;
  if (whoAmI === undefined) return { mode: 'legacy' };
  if (typeof whoAmI !== 'function') return { mode: 'unavailable' };
  try {
    const identity = parseConnectionIdentity(whoAmI());
    return identity === null ? { mode: 'unavailable' } : { mode: 'connection', identity };
  } catch {
    return { mode: 'unavailable' };
  }
}

export function bootConnection(): BootConnection {
  memo ??= readBootConnection();
  return memo;
}

export function _resetBootConnectionForTesting(): void {
  memo = undefined;
}
