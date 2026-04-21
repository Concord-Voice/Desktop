import { render } from '../../../test-utils';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetAllStores } from '../../../helpers/store-helpers';
import DMPrivacyControls from '@/renderer/components/Settings/DMPrivacyControls';

describe('DMPrivacyControls', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('renders the DM privacy slider header', () => {
    const { getByText } = render(
      <DMPrivacyControls localDmLevel={2} setDmPrivacyLevel={vi.fn()} />
    );
    expect(getByText(/who can dm you/i)).toBeInTheDocument();
  });
});
