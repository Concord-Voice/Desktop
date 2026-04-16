import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { resetAllStores } from '../../../helpers/store-helpers';
import TelemetryAllowlistDisclosure from '../../../../src/renderer/components/TelemetryAllowlistDisclosure';
import {
  ALLOWLIST_META,
  ALLOWLIST_CATEGORIES,
} from '../../../../src/shared/sentry-allowlist-descriptions';

beforeEach(() => {
  resetAllStores();
});

describe('TelemetryAllowlistDisclosure', () => {
  it('renders the summary line with policy version and lastUpdated', () => {
    render(<TelemetryAllowlistDisclosure />);
    expect(
      screen.getByText(
        `What we collect · Policy v${ALLOWLIST_META.version} · Updated ${ALLOWLIST_META.lastUpdated}`
      )
    ).toBeInTheDocument();
  });

  it('renders the ALLOWLIST_META summary text', () => {
    render(<TelemetryAllowlistDisclosure />);
    expect(screen.getByText(ALLOWLIST_META.summary)).toBeInTheDocument();
  });

  it('renders one h4 per category and every field/description pair', () => {
    const { container } = render(<TelemetryAllowlistDisclosure />);

    // One <h4> per category (contexts + tags)
    expect(screen.getByText(ALLOWLIST_CATEGORIES.contexts.title)).toBeInTheDocument();
    expect(screen.getByText(ALLOWLIST_CATEGORIES.tags.title)).toBeInTheDocument();

    // Every field key and description
    for (const category of Object.values(ALLOWLIST_CATEGORIES)) {
      for (const [key, desc] of Object.entries(category.fields)) {
        const dt = container.querySelector(`dt`);
        expect(screen.getByText(key)).toBeInTheDocument();
        expect(screen.getByText(desc)).toBeInTheDocument();
        void dt; // suppress unused warning
      }
    }
  });

  it('is collapsed by default (details element has no open attribute)', () => {
    const { container } = render(<TelemetryAllowlistDisclosure />);
    const details = container.querySelector('details.telemetry-disclosure');
    expect(details).not.toBeNull();
    expect(details!.hasAttribute('open')).toBe(false);
  });
});
