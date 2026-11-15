// #198 (merged from main) re-expressed for #86: main's isTrustedMainWindowSender cases,
// run against the admission the lifecycle channels now use (app-global-mutate =
// requireForegroundPrimary). "The live main window" is the foreground connection's
// bound primary; the assertions are main's.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { quit: vi.fn(), getPath: () => '/tmp/concord-test-userdata' },
  ipcMain: { handle: vi.fn() },
}));

import type { IpcMainInvokeEvent } from 'electron';
import {
  _resetConnectionRegistryForTesting,
  bindSender,
  disposeConnection,
  openConnection,
  registerService,
  setForeground,
} from '@/main/connectionRegistry';
import { CHANNEL_CLASSES } from '@/main/ipc/channelClassification';
import { requireForegroundPrimary } from '@/main/ipc/connectionSender';

describe('lifecycle admission (main #198 isTrustedMainWindowSender cases)', () => {
  // What makes the cases below the lifecycle channels' admission: registerIpc admits
  // app-global-mutate through requireForegroundPrimary alone.
  it.each(['window:quit', 'app:quit', 'app:relaunch', 'update:install'])(
    '%s is app-global-mutate',
    (channel) => {
      expect(CHANNEL_CLASSES[channel]).toBe('app-global-mutate');
    }
  );

  const contents = { id: 41, mainFrame: { frameTreeNodeId: 41 } };
  let connectionId = '';
  const event = (url: string, id = 41, sender: unknown = contents) =>
    ({
      sender,
      senderFrame: { url, frameTreeNodeId: id, parent: null, detached: false },
    }) as unknown as IpcMainInvokeEvent;

  beforeEach(() => {
    _resetConnectionRegistryForTesting();
    const r = registerService('https://api.concordvoice.chat', {
      makeSession: () => ({}) as never,
      makeCustody: () => ({}) as never,
      isValidatedSelfHostedApiBase: () => true,
    });
    if (!r.ok) throw new Error(r.reason);
    const o = openConnection(r.service.serviceId, contents as never, null);
    if (!o.ok) throw new Error(o.reason);
    connectionId = o.record.connectionId;
    bindSender(contents as never, connectionId, 'primary');
    setForeground(connectionId);
  });

  it.each([
    ['app://concord/index.html', null],
    ['spa-cache://concord/index.html', null],
    ['http://localhost:3001/', null],
    ['https://spa.example/index.html', 'https://spa.example'],
  ])('accepts the live main frame at %s', (url, origin) => {
    expect(requireForegroundPrimary(event(url), origin)).not.toBeNull();
  });

  it('rejects PiP, subframes, untrusted URLs and missing senders', () => {
    for (const e of [
      event('app://concord/index.html', 41, { id: 42, mainFrame: { frameTreeNodeId: 41 } }),
      event('app://concord/index.html', 42),
      event('https://evil.example/', 41),
      { sender: contents, senderFrame: null } as unknown as IpcMainInvokeEvent,
    ])
      expect(requireForegroundPrimary(e, null)).toBeNull();
  });

  it('fails closed for missing, destroyed, replaced or inaccessible windows', () => {
    const trusted = event('app://concord/index.html');
    setForeground(null);
    expect(requireForegroundPrimary(trusted, null)).toBeNull();
    setForeground(connectionId);
    const replacement = { id: 43, mainFrame: { frameTreeNodeId: 41 } };
    expect(
      requireForegroundPrimary(event('app://concord/index.html', 41, replacement), null)
    ).toBeNull();
    const inaccessible = {
      sender: contents,
      get senderFrame(): never {
        throw new Error('destroyed');
      },
    } as unknown as IpcMainInvokeEvent;
    expect(requireForegroundPrimary(inaccessible, null)).toBeNull();
    // "Destroyed": a disposed connection's primary is no longer bound.
    disposeConnection(connectionId);
    expect(requireForegroundPrimary(trusted, null)).toBeNull();
  });

  it('rejects the bound primary of a background connection', () => {
    const r = registerService('https://other.example', {
      makeSession: () => ({}) as never,
      makeCustody: () => ({}) as never,
      isValidatedSelfHostedApiBase: () => true,
    });
    if (!r.ok) throw new Error(r.reason);
    const bg = { id: 51, mainFrame: { frameTreeNodeId: 51 } };
    const o = openConnection(r.service.serviceId, bg as never, null);
    if (!o.ok) throw new Error(o.reason);
    bindSender(bg as never, o.record.connectionId, 'primary');
    expect(requireForegroundPrimary(event('app://concord/index.html', 51, bg), null)).toBeNull();
    setForeground(o.record.connectionId);
    expect(
      requireForegroundPrimary(event('app://concord/index.html', 51, bg), null)
    ).not.toBeNull();
  });
});
