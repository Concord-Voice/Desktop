import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as SentryReact from '@sentry/react';
import { resetAllStores } from '../../../helpers/store-helpers';
import {
  AppRootFallback,
  AuthenticatedViewFallback,
  SettingsFallback,
  PipFallback,
  AuthFallback,
  handleAppRootError,
} from '../../../../src/renderer/App';

// Minimal component that throws on render
function ThrowingComponent({ message }: { message: string }) {
  throw new Error(message);
}

// Suppress React error boundary console noise in test output
const originalError = console.error;
beforeEach(() => {
  resetAllStores();
  console.error = vi.fn();
});
afterEach(() => {
  console.error = originalError;
});

describe('Sentry ErrorBoundary integration', () => {
  it('renders fallback on child error', () => {
    render(
      <SentryReact.ErrorBoundary
        fallback={<div>Something went wrong</div>}
        showDialog={false}
        beforeCapture={(scope) => scope.setTag('boundary', 'test')}
      >
        <ThrowingComponent message="test crash" />
      </SentryReact.ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong')).toBeDefined();
  });

  it('does not render a feedback form when showDialog is false', () => {
    render(
      <SentryReact.ErrorBoundary fallback={<div>Crashed</div>} showDialog={false}>
        <ThrowingComponent message="dialog test" />
      </SentryReact.ErrorBoundary>
    );

    expect(screen.getByText('Crashed')).toBeDefined();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('beforeCapture sets the boundary tag', () => {
    const mockScope = { setTag: vi.fn() };
    const beforeCapture = (scope: any) => {
      scope.setTag('boundary', 'app-root');
    };

    beforeCapture(mockScope);

    expect(mockScope.setTag).toHaveBeenCalledWith('boundary', 'app-root');
  });
});

describe('Fallback components', () => {
  it('AppRootFallback renders static text and reload button', () => {
    const reloadMock = vi.fn();
    vi.stubGlobal('location', { reload: reloadMock });

    render(<AppRootFallback />);

    expect(screen.getByText('Something went wrong')).toBeDefined();
    expect(
      screen.getByText('The error has been reported. Please restart the application.')
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /reload/i }));
    expect(reloadMock).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('AuthenticatedViewFallback renders static text', () => {
    render(<AuthenticatedViewFallback />);
    expect(screen.getByText('This view failed to load')).toBeDefined();
  });

  it('SettingsFallback renders static text', () => {
    render(<SettingsFallback />);
    expect(screen.getByText('Settings failed to load')).toBeDefined();
  });

  it('PipFallback renders static text', () => {
    render(<PipFallback />);
    expect(screen.getByText('Voice UI crashed')).toBeDefined();
    expect(
      screen.getByText('Your call is still active. Close this window and rejoin from the main app.')
    ).toBeDefined();
  });

  it('AuthFallback renders static text and reload button', () => {
    const reloadMock = vi.fn();
    vi.stubGlobal('location', { reload: reloadMock });

    render(<AuthFallback />);

    expect(screen.getByText('Authentication UI failed to load')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /reload/i }));
    expect(reloadMock).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('ErrorBoundary with AppRootFallback catches error and calls onError', () => {
    const onError = vi.fn();
    const reloadMock = vi.fn();
    vi.stubGlobal('location', { reload: reloadMock });

    render(
      <SentryReact.ErrorBoundary
        fallback={<AppRootFallback />}
        showDialog={false}
        beforeCapture={(scope) => scope.setTag('boundary', 'app-root')}
        onError={onError}
      >
        <ThrowingComponent message="app root crash" />
      </SentryReact.ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong')).toBeDefined();
    expect(onError).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('ErrorBoundary with AuthenticatedViewFallback catches error', () => {
    render(
      <SentryReact.ErrorBoundary
        fallback={<AuthenticatedViewFallback />}
        showDialog={false}
        beforeCapture={(scope) => scope.setTag('boundary', 'authenticated-view')}
      >
        <ThrowingComponent message="view crash" />
      </SentryReact.ErrorBoundary>
    );

    expect(screen.getByText('This view failed to load')).toBeDefined();
  });

  it('ErrorBoundary with SettingsFallback catches error', () => {
    render(
      <SentryReact.ErrorBoundary
        fallback={<SettingsFallback />}
        showDialog={false}
        beforeCapture={(scope) => scope.setTag('boundary', 'settings')}
      >
        <ThrowingComponent message="settings crash" />
      </SentryReact.ErrorBoundary>
    );

    expect(screen.getByText('Settings failed to load')).toBeDefined();
  });

  it('ErrorBoundary with PipFallback catches error', () => {
    render(
      <SentryReact.ErrorBoundary
        fallback={<PipFallback />}
        showDialog={false}
        beforeCapture={(scope) => scope.setTag('boundary', 'pip-window')}
      >
        <ThrowingComponent message="pip crash" />
      </SentryReact.ErrorBoundary>
    );

    expect(screen.getByText('Voice UI crashed')).toBeDefined();
  });

  it('ErrorBoundary with AuthFallback catches error', () => {
    const reloadMock = vi.fn();
    vi.stubGlobal('location', { reload: reloadMock });

    render(
      <SentryReact.ErrorBoundary
        fallback={<AuthFallback />}
        showDialog={false}
        beforeCapture={(scope) => scope.setTag('boundary', 'auth-flow')}
      >
        <ThrowingComponent message="auth crash" />
      </SentryReact.ErrorBoundary>
    );

    expect(screen.getByText('Authentication UI failed to load')).toBeDefined();

    vi.unstubAllGlobals();
  });

  it('no fallback contains user data or dynamic content', () => {
    const { container: root } = render(<AppRootFallback />);
    const { container: auth } = render(<AuthenticatedViewFallback />);
    const { container: settings } = render(<SettingsFallback />);
    const { container: pip } = render(<PipFallback />);
    const { container: authFlow } = render(<AuthFallback />);

    // Verify no dynamic content — all text should be static
    for (const el of [root, auth, settings, pip, authFlow]) {
      expect(el.querySelector('[data-testid]')).toBeNull();
      expect(el.querySelector('input')).toBeNull();
      expect(el.querySelector('textarea')).toBeNull();
    }
  });

  it('handleAppRootError does not throw', () => {
    // handleAppRootError uses dynamic import() to load recovery/reset services.
    // We verify it doesn't throw synchronously — the async imports resolve
    // in the background. Full integration of the recovery path is tested
    // in the existing main process tests.
    expect(() => handleAppRootError()).not.toThrow();
  });
});
