# Concord Voice UI — how to build with these components

Concord Voice is a **dark-first** desktop chat UI. Components are real compiled
React from `@concordvoice/desktop`; style with the design tokens below.

## Wrapping & setup

Wrap the app root in **`ModalProvider`** — `Modal`, `ConfirmActionModal`,
`ImageCropEditor`, and `ShortcutOverlay` call `useModalStack()` and **throw
without it**. `ChannelSwitcher` additionally needs a React Router context
(`useNavigate`).

```jsx
import { ModalProvider, Modal } from '@concordvoice/desktop';

<ModalProvider>
  <YourApp />
</ModalProvider>
```

The theme is applied through CSS custom properties on `:root` (dark by default).
Put app content on `--bg-primary` with `--text-primary` — the default page/card
background is not themed, so bare text on it is near-invisible.

## Styling idiom — CSS custom properties (`var(--*)`)

There are **no utility classes**. Components self-style (their CSS ships in the
bundle); style your own layout glue with these token families:

| Family | Tokens |
|---|---|
| Surfaces | `--bg-primary` `--bg-secondary` `--bg-tertiary` `--bg-hover` `--bg-active` |
| Text | `--text-primary` `--text-secondary` `--text-tertiary` `--text-muted` `--text-error-strong` `--text-warning-strong` |
| Accent | `--accent-primary` `--accent-secondary` `--accent-hover` `--on-accent` `--gradient-brand` |
| Status / state | `--success` `--danger` `--danger-hover` `--status-connected` `--status-connecting` `--status-disconnected` `--state-selected` `--state-hover` `--state-focused` |
| Links | `--link-color` `--link-color-hover` `--link-color-visited` |
| Border / radius | `--border-color` `--radius-base` `--radius-elevated` `--radius-modal` |
| Type | `--font-display-stack` (brand display headings) · `--text-display-xl` `--text-display-lg` `--text-display-md` `--text-display-sm` |

Headings use `font-family: var(--font-display-stack)` (the angular brand face);
body text inherits the default sans stack.

## Where the truth lives

- Tokens + theme: the bound `styles.css` (and its `@import`s, incl.
  `_ds_bundle.css`). Read it before inventing values.
- Per component: its `.d.ts` (the exact `<Name>Props` contract) and
  `.prompt.md` (usage) under `components/<group>/<Name>/`.

## Idiomatic example

```jsx
import { ModalProvider, Modal, PremiumChip } from '@concordvoice/desktop';

function LeaveDialog({ open, onClose }) {
  return (
    <ModalProvider>
      <Modal isOpen={open} onClose={onClose} title="Leave server?" width="medium">
        <div style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
          <p style={{ marginBottom: 20, lineHeight: 1.5 }}>
            You’ll stop receiving messages from this server.
          </p>
          <button type="button" style={{ padding: '8px 16px', fontWeight: 600 }}>
            Leave server
          </button>
        </div>
      </Modal>
    </ModalProvider>
  );
}
```

`PremiumChip` / `PremiumGate` mark paid features; `ContextMenu` composes via
`ContextMenu.Item` / `ContextMenu.Separator`. `CustomSelect` is a native
`<select>` wrapper. The overlays (`ShortcutOverlay`, `ForceUpdateOverlay`,
`ConnectionLostOverlay`, `ChannelSwitcher`, `UpdateBanner`) are prop-less and
driven by app state.
