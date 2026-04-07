import { render, screen, fireEvent, act, waitFor } from '../../../test-utils';
import GifEmbed from '@/renderer/components/Chat/GifEmbed';
import { resetAllStores } from '../../../helpers/store-helpers';

// Capture IntersectionObserver callbacks so we can trigger visibility manually
let observerCallback: (entries: { isIntersecting: boolean }[]) => void;

beforeAll(() => {
  // Override the setup.ts mock with one that captures the callback (writable: true in setup)
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      observerCallback = callback;
    }
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
  };
});

// Mock the gifProvider so we don't make any network calls.
const mockResolvedVideo = {
  slug: 'mp4-test-slug',
  width: 480,
  height: 270,
  animatedUrl: 'https://media.klipy.com/abc.mp4',
  animatedKind: 'video' as const,
  stillUrl: 'https://media.klipy.com/abc.jpg',
};

const mockResolvedImage = {
  slug: 'gif-test-slug',
  width: 200,
  height: 200,
  animatedUrl: 'https://media.klipy.com/abc.gif',
  animatedKind: 'image' as const,
  stillUrl: 'https://media.klipy.com/abc.jpg',
};

const getBySlugMock = vi.fn();
vi.mock('@/renderer/services/gifProvider', () => ({
  gifProvider: {
    name: 'KLIPY',
    searchPlaceholder: 'Search KLIPY',
    poweredByText: 'Powered by KLIPY',
    logoAssetLight: './branding/KLIPY/klipy-logo-light.svg',
    logoAssetDark: './branding/KLIPY/klipy-logo-dark.svg',
    independenceDisclaimer: 'Independent disclaimer',
    supportsRecent: true,
    supportsCategories: true,
    trending: vi.fn(),
    search: vi.fn(),
    recent: vi.fn(),
    categories: vi.fn(),
    getBySlug: (slug: string) => getBySlugMock(slug),
    notifyShared: vi.fn(),
    report: vi.fn(),
    setProxyEnabled: vi.fn(),
    setPersonalizationEnabled: vi.fn(),
  },
}));

function triggerVisible() {
  act(() => {
    observerCallback([{ isIntersecting: true }]);
  });
}

describe('GifEmbed', () => {
  beforeEach(() => {
    resetAllStores();
    getBySlugMock.mockReset();
  });

  it('renders nothing when embedsSuppressed is true', () => {
    const { container } = render(
      <GifEmbed slug="abc" reduceMotion={false} loadAutomatically={true} embedsSuppressed={true} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('shows click-to-load placeholder when loadAutomatically is false', () => {
    render(<GifEmbed slug="abc" reduceMotion={false} loadAutomatically={false} />);
    expect(screen.getByText('Click to load GIF')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Click to load GIF' })).toBeInTheDocument();
  });

  it('does not call gifProvider.getBySlug while click-to-load placeholder is shown', () => {
    render(<GifEmbed slug="abc" reduceMotion={false} loadAutomatically={false} />);
    triggerVisible();
    expect(getBySlugMock).not.toHaveBeenCalled();
  });

  it('fetches via gifProvider when user clicks the placeholder', async () => {
    getBySlugMock.mockResolvedValue(mockResolvedVideo);
    render(<GifEmbed slug="abc" reduceMotion={false} loadAutomatically={false} />);
    fireEvent.click(screen.getByText('Click to load GIF'));
    triggerVisible();
    await waitFor(() => expect(getBySlugMock).toHaveBeenCalledWith('abc'));
  });

  it('renders <video> for MP4 renditions when loadAutomatically and not reduceMotion', async () => {
    getBySlugMock.mockResolvedValue(mockResolvedVideo);
    const { container } = render(
      <GifEmbed slug="mp4-test-slug" reduceMotion={false} loadAutomatically={true} />
    );
    triggerVisible();
    await waitFor(() => {
      const video = container.querySelector('video');
      expect(video).not.toBeNull();
      expect(video?.getAttribute('src')).toBe('https://media.klipy.com/abc.mp4');
      expect(video?.getAttribute('poster')).toBe('https://media.klipy.com/abc.jpg');
    });
  });

  it('renders <img> for GIF/WEBP renditions', async () => {
    getBySlugMock.mockResolvedValue(mockResolvedImage);
    const { container } = render(
      <GifEmbed slug="gif-test-slug" reduceMotion={false} loadAutomatically={true} />
    );
    triggerVisible();
    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe('https://media.klipy.com/abc.gif');
    });
  });

  it('renders the still rendition when reduceMotion is true', async () => {
    getBySlugMock.mockResolvedValue(mockResolvedVideo);
    const { container } = render(
      <GifEmbed slug="mp4-test-slug" reduceMotion={true} loadAutomatically={true} />
    );
    triggerVisible();
    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe('https://media.klipy.com/abc.jpg');
      // No video element when reduce-motion is on
      expect(container.querySelector('video')).toBeNull();
    });
  });

  it('renders error state when gifProvider rejects', async () => {
    getBySlugMock.mockRejectedValue(new Error('not found'));
    render(<GifEmbed slug="missing" reduceMotion={false} loadAutomatically={true} />);
    triggerVisible();
    await waitFor(() => {
      expect(screen.getByText('GIF unavailable')).toBeInTheDocument();
    });
  });

  it('shows the Powered by KLIPY attribution when a GIF is rendered', async () => {
    getBySlugMock.mockResolvedValue(mockResolvedVideo);
    render(<GifEmbed slug="mp4-test-slug" reduceMotion={false} loadAutomatically={true} />);
    triggerVisible();
    await waitFor(() => {
      expect(screen.getByText('Powered by KLIPY')).toBeInTheDocument();
    });
  });

  it('the rendered <video> has accessible aria-label', async () => {
    getBySlugMock.mockResolvedValue(mockResolvedVideo);
    const { container } = render(
      <GifEmbed slug="mp4-test-slug" reduceMotion={false} loadAutomatically={true} />
    );
    triggerVisible();
    await waitFor(() => {
      const video = container.querySelector('video');
      expect(video?.getAttribute('aria-label')).toBe('GIF from KLIPY');
    });
  });
});
