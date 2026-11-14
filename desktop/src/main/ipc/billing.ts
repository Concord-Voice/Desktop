/**
 * The `billing:open` invoke (#1305, #2033 PR-3b, IPC contract 32).
 *
 * Two fences, in this order: the sender must be the `saas` connection's bound
 * primary main frame (`saas-only` admission, IPC contract v34, #86), and
 * the URL must be exactly the kind's Stripe host (`validateBillingUrl`). Only
 * then does main open the launcher window; the renderer never chooses where
 * the view may navigate after that.
 */
import type { BaseWindow } from 'electron';

import {
  openBillingWindow,
  validateBillingUrl,
  type BillingResult,
} from '../billing/billingWindow';

import { CHANNEL_CLASSES } from './channelClassification';
import { registerIpc } from './registry';

export function registerBillingIpc(getMainWindow: () => BaseWindow | null): void {
  // #86 Task 7B: `saas-only` through registerIpc. A refused sender throws, as before.
  registerIpc(
    'billing:open',
    CHANNEL_CLASSES['billing:open'],
    async (_sender, _event, req: unknown): Promise<{ result: BillingResult }> => {
      const r = req as { kind?: unknown; url?: unknown } | null;
      const url = validateBillingUrl(r?.kind, r?.url);
      if (!url) {
        // A closed category only: the raw field is renderer-controlled.
        const kind = r?.kind === 'checkout' || r?.kind === 'portal' ? r.kind : 'unknown';
        console.warn(`billing:open rejected an invalid url for kind ${kind}`);
        throw new Error('billing:open rejected: invalid url');
      }
      return { result: await openBillingWindow(getMainWindow(), url) };
    },
    {
      refusal: () => {
        console.warn('billing:open rejected an untrusted sender');
        return Promise.reject(new Error('billing:open rejected: untrusted sender'));
      },
    }
  );
}
