// @vitest-environment node
// #87 §3.3: the native capture-move ceremony. Copy is verbatim from the spec; labels
// come only from main; Stay is the default and the cancel; anything but an explicit
// Join resolves as Stay.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseWindow } from 'electron';

const { mockDialogShowMessageBox } = vi.hoisted(() => ({
  mockDialogShowMessageBox: vi.fn(async () => ({ response: 0 })),
}));

vi.mock('electron', () => ({ dialog: { showMessageBox: mockDialogShowMessageBox } }));

import {
  LABEL_MAX,
  OTHER_CONNECTION_LABEL,
  _setShowMessageBoxForTesting,
  buildCeremonyOptions,
  connectionLabel,
  runCaptureCeremony,
  truncateLabel,
  type ShowMessageBox,
} from '../../../src/main/captureCeremony';

const DETAIL_TAIL =
  'Concord Voice can use your microphone, camera and screen sharing on one connection at a time.';

const SAAS = { kind: 'saas', origin: 'https://api.concordvoice.chat' } as const;
const A = { kind: 'selfhost', origin: 'https://a.example' } as const;
const win = { id: 1 } as unknown as BaseWindow;

/** A 40-character host label. */
const LONG_HOST = 'abcdefghijklmnopqrstuvwxyz.0123456.local';

beforeEach(() => {
  mockDialogShowMessageBox.mockClear();
  _setShowMessageBoxForTesting(null);
});

afterEach(() => {
  _setShowMessageBoxForTesting(null);
});

describe('buildCeremonyOptions (§3.3 copy, verbatim)', () => {
  it('builds the exact dialog options', () => {
    const signal = new AbortController().signal;
    expect(buildCeremonyOptions('Concord Voice', 'a.example', signal)).toEqual({
      type: 'question',
      noLink: true,
      normalizeAccessKeys: true,
      signal,
      title: 'Concord Voice',
      message: 'Join voice on a.example?',
      detail:
        "You're in a call on Concord Voice. Joining on a.example ends that call, and people on " +
        'Concord Voice will see you leave. Concord Voice can use your microphone, camera and ' +
        'screen sharing on one connection at a time.',
      buttons: ['&Stay on Concord Voice', '&Join on a.example'],
      defaultId: 0,
      cancelId: 0,
    });
  });

  it('passes the caller signal through by identity', () => {
    const signal = new AbortController().signal;
    expect(buildCeremonyOptions('Concord Voice', 'a.example', signal).signal).toBe(signal);
  });

  it('equal labels: the current one becomes "your other connection"', () => {
    const signal = new AbortController().signal;
    const o = buildCeremonyOptions('a.example', 'a.example', signal);
    expect(OTHER_CONNECTION_LABEL).toBe('your other connection');
    expect(o.message).toBe('Join voice on a.example?');
    expect(o.detail).toBe(
      "You're in a call on your other connection. Joining on a.example ends that call, and " +
        `people on your other connection will see you leave. ${DETAIL_TAIL}`
    );
    expect(o.detail?.startsWith("You're in a call on your other connection.")).toBe(true);
    expect(o.buttons).toEqual(['&Stay on your other connection', '&Join on a.example']);
  });

  it('truncates long labels in the buttons only; detail and message keep the full host', () => {
    expect(LONG_HOST).toHaveLength(40);
    const signal = new AbortController().signal;
    const o = buildCeremonyOptions('Concord Voice', LONG_HOST, signal);
    const short = truncateLabel(LONG_HOST);
    expect(o.buttons).toEqual(['&Stay on Concord Voice', `&Join on ${short}`]);
    expect(o.message).toBe(`Join voice on ${LONG_HOST}?`);
    expect(o.detail).toContain(`Joining on ${LONG_HOST} ends that call`);
  });

  it('escapes a literal ampersand in a button label so it cannot plant an access key', () => {
    const signal = new AbortController().signal;
    const o = buildCeremonyOptions('Concord Voice', 'a&b.example', signal);
    expect(o.buttons).toEqual(['&Stay on Concord Voice', '&Join on a&&b.example']);
    // The message and detail are not access-key processed and keep the literal host.
    expect(o.message).toBe('Join voice on a&b.example?');
  });
});

describe('truncateLabel', () => {
  it('defaults to a 28-character limit', () => {
    expect(LABEL_MAX).toBe(28);
  });

  it('cuts a 40-character host to 28 characters with the ellipsis in the middle', () => {
    const t = truncateLabel(LONG_HOST);
    expect(t).toHaveLength(28);
    expect(t.indexOf('…')).toBe(14);
    expect(t.startsWith(LONG_HOST.slice(0, 14))).toBe(true);
    expect(t.endsWith(LONG_HOST.slice(-13))).toBe(true);
  });

  it('leaves a label at or under the limit unchanged', () => {
    expect(truncateLabel('Concord Voice')).toBe('Concord Voice');
    const exact = 'x'.repeat(28);
    expect(truncateLabel(exact)).toBe(exact);
    expect(truncateLabel('x'.repeat(29))).toHaveLength(28);
  });

  it('honours an explicit limit', () => {
    expect(truncateLabel('abcdefghij', 5)).toBe('ab…ij');
  });
});

describe('connectionLabel (main-sourced only)', () => {
  it('names the hosted service "Concord Voice"', () => {
    expect(connectionLabel(SAAS)).toBe('Concord Voice');
  });

  it('gives a self-hosted service its punycode host, non-default port included', () => {
    expect(connectionLabel({ kind: 'selfhost', origin: 'https://bücher.example:8443' })).toBe(
      'xn--bcher-kva.example:8443'
    );
  });

  it('drops a default port', () => {
    expect(connectionLabel({ kind: 'selfhost', origin: 'https://a.example:443' })).toBe(
      'a.example'
    );
  });

  it('payload injection: a path or userinfo in the origin never reaches the label', () => {
    expect(connectionLabel({ kind: 'selfhost', origin: 'https://evil.example/&Join' })).toBe(
      'evil.example'
    );
    expect(connectionLabel({ kind: 'selfhost', origin: 'https://Join@evil.example' })).toBe(
      'evil.example'
    );
  });
});

describe('runCaptureCeremony', () => {
  it('response 1 resolves join', async () => {
    const show = vi.fn<ShowMessageBox>().mockResolvedValue({ response: 1 });
    const signal = new AbortController().signal;
    await expect(runCaptureCeremony(win, SAAS, A, signal, { showMessageBox: show })).resolves.toBe(
      'join'
    );
  });

  it('response 0 resolves stay', async () => {
    const show = vi.fn<ShowMessageBox>().mockResolvedValue({ response: 0 });
    const signal = new AbortController().signal;
    await expect(runCaptureCeremony(win, SAAS, A, signal, { showMessageBox: show })).resolves.toBe(
      'stay'
    );
  });

  it.each([[2], [-1], [Number.NaN], [undefined], ['1']])(
    'any other response (%j) resolves stay',
    async (response) => {
      const show = vi.fn<ShowMessageBox>().mockResolvedValue({ response } as never);
      const signal = new AbortController().signal;
      await expect(
        runCaptureCeremony(win, SAAS, A, signal, { showMessageBox: show })
      ).resolves.toBe('stay');
    }
  );

  it('a rejecting dialog resolves stay', async () => {
    const show = vi.fn<ShowMessageBox>().mockRejectedValue(new Error('native dialog failed'));
    const signal = new AbortController().signal;
    await expect(runCaptureCeremony(win, SAAS, A, signal, { showMessageBox: show })).resolves.toBe(
      'stay'
    );
  });

  it('a synchronously throwing dialog resolves stay', async () => {
    const show = vi.fn<ShowMessageBox>(() => {
      throw new Error('boom');
    });
    const signal = new AbortController().signal;
    await expect(runCaptureCeremony(win, SAAS, A, signal, { showMessageBox: show })).resolves.toBe(
      'stay'
    );
  });

  it('abort while pending: the dialog sees an aborted signal and the result is stay', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const show = vi.fn<ShowMessageBox>(
      (_w, o) =>
        new Promise((resolve) => {
          seen = o.signal;
          // Electron closes the box "as if it was cancelled by the user".
          o.signal?.addEventListener('abort', () => resolve({ response: o.cancelId ?? 0 }));
        })
    );
    const pending = runCaptureCeremony(win, SAAS, A, controller.signal, { showMessageBox: show });
    controller.abort();
    await expect(pending).resolves.toBe('stay');
    expect(seen?.aborted).toBe(true);
  });

  it('abort wins even when the dialog answers Join afterwards', async () => {
    const controller = new AbortController();
    const show = vi.fn<ShowMessageBox>(async () => {
      controller.abort();
      return { response: 1 };
    });
    await expect(
      runCaptureCeremony(win, SAAS, A, controller.signal, { showMessageBox: show })
    ).resolves.toBe('stay');
  });

  it('an already-aborted signal resolves stay without showing a dialog', async () => {
    const controller = new AbortController();
    controller.abort();
    const show = vi.fn<ShowMessageBox>().mockResolvedValue({ response: 1 });
    await expect(
      runCaptureCeremony(win, SAAS, A, controller.signal, { showMessageBox: show })
    ).resolves.toBe('stay');
    expect(show).not.toHaveBeenCalled();
  });

  it('passes the BaseWindow as the first argument and main-sourced labels in the options', async () => {
    const show = vi.fn<ShowMessageBox>().mockResolvedValue({ response: 0 });
    const signal = new AbortController().signal;
    await runCaptureCeremony(
      win,
      SAAS,
      { kind: 'selfhost', origin: 'https://evil.example/&x' },
      signal,
      {
        showMessageBox: show,
      }
    );
    expect(show).toHaveBeenCalledTimes(1);
    const [w, o] = show.mock.calls[0]!;
    expect(w).toBe(win);
    expect(o).toEqual(buildCeremonyOptions('Concord Voice', 'evil.example', signal));
  });

  it('uses the real dialog.showMessageBox(window, options) by default', async () => {
    mockDialogShowMessageBox.mockResolvedValueOnce({ response: 1 });
    const signal = new AbortController().signal;
    await expect(runCaptureCeremony(win, SAAS, A, signal)).resolves.toBe('join');
    expect(mockDialogShowMessageBox).toHaveBeenCalledWith(
      win,
      buildCeremonyOptions('Concord Voice', 'a.example', signal)
    );
  });

  it('_setShowMessageBoxForTesting replaces the default until cleared', async () => {
    const injected = vi.fn<ShowMessageBox>().mockResolvedValue({ response: 1 });
    _setShowMessageBoxForTesting(injected);
    const signal = new AbortController().signal;
    await expect(runCaptureCeremony(win, SAAS, A, signal)).resolves.toBe('join');
    expect(injected).toHaveBeenCalledTimes(1);
    expect(mockDialogShowMessageBox).not.toHaveBeenCalled();

    _setShowMessageBoxForTesting(null);
    await expect(runCaptureCeremony(win, SAAS, A, signal)).resolves.toBe('stay');
    expect(mockDialogShowMessageBox).toHaveBeenCalledTimes(1);
  });

  it('an explicit deps.showMessageBox wins over the test seam', async () => {
    const seam = vi.fn<ShowMessageBox>().mockResolvedValue({ response: 1 });
    const explicit = vi.fn<ShowMessageBox>().mockResolvedValue({ response: 0 });
    _setShowMessageBoxForTesting(seam);
    const signal = new AbortController().signal;
    await expect(
      runCaptureCeremony(win, SAAS, A, signal, { showMessageBox: explicit })
    ).resolves.toBe('stay');
    expect(seam).not.toHaveBeenCalled();
  });
});
