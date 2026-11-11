/**
 * Attachment display policy (Mark, 2026-11-05): files never download until the
 * user asks, except photos, animated images (on the KLIPY GIF rules), videos up
 * to the image preload ceiling on Desktop, and text/Markdown, which preload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '../../../test-utils';
import AttachmentDisplay, {
  VIDEO_PRELOAD_MAX_BYTES,
  __resetBlobCacheForTests,
} from '@/renderer/components/Chat/AttachmentDisplay';
import type { AttachmentSummary } from '@/renderer/types/chat';
import { resetAllStores } from '../../../helpers/store-helpers';
import { usePrivacyStore } from '@/renderer/stores/ui/privacyStore';
import { useSettingsStore } from '@/renderer/stores/ui/settingsStore';

vi.mock('@/renderer/components/Chat/OverflowMarkdownAttachment', () => ({
  __esModule: true,
  default: ({
    attachment,
    format,
    previewBody,
  }: {
    attachment: AttachmentSummary;
    format: string;
    previewBody: string;
  }) => (
    <div data-testid="text-attachment" data-id={attachment.id} data-format={format}>
      {previewBody}
    </div>
  ),
}));

const mockApiFetch = vi.fn();
let readBodyDuringDecrypt = false;
vi.mock('@/renderer/services/system/apiClient', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/renderer/services/e2ee/e2eeService', () => ({
  e2eeService: {
    getChannelKey: () => Promise.resolve({} as CryptoKey),
    getChannelKeyByVersion: () => Promise.resolve({} as CryptoKey),
  },
}));

vi.mock('@/renderer/utils/crypto/attachmentChunkedCrypto', async () => {
  const actual = await vi.importActual<
    typeof import('@/renderer/utils/crypto/attachmentChunkedCrypto')
  >('@/renderer/utils/crypto/attachmentChunkedCrypto');
  return {
    ...actual,
    decryptAttachmentStream: async (
      body: ReadableStream<Uint8Array>,
      _len: number,
      _key: unknown,
      mime: string
    ) => {
      if (readBodyDuringDecrypt) {
        const reader = body.getReader();
        while (!(await reader.read()).done) {
          /* drain without buffering */
        }
      }
      return new Blob([new Uint8Array(16)], { type: mime });
    },
  };
});

const OriginalIO = globalThis.IntersectionObserver;
function installImmediateIO() {
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = class {
    constructor(private readonly cb: IntersectionObserverCallback) {}
    observe() {
      this.cb(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver
      );
    }
    disconnect = vi.fn();
    unobserve = vi.fn();
  };
}

function mockFetchSuccess(mimeType: string) {
  mockApiFetch.mockResolvedValue({
    ok: true,
    body: new ReadableStream<Uint8Array>(),
    headers: new Headers({ 'X-File-Mime-Type': mimeType }),
  });
}

beforeEach(() => {
  resetAllStores();
  readBodyDuringDecrypt = false;
  vi.clearAllMocks();
  __resetBlobCacheForTests();
  installImmediateIO();
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = OriginalIO;
});

describe('image preload cap', () => {
  const cap = 134_218_232;
  const image = (
    id: string,
    size: number,
    file_type: 'photo' | 'animated' = 'photo'
  ): AttachmentSummary => ({
    id,
    file_type,
    mime_type: 'image/png',
    file_size: size,
  });

  it('requires a click before loading a large photo or animated image', async () => {
    mockFetchSuccess('image/png');
    const view = render(
      <AttachmentDisplay attachments={[image('large', cap + 1)]} channelId="c" />
    );
    const button = screen.getByRole('button', { name: /load image/i });
    expect(mockApiFetch).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
    view.unmount();
    mockApiFetch.mockClear();
    render(
      <AttachmentDisplay attachments={[image('large-gif', cap + 1, 'animated')]} channelId="c" />
    );
    expect(screen.getByRole('button', { name: /load image/i })).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('asks again before reloading an oversized image after scrolling away', async () => {
    let notify!: (visible: boolean) => void;
    (globalThis as unknown as Record<string, unknown>).IntersectionObserver = class {
      constructor(private readonly cb: IntersectionObserverCallback) {
        notify = (visible) =>
          this.cb(
            [{ isIntersecting: visible } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver
          );
      }
      observe() {
        notify(true);
      }
      disconnect = vi.fn();
      unobserve = vi.fn();
    };
    mockFetchSuccess('image/png');
    render(<AttachmentDisplay attachments={[image('scroll-large', cap + 1)]} channelId="c" />);
    fireEvent.click(screen.getByRole('button', { name: /load image/i }));
    await waitFor(() => expect(document.querySelector('img.attachment-image')).not.toBeNull());
    act(() => notify(false));
    act(() => notify(true));
    expect(screen.getByRole('button', { name: /load image/i })).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /load image/i }));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
  });

  it('does not bypass the size gate when GIF auto-loading is enabled', () => {
    usePrivacyStore.setState((state) => ({
      settings: { ...state.settings, loadGifsAutomatically: false },
    }));
    render(
      <AttachmentDisplay attachments={[image('gif-size', cap + 1, 'animated')]} channelId="c" />
    );
    act(() =>
      usePrivacyStore.setState((state) => ({
        settings: { ...state.settings, loadGifsAutomatically: true },
      }))
    );
    expect(screen.getByRole('button', { name: /load image/i })).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('requires a click for an unknown length', () => {
    render(<AttachmentDisplay attachments={[image('unknown', 0)]} channelId="c" />);
    expect(screen.getByRole('button', { name: /load image/i })).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('keeps auto-loading an image at the cap', async () => {
    mockFetchSuccess('image/png');
    render(<AttachmentDisplay attachments={[image('small', cap)]} channelId="c" />);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
  });

  it('stops an oversized streamed body even without a trustworthy Content-Length', async () => {
    readBodyDuringDecrypt = true;
    const chunk = new Uint8Array(1024 * 1024);
    const cancelled = vi.fn();
    let chunks = 0;
    mockApiFetch.mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        pull(controller) {
          chunks += 1;
          controller.enqueue(chunk);
        },
        cancel: cancelled,
      }),
      headers: new Headers({ 'X-File-Mime-Type': 'image/png' }),
    });
    render(<AttachmentDisplay attachments={[image('lying-stream', 100)]} channelId="c" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /load image/i })).toBeInTheDocument()
    );
    await waitFor(() => expect(cancelled).toHaveBeenCalled());
    expect(chunks).toBeLessThanOrEqual(131);
  });

  it('honors a click made while an automatic GIF request is in flight', async () => {
    let resolveFirst!: (response: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    mockFetchSuccess('image/gif');
    mockApiFetch.mockReturnValueOnce(pending);
    render(<AttachmentDisplay attachments={[image('gif-race', 100, 'animated')]} channelId="c" />);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
    act(() =>
      usePrivacyStore.setState((state) => ({
        settings: { ...state.settings, loadGifsAutomatically: false },
      }))
    );
    fireEvent.click(screen.getByRole('button', { name: 'Click to load GIF' }));
    await act(async () =>
      resolveFirst({
        ok: true,
        body: new ReadableStream(),
        headers: new Headers({
          'X-File-Mime-Type': 'image/gif',
          'Content-Length': String(cap + 1),
        }),
      })
    );
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.querySelector('img.attachment-image')).not.toBeNull());
  });

  it('does not restart a consented request after the surface unmounts', async () => {
    let resolveFirst!: (response: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const cancelled = vi.fn();
    mockApiFetch.mockReturnValueOnce(pending);
    const view = render(
      <AttachmentDisplay attachments={[image('unmount-race', 100, 'animated')]} channelId="c" />
    );
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
    act(() =>
      usePrivacyStore.setState((state) => ({
        settings: { ...state.settings, loadGifsAutomatically: false },
      }))
    );
    fireEvent.click(screen.getByRole('button', { name: 'Click to load GIF' }));
    view.unmount();
    await act(async () =>
      resolveFirst({
        ok: true,
        body: new ReadableStream({ cancel: cancelled }),
        headers: new Headers({
          'X-File-Mime-Type': 'image/gif',
          'Content-Length': String(cap + 1),
        }),
      })
    );
    await waitFor(() => expect(cancelled).toHaveBeenCalled());
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it('honors a manual request that shares a bounded in-flight load', async () => {
    let resolveFirst!: (response: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    mockFetchSuccess('image/png');
    mockApiFetch.mockReturnValueOnce(pending);
    const first = render(
      <AttachmentDisplay attachments={[image('shared-race', 100)]} channelId="c" />
    );
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
    const second = render(
      <AttachmentDisplay attachments={[image('shared-race', cap + 1)]} channelId="c" />
    );
    fireEvent.click(screen.getByRole('button', { name: /load image/i }));
    await act(async () =>
      resolveFirst({
        ok: true,
        body: new ReadableStream(),
        headers: new Headers({
          'X-File-Mime-Type': 'image/png',
          'Content-Length': String(cap + 1),
        }),
      })
    );
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(second.container.querySelector('img.attachment-image')).not.toBeNull()
    );
    first.unmount();
    second.unmount();
  });

  it('asks before decrypting when response length exceeds its small summary', async () => {
    const cancel = vi.fn();
    mockApiFetch.mockResolvedValue({
      ok: true,
      body: new ReadableStream({ cancel }),
      headers: new Headers({ 'X-File-Mime-Type': 'image/png', 'Content-Length': String(cap + 1) }),
    });
    render(<AttachmentDisplay attachments={[image('understated', 100)]} channelId="c" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /load image/i })).toBeInTheDocument()
    );
    expect(cancel).toHaveBeenCalled();
  });
});

describe('video preload cap', () => {
  const video = (id: string, size: number): AttachmentSummary => ({
    id,
    file_type: 'video',
    mime_type: 'video/mp4',
    file_size: size,
  });

  it('requires consent for a large image disguised as a video', async () => {
    mockFetchSuccess('image/png');
    render(
      <AttachmentDisplay attachments={[video('v-disguised', 200 * 1024 * 1024)]} channelId="c" />
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(mockApiFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Large video — download 200.0 MB?'));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledOnce());
  });

  it('preloads a video at the automatic media ceiling', async () => {
    mockFetchSuccess('video/mp4');
    render(
      <AttachmentDisplay attachments={[video('v-cap', VIDEO_PRELOAD_MAX_BYTES)]} channelId="c" />
    );
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
  });

  it('asks when a video response exceeds its small summary', async () => {
    const cancel = vi.fn();
    mockApiFetch.mockResolvedValue({
      ok: true,
      body: new ReadableStream({ cancel }),
      headers: new Headers({
        'X-File-Mime-Type': 'video/mp4',
        'Content-Length': String(VIDEO_PRELOAD_MAX_BYTES + 1),
      }),
    });
    render(<AttachmentDisplay attachments={[video('v-understated', 100)]} channelId="c" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Large video — download\?/i })).toBeInTheDocument()
    );
    expect(cancel).toHaveBeenCalled();
  });

  it('asks before downloading a video above the automatic media ceiling', async () => {
    mockFetchSuccess('video/mp4');
    render(
      <AttachmentDisplay
        attachments={[video('v-big', VIDEO_PRELOAD_MAX_BYTES + 1)]}
        channelId="c"
      />
    );
    const confirm = screen.getByText('Large video — download 128.0 MB?');
    expect(mockApiFetch).not.toHaveBeenCalled();

    fireEvent.click(confirm);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
  });
});

describe('animated attachments follow the KLIPY GIF rules', () => {
  const gif: AttachmentSummary = {
    id: 'gif-1',
    file_type: 'animated',
    mime_type: 'image/gif',
    file_size: 1000,
  };

  it('waits for a click when "load GIFs automatically" is off', async () => {
    usePrivacyStore.setState((s) => ({
      settings: { ...s.settings, loadGifsAutomatically: false },
    }));
    mockFetchSuccess('image/gif');
    render(<AttachmentDisplay attachments={[gif]} channelId="c" />);

    const placeholder = screen.getByRole('button', { name: 'Click to load GIF' });
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(document.querySelector('.attachment-loading')).toBeNull();

    fireEvent.click(placeholder);
    await waitFor(() => expect(document.querySelector('img.attachment-image')).not.toBeNull());
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it('loads once the setting is switched on while a GIF waits for a click', async () => {
    usePrivacyStore.setState((s) => ({
      settings: { ...s.settings, loadGifsAutomatically: false },
    }));
    mockFetchSuccess('image/gif');
    render(<AttachmentDisplay attachments={[gif]} channelId="c" />);
    expect(screen.getByRole('button', { name: 'Click to load GIF' })).toBeInTheDocument();

    act(() => {
      usePrivacyStore.setState((s) => ({
        settings: { ...s.settings, loadGifsAutomatically: true },
      }));
    });
    await waitFor(() => expect(document.querySelector('img.attachment-image')).not.toBeNull());
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it('loads without a click when the setting is on', async () => {
    mockFetchSuccess('image/gif');
    render(<AttachmentDisplay attachments={[gif]} channelId="c" />);
    await waitFor(() => expect(document.querySelector('img.attachment-image')).not.toBeNull());
    expect(screen.queryByText('Click to load GIF')).toBeNull();
  });

  describe('paused still frame', () => {
    const originalDecode = HTMLImageElement.prototype.decode;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalBitmap = (globalThis as Record<string, unknown>).createImageBitmap;

    beforeEach(() => {
      HTMLImageElement.prototype.decode = () => Promise.resolve();
      HTMLCanvasElement.prototype.getContext = (() => null) as never;
      HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
        cb(new Blob(['still'], { type: 'image/png' }));
      };
      (globalThis as Record<string, unknown>).createImageBitmap = vi.fn(() =>
        Promise.resolve({ width: 4, height: 4, close: vi.fn() })
      );
    });

    afterEach(() => {
      HTMLImageElement.prototype.decode = originalDecode;
      HTMLCanvasElement.prototype.toBlob = originalToBlob;
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      (globalThis as Record<string, unknown>).createImageBitmap = originalBitmap;
    });

    it('makes no still while the image is playing', async () => {
      useSettingsStore.setState((s) => ({
        appearance: { ...s.appearance, reduceAnimations: false, gifPlayback: 'always' },
      }));
      mockFetchSuccess('image/gif');
      render(<AttachmentDisplay attachments={[gif]} channelId="c" />);

      await waitFor(() => expect(document.querySelector('img.attachment-image')).not.toBeNull());
      expect((globalThis as Record<string, unknown>).createImageBitmap).not.toHaveBeenCalled();
    });

    it('shows the first frame instead of a blank box while hover-gated', async () => {
      useSettingsStore.setState((s) => ({
        appearance: { ...s.appearance, reduceAnimations: false, gifPlayback: 'hover' },
      }));
      mockFetchSuccess('image/gif');
      render(<AttachmentDisplay attachments={[gif]} channelId="c" />);

      await waitFor(() => expect(document.querySelector('img.attachment-image')).not.toBeNull());
      expect(screen.queryByText('Hover to play')).toBeNull();
      expect(document.querySelector('.attachment-image-placeholder')).toBeNull();
    });

    it('does not keep a clicked GIF playing on focus the chip took with it', async () => {
      useSettingsStore.setState((s) => ({
        appearance: { ...s.appearance, reduceAnimations: false, gifPlayback: 'hover' },
      }));
      usePrivacyStore.setState((s) => ({
        settings: { ...s.settings, loadGifsAutomatically: false },
      }));
      mockFetchSuccess('image/gif');
      render(<AttachmentDisplay attachments={[gif]} channelId="c" />);

      const chip = screen.getByRole('button', { name: 'Click to load GIF' });
      fireEvent.focus(chip);
      fireEvent.click(chip);
      // Paused on hover mode once the pointer is gone, so a still frame is made.
      await waitFor(() =>
        expect((globalThis as Record<string, unknown>).createImageBitmap).toHaveBeenCalled()
      );
    });
  });
});

describe('text attachments preload into the collapsible text space', () => {
  it.each([
    ['text/plain', 'text', ''],
    ['text/markdown', 'markdown', 'body'],
  ])('routes %s as %s', (mime, format, preview) => {
    render(
      <AttachmentDisplay
        attachments={[{ id: `t-${format}`, file_type: 'file', mime_type: mime, file_size: 10 }]}
        channelId="c"
        messageBody="body"
      />
    );
    const el = screen.getByTestId('text-attachment');
    expect(el).toHaveAttribute('data-format', format);
    // The message body is only a stand-in for overflow Markdown, never for text.
    expect(el.textContent).toBe(preview);
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'never routes a prototype key (%s) as a text format',
    (mime) => {
      render(
        <AttachmentDisplay
          attachments={[{ id: `p-${mime}`, file_type: 'file', mime_type: mime, file_size: 10 }]}
          channelId="c"
        />
      );
      expect(screen.queryByTestId('text-attachment')).toBeNull();
      expect(screen.getByRole('button', { name: 'Download attachment' })).toBeInTheDocument();
    }
  );

  it('leaves any other file as a download card that fetches nothing', () => {
    render(
      <AttachmentDisplay
        attachments={[
          { id: 'pdf', file_type: 'file', mime_type: 'application/pdf', file_size: 10 },
        ]}
        channelId="c"
      />
    );
    expect(screen.getByRole('button', { name: 'Download attachment' })).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
