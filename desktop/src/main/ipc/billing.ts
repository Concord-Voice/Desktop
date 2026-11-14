/**
 * The `billing:open` invoke (#1305, #2033 PR-3b, IPC contract 32).
 *
 * Three fences, in this order: the sender must be the `saas` connection's bound
 * primary main frame (`saas-only` admission, IPC contract v34, #86); that
 * connection must be the FOREGROUND one (#86 C10); and the URL must be exactly
 * the kind's Stripe host (`validateBillingUrl`). Only then does main open the
 * launcher window; the renderer never chooses where the view may navigate
 * after that.
 *
 * The foreground fence exists because the sheet is a modal child of the shared
 * shell window: a hidden saas view behind a self-hosted one must not raise
 * trusted-looking payment UI over the connection the user is looking at. It is
 * read in the same tick as admission and `openBillingWindow` builds its window
 * synchronously, so nothing can switch the foreground between the check and the
 * modal. Do not put an `await` above `openBillingWindow`.
 */
import type { BaseWindow } from 'electron';

import {
  openBillingWindow,
  validateBillingUrl,
  type BillingResult,
} from '../billing/billingWindow';

import { foreground } from '../connectionRegistry';

import { CHANNEL_CLASSES } from './channelClassification';
import { registerIpc } from './registry';

const UNTRUSTED_SENDER = 'billing:open rejected: untrusted sender';

export function registerBillingIpc(getMainWindow: () => BaseWindow | null): void {
  // #86 Task 7B: `saas-only` through registerIpc. A refused sender throws, as before.
  registerIpc(
    'billing:open',
    CHANNEL_CLASSES['billing:open'],
    async (sender, _event, req: unknown): Promise<{ result: BillingResult }> => {
      // #86 C10: saas-only admits a hidden saas view; the sheet opens only over the
      // connection on screen. Refused with today's shape, before the payload is read.
      if (foreground() !== sender.record) {
        console.warn('billing:open rejected a background sender');
        throw new Error(UNTRUSTED_SENDER);
      }
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
        return Promise.reject(new Error(UNTRUSTED_SENDER));
      },
    }
  );
}
