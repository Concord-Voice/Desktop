/**
 * #86 Task 7B test fixture: a bound sender for suites whose handlers now run behind
 * `registerIpc`. Resets both registries (registerIpc refuses a duplicate channel),
 * registers one service, opens one connection on a fake webContents, binds it as the
 * primary and, unless told otherwise, makes it the foreground connection.
 *
 * `event(url)` is that sender's main-frame event (`parent: null`, matching
 * `frameTreeNodeId`, not detached), so admission turns on the frame URL and the
 * binding, never on a fixture gap. `event(null)` presents a null `senderFrame`.
 */
import {
  _resetConnectionRegistryForTesting,
  bindSender,
  openConnection,
  registerService,
  setForeground,
} from '@/main/connectionRegistry';
import { _resetIpcRegistryForTesting } from '@/main/ipc/registry';

export const SAAS_ORIGIN = 'https://api.concordvoice.chat';

export interface BoundSenderFixture {
  readonly connectionId: string;
  event(url?: string | null): never;
}

export function bindTestSender(
  opts: { origin?: string; foreground?: boolean; id?: number; reset?: boolean } = {}
): BoundSenderFixture {
  if (opts.reset !== false) {
    _resetConnectionRegistryForTesting();
    _resetIpcRegistryForTesting();
  }
  const id = opts.id ?? 7;
  const r = registerService(opts.origin ?? SAAS_ORIGIN, {
    makeSession: () => ({}) as never,
    makeCustody: () => ({}) as never,
    isValidatedSelfHostedApiBase: () => true,
  });
  if (!r.ok) throw new Error(r.reason);
  const wc = { id, mainFrame: { frameTreeNodeId: id } } as never;
  const o = openConnection(r.service.serviceId, wc, null);
  if (!o.ok) throw new Error(o.reason);
  bindSender(wc, o.record.connectionId, 'primary');
  if (opts.foreground !== false) setForeground(o.record.connectionId);
  return {
    connectionId: o.record.connectionId,
    event: (url: string | null = 'app://concord/index.html') =>
      ({
        sender: wc,
        senderFrame:
          url === null ? null : { url, parent: null, frameTreeNodeId: id, detached: false },
      }) as never,
  };
}
