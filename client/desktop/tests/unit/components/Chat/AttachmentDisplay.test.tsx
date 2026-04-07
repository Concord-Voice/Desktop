import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '../../../test-utils';
import userEvent from '@testing-library/user-event';
import AttachmentDisplay from '@/renderer/components/Chat/AttachmentDisplay';
import type { AttachmentSummary } from '@/renderer/types/chat';
import { mockAttachment, mockAttachment2 } from '../../../mocks/fixtures';

// Mock apiClient
const mockApiFetch = vi.fn();
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// Mock e2eeService
const mockGetChannelKey = vi.fn();
vi.mock('@/renderer/services/e2eeService', () => ({
  e2eeService: {
    get isInitialized() {
      return true;
    },
    getChannelKey: (...args: unknown[]) => mockGetChannelKey(...args),
  },
}));

// Mock decryptFile
const mockDecryptFile = vi.fn();
vi.mock('@/renderer/utils/attachmentCrypto', async () => {
  const actual = await vi.importActual<typeof import('@/renderer/utils/attachmentCrypto')>(
    '@/renderer/utils/attachmentCrypto'
  );
  return {
    ...actual,
    decryptFile: (...args: unknown[]) => mockDecryptFile(...args),
  };
});

function mockFetchSuccess(data = new ArrayBuffer(100), mimeType = 'image/png') {
  mockApiFetch.mockResolvedValue({
    ok: true,
    arrayBuffer: () => Promise.resolve(data),
    headers: new Headers({ 'X-File-Mime-Type': mimeType }),
  });
}

function mockFetchFailure() {
  mockApiFetch.mockResolvedValue({
    ok: false,
    status: 500,
  });
}

// Helper to override IntersectionObserver so it fires immediately
let ioCallback: IntersectionObserverCallback | null = null;
function installImmediateIO() {
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = class {
    constructor(cb: IntersectionObserverCallback) {
      ioCallback = cb;
    }
    observe() {
      // Immediately trigger intersection
      if (ioCallback) {
        ioCallback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver
        );
      }
    }
    disconnect = vi.fn();
    unobserve = vi.fn();
  };
}

const OriginalIO = globalThis.IntersectionObserver;

describe('AttachmentDisplay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecryptFile.mockImplementation((data: ArrayBuffer) => Promise.resolve(data));
    mockGetChannelKey.mockResolvedValue({} as CryptoKey);
  });

  afterEach(() => {
    // Restore original IntersectionObserver
    (globalThis as unknown as Record<string, unknown>).IntersectionObserver = OriginalIO;
    ioCallback = null;
  });

  it('renders nothing when no attachments', () => {
    const { container } = render(
      <AttachmentDisplay attachments={[]} channelId="ch-1" isEncrypted={false} />
    );
    expect(container.firstChild).toBeNull();
  });

  // --- Image attachments ---
  it('renders image container for photo type', () => {
    const { container } = render(
      <AttachmentDisplay attachments={[mockAttachment]} channelId="ch-1" isEncrypted={false} />
    );
    expect(container.querySelector('.attachment-image-container')).toBeInTheDocument();
  });

  it('renders image after successful fetch (unencrypted)', async () => {
    mockFetchSuccess();
    installImmediateIO();
    const img: AttachmentSummary = { ...mockAttachment, id: 'img-unenc-1' };

    render(<AttachmentDisplay attachments={[img]} channelId="ch-1" isEncrypted={false} />);

    await waitFor(() => {
      expect(screen.getByAltText('Attachment img-unenc-1')).toBeInTheDocument();
    });
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/media/attachments/img-unenc-1');
    expect(mockDecryptFile).not.toHaveBeenCalled();
  });

  it('decrypts image when channel is encrypted', async () => {
    mockFetchSuccess();
    installImmediateIO();
    const img: AttachmentSummary = { ...mockAttachment, id: 'img-enc-1' };

    render(<AttachmentDisplay attachments={[img]} channelId="ch-1" isEncrypted={true} />);

    await waitFor(() => {
      expect(mockDecryptFile).toHaveBeenCalled();
    });
    expect(mockGetChannelKey).toHaveBeenCalledWith('ch-1');
  });

  it('shows error when image fetch fails', async () => {
    mockFetchFailure();
    installImmediateIO();
    const img: AttachmentSummary = { ...mockAttachment, id: 'img-fail-1' };

    render(<AttachmentDisplay attachments={[img]} channelId="ch-1" isEncrypted={false} />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load image')).toBeInTheDocument();
    });
  });

  // --- File attachments ---
  it('renders file attachment with download button', () => {
    render(
      <AttachmentDisplay attachments={[mockAttachment2]} channelId="ch-1" isEncrypted={false} />
    );
    expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument();
  });

  it('renders file size and mime type', () => {
    render(
      <AttachmentDisplay attachments={[mockAttachment2]} channelId="ch-1" isEncrypted={false} />
    );
    expect(screen.getByText('2.0 MB')).toBeInTheDocument();
    expect(screen.getByText('application/pdf')).toBeInTheDocument();
  });

  it('downloads file on click', async () => {
    mockFetchSuccess(new ArrayBuffer(50), 'application/pdf');
    const user = userEvent.setup();

    render(
      <AttachmentDisplay attachments={[mockAttachment2]} channelId="ch-1" isEncrypted={false} />
    );

    await user.click(screen.getByRole('button', { name: /download/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/media/attachments/attach-2');
    });
  });

  // --- Video attachments ---
  it('renders video load button', () => {
    const videoAttachment: AttachmentSummary = {
      id: 'vid-1',
      file_type: 'video',
      mime_type: 'video/mp4',
      file_size: 5000000,
    };
    render(
      <AttachmentDisplay attachments={[videoAttachment]} channelId="ch-1" isEncrypted={false} />
    );
    expect(screen.getByText('Load video')).toBeInTheDocument();
  });

  it('loads video on button click', async () => {
    mockFetchSuccess(new ArrayBuffer(100), 'video/mp4');
    const user = userEvent.setup();
    const videoAttachment: AttachmentSummary = {
      id: 'vid-2',
      file_type: 'video',
      mime_type: 'video/mp4',
      file_size: 5000000,
    };
    const { container } = render(
      <AttachmentDisplay attachments={[videoAttachment]} channelId="ch-1" isEncrypted={false} />
    );

    await user.click(screen.getByText('Load video'));

    await waitFor(() => {
      expect(container.querySelector('video')).toBeInTheDocument();
    });
  });

  it('auto-loads video when scrolled into view (IntersectionObserver)', async () => {
    mockFetchSuccess(new ArrayBuffer(100), 'video/mp4');
    installImmediateIO();
    const videoAttachment: AttachmentSummary = {
      id: 'vid-auto',
      file_type: 'video',
      mime_type: 'video/mp4',
      file_size: 5000000,
    };
    const { container } = render(
      <AttachmentDisplay attachments={[videoAttachment]} channelId="ch-1" isEncrypted={false} />
    );
    await waitFor(() => {
      expect(container.querySelector('video')).toBeInTheDocument();
    });
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/media/attachments/vid-auto');
  });

  it('renders rich placeholder with mime type and file size for video', () => {
    const videoAttachment: AttachmentSummary = {
      id: 'vid-meta',
      file_type: 'video',
      mime_type: 'video/mp4',
      file_size: 5_000_000,
    };
    render(
      <AttachmentDisplay attachments={[videoAttachment]} channelId="ch-1" isEncrypted={false} />
    );
    // Mime + size shown in the rich placeholder meta line
    expect(screen.getByText(/video\/mp4/)).toBeInTheDocument();
    expect(screen.getByText(/4\.8 MB|5\.0 MB|4\.77 MB/)).toBeInTheDocument();
  });

  it('shows retry text when video load fails', async () => {
    mockFetchFailure();
    installImmediateIO();
    const videoAttachment: AttachmentSummary = {
      id: 'vid-fail',
      file_type: 'video',
      mime_type: 'video/mp4',
      file_size: 1000,
    };
    render(
      <AttachmentDisplay attachments={[videoAttachment]} channelId="ch-1" isEncrypted={false} />
    );
    await waitFor(() => {
      expect(screen.getByText(/Failed to load video — retry/)).toBeInTheDocument();
    });
  });

  // --- Audio attachments ---
  it('renders audio load button', () => {
    const audioAttachment: AttachmentSummary = {
      id: 'aud-1',
      file_type: 'audio',
      mime_type: 'audio/mpeg',
      file_size: 3000000,
    };
    render(
      <AttachmentDisplay attachments={[audioAttachment]} channelId="ch-1" isEncrypted={false} />
    );
    expect(screen.getByText('Load audio')).toBeInTheDocument();
  });

  it('loads audio on button click', async () => {
    mockFetchSuccess(new ArrayBuffer(100), 'audio/mpeg');
    const user = userEvent.setup();
    const audioAttachment: AttachmentSummary = {
      id: 'aud-2',
      file_type: 'audio',
      mime_type: 'audio/mpeg',
      file_size: 3000000,
    };
    const { container } = render(
      <AttachmentDisplay attachments={[audioAttachment]} channelId="ch-1" isEncrypted={false} />
    );

    await user.click(screen.getByText('Load audio'));

    await waitFor(() => {
      expect(container.querySelector('audio')).toBeInTheDocument();
    });
  });

  // --- Multiple / animated ---
  it('renders multiple attachment types together', () => {
    const { container } = render(
      <AttachmentDisplay
        attachments={[mockAttachment, mockAttachment2]}
        channelId="ch-1"
        isEncrypted={false}
      />
    );
    expect(container.querySelector('.attachment-image-container')).toBeInTheDocument();
    expect(container.querySelector('.attachment-file-card')).toBeInTheDocument();
  });

  it('renders animated type as image container', () => {
    const gifAttachment: AttachmentSummary = {
      id: 'gif-1',
      file_type: 'animated',
      mime_type: 'image/gif',
      file_size: 500000,
    };
    const { container } = render(
      <AttachmentDisplay attachments={[gifAttachment]} channelId="ch-1" isEncrypted={false} />
    );
    expect(container.querySelector('.attachment-image-container')).toBeInTheDocument();
  });

  // --- FileIcon coverage ---
  it('renders correct icon for file type', () => {
    const unknownFile: AttachmentSummary = {
      id: 'unk-1',
      file_type: 'file',
      mime_type: 'application/octet-stream',
      file_size: 1000,
    };
    const { container } = render(
      <AttachmentDisplay attachments={[unknownFile]} channelId="ch-1" isEncrypted={false} />
    );
    expect(container.querySelector('.attachment-file-card')).toBeInTheDocument();
  });
});
