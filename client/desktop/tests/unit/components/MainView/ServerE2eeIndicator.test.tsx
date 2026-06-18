import { render, screen, fireEvent } from '../../../test-utils';
import ServerE2eeIndicator from '@/renderer/components/MainView/ServerE2eeIndicator';
import { mockServer } from '../../../mocks/fixtures';

// Extracted from MainView in the SC-1 cognitive-complexity cleanup. These tests
// cover the new file directly; MainView.test.tsx still exercises it via the full
// MainView render (the DOM is unchanged by the extraction).

// A non-zero rect so computeE2eeTooltipPos has realistic geometry. The two rects
// below drive its right-aligned vs left-clamped branches.
const rect = (over: Partial<DOMRect>): DOMRect =>
  ({
    right: 500,
    left: 260,
    bottom: 40,
    top: 20,
    width: 20,
    height: 20,
    x: 260,
    y: 20,
    toJSON: () => ({}),
    ...over,
  }) as DOMRect;

describe('ServerE2eeIndicator', () => {
  it('renders the encrypted lock when e2ee_default is true', () => {
    const { container } = render(
      <ServerE2eeIndicator server={{ ...mockServer, e2ee_default: true }} />
    );
    const indicator = container.querySelector('.server-e2ee-indicator');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveClass('encrypted');
  });

  it('renders the unencrypted lock when e2ee_default is false', () => {
    const { container } = render(
      <ServerE2eeIndicator server={{ ...mockServer, e2ee_default: false }} />
    );
    expect(container.querySelector('.server-e2ee-indicator')).toHaveClass('unencrypted');
  });

  it('shows the enabled tooltip on hover (right-aligned) and hides it on leave', () => {
    const { container } = render(
      <ServerE2eeIndicator server={{ ...mockServer, e2ee_default: true }} />
    );
    const indicator = container.querySelector('.server-e2ee-indicator') as HTMLElement;
    indicator.getBoundingClientRect = () => rect({ right: 500, left: 260 });

    fireEvent.mouseEnter(indicator);
    expect(screen.getByText('E2EE Enabled')).toBeInTheDocument();

    fireEvent.mouseLeave(indicator);
    expect(screen.queryByText('E2EE Enabled')).not.toBeInTheDocument();
  });

  it('shows the disabled tooltip clamped when the indicator is near the left edge', () => {
    const { container } = render(
      <ServerE2eeIndicator server={{ ...mockServer, e2ee_default: false }} />
    );
    const indicator = container.querySelector('.server-e2ee-indicator') as HTMLElement;
    indicator.getBoundingClientRect = () => rect({ right: 100, left: 10 });

    fireEvent.mouseEnter(indicator);
    expect(screen.getByText('E2EE Disabled')).toBeInTheDocument();
  });

  it('shows the tooltip on keyboard focus and hides it on blur (a11y parity)', () => {
    const { container } = render(
      <ServerE2eeIndicator server={{ ...mockServer, e2ee_default: true }} />
    );
    const indicator = container.querySelector('.server-e2ee-indicator') as HTMLElement;
    expect(indicator).toHaveAttribute(
      'aria-label',
      'Server end-to-end encryption: enabled by default'
    );
    indicator.getBoundingClientRect = () => rect({ right: 500, left: 260 });

    fireEvent.focus(indicator);
    expect(screen.getByText('E2EE Enabled')).toBeInTheDocument();

    fireEvent.blur(indicator);
    expect(screen.queryByText('E2EE Enabled')).not.toBeInTheDocument();
  });
});
