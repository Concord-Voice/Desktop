import { render } from '../../../test-utils';
import { describe, it, expect, beforeEach } from 'vitest';
import { resetAllStores } from '../../../helpers/store-helpers';
import CrashReportingSection from '@/renderer/components/Settings/CrashReportingSection';

describe('CrashReportingSection', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('renders the crash reporting section heading', () => {
    const { getByText } = render(<CrashReportingSection />);
    expect(getByText(/crash reporting/i)).toBeInTheDocument();
  });
});
