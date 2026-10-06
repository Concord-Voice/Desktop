import { render } from '../../../test-utils';
import { vi } from 'vitest';
import { useSettingsStore } from '@/renderer/stores/ui/settingsStore';
import { useAuthStore } from '@/renderer/stores/auth/authStore';
import { useUserStore } from '@/renderer/stores/auth/userStore';
import { mockUser } from '../../../mocks/fixtures';
import { resetAllStores } from '../../../helpers/store-helpers';

vi.mock('@/renderer/services/system/apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ sessions: [], past_sessions: [] }),
  }),
  API_BASE: 'http://localhost:8080',
}));

vi.mock('@/renderer/components/Auth/LoadingSpinner', () => ({
  default: ({ size, inline }: { size?: string; inline?: boolean }) => (
    <div data-testid="loading-spinner" data-size={size} data-inline={inline}>
      Loading...
    </div>
  ),
}));

import SettingsPage from '@/renderer/components/Settings/SettingsPage';

// jsdom lacks scrollIntoView
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  Element.prototype.scrollIntoView = vi.fn();
});

function openCollapsibleIds(): string[] {
  return Array.from(document.querySelectorAll('details.settings-collapsible[open]')).map(
    (el) => el.id || '(no id)'
  );
}

describe('SettingsPage section memory (#2365)', () => {
  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
    useAuthStore.getState().setAccessToken('mock-token');
    useUserStore.setState({ user: mockUser });
    useSettingsStore.setState({
      appearance: {
        theme: 'dark',
        colorScheme: 'concord',
        fontSize: 'default',
        compactMode: false,
        reduceAnimations: false,
        customColors: null,
      },
    });
  });

  it('I1 default Appearance pane renders no open collapsible on first visit (#2365)', () => {
    render(<SettingsPage />);

    // Positive gate: the pane really rendered collapsibles, including the one the bug
    // leaves expanded, so an empty open-list below cannot mean "nothing rendered".
    expect(document.getElementById('client-behavior')).not.toBeNull();
    expect(document.querySelectorAll('details.settings-collapsible').length).toBeGreaterThan(0);

    const open = openCollapsibleIds();
    expect(
      open,
      `expected no Settings section to be open on first visit, but these are open: ${open.join(', ')}`
    ).toEqual([]);
  });

  // Later tests (I2–I6) are appended by Task 3.
});
