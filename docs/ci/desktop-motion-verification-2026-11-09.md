# Desktop motion and worker alert verification — 2026-11-09

Source baseline: `b151bdc782a36c8ed4134ef31164bd44cc9e63d3`.

## Runtime method and result

`cd desktop && npx playwright test tests/e2e/reduced-motion.spec.ts`
passes **38/38**, with zero skipped or flaky cases. The fixture runs the real
renderer entry and settingsStore subscriber, loads the actual component stylesheet,
and creates matching DOM descendants under the real document root. Each case
checks a positive normal-motion control, the application Reduce Animations toggle,
live OS reduced-motion changes, and restoration to normal motion. The slider case
uses Chromium's real UA shadow-tree thumb through CDP, not the input's computed
style. These checks verify the stated CSS cascade and runtime preference wiring;
they are not a full visual or authenticated interaction audit of each component.

The original scrolling and slider-thumb cases failed before the fix: smooth
scrolling persisted and the thumb retained its 0.1s transition. Fixes add scoped
OS/application overrides, and ServerBar arrow scrolling now delegates to CSS
with `behavior: auto`. The targeted component/settings unit run passes 30/30.

## Individual inputs

All 36 coverage candidates were individually marked **FALSE_POSITIVE** in Sonar on
2026-11-09, from `21:14:33Z` through `21:45:43Z`. Each transition had a fresh
exact-ID/rule/path/state check and unchanged-source check against main
`417ca267310004906a8740d84b3b8e8071ec65e6`, an instance-specific runtime
rationale, and an independent API readback. The final reconciliation confirms all
36 states and exact stored comments; the minimum interval between writes was
30 seconds. Per-issue timestamps and Sonar comment keys are recorded in
[the false-positive register](sonarqube-false-positive-register.md#post-migration-desktop).
The two real defects require merged code and a matching scan before being called
resolved. No false-positive marker is recorded for unexecuted transitions.

| Sonar issue | Source selector | Property verified | Disposition |
|---|---|---|---|
| `AaGRKm7HWV1cgC4sffoj` | `.auth-screen` in `src/renderer/components/Auth/AuthFlow.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm7HWV1cgC4sffok` | `.auth-placeholder` in `src/renderer/components/Auth/AuthFlow.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm7QWV1cgC4sffoo` | `.radio-inner` in `src/renderer/components/Auth/ConnectionSelector.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm7GWV1cgC4sffoi` | `.info-tooltip-popup` in `src/renderer/components/Auth/InfoTooltip.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm7NWV1cgC4sffon` | `.spinner` in `src/renderer/components/Auth/LoadingSpinner.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm7KWV1cgC4sffol` | `.strength-label.legendary` in `src/renderer/components/Auth/PasswordStrength.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm6vWV1cgC4sffoZ` | `.delete-message-confirm-btn` in `src/renderer/components/Chat/DeleteMessageModal.css` | `transition-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm6oWV1cgC4sffoV` | `.scroll-to-bottom` in `src/renderer/components/Chat/MessageList.css` | `transition-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm6oWV1cgC4sffoW` | `.scroll-to-bottom svg` in `src/renderer/components/Chat/MessageList.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm6sWV1cgC4sffoY` | `.reaction-chip-enter` in `src/renderer/components/Chat/ReactionBar.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm6rWV1cgC4sffoX` | `.typing-dot` in `src/renderer/components/Chat/TypingIndicator.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm7wWV1cgC4sffo0` | `.status-dot` in `src/renderer/components/ConnectionStatus/ConnectionStatus.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm7UWV1cgC4sffop` | `.category-manager .server-settings-submit-btn` in `src/renderer/components/DirectMessages/CategoryManagerPanel.css` | `transition-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm7kWV1cgC4sffou` | `.emoji-picker--popover` in `src/renderer/components/EmojiPicker/EmojiPicker.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm7kWV1cgC4sffov` | `.emoji-picker-cell` in `src/renderer/components/EmojiPicker/EmojiPicker.css` | `transition-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm7kWV1cgC4sffow` | `.emoji-picker-skin-tones` in `src/renderer/components/EmojiPicker/EmojiPicker.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm7uWV1cgC4sffoz` | `.gif-tile` in `src/renderer/components/GifPicker/GifPicker.css` | `transition-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm6DWV1cgC4sffoM` | `.folder-dropdown-ghost` in `src/renderer/components/Layout/FolderBar.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm6IWV1cgC4sffoP` | `.server-bar-scroll` in `src/renderer/components/Layout/ServerBar.css` | `scroll-behavior` | Fix in this PR; scanner verification pending |
| `AaGRKm6IWV1cgC4sffoQ` | `.server-bar-icon-ghost` in `src/renderer/components/Layout/ServerBar.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm7dWV1cgC4sffoq` | `.member-profile-card` in `src/renderer/components/Members/MemberProfileCard.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm7fWV1cgC4sffor` | `.user-profile-container` in `src/renderer/components/Members/UserProfileModal.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm6jWV1cgC4sffoT` | `.invite-code-display` in `src/renderer/components/Servers/InviteToServerModal.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm6lWV1cgC4sffoU` | `.join-server-preview` in `src/renderer/components/Servers/JoinServerModal.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm7rWV1cgC4sffoy` | `.user-panel-settings-btn` in `src/renderer/components/User/UserPanel.css` | `transition-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm7oWV1cgC4sffox` | `.user-popover` in `src/renderer/components/User/UserPopover.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm7BWV1cgC4sffoh` | `.participant-volume-row-slider::-webkit-slider-thumb` in `src/renderer/components/Voice/ParticipantVolumeRow.css` | `transition-duration` | Fix in this PR; scanner verification pending |
| `AaGRKm6-WV1cgC4sffoe` | `.voice-view__join::before` in `src/renderer/components/Voice/VoiceView.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm5KWV1cgC4sffn_` | `.connection-lost-icon.spinning` in `src/renderer/components/ui/ConnectionLostOverlay.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm5hWV1cgC4sffoA` | `.ctx-menu` in `src/renderer/components/ui/ContextMenu.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm5hWV1cgC4sffoB` | `.ctx-menu-closing` in `src/renderer/components/ui/ContextMenu.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm5hWV1cgC4sffoD` | `.ctx-submenu` in `src/renderer/components/ui/ContextMenu.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm5hWV1cgC4sffoE` | `.ctx-submenu-closing` in `src/renderer/components/ui/ContextMenu.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm5hWV1cgC4sffoF` | `.ctx-submenu-closing.ctx-submenu-flip` in `src/renderer/components/ui/ContextMenu.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm5hWV1cgC4sffoC` | `.ctx-menu-item, .ctx-menu-header, .ctx-menu-separator` in `src/renderer/components/ui/ContextMenu.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm5-WV1cgC4sffoK` | `.force-update-spinner` in `src/renderer/components/ui/ForceUpdateOverlay.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm57WV1cgC4sffoH` | `.modal-container` in `src/renderer/components/ui/Modal.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |
| `AaGRKm56WV1cgC4sffoG` | `.update-banner` in `src/renderer/components/ui/UpdateBanner.css` | `animation-duration` | FALSE_POSITIVE; runtime evidence and verified receipt in register |

## Worker-origin alert

CodeQL [#10](https://github.com/Concord-Voice/Desktop/security/code-scanning/10)
was individually dismissed as false positive after fresh alert/rule/path and
current-source checks on both worker creators. Both private dedicated Workers
use a fixed module URL (`voiceService.ts:11099`, `pipVoiceClient.ts:497`);
`e2eeWorker.ts:105` is the dedicated-port handler, not a Window message listener.
No untrusted window-message relay to it was found. This evaluates only the
reported origin-check condition, not every IPC/schema or cryptographic property.

The [HTML Worker outside-port contract](https://html.spec.whatwg.org/multipage/workers.html#dedicated-workers-and-the-worker-interface)
defines the private channel used by Worker.postMessage; the
[CodeQL rule](https://codeql.github.com/codeql-query-help/javascript/js-missing-origin-check/)
describes an untrusted-window messaging threat.

Dismissed `2026-11-09T20:28:59Z`; independently verified `2026-11-09T20:29:00.055221+00:00`. Exact stored comment:

> False positive at b151bdc7: e2eeWorker.ts:105 receives a dedicated Worker port, not Window messages. Both creators (voiceService.ts:11099, pipVoiceClient.ts:497) use fixed module URLs and private handles; no window-message relay. HTML Worker outside-port contract.
