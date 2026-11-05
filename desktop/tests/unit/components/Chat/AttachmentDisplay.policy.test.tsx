/**
 * Attachment display policy (Mark, 2026-11-05): files never download until the
 * user asks, except photos, animated images (on the KLIPY GIF rules), videos up
 * to 256 MiB on Desktop, and text/Markdown, which preload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../../../test-utils';
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
    decryptAttachmentBlob: (_bytes: Uint8Array, _key: unknown, mime: string) =>
      Promise.resolve(new Blob([new Uint8Array(16)], { type: mime })),
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
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)),
    headers: new Headers({ 'X-File-Mime-Type': mimeType }),
  });
}

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  __resetBlobCacheForTests();
  installImmediateIO();
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = OriginalIO;
});

describe('video preload cap', () => {
  const video = (id: string, size: number): AttachmentSummary => ({
    id,
    file_type: 'video',
    mime_type: 'video/mp4',
    file_size: size,
  });

  it('preloads a video at exactly 256 MiB', async () => {
    mockFetchSuccess('video/mp4');
    render(
      <AttachmentDisplay attachments={[video('v-cap', VIDEO_PRELOAD_MAX_BYTES)]} channelId="c" />
    );
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
  });

  it('asks before downloading a video above 256 MiB, then loads on confirm', async () => {
    mockFetchSuccess('video/mp4');
    render(
      <AttachmentDisplay
        attachments={[video('v-big', VIDEO_PRELOAD_MAX_BYTES + 1)]}
        channelId="c"
      />
    );
    const confirm = screen.getByText('Large video — download 256.0 MB?');
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
