import React, { useCallback } from 'react';
import { useSettingsCollapsibleStore } from '../../stores/ui/settingsCollapsibleStore';

interface CollapsibleSectionProps {
  id: string;
  title: string;
  children: React.ReactNode;
}

/**
 * A Settings section with a native `<details>`/`<summary>` disclosure.
 *
 * Collapsed by default, with no per-site override (#2365): the `defaultOpen` prop that
 * let six sections open expanded is gone, so uniformity cannot regress through it.
 *
 * Open state is remembered for the renderer session in `useSettingsCollapsibleStore`,
 * keyed by `id`, through a two-way binding — react.dev's own `<details>` pattern: `open`
 * renders from the store and `onToggle` writes the DOM truth back. The native `toggle`
 * event fires for script-driven `el.open = …` writes as well as clicks (MDN), so the
 * code paths that open sections directly — Expand/Collapse all, the sub-nav scroll, a
 * focus request, the update indicator — reach the store with no store call of their
 * own. React rewrites the `open` attribute only when the subscribed value changes, so
 * the binding never stomps a DOM change the store has not recorded yet, and `toggle`
 * is a discrete-priority event, so the store-driven re-render commits before the next
 * input task.
 *
 * `onToggle` bubbles in React (unlike the native event): a nested `<details>` — the
 * font-area accordion, the About legal text — invokes this handler with
 * `target !== currentTarget` and must be ignored, or it would overwrite this section's
 * memory with its own state. The handler reads `currentTarget.open`, the DOM truth at
 * dispatch, never `newState`: jsdom supplies no `newState`, and `target.open` is the
 * nested-details bug.
 */
const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({ id, title, children }) => {
  const open = useSettingsCollapsibleStore((s) => s.openSections[id] === true);
  const setSectionOpen = useSettingsCollapsibleStore((s) => s.setSectionOpen);

  const handleToggle = useCallback(
    (event: React.SyntheticEvent<HTMLDetailsElement>) => {
      if (event.target !== event.currentTarget) return;
      setSectionOpen(id, event.currentTarget.open);
    },
    [id, setSectionOpen]
  );

  return (
    <details
      className="settings-section settings-collapsible"
      id={id}
      open={open}
      onToggle={handleToggle}
    >
      <summary className="settings-collapsible-header">
        <h2 className="settings-section-title">{title}</h2>
        <svg
          className="settings-collapsible-chevron"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <div className="settings-collapsible-body">{children}</div>
    </details>
  );
};

export default CollapsibleSection;
