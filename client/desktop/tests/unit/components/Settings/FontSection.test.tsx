import { render, screen, fireEvent, userEvent } from '../../../test-utils';
import { vi } from 'vitest';

// Mirrors AccessibilitySection.test.tsx — mock the draft hook so the section renders
// in isolation. Variable is `mock`-prefixed so Vitest's hoisted factory may reference it.
const mockSetDraftAppearanceSetting = vi.fn();
let mockAppFont = 'default';
let mockColorScheme = 'concord';
let mockDyslexicSupport = false;

vi.mock('@/renderer/hooks/useDraftSettings', () => ({
  useDraftAppearance: vi.fn(() => ({
    theme: 'dark',
    colorScheme: mockColorScheme,
    fontSize: 'default',
    compactMode: false,
    reduceAnimations: false,
    uiScale: 1,
    highContrast: false,
    customColors: null,
    appFont: mockAppFont,
    dyslexicSupport: mockDyslexicSupport,
  })),
  setDraftAppearanceSetting: (...args: unknown[]) => mockSetDraftAppearanceSetting(...args),
}));

import FontSection from '@/renderer/components/Settings/FontSection';

beforeEach(() => {
  mockAppFont = 'default';
  mockColorScheme = 'concord';
  mockDyslexicSupport = false;
  mockSetDraftAppearanceSetting.mockClear();
});

describe('FontSection (Appearance ▸ Fonts)', () => {
  it('renders the font options', () => {
    render(<FontSection />);
    expect(screen.getByRole('button', { name: /Concord Voice Default/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /System Default/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /OpenDyslexic/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Inter/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Lexend/i })).toBeInTheDocument();
  });

  it('clicking a font writes appFont to the draft store', () => {
    render(<FontSection />);
    fireEvent.click(screen.getByRole('button', { name: /Inter/i }));
    expect(mockSetDraftAppearanceSetting).toHaveBeenCalledWith('appFont', 'inter');
  });

  it('marks the active font with aria-pressed', () => {
    mockAppFont = 'lexend';
    render(<FontSection />);
    expect(screen.getByRole('button', { name: /Lexend/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Inter/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('font options are keyboard-activatable (Enter on a focused option)', async () => {
    const user = userEvent.setup();
    render(<FontSection />);
    const inter = screen.getByRole('button', { name: /Inter/i });
    inter.focus();
    await user.keyboard('{Enter}');
    expect(mockSetDraftAppearanceSetting).toHaveBeenCalledWith('appFont', 'inter');
  });

  it('reveals the theme-bundled font when a font-bundling scheme is active', () => {
    mockColorScheme = 'agency';
    render(<FontSection />);
    const atkinson = screen.getByRole('button', { name: /Atkinson Hyperlegible Next/i });
    expect(atkinson).toHaveTextContent(/Provided by the active theme/i);
    // No explicit pick → the theme font is the active option (soft lock).
    expect(atkinson).toHaveAttribute('aria-pressed', 'true');
  });

  it('hides the reveal for a non-bundling scheme', () => {
    mockColorScheme = 'concord';
    render(<FontSection />);
    expect(screen.queryByText(/Provided by the active theme/i)).not.toBeInTheDocument();
  });

  it('an explicit pick overrides the theme font (soft lock — pick wins)', () => {
    mockColorScheme = 'agency';
    mockAppFont = 'inter';
    render(<FontSection />);
    expect(screen.getByRole('button', { name: /Inter/i })).toHaveAttribute('aria-pressed', 'true');
    const atkinson = screen.getByRole('button', { name: /Atkinson Hyperlegible Next/i });
    // Badge stays (informational: the scheme still bundles Atkinson) but it is not active.
    expect(atkinson).toHaveTextContent(/Provided by the active theme/i);
    expect(atkinson).toHaveAttribute('aria-pressed', 'false');
  });

  it('options stay clickable under theme-lock (override writes appFont)', () => {
    mockColorScheme = 'agency';
    render(<FontSection />);
    fireEvent.click(screen.getByRole('button', { name: /Lexend/i }));
    expect(mockSetDraftAppearanceSetting).toHaveBeenCalledWith('appFont', 'lexend');
  });

  it('does NOT render a dyslexic lock — that is #1644 (boundary check)', () => {
    // dyslexicSupport overrides the theme in the resolver (lockReason='dyslexic'),
    // so #1643's soft theme-lock does NOT make the theme font the active option:
    // activeId tracks appFont ('default'). The reveal badge still shows the scheme's
    // bundled font, but the dyslexic HARD lock UI is #1644's deliverable, not #1643's.
    mockColorScheme = 'agency';
    mockDyslexicSupport = true;
    render(<FontSection />);
    const atkinson = screen.getByRole('button', { name: /Atkinson Hyperlegible Next/i });
    expect(atkinson).toHaveTextContent(/Provided by the active theme/i); // reveal persists
    expect(atkinson).toHaveAttribute('aria-pressed', 'false'); // NOT theme-locked under dyslexic
    expect(screen.getByRole('button', { name: /Concord Voice Default/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    ); // activeId = appFont ('default')
    expect(atkinson).toBeEnabled(); // no #1643 dyslexic disable/grey-out
  });
});
