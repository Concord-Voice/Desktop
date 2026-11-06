import { render, screen, userEvent } from '../../../test-utils';
import ImageCropEditor from '@/renderer/components/ui/ImageCropEditor';
import { vi, type Mock } from 'vitest';

// Mock apiFetch
vi.mock('@/renderer/services/system/apiClient', () => ({
  apiFetch: vi.fn(),
}));

// Canvas mocks are provided globally by tests/setup.ts.
// This file relies on those mocks — no local overrides needed.

describe('ImageCropEditor', () => {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  const file = new File(['pixels'], 'photo.png', { type: 'image/png' });

  const defaultProps = {
    isOpen: true,
    onClose,
    onConfirm,
    imageFile: file,
    title: 'Crop Avatar',
    cropShape: { type: 'circle' as const },
    output: { width: 512, height: 512, quality: 0.9 },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders modal with correct title when open', () => {
    render(<ImageCropEditor {...defaultProps} />);
    expect(screen.getByText('Crop Avatar')).toBeInTheDocument();
  });

  it('does not render when isOpen is false', () => {
    render(<ImageCropEditor {...defaultProps} isOpen={false} />);
    expect(screen.queryByText('Crop Avatar')).not.toBeInTheDocument();
  });

  it('shows loading state initially', () => {
    render(<ImageCropEditor {...defaultProps} />);
    expect(screen.getByText('Loading image...')).toBeInTheDocument();
  });

  it('calls onClose when Cancel is clicked', async () => {
    // Simulate image loaded by triggering the Image onload
    const originalImage = global.Image;
    global.Image = class MockImage {
      naturalWidth = 1024;
      naturalHeight = 1024;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    } as unknown as typeof Image;

    const user = userEvent.setup();
    render(<ImageCropEditor {...defaultProps} />);

    // Wait for image to "load"
    await screen.findByText('Cancel');
    await user.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();

    global.Image = originalImage;
  });

  it('calls onClose on Escape key', async () => {
    const user = userEvent.setup();
    render(<ImageCropEditor {...defaultProps} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('renders zoom slider after image loads', async () => {
    const originalImage = global.Image;
    global.Image = class MockImage {
      naturalWidth = 1024;
      naturalHeight = 1024;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    } as unknown as typeof Image;

    render(<ImageCropEditor {...defaultProps} />);
    const slider = await screen.findByLabelText('Zoom level');
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveAttribute('type', 'range');

    global.Image = originalImage;
  });

  it('shows drag hint text', async () => {
    const originalImage = global.Image;
    global.Image = class MockImage {
      naturalWidth = 1024;
      naturalHeight = 1024;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    } as unknown as typeof Image;

    render(<ImageCropEditor {...defaultProps} />);
    expect(await screen.findByText('Drag to reposition, scroll to zoom')).toBeInTheDocument();

    global.Image = originalImage;
  });

  it('shows small image warning when source is smaller than output', async () => {
    const originalImage = global.Image;
    global.Image = class MockImage {
      naturalWidth = 100;
      naturalHeight = 100;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    } as unknown as typeof Image;

    render(<ImageCropEditor {...defaultProps} />);
    expect(await screen.findByText(/Quality may/)).toBeInTheDocument();

    global.Image = originalImage;
  });

  it('calls onConfirm with data URL when no upload config', async () => {
    const originalImage = global.Image;
    global.Image = class MockImage {
      naturalWidth = 1024;
      naturalHeight = 1024;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    } as unknown as typeof Image;

    // Mock FileReader for the blobToDataUrl fallback
    const originalFileReader = global.FileReader;
    global.FileReader = class MockFileReader {
      result: string | ArrayBuffer | null = 'data:image/jpeg;base64,cropped';
      onload: ((ev: ProgressEvent<FileReader>) => void) | null = null;
      onerror: ((ev: ProgressEvent<FileReader>) => void) | null = null;
      readAsDataURL() {
        setTimeout(() => this.onload?.({} as ProgressEvent<FileReader>), 0);
      }
    } as unknown as typeof FileReader;

    const user = userEvent.setup();
    render(<ImageCropEditor {...defaultProps} />);

    await screen.findByText('Apply');
    await user.click(screen.getByText('Apply'));

    // Wait for async confirm handler
    await vi.waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith('data:image/jpeg;base64,cropped');
    });

    global.Image = originalImage;
    global.FileReader = originalFileReader;
  });

  it('uploads to object storage when upload config provided', async () => {
    const { apiFetch } = await import('@/renderer/services/system/apiClient');
    (apiFetch as Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ url: '/api/v1/media/avatars/123' }),
    });

    const originalImage = global.Image;
    global.Image = class MockImage {
      naturalWidth = 1024;
      naturalHeight = 1024;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    } as unknown as typeof Image;

    const user = userEvent.setup();
    render(
      <ImageCropEditor {...defaultProps} upload={{ endpoint: '/api/v1/media/upload/avatar' }} />
    );

    await screen.findByText('Apply');
    await user.click(screen.getByText('Apply'));

    await vi.waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/v1/media/upload/avatar',
        expect.objectContaining({
          method: 'POST',
        }),
        expect.objectContaining({ context: expect.anything() })
      );
      expect(onConfirm).toHaveBeenCalledWith('/api/v1/media/avatars/123');
    });

    global.Image = originalImage;
  });

  describe('animated GIF (#1302)', () => {
    // A 1×1 two-frame GIF89a, and the same with one frame.
    const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0];
    const gifBytes = (frames: number): Uint8Array =>
      new Uint8Array([
        ...Array.from('GIF89a', (c) => c.charCodeAt(0)),
        1,
        0,
        1,
        0,
        0x80,
        0,
        0,
        0,
        0,
        0,
        255,
        255,
        255,
        ...Array.from({ length: frames }, () => frame).flat(),
        0x3b,
      ]);
    const gifFile = (frames: number): File =>
      new File([gifBytes(frames)], 'party.gif', { type: 'image/gif' });

    let originalImage: typeof Image;
    beforeEach(async () => {
      const { apiFetch } = await import('@/renderer/services/system/apiClient');
      (apiFetch as Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ url: '/api/v1/media/avatars/123' }),
      });
      originalImage = global.Image;
      global.Image = class MockImage {
        naturalWidth = 1024;
        naturalHeight = 1024;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_: string) {
          setTimeout(() => this.onload?.(), 0);
        }
      } as unknown as typeof Image;
    });
    afterEach(() => {
      global.Image = originalImage;
    });

    async function sentFile(imageFile: File, allowAnimated: boolean): Promise<File> {
      const { apiFetch } = await import('@/renderer/services/system/apiClient');
      const user = userEvent.setup();
      render(
        <ImageCropEditor
          {...defaultProps}
          imageFile={imageFile}
          upload={{ endpoint: '/api/v1/media/upload/avatar', allowAnimated }}
        />
      );
      await screen.findByText('Apply');
      if (allowAnimated && imageFile.name === 'party.gif') {
        await screen.findByText(/keeps its animation/);
      }
      await user.click(screen.getByText('Apply'));
      await vi.waitFor(() => expect(onConfirm).toHaveBeenCalled());
      const body = (apiFetch as Mock).mock.calls[0][1].body as FormData;
      return body.get('file') as File;
    }

    it('sends an animated GIF whole where animation is allowed', async () => {
      const original = gifFile(2);
      const sent = await sentFile(original, true);
      expect(sent.name).toBe('cropped.gif');
      expect(sent.type).toBe('image/gif');
      expect(new Uint8Array(await sent.arrayBuffer())).toEqual(gifBytes(2));
    });

    it('crops an animated GIF to a still where animation is not allowed', async () => {
      const sent = await sentFile(gifFile(2), false);
      expect(sent.type).not.toBe('image/gif');
      expect(screen.getByText('Drag to reposition, scroll to zoom')).toBeInTheDocument();
    });

    it('crops a single-frame GIF even where animation is allowed', async () => {
      const single = new File([gifBytes(1)], 'still.gif', { type: 'image/gif' });
      const sent = await sentFile(single, true);
      expect(sent.type).not.toBe('image/gif');
    });
  });

  // ── ARIA / a11y attributes ───────────────────────────────────────────

  it('renders canvas element inside crop button', async () => {
    const originalImage = global.Image;
    global.Image = class MockImage {
      naturalWidth = 1024;
      naturalHeight = 1024;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    } as unknown as typeof Image;

    render(<ImageCropEditor {...defaultProps} />);
    await screen.findByText('Cancel');
    // ImageCropEditor renders inside a Modal, which portals to document.body
    // (#2087) — query document-scoped rather than the render container.
    const canvas = document.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
    // Canvas is a child of the interactive crop button — no aria-hidden needed
    expect(canvas?.closest('button')).toBeInTheDocument();

    global.Image = originalImage;
  });

  it('renders crop area as interactive button with aria-label', async () => {
    const originalImage = global.Image;
    global.Image = class MockImage {
      naturalWidth = 1024;
      naturalHeight = 1024;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    } as unknown as typeof Image;

    render(<ImageCropEditor {...defaultProps} />);
    await screen.findByText('Cancel');
    const cropArea = screen.getByRole('button', {
      name: 'Image crop editor — drag to reposition, scroll to zoom',
    });
    expect(cropArea).toBeInTheDocument();
    expect(cropArea).toHaveClass('image-crop-preview');

    global.Image = originalImage;
  });

  it('renders zoom slider with aria-label "Zoom level"', async () => {
    const originalImage = global.Image;
    global.Image = class MockImage {
      naturalWidth = 1024;
      naturalHeight = 1024;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    } as unknown as typeof Image;

    render(<ImageCropEditor {...defaultProps} />);
    const slider = await screen.findByLabelText('Zoom level');
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveAttribute('aria-label', 'Zoom level');

    global.Image = originalImage;
  });

  it('shows upload error on failure', async () => {
    const { apiFetch } = await import('@/renderer/services/system/apiClient');
    (apiFetch as Mock).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'File too large' }),
    });

    const originalImage = global.Image;
    global.Image = class MockImage {
      naturalWidth = 1024;
      naturalHeight = 1024;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    } as unknown as typeof Image;

    const user = userEvent.setup();
    render(
      <ImageCropEditor {...defaultProps} upload={{ endpoint: '/api/v1/media/upload/avatar' }} />
    );

    await screen.findByText('Apply');
    await user.click(screen.getByText('Apply'));

    expect(await screen.findByText('File too large')).toBeInTheDocument();

    global.Image = originalImage;
  });
});
