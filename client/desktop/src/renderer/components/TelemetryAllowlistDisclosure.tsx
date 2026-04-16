import React from 'react';
import {
  ALLOWLIST_META,
  ALLOWLIST_CATEGORIES,
  type AllowlistCategory,
} from '../../shared/sentry-allowlist-descriptions';
import './TelemetryAllowlistDisclosure.css';

const TelemetryAllowlistDisclosure: React.FC = () => {
  return (
    <details className="telemetry-disclosure">
      <summary
        className="telemetry-disclosure-summary"
        aria-label={`What we collect. Policy version ${ALLOWLIST_META.version}, updated ${ALLOWLIST_META.lastUpdated}.`}
      >
        What we collect · Policy v{ALLOWLIST_META.version} · Updated {ALLOWLIST_META.lastUpdated}
      </summary>
      <div className="telemetry-disclosure-body">
        <p className="telemetry-disclosure-headline">{ALLOWLIST_META.summary}</p>

        <CategoryBlock category={ALLOWLIST_CATEGORIES.contexts} />
        <CategoryBlock category={ALLOWLIST_CATEGORIES.tags} />

        <h4 className="telemetry-disclosure-changelog-title">
          What&apos;s new in v{ALLOWLIST_META.version}
        </h4>
        <ul className="telemetry-disclosure-changelog">
          {ALLOWLIST_META.changelog
            .filter((c) => c.version === ALLOWLIST_META.version)
            .map((entry) => (
              <li key={entry.version}>{entry.change}</li>
            ))}
        </ul>
      </div>
    </details>
  );
};

const CategoryBlock: React.FC<{ category: AllowlistCategory }> = ({ category }) => (
  <section className="telemetry-disclosure-section">
    <h4>{category.title}</h4>
    <p className="telemetry-disclosure-intro">{category.intro}</p>
    <dl className="telemetry-disclosure-fields">
      {Object.entries(category.fields).map(([key, desc]) => (
        <React.Fragment key={key}>
          <dt>{key}</dt>
          <dd>{desc}</dd>
        </React.Fragment>
      ))}
    </dl>
  </section>
);

export default TelemetryAllowlistDisclosure;
