---
description: React + TypeScript frontend conventions for the Electron desktop client
paths:
  - "desktop/src/**/*.ts"
  - "desktop/src/**/*.tsx"
---

# Frontend Rules

## State Management

- ~47 Zustand stores (v5.0.12) — always use selective subscriptions: `useStore((s) => s.field)`
- Actions live on the store — never define state-changing logic in components
- Use `persist` middleware only for data surviving app restart
- Store files: `src/renderer/stores/<concern>/{name}Store.ts` — one per file
- Check existing stores before creating new ones

### Unread reconciliation needs ownership and completeness (post-#3773)

A channel's positive cross-server row proves its owner, not that all of that
server's unread channels are known. Clear the last-read server's indicators only
from its owned complete per-server snapshot or validated complete bulk detail
whose request and membership still have authority. A retained B snapshot never
proves A empty; unknown, legacy, partial, and invalidated A detail stays
conservative. Keep genuine remaining unread and mentions in other servers.

When a late detailed seed follows a local A1 read, reconcile the read and the
server decision together: A1 stays absent, but an untouched eligible A2 first
discovered by the seed must keep A visible. Preserve newer local arrivals,
mute-aware corrections, channel-over-server mute precedence, and precision
metadata. Read consumers must preserve the store's owner-aware decision,
including eligible unread already known from complete detail. A follow-up clear
based only on the retained generic map must not override those counts or a
pending read reason. Keep genuinely later server-only corrections authoritative.
Prove the actual channel list and menu paths, since a direct store call omits the
caller's follow-up actions. Missing detail retains the approximate server-ID
fallback.

Bulk unread continuations belong to both a hook lifetime and a shared request
window. Check that authority after response and body awaits; unmount, reset, or
a successor request must prevent an old continuation from writing or consuming
the successor's dirty fence. Keep HTTP cleanup separate from long-lived
WebSocket subscriptions, and prove that StrictMode replay can still commit its
surviving request.

A server menu's whole-server read is scoped to that server, not a session reset.
Keep other servers' counts, mentions and the current seed's authority. Fence older
rows for the read server, including rows first revealed by that response, while
keeping genuine arrivals after the read. Reserve global reset invalidation for
actual session/account teardown.

The owning per-server fetch needs that read boundary too: check a server-scoped
read revision and the global reset identity after both awaits. A whole-server
read invalidates older requests for that server without cancelling another
server's response or a genuinely newer request. Keep this authority independent
of the bulk seed window, which may complete or be replaced in either order.

### Account-owned Settings saves and visit cleanup (PR #3780)

Debounced privacy choices belong to `privacyStore`, so moving between Settings
panes cannot discard a choice. Capture request context and privacy identity when
the user selects a value; check both before dispatch and response publication.
`clearPrivacy()` cancels queued writes synchronously, even before logout advances
auth generation. Keep each field's pending value and refusal independent.

Each known privacy field has a current write owner. Queue selection claims its
tier before debounce; a direct request claims only its specified fields after
context admission. Claim before notifying subscribers, so a successor invoked
by a notification keeps its ownership. A loaded PATCH publishes only written
fields it still owns. GET snapshots preserve fields confirmed after the read
began; an eligible first full response hydrates untouched server values.
Unrelated success must retain a still-current field refusal. Keep identity,
request-context and full-read ordering fences; clear private owners and
confirmation revisions on privacy reset. This metadata stays outside the wire
settings and persisted state.

Logout-class reset closes the Settings overlay through `closeForLogout()` despite
ordinary draft-dismissal blockers and ends an active disclosure visit. Preserve
the existing 30-minute deadline for an already-closed visit and same-account
recovery behavior. Expansion stores contain device UI choices, not account data.

### Membership reconciliation belongs to the action, not the caller (post-#2363)

**`inviteStore.joinServer` performs the `serverStore.addServer` write itself. Callers must
not repeat it, and a new caller must not re-add it.** There were two call sites —
`JoinServerModal` and `InviteEmbed` — and only one reconciled. Because
`useServerChannelSubscriptions` derives the WebSocket `subscribe_server` set from the *same*
`serverStore.servers` array `ServerList` renders, that one omission starved the sidebar entry
**and** the unread subscription from a single source, which is why #2363 read as two separate
bugs. A third caller would forget again; the write lives at the single point that performs the
join. `JoinServerModal` still builds its own `ServerWithRole` locally because `onSuccess(server)`
is a prop contract — that object is passed upward, never written to a store.

**`serverStore.addServer` is an UPSERT, not a prepend — as a boundary guard, with NO
currently-reachable collision.** This invariant has now had two wrong justifications, both recorded so
they are not reinvented. It is **not** a repeat join: the control plane returns **409** for an existing
member (`internal/invites/handlers.go`, `checkBanAndMembership`) before the insert. It is **not** a
rehydrated row either: `partialize` persists only `activeServerId`, so the `servers` array never
rehydrates. Today's two callers — `joinServer` and `CreateServerModal` — cannot collide. What the
upsert buys is that `addServer` means "this server is in the list", so a third caller cannot
reintroduce the duplicate `key={server.id}` an unconditional prepend allows. Keep it, and do not
attach a new reachability story to it; if you need one, the honest answer is that there isn't one. On the update path two field groups are pinned from the existing
row rather than taken from the response: `permissions`, which the join response omits entirely
(**live since #2372**, no longer future-facing — `InviteServerPicker` reads
`servers[].permissions` as its primary source, so clobbering it would hide a server the user can
genuinely invite to), and
`member_count`/`online_count`, which `joinServer` **fabricates as `0`** because
`JoinServerResponse` carries only `{ server, role }`. Do not "simplify" either to a plain
spread, and do not gate the counts on a non-zero heuristic — a server genuinely at 0 online is
a real state. Every other field correctly takes the fresh response.

**Correcting this entry on the record:** it previously said `fetchServers` *did* populate
`servers[].permissions`, so "a future reader could start depending on it". That was false.
`models.ServerWithRole` (`internal/models/server.go`) carried no `Permissions` field at all, and
`ListServers` never selected one — the TS field was declared with **no writer on any code path
and no reader in the renderer**, and the boundary guard above was protecting a value that never
arrived. Verify a claim of this shape against the Go model and the handler's `SELECT`, never
against the TS interface: an optional TS field can describe a wire shape the server does not send,
and nothing in the type system or the test suite will say so.

### Which server permissions a component may read

`permissionStore.serverPermissions` answers only for servers **MainView has made active**, because
its one populator is MainView's `activeServerId` effect. Any component that asks a permission
question about a server the user is *not* currently viewing — the DM composer's
`InviteServerPicker` is the founding case (#2372) — must read `servers[].permissions` and keep
`permissionStore` as a fallback only, for a control plane predating that field. Do not close the
gap by fanning out `GET /servers/{id}/permissions`: it is capped at 30/min/user and MainView spends
from the same budget, so an account above ~30 servers starts failing closed intermittently, which
is strictly worse than failing closed consistently. A row `joinServer` wrote has neither source and
is correctly invisible to such a question until the next `fetchServers`.

### There is no client channel-permission mirror

`resolveChannelPermissions` (a client re-implementation of the control plane's channel-override
fold) is deleted. Every consumer reads the server-computed `channelPermissions`
(`GET /channels/:id/permissions`), which already carries the MFA-enforcement mask on a server that
enforces it (`mfa_restricted`). A client-side fold would be a second copy of that logic that the
mask does not reach. Do not reintroduce one; refetch instead (`fetchChannelPermissions`).

### A per-user probe degrades OPEN, and says so in its type

`services/system/friendEligibility.ts` and `services/system/mutualServers.ts` are the two probes of
this shape: a per-user question answered by a route an older self-hosted control plane may not
have. Both carry the same five guards — a TTL, in-flight dedupe keyed on the user id and inserted
**synchronously** before the await, a bounded route-missing latch, a request timeout, and an
identity generation cleared from `resetService` so a continuation cannot write the previous
account's answer into the next session. Copy the whole set; each one is there because its absence
was a bug.

**The verdict type must make "could not ask" distinct from "the answer is no"** — `unknown` and
`null` respectively, never a bare boolean. Both degrade OPEN on it: hiding an affordance that
would have worked is an undiagnosable dead end, while offering one that fails costs an error the
user can read. `useMutualServersForAll` extends that to a fan-out — if ANY recipient's answer is
unknown it greys nothing, rather than intersecting the ones that did answer and presenting a
confident result to a question that was not fully answered.

One divergence worth knowing, because it looks like drift: `mutualServers` treats **any** 404 as
route-missing, while `friendEligibility` has to inspect the 404 body. That follows from the routes'
own privacy designs — `/mutual-servers` answers `200 {"server_ids": []}` for an unknown user
precisely so it cannot be a user-existence oracle, so it never 404s for a reason of its own. Do not
add body matching there "for symmetry": it would match a shape that endpoint never emits.

**The cross-view DM indicator needs someone to fetch its state.** `ServerBar` computes
`hasUnreadDMs` from `dmStore.conversations`, which nothing populated outside the DM view — so a
DM that arrived while the user was offline stayed invisible, with no badge to prompt opening the
DM list. **`App` owns that fetch**, above `<Routes>`, keyed on
`accessToken` so it re-runs on every rotation. It is the **only** mount-time conversation fetch;
`ConversationList`'s was deleted. It was on `ServerBar` first and that was wrong — `ServerBar` is
**not** persistent chrome: `MainView` and `DirectMessagesView` each instantiate their own, so a
`/app` ↔ `/app/dms` navigation remounted it and re-ran the effect. `AppLayout` is not the fix
either; it is rendered *inside* both views and remounts on the same boundary. Do not move this
fetch back down into a route-scoped component.
An overlapping `fetchConversations` does **not** collapse: `queueConversationRefetchIfLoading`
sets `conversationRefetchQueued` and the in-flight request's `finally` issues it, so two mount
sites cost two sequential authenticated full-list requests on every DM-view entry. Reconnect is
likewise not a call site — `useWebSocketMessages` already refetches on live DM events. No
`HydrationLifecycleGuard` — `dmStore` has no concurrent-commit hazard, and the account-switch
fence already exists via `gracefulReset()` → `clearDMs()` → `journal.cleared`.

**A store write that follows an `await` on an account-scoped request MUST re-check the auth
lifecycle first.** `gracefulReset()` clears stores; it cannot cancel a request already in flight.
User A starts a join, logs out, user B signs in, A's POST resolves — and an unconditional write
puts A's server into B's sidebar *and* into B's `subscribe_server` set, which is derived from the
same array. `inviteStore.joinServer` therefore snapshots with `captureAuthLifecycle()` before the
request and gates the write on `isSameAuthLifecycle(snapshot)`, returning `null` rather than
surfacing an error to whoever is now signed in. `permissionStore` fences every one of its actions
the same way (#3406), since a permission read from the previous account would otherwise decide
which controls the next one sees.

**A read that began before a confirmed write must not land on top of it.** A settings modal reads
when it opens, so its first read routinely races the user's first save, and the older response
arriving last used to revert the save (an added override vanished; re-saving the stale row erased
the bits just written). `permissionStore` therefore sequences reads per scope (#3406): a read takes a
ticket when it starts, a write raises the scope's floor once the server has confirmed it, and a read
begun below the floor re-reads instead of committing. It re-reads rather than simply dropping out
because the role writes and override deletes patch whatever the view holds, which may be an
incomplete cache. An older read also never replaces a newer one. A store that refetches, or patches
locally, after a write needs the same fence: the refetch landing last protects it only until the
refetch fails.

**Validate the shape before writing, even on a 2xx.** `res.ok` says the request succeeded, not that
the body is what was asked for. `isJoinedServerUsable` requires a non-empty `server.id`, a non-empty
`server.name`, AND a role in the known enum, and a malformed 200 is treated as a failed join. **An
id-only check is NOT enough** — that was the first version of this guard, and
`{server: {id: "s1"}, role: "member"}` passed it, then crashed the authenticated chrome, because
`ServerList` and `ServerBar` call `server.name.charAt(0)` unguarded at three sites. A missing id is
the quieter half: it writes `id: undefined` and collides `key={server.id}` for every such row, which
is the duplicate-key defect the upsert above exists to prevent, arriving by a different door.

Check what the store writes and its consumers dereference — deliberately **not** the whole `Server`
shape. A schema validator here would be a second source of truth for a type that already has one, and
would fail closed on ordinary contract ADDITIONS, making a legitimately extended server unjoinable.

**Compare `authGeneration`, never a credential.** `rotateAuthCredentials` replaces BOTH the access
token and the session id on an ordinary proactive refresh while DELIBERATELY preserving the
generation. Comparing either credential therefore reads a routine refresh as an account switch and
discards a join the server has already committed — empty sidebar, caller told it failed. Tokens
rotate on a schedule, so that collision is ordinary. `beginPostLoginHydration`'s subscriber
deliberately compares credentials instead, and that is not an inconsistency: it asks "are these the
same CREDENTIALS", which a rotation legitimately answers no to and where re-running short-lived
hydration is cheap. An in-flight WRITE asks "is this the same ACCOUNT" and must survive a rotation.
Unifying the two looked right and was wrong.

**A membership mutation is JOURNALLED into every in-flight read, not allowed to invalidate it.**
`fetchServers` commits a whole-array replace, and a join is not a fetch — so a read that snapshotted
membership before the join still passed the authoritativeness gate and deleted the row just added,
reproducing the missing-sidebar and missing-subscription defect until some later fetch happened to
run. `addServer` adds the id to every live journal's `addedIds`, symmetric with the `removedIds` that
`removeServer` already journals, and the commit re-attaches any journalled addition the response
does not contain.

**Do not "simplify" this to a `serverFetchSequence` bump.** That was the first shape of the fix and
it retired the in-flight read entirely — which also skipped its purge, while the caller saw a
resolved promise and a still-current guard. `useConnectionRecovery` would then announce
`connection-recovered` with membership never refreshed, leaving a server the user was removed from
during the outage visible and backfilling against it: #2329's exact defect, reintroduced sideways.
Journalling invalidates nothing. For the same reason `purgeMissingServerState` and
`retainActiveServerId` read the COMMITTED list rather than the response — against the response the
just-joined server counts as missing and has its channels torn down moments after the join.

**`servers[].permissions` is a snapshot taken at `fetchServers`, and nothing invalidates it.**
No WebSocket event refreshes the field, so a member whose `PermInvite` is revoked mid-session
keeps seeing that server in the picker until the next `fetchServers`. `permissionStore` had a
refresh path; this field does not. Staleness is **permissive-only** and the cost is bounded to a
click that fails: `POST /servers/:id/invites` re-resolves the permission server-side and returns
403, so the field is never an authorization boundary. Do not add a WebSocket refresh for it
without deciding what the picker should do mid-open — the value of the snapshot is that the list
does not reshuffle under the pointer.

## Components

- Functional components only, PascalCase naming
- Props typed with interfaces, not inline types
- Co-locate CSS files with components (`Component.tsx` + `Component.css`)
- Custom hooks: `use` prefix, in `src/renderer/hooks/<concern>/`

### A global overlay must be reachable over the Settings dialog

`SettingsOverlayHost` opens a native `<dialog>` with `showModal()`, so Settings lives in the
browser **top layer**, and the browser blocks everything outside it. No z-index reaches above
the top layer. This has now caused a defect three times:

- **#2087:** a child `ui/Modal` portaled to `document.body` sat under Settings. The fix was
  `ModalPortalHostContext`, which moves the child into the host's own subtree.
- **MFA upgrade challenge:** `MFAChallengeModal` rendered a plain `div` inside `#root`. That div
  was under the top layer and also under `#root`, which `ModalContext` makes `inert` while any
  `ui/Modal` is open. When `/auth/refresh` returned `mfa_upgrade_required` with Settings open, the
  pending request waited on a challenge that nobody could reach. Only a reload escaped it.
- **The other global overlays:** `ForceUpdateOverlay` and `ConnectionLostOverlay` were plain
  `div`s in `#root` too, so a forced update or a lost connection raised while Settings or any
  `ui/Modal` was open left Update, Retry and Exit unreachable. `AttestationFailedModal` and
  `ChangelogModal` were already `showModal()` dialogs, but not in the `ModalContext` stack, so
  the `ui/Modal` underneath still captured their Escape and Tab.

The rule applies to any overlay mounted from `App` that another request or flow waits on:

1. **Open it with `showModal()`.** The last modal dialog shown is the topmost one and blocks the
   rest. A portal to `document.body` is not sufficient. Measured on Chromium 152: an element in
   `body` at `z-index: 2147483647` cannot take focus while Settings is open.
2. **The dialog, not a portal, is what escapes `#root`'s `inert`.** Measured on Chromium 152: a
   `showModal()` dialog inside an `inert` ancestor still takes focus, so a dialog may stay inside
   `#root`. An earlier version of this rule required a portal beside `#root`; the measurement
   retired it. A portal alone fixes nothing, because a non-dialog in `body` is still under the
   top layer.
3. **Register it with `useModalStack()` at a depth above every `ui/Modal`.** Without registration,
   the modal underneath stays "topmost". Its document-level Escape handler (capture phase) then
   closes the modal behind the overlay, and its Tab trap cancels every Tab press. Pass
   `el: null`: the top layer ignores z-index, so `syncInert` has nothing to write. Every overlay
   of this kind registers at `TOP_LAYER_DEPTH`, so a `ui/Modal` opened later still ranks below it.
   Nothing reads the order among these `el: null` entries, which matters because it is not the top
   layer's order once the MFA challenge retakes the top (rule 6).
4. **Handle `close` as well as `cancel`.** Escape's `cancel` is cancelable only while the page has
   user activation (measured both ways on Chromium 152 — see the Platform-behavior register). With
   no activation since the dialog opened, `preventDefault()` has no effect and the dialog closes. A
   network response opens these overlays, so this is the usual case, not an edge case. A closed
   dialog with live state is the deadlock again, so treat the close as the cancel action — unless
   the flow's own Cancel is disabled at that moment (the MFA challenge while a proof is in flight).
   Then re-show the dialog and let the in-flight action settle it.
   **A mandatory overlay sets `closedby="none"` instead** — measured on Chromium 152, Escape then
   fires neither `cancel` nor `close` and the dialog stays open. `ForceUpdateOverlay` and
   `ConnectionLostOverlay` do this. `closedby="none"` disables only the overlay's OWN close
   watcher: a dialog shown without user activation joins the close-watcher group of the dialog
   below it, and Escape then closes THAT one (measured on Chromium 152, see the register). So a
   mandatory overlay also cancels Escape keydowns, which stops the request, and re-shows itself if
   anything closes it. `useTopLayerDialog` does both for a dialog rendered with `closedby="none"`.
5. **Set `margin: auto` on the dialog, and dim with `::backdrop`.** The `* { margin: 0 }` reset in
   `styles/index.css` removes the UA margin that centres a modal dialog. A dimming wrapper `div`
   in `#root` sits under the top layer, so it never covers Settings; `::backdrop` does. Keep
   `display` off the dialog's own selector: it overrides the UA's `display: none` for a closed
   dialog, which then paints in page flow. Lay out on `[open]` or on an inner card.

6. **Showing it once is not enough: take the top back.** The top layer is
   last-`showModal()`-wins, so a dialog shown AFTER the overlay buries it again. Settings opened
   with Ctrl/Cmd+, and a network-driven attestation failure both did (#3423 red-team).
   `MFAChallengeModal` watches `document.body` for another `<dialog>` gaining `open` and, when that
   dialog is `:modal`, runs `close()` + `showModal()`, then puts focus back on the control the user
   was in. It tracks that control with a `focusin` listener on its own dialog: by the time the
   observer runs, the burying dialog's `showModal()` has already moved `document.activeElement`
   into itself, so reading `activeElement` then restores nothing. Filter on `HTMLDialogElement`, because `<details>` uses the same attribute, and on
   `:modal`, because a non-modal `show()` does not enter the top layer. **Only one overlay may do
   this.** Two of them would trade the top layer forever. While a challenge is pending,
   `keyboardShortcutService` runs only `toggle-mute` and `toggle-deafen`: they open no dialog and
   never use Escape, and a user in a call must still be able to mute. Every other shortcut is
   skipped, so keys typed into the challenge never open a dialog over it, and `close-modal` does
   not cancel the Escape keydown that sends the challenge its close request.
7. **Key per-flow state and effects on the flow's identity, not on "is open".** The modal stays
   mounted between challenges. A proof's result touches only the challenge it was sent for. A new
   challenge resets its spinner and error. The show/register effect depends on the token, so a
   replacement re-shows a dialog that Escape closed. A `close` event that arrives while the dialog
   is open again (after a retake or a replacement) belonged to an earlier close and is ignored.
   `showChallenge` settles a challenge it replaces, because every caller awaits it.
8. **Page-wide key listeners stand down for a modal dialog in front of them.** A
   `document` or `globalThis` keydown listener that owns an overlay (an Escape dismiss, a Tab
   trap, arrow-key navigation) must return early when `keyTargetsForeignModal(event, ownRoot)` is
   true. The key belongs to an open `:modal` `<dialog>` that does not contain the listener's own
   root: either it was typed inside that dialog, or it came from outside every dialog while one is
   open. The second case is real. A proof in flight disables the focused digit and Chromium drops
   focus to `<body>`, so after a wrong code every key comes from there. Otherwise the listener's
   `preventDefault()` on Escape takes the close request from the dialog in front, and its Tab trap
   pulls focus back behind it. Every such listener in the renderer is gated, with two exceptions
   that need no gate: `ui/Modal`, whose stack check already stands down under the challenge, and
   a Tab trap that acts only while focus is on its own first or last control (`ImageLightbox`),
   since a key in a dialog in front never has focus there. The challenge also puts focus back on
   a code input when a proof fails.
9. **Render the overlay on every path that can await it.** A request can raise the challenge and
   then wait on it. `App`'s session-restore branch awaits post-login hydration, so it renders
   `MFAChallengeModal` too; with only the titlebar mounted, restore would never finish.


`useTopLayerDialog` (`hooks/ui/useTopLayerDialog.ts`) implements 1 and 3, rule 4's handling of a
`closedby="none"` dialog, and focus return to the invoker on unmount. It returns a `titleId` and
a `descriptionId` for the dialog's `aria-labelledby` and `aria-describedby`. `ForceUpdateOverlay`,
`ConnectionLostOverlay`, `AttestationFailedModal`, `ChangelogModal` and
`VoiceJoinErrorNotice` use it.
`MFAChallengeModal` implements rules 1–7 in its own effect, because it alone applies rules 6 and 7:
the hook keys on "is open" and never takes the top back.
The hook marks its dialog with `data-global-overlay`. While such a dialog is open, or an MFA
challenge is pending, `keyboardShortcutService` runs only `toggle-mute` and `toggle-deafen`
(rule 6), so Ctrl/Cmd+, cannot show Settings above it and close-modal cannot cancel its Escape.
The challenge dialog carries no marker: the service reads the pending token from the challenge
store. A dialog opened by code rather than a key (another global overlay, the MFA challenge) still
goes on top.
jsdom implements neither `inert` nor the top layer, so `tests/helpers/topLayerEmulation.tsx`
emulates both for focus, following the HTML spec: only a MODAL dialog escapes an inert ancestor
(rule 2), a closed `<dialog>` refuses focus, `showModal()` re-adds a closed dialog to the top and
focuses its first enabled control but does nothing to a dialog already modal, and `close()`
queues its event as Chromium does and does nothing to a closed dialog. `tests/setup.ts` makes
`:modal` match a dialog opened with `showModal()`; a suite that stubs `showModal()` must call
through to it. `tests/helpers/foreignModal.ts` opens a modal dialog in front of a component and
removes it after each test. Reuse all three for the next overlay of this kind:
`tests/unit/components/globalOverlaysBehindModal.test.tsx` shows the shape, and its first cases
check each emulation rule on its own, so deleting a rule turns its case red.
`tests/unit/components/Auth/mfaChallengeBehindModal.test.tsx` pins rules 6 and 7, and
`tests/unit/styles/dialog-placement.test.ts` pins rule 5. The emulation cannot notice an engine
that stops honouring rule 2's escape, rule 4's `closedby="none"`, or the close-watcher grouping
rule 4 guards against, so all three are in the Platform-behavior register below with a
real-engine probe.

## TypeScript

- No `any` — treat lint warnings as errors in security-critical code (auth, E2EE, RBAC)
- No non-null assertions (`!`) in production code
- Path aliases: `@/renderer/*`, `@shared/*`
- Unused variables: prefix with `_`

## Platform-behavior register (post-#2866)

Some behavior we depend on is **not expressible as an API signature**. It is a timing,
ordering, or availability contract of the underlying engine — Chromium, the OS keychain,
libwebrtc — and it can change while every signature stays identical. Feature detection
does not see it: in the founding incident `'transform' in receiver` still passed and the
assignment still did not throw, yet zero frames flowed.

Two consequences, and they are the whole reason this section exists:

1. **Reviewing the diff cannot catch a break here** — an engine bump's diff is a version
   string, and the risk lives entirely in behavior the patch does not contain.
2. **A unit test usually cannot either** — the contract only exists in a real engine, and
   a mock accepts whatever you do to it.

So each entry below names a **runtime proof**, not a test. That is the control.

| Contract | Why a signature check misses it | What proves it |
|---|---|---|
| **Encoded-transform attachment timing.** A receive transform must attach at receiver creation (`ConsumerOptions.onRtpReceiver`, after `setRemoteDescription` and before `createAnswer`); sender-side at `onRtpSender`. See § E2EE below | The property exists and is assignable at any time. Chromium ≥149 simply stops routing frames to one attached late, and *replacing* one throws `InvalidStateError`. MDN documents the first-frame guarantee only for the creation-time path and does not cover late attachment at all | `voiceTransformBypass.ts` — ~5 s after each decrypt attach (30 s slow-poll for silent producers), pair `inbound-rtp.packetsReceived` against the worker's entered-frame count. Packets with zero entered frames = engine bypass ⇒ fail closed, then one-shot fallback to the legacy pipeline |
| **`stopTracks: false` on every producer.** mediasoup-client's `Transport.produce()` defaults `stopTracks` to `true`, so `producer.close()` kills the underlying `MediaStreamTrack` | The option is accepted either way and nothing throws. The damage appears only later, as a dead capture device on the next produce — the serialization tails in § Voice/media producer track lifecycle encode real outages | The per-source cleanup helpers keyed off `producer.appData.source`, plus the capture-stop fail-closed path. Do not drop the flag to "simplify" a `produce()` call |
| **`safeStorage` keychain availability.** E2EE key persistence may fail on a machine with no working OS keychain, and on Linux the async encryptor may hold only a hardcoded key | `safeStorage` is always present; only the *write* fails, and only on some machines. `isAsyncEncryptionAvailable()` also resolves `true` when Linux has fallen back to Chromium's `PosixKeyProvider` (hardcoded key, tag `v10`). Electron's docs name only the `basic_text` signal for this; the fallback also follows a keyring that fails to return a key, which no API reports | `persistE2EESessionKeys` surfaces the failure and **never clears a valid in-memory session** (#1278 / #1288). A persistence failure costs restart-survival only. `secureStorage.encryptForDisk` reads the tag of every Linux ciphertext and accepts only the keyring tags `v11` and `v12`, so the hardcoded key (`v10`), or a tag nobody has verified, counts as no secure storage: nothing persists under it, and Login and Register refuse to start (#197) (see [`electron.md`](electron.md) § Token Storage) |
| **ICE selected-pair resolution timing.** The relay diagnostic resolves its answer from `RTCTransportStats.selectedCandidatePairId`, and the single `connectionstatechange` -> `'connected'` callback is the ONLY chance to read it. mediasoup-client dedupes on the state VALUE (`Transport.js:794`) and Chromium maps both ICE `connected` and `completed` onto that same string, so the post-nomination moment never arrives as a second event | Every field in the stats report is optional, so a report that resolves nothing is byte-identical to one taken too early -- both simply yield `null`. The W3C spec defines `connected` and `completed` as distinct ICE states but carries no sentence ordering `selectedCandidatePairId`'s population against either, so nothing guarantees the value is present when we look. A synthetic stats `Map` cannot see this at all: it returns whatever it was built to return | `recordSelectedCandidatePair` emits `[ice] selected-pair-unresolved` when a transport reached `connected` and no pair resolved, and arms `recorded` only on a successful emit so a real `disconnected`->`connected` retries -- including one observed while a read is still IN FLIGHT, which is queued rather than declined, because mediasoup never replays a state event you did not act on. A generation fence bounds that queue: a read reports, and a queued reconnect replays, ONLY while its generation is still the live connected one -- so a rapid flap can neither report a transport that has since gone nor latch a measurement from a connection that already ended. A bug report carrying `-unresolved` with no `selected-pair` IS the contract breaking. A REJECTED read logs `[ice] selected-pair-stats-unavailable` under a separate label so it can never be mistaken for that -- a rejection is the transport closing under us, not the engine changing behaviour, and one shared label would mean neither thing. PR #3117 shipped this diagnostic silent and it emitted nothing for two days with every test green -- the founding case for this row |
| **A/V playout synchronisation.** Lip-sync rests on the SFU's RTCP Sender Reports mapping RTP timestamps to a sender NTP clock. mediasoup 3.25.0 (PR #2917) changed how the worker derives them — from RTP arrival time to an estimated capture instant (`RemoteClockOffsetEstimator` / `RemoteCaptureTimeEstimator`, upstream PRs #1882–#1887) — and changed `abs-capture-time` rewriting in `SimulcastProducerStreamManager` (#1889), so post-3.25.0 the SR NTP is intended to convey the *publisher's* capture instant in the SFU's clock basis rather than the SFU's own arrival time. 49 check-runs passed because nothing measured drift. #3055 then bumped again to **3.26.0** before any proof existed. Baseline for this row: **mediasoup 3.26.0, Electron 44.1.1 / Chromium 152**; re-run clean on mediasoup 3.28.0 with Electron 44.5.0 (2026-10-14, PR #3787 probe evidence) | The W3C defines the field that would answer this directly — `RTCInboundRtpStreamStats.estimatedPlayoutTimestamp`, "the estimated playout time of this receiver's track … the NTP timestamp of the last playable audio sample or video frame that has a known timestamp (from an RTCP SR packet mapping RTP timestamps to NTP timestamps), extrapolated with the time elapsed since it was ready to be played out" — and its only A/V-sync guidance is a **non-normative** example: "`audioInboundRtpStats.estimatedPlayoutTimestamp - videoInboundRtpStats.estimatedPlayoutTimestamp`". No normative sentence guarantees the two are comparable. **And Chromium does not implement it** (MDN browser-compat-data `api/RTCStatsReport.json`: `version_added: false`), while our bundled `lib.dom.d.ts:2237` **does declare it** — so a detector written against it compiles, type-checks and unit-tests green against a synthetic `Map`, and is permanently `undefined` at runtime. Presence in the type system is exactly zero evidence of behaviour. The field Chromium *does* populate, `remote-outbound-rtp.remoteTimestamp` — "measured at the remote endpoint and reported in an RTCP Sender Report (SR)" — has **no DOM type at all** and no spec sentence about synchronisation. The platform types the field it does not implement and implements the field it does not type | `avSyncDriftDetector.ts` — pairs each kind's `inbound-rtp` to its `remote-outbound-rtp` via `remoteId`/`localId` (both directions or refuse), differences the two `timestamp − remoteTimestamp` offsets so the shared sender clock basis cancels, and fits a Theil–Sen slope over a ≥ 60 s window. Audio and video are on **separate** recv `RTCPeerConnection`s — `createRecvTransports` builds both unconditionally, because avoiding BUNDLE payload-type collision was the point of #291 — so the sampler calls `getStats()` on **both** transports and merges under an `'a:'`/`'v:'` id namespace (`RTCStats.id` is unique only *within* one report, and a raw merge mis-pairs across transports rather than refusing). `owd_A − owd_V` is therefore the difference of two independently-ICE-negotiated paths between the same host pair, not one path's queuing noise: while both transports hold their selected candidate pair and share a bottleneck there is still no physical reason for a sustained trend, so a slope is evidence about timestamping. When they select **different** candidate types, congestion building on only one of them is a genuine false-positive class (differential path drift) — read `pairAudio`/`pairVideo` on the marker before believing it: same type is corroboration, `relay` against `host`/`srflx` is the alternative explanation. Emits `[avsync] drift-detected` on ≥ 1.0 ms/s sustained **AND** an excursion of `\|skew_last − skew_first\| ≥ MIN_EXCURSION_MS` (60 ms) across the window — both are independent gates, so a slow drift that clears the slope threshold can still sit below trip until the excursion gate also clears. Four guards carry the design: a frozen SR stream manufactures a perfect +1 ms/ms line, so a sample is refused unless `remoteTimestamp` advanced (`sr-not-advanced`); a server-commanded spatial-layer switch steps the capture-time basis while SSRC and `trackIdentifier` hold constant, invisible to every identity guard, so a step clears history (`offset-step`) — gated on a RATE, `MAX_STEP_MS / (SAMPLE_INTERVAL_MS / 1000)` = 6 ms/s, not an absolute 30 ms delta, because `sr-not-advanced` can hold across an arbitrary run of stalled ticks and an absolute threshold calibrated for one 5 s gap misreads a genuine 1 ms/s drift spread across a 30 s stall as a single 30 ms step and wipes the window; more than one **SR-linked** remote sender of a kind refuses to measure at all (`ambiguous-streams`), because one recv transport per kind serves every remote participant and a pairing keyed by kind alone would silently keep one publisher and drop the rest, differencing a skew across two publishers' clocks into a plausible-looking wrong number — so the detector is deliberately quiet in group calls, not broken. A group call therefore refuses on EVERY tick for its whole session, so the quiet needs to be **announced rather than merely intended** — an unannounced silence is indistinguishable from a broken detector, and a triager reading a 5-party bug report with no `[avsync]` line would reasonably conclude the detector ran and found nothing. It emits `[avsync] unmeasured` once per session after `AMBIGUOUS_STREAK_TO_REPORT` consecutive refusals, on its own latch and its own streak — `ambiguous-streams` stays OUT of the field-absence class, because the engine ceasing to emit the fields and the detector declining to measure fields it can read perfectly well are different facts and must not share a label. The payload is the **reason only**: no peer count, because this line reaches a PUBLIC repo through the feedback pipeline (`observability.md` principle 6) and "declined to measure" is the whole signal a triager needs. (An earlier revision of this row cited principle 7 as forbidding such a marker. That was wrong — principle 7 governs privacy-decision discriminators, where a refusal is deliberately engineered to be indistinguishable from another refusal; a diagnostic declining to measure is not that, and the real constraint is principle 6's public-repo exposure.) **SR linkage, not entry count, is the admission test, and that distinction was found on a live call rather than in review:** mediasoup-client creates a bandwidth `probator` consumer in EVERY call — an `inbound-rtp` of kind video, ssrc 1234, `mid: 'probator'`, carrying no `remoteId` and no `remote-outbound-rtp` — so counting raw inbound entries made this guard fire on an ordinary TWO-party call, refusing all 22 ticks with the whole unit suite green. An inbound stream with no Sender Report partner can contribute no offset and is not evidence of a second publisher; and thresholds are **calibrated on a loopback harness** where one-way delay is ~0 — real-network jitter is unmeasured. `[avsync] fields-unavailable` is a **separate, latched** label for the engine ceasing to emit the fields — drift observed and could-not-measure must never share one. The proof is **one-sided** (receiver only): the SFU's own `producer.on('trace','sr')` view is available with no new dependency and is deliberately deferred as a 5-surface, default-off operator change. Probe: `./scripts/concord-dev.sh up --clients 2`, video on both, ≥ 90 s, DevTools console level **Verbose** |
| **Per-sender RTP encoding parameters.** `priority` and `networkPriority` may carry a non-default value on `encodings[0]` ONLY | Both mediasoup-client's `RtpEncodingParameters` and the bundled `lib.dom.d.ts` declare the fields on **every** encoding, so a three-rung ladder carrying them on all three type-checks, lints, and unit-tests green against a plain object. libwebrtc's `UnimplementedRtpParameterHasValue` then refuses the whole call: `addTransceiver` throws and the publish fails outright, while `setParameters` rejects into a `.catch` that logs `[video-settings] Video priority update failed` — so the change is never applied, and the only signal is that console line: nothing surfaces to the user, which is why a layered sender silently ignored every priority change. No signature anywhere can express "index 0 only", and only `'low'` maps to both libwebrtc defaults — the app default is `'medium'`, so every affected publish failed | **MEASURED 2026-09-17 on Chromium 152**, the major Electron 44 ships, by calling `addTransceiver` with each shape: both fields on all three rungs throws `OperationError` carrying the exact production message; on rung 0 only it is ACCEPTED; **either field alone** on rungs 1–2 throws, so neither is the sole culprit; `'low'` on all three is accepted, confirming it is the one value matching both libwebrtc defaults; and a single encoding carrying both is accepted, that encoding being index 0. Note the type is `OperationError` — not `InvalidModificationError`, which is what recall suggests and what this entry said before it was measured. `cameraLayering.test.ts` § `per-sender RTP encoding parameters (libwebrtc contract)` guards it thereafter, asserting the RULE rather than the ladder's literal shape — the two tests that asserted the shape had pinned the defect and stayed green through it. End-to-end confirmation is a live two-client call with both cameras on, which is what turns the room camera-layering gate on |
| **`createMediaElementSource` on a `srcObject`-backed element, and `createMediaStreamSource` over a consumer track.** The receive audio graph may NOT be fed by capturing the `<audio>` element; it must be fed from the `MediaStream` — except where the recv transport carries `encodedInsertableStreams`, which is Chromium #295's precondition and makes the stream source the unsafe one instead. The two are mutually exclusive and the fork is `voiceService.recvTransportUsesInsertableStreams(kind)` | `createMediaElementSource` exists, is callable, accepts the element, returns a node and connects normally. It throws nothing and warns nothing — it simply captures silence, while the element keeps playing at full volume, so the audio is still AUDIBLE and only the graph is dead. That is why five features rode it unnoticed: per-participant volume, master output volume, quiet boost, the analyser driving boost, and output-device selection. MDN's `createMediaElementSource` page carries no exclusion for `srcObject`-driven elements, and no signature can express "this capture is live only when the element's source is a resource URL". A unit test cannot see it either: `AudioContext` is mocked in every one of ours, and a mock accepts whatever you do to it | **MEASURED 2026-09-17 on Electron 44 / Chromium 152** against a loopback `RTCPeerConnection` carrying a real remote track (79 packets / 75,360 samples confirmed via `getStats` inbound-rtp, as the positive control): oscillator → analyser peak **1.0000**; `createMediaElementSource` on the remote track peak **0.0000**; `createMediaStreamSource` on the same track peak **0.9058**; and a MUTED element still pulls the track, peak **0.9035**, which is what lets the graph path mute the element without stalling the pipeline. **No standing runtime detector ships for this row, and that is a stated gap rather than an oversight** — unlike the transform-bypass and A/V-sync rows there is no cheap in-band witness, because a silent graph and a silent speaker are the same observation. What bounds it instead is structural: the dead API has no call site left, and `ParticipantGrid.audioGraph.test.tsx` asserts the CONTRACT ("exactly one audible path, and the volume controls are on it") rather than which API is called, so a regression to the element capture fails on an assertion instead of on a missing mock. A regression in the OTHER direction — Chromium making `createMediaStreamSource` silent on the script-transform path too — would be inaudible and undetected; re-run the probe on any Electron bump per `/weekly-deps` § 4.C |
| **Escape on a modal `<dialog>` can close it through `preventDefault()`.** Escape's `cancel` is cancelable only while the page has user activation. Without it the dialog closes and `close` follows. `MFAChallengeModal`'s `onClose` re-shows the dialog while a proof is in flight, and treats any other close over a live challenge as Cancel (#3423) | `oncancel` exists and `preventDefault()` works in every unit test, because a test fires a cancelable event. MDN says "The event is cancelable and does not bubble", which does not hold here; the HTML close-request steps allow a cancel only when the window "has history-action activation" | Measured both ways on Electron 44.4.3 / Chromium 152: with no user input since the dialog opened, Escape closed the MFA challenge despite `preventDefault()` (#3423); after real input through `webContents.sendInputEvent`, #3424's dialog top-layer probe recorded `cancel(cancelable=true)` then `close`. Re-run both arms on any Electron bump |
| **Escape on a `closedby="none"` dialog closes the dialog below it when both were shown without user activation.** A dialog shown with no user activation since the previous one joins that dialog's close-watcher group, and `closedby="none"` disables only its own watcher, so the close request passes to the next watcher in the group. A network response raises the global overlays, so this is their usual case: Escape on `ConnectionLostOverlay` dismissed an `AttestationFailedModal` or `ChangelogModal` beneath it. `useTopLayerDialog` cancels Escape keydowns in a `closedby="none"` dialog, which stops the request before it reaches the group (#3424) | The HTML spec's close requests (§ Close requests and close watchers) run every watcher in the topmost group and pass over a disabled one without stopping. Nothing on a dialog reports its group, a single-dialog test never sees it, and the jsdom emulation has no close watchers at all | **MEASURED 2026-09-24 on Electron 44.4.3 / Chromium 152.0.7977.130** by `desktop/scripts/dialog-top-layer-probe`, with both dialogs shown without activation: one Escape closes two ordinary dialogs (the grouping control), closes the dialog beneath a `closedby="none"` one while that one stays open, and closes neither once the `closedby="none"` dialog cancels the keydown. With a gesture between the two `showModal()` calls the dialogs sit in separate groups, and Escape on the locked one does nothing |
| **A dialog's `close` event is queued, not fired inside `close()`.** Code after `close()` in the same task, such as the top-layer retake's `showModal()`, runs first, so a `close` handler can find its dialog open again. `MFAChallengeModal`'s `onClose` ignores a close while `e.currentTarget.open` (#3423) | The event arrives either way; only its order moves. MDN says only that it fires "when the `<dialog>` it represents has been closed". The `tests/setup.ts` polyfill fires it synchronously, the opposite order, so `mfaChallengeBehindModal.test.tsx` queues it in a microtask | Measured on Chrome 152.0.7977.130 (the Chromium in Electron 44): `close()`, then `showModal()` in the same task; `close` fired afterwards with `open === true` (#3423) |
| **The last `showModal()` owns the top of the top layer.** A dialog opened later covers every earlier modal, whatever its `z-index`. The MFA challenge takes the top back with `close()` + `showModal()` when another dialog opens over it; only the challenge may do this (§ "A global overlay must be reachable over the Settings dialog", rule 6) | Nothing reports the stacking order, and a covered modal is still `open`. MDN says a modal displays "over the top of any other dialogs", which covers opening but not retaking | Measured on Chrome 152.0.7977.130: after showing A then B, `document.elementFromPoint` at A's centre returns B. The #3423 captures show the challenge above Settings in both themes |
| **Top-layer dialog escape and `closedby="none"`.** The overlays using `useTopLayerDialog` render inside `#root`, which ModalContext makes `inert` while any `ui/Modal` is open, and rely on a `showModal()` dialog escaping that inert ancestor. `ForceUpdateOverlay` and `ConnectionLostOverlay` also rely on `closedby="none"` to keep Escape from dismissing them | The HTML spec carries both: a modal dialog's "subject escapes inertness of ancestors" (§ Modal dialogs and inert subtrees), and `closedby="none"` means "No user actions automatically close the dialog" (§ The `dialog` element). Neither is visible to a type or feature check, and the jsdom suite EMULATES both (`tests/helpers/topLayerEmulation.tsx`), so it stays green if an engine stops honouring either. The failure shape is an overlay that paints on top but cannot be focused or clicked, or a mandatory overlay that Escape dismisses | **MEASURED 2026-09-23 on Electron 44.4.3 / Chromium 152.0.7977.130** by `desktop/scripts/dialog-top-layer-probe` (from `client/desktop`: `timeout 60 npx electron scripts/dialog-top-layer-probe`, read `PROBE PASS`/`PROBE FAIL`), each against a control in the same harness: a plain button under the inert ancestor refuses focus while the nested dialog's button takes it, and the same injected Escape closes an ordinary modal dialog while the `closedby="none"` one fires neither `cancel` nor `close` and stays open. Not in CI: the headless Linux probe job has no window to deliver the Escape to |

| **Microphone AudioWorklet loading and lifetime.** The microphone processor must load from a Vite-emitted JavaScript URL on the renderer's current origin before constructing its node; process each block at its actual length and retire a node after `processorerror` | A URL import can type-check while Vite inlines a data URL or omits the asset from a build, and a mock `addModule` cannot prove that Chromium executes the emitted bytes. MDN says `addModule()` returns ["A Promise that resolves once the module from the given URL has been added"](https://developer.mozilla.org/en-US/docs/Web/API/Worklet/addModule#return_value). Its [process contract](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor/process#exceptions) says an uncaught error makes the node output silence for the rest of its lifetime; block size can change | Build a renderer containing the host import, verify the emitted `.js` URL and JavaScript MIME, then run `addModule` and an offline impulse through the emitted asset on the same origin. A 2026-10-06 Vite 8.3.3 canary build and muted Chromium 153 run loaded the emitted asset: 4 ms delay at 48 kHz, final peak `0.5011872053146362`, and stereo ratio `0.5`. The packaged `app://concord` and signed `spa-cache://concord` origins still require their own runtime check before this is called fully verified; re-run all origin checks on an Electron/Vite bump |


| **Calibration phase attribution and silent processing (#3637).** Renderer delivery time cannot label audio. Send increasing safe-integer epochs, reset the calibration partial window on the audio thread, acknowledge the epoch/phase, and accept only matching complete-window reports. Count usable frames at the actual context rate; cap quiet/speech reports at 10/20 captured seconds. Silent calibration connects the existing Test processor through zero gain to the running destination, with no listening element; close the processor/context and disconnect owned nodes on teardown | MDN says the AudioContext [currentTime](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/currentTime) is an “ever-increasing hardware timestamp in seconds”; its [suspend()](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/suspend) contract “temporarily halts audio hardware access.” Neither establishes renderer message-delivery time as an audio-phase boundary or proves a silent graph runs on every packaged origin. An epoch acknowledgement is synchronization, not proof of speech or microphone quality | **MEASURED 2026-10-25 on real Chromium 151.0.7922.173**, Vite origin `http://127.0.0.1:5177`, importing actual `createMicProcessor` and current-origin worklet (`HTTP 200`, `text/javascript`). Synthetic ConstantSource through fixed gate and zero-gain destination produced epoch-1 quiet reports: 500 windows / 480,000 frames at 48 kHz, then held its cap. Reports measured peak `0.0010000000474974513` while gated output peak was `0`. Suspension held report count stable. Epoch-2 speech reported `0.009999999776482582`; context closed with no processor errors. See verification report for reproduction and limits. This proves this synthetic browser graph only; packaged Electron origins, physical microphone quality, full UI cleanup and mid-window phase reset require their own evidence. Re-run on browser/Electron/Vite changes |

**Adding an entry.** When you find that some behavior you rely on is not guaranteed by a
signature — a timing rule, an ordering rule, an engine-availability rule — add a row here
with its runtime proof, and quote the sentence from MDN or the spec that carries (or fails
to carry) the guarantee. See the web-platform section of
`_shared/context7-docs-discipline.md`.

**What this is not.** Not an inventory of every platform API the renderer calls — that
would rot immediately and nobody would read it. Only contracts where **presence does not
predict behavior** belong here. If a normal type check or unit test proves it, leave it out.

`/weekly-deps` walks this register on any bundled-engine bump (Electron/Chromium, any
Node runtime change — a minor rolls V8 — mediasoup/libwebrtc, and container image tags),
matching that skill's own trigger table rather than a narrower list, and then RUNS each exposed row's probe against the new engine
before the bump can be recommended (§ 4.C step 4b). Walking it names the proof; running it
is what produces the evidence — a row reported "exposed, probe armed" is a fact about this
repository, not an observation about this bump.

## E2EE

- Decryption happens client-side via `e2eeService` — use shared service, don't inline
- Key material must NEVER be logged, sent to server unencrypted, or stored outside `safeStorage`
- Always call `e2eeService.encrypt/decrypt` — encryption is structural after #1024, not gated on a per-channel flag; check `e2eeService.isInitialized` for startup-race protection
- `encodedTransformSupport.ts` resolves one media-E2EE transform API. Prefer
  `RTCRtpScriptTransform` whenever it exists, even if `createEncodedStreams` also exists; use the
  legacy main-thread stream only when the Worker API is absent — or when the legacy override is
  engaged (below). Set mediasoup-client's `encodedInsertableStreams` transport option only for the
  legacy path. Both paths must receive the same codec family and exact-key provisioning behavior;
  no API means fail closed.
- **Receive transforms attach AT RECEIVER CREATION, never after.** Chromium ≥149 (the encoded
  transform V2 line) does not route frames through a `receiver.transform` attached after the
  receiver is live: the transform's pipe stays empty while ciphertext flows to the decoder
  (garbled voice at full-scale noise / black video — the 2026-08-21 incident), and replacing a
  transform throws `InvalidStateError`. The decrypt transform therefore attaches in
  mediasoup-client's synchronous `ConsumerOptions.onRtpReceiver` callback (fires after
  `setRemoteDescription`, before `createAnswer`) via `buildDecryptCreationAttach`, mirroring the
  sender-side `onRtpSender` hook. `applyDecryptTransform` stays as the verifier: it detects the
  creation-time attachment, arms the bypass probe, and remains the fail-closed late-attach path
  for the legacy pipeline only. Do NOT revert to attaching after `consume()` resolves.
- **The bypass probe is the tripwire; the legacy override is the parachute.** ~5s after each
  decrypt attach (30s slow-poll for silent producers, for the consumer's lifetime), the probe
  pairs `inbound-rtp packetsReceived` with the worker's entered-frame count. Packets with zero
  entered frames = engine bypass: one direct re-attach (never null-then-set — null engages the
  spec's passthrough algorithm), then fail-closed consumer close and a one-shot session switch to
  the legacy pipeline with an automatic media-session rebuild. The override persists per page
  session (`sessionStorage['concord.e2eeLegacyFallback']`) so a fresh launch retries the modern
  path; `localStorage['concord.forceLegacyE2EE'] = '1'` is the manual/support override. Probes arm
  only on the script-transform path — the legacy pipeline is main-thread and would always read as
  bypassed.
- Every mic, camera, screen, screen-audio, and re-produce call attaches its encrypt transform in
  mediasoup-client's synchronous `onRtpSender` callback. That callback runs immediately after the
  `RTCRtpSender` is created and before offer creation or server-side `produce` signaling. An
  unavailable/failed transform must throw from the callback and abort publishing with the owning
  source cleanup; never wait for `transport.produce()` to resolve and attach afterward, because
  that creates a plaintext-send window.
- A typed `crypto_version_mismatch` means only that the client and occupied room use incompatible
  formats. The update/security banner must remain direction-neutral because either side may be
  newer; never claim specifically that the local client is outdated.

## Voice/media producer track lifecycle (`voiceService.ts`, post-#1902)

Any mediasoup producer that is **closed and then re-produced reusing the same
`MediaStreamTrack`** (the `fastReproduce*` codec/layer-swap paths, triggered by the
`camera-layering-gate` / codec-floor events) MUST be created with **`stopTracks: false`**.
mediasoup-client's `Transport.produce()` defaults `stopTracks` to `true`, so `producer.close()`
stops the very track the next `produce({ track })` reuses → `InvalidStateError('track ended')`,
which (room-wide, since the gate event is broadcast) killed every camera in the call. The
track lifecycle is instead owned by `localCameraStream` / `localScreenStream`, which every
teardown path stops explicitly. This applies to camera, screen, and screen-audio producers.
The microphone producer also needs `stopTracks: false`: a stale settings swap can restore
its prior graph track after `replaceTrack()` succeeds, and `cleanupMicState()` owns both
graph and capture track teardown. Founding incident: #1902.

**Microphone recovery intent belongs to the live session (#3619).** Codec/quality
replacements use the shared microphone queue. A failed replacement may leave no mapped mic;
later input or capture-constraint changes must enter that same queue when recovery is armed.
Only an existing mic may arm recovery. Explicit close, leave, cleanup, and E2EE failure
invalidate it, so settings changes cannot start capture in a listen-only or ended call.
Checking only for a mapped producer at each settings callback loses the recovery intent.

**A pending Microphone Test restart preserves the user's intent, not its capture.**
Device or processing changes that require a restart must use the shared restart helper even while
permission, capture, output-sink selection, or playback is pending. The helper invalidates and
releases the superseded generation, preserves ownership of any call suspension, and starts with
the latest committed settings. Explicit Stop, owner exit, or a call conflict cancels successors.

**Do not enter solo bandwidth-saving mode before the local participant is in the roster.**
An early peer `user-joined` can arrive before the authoritative `join-room` roster; counting that
partial roster as one participant pauses local producers during an active call. `checkSoloBandwidthSaving`
must require the local user entry before applying participant-count transitions.

**Receive consumers belong to the media-session generation that requested them.** Capture the
generation and Socket.IO socket before queuing `consumeProducer`, and carry both through server
consume, local transport consume, E2EE setup, and resume. After async boundaries, an invalidated
generation must close any server-side or local consumer through that captured socket before a track
can be routed into the store. Register `transportclose` cleanup as soon as the consumer enters the
maps, before E2EE setup awaits; before routing or resuming, require the consumer to remain open and
be the same instance in the map. This prevents a stale session from attaching media after cleanup
and a transport-closed consumer from lingering in the maps.

Once a consume is queued, `producer-closed` cancels the pending operation for that producer and
`user-left` cancels pending operations for that sender. The worker checks cancellation at its async
boundaries and closes any server-side or local consumer before store attach. A `new-producer` still
waiting for `addDecryptKeyForUser` has not queued a consume token yet; these events do not cancel
that pre-key wait. Do not describe cancellation as immediate across that earlier await.

### Screen-share audio and source switching

**The audio opt-out is honoured at the CAPTURE call, not just in the picker.**
`captureScreen`/`captureScreenElectron` take a `wantAudio` argument and require
`wantAudio && canCarryScreenAudio(chosenId, platform)` before requesting loopback. Both
conditions, never either: `wantAudio` alone reintroduces #2161 on a window target, and the prefix alone
ignores an explicit opt-out. `ScreenShareOptions.streamAudio` shipped once with the picker
writing it, the store persisting it, and the CAPTURE PATH ignoring it entirely — with a fully
green suite, because every test asserted the value was passed and none that it was obeyed.
"No readers" would overstate it; the readers that existed were all upstream of the decision.
See the testing note below.

**Capability is target AND platform, and the check lives at the CAPTURE SEAM.**
`canCarryScreenAudio` in `utils/policy/screenAudioCapability.ts` is the single authority,
shared by the picker and the service so they cannot drift. It is called inside
`captureScreenElectron` rather than in each caller's own `wantAudio` computation, because
`produceScreen` and `switchScreenSourceQueued` compute that value independently: while the
platform half lived only in `produceScreen`, a switch confirmed on Linux before the picker's
async platform probe settled forwarded `streamAudio: true` straight past it. A guard that has
to be repeated by every caller is a guard the next caller will omit. Linux has no loopback on this path; gating on the `screen:`
prefix alone offered an enabled, default-on control there for an operation that cannot succeed.

**Grep `setScreenAudioOn` before assuming you have found every site.** That instruction, not
the number, is the rule — the number in this paragraph has been wrong five times now (six, then
seven, then nine, then ten, then fourteen), each time because a new site was added without
updating the count. Re-verified 2026-09-23 (#3394 PR 2 docs pass) against `main`: there are
**fifteen**, and this time the added site is NOT drift — it is this PR's own
`handleScreenAudioInterrupt` (§ "Screen-share audio and source switching — interrupted state"
below), which writes `store.setScreenAudioOn(false)` on the way into the `interrupted` arm, the
same as every other path that ends a share's audio without ending the share. `fastReproduceScreenQueued`'s own screen-producer `transportclose`; two in
`reProduceScreenAudio` (its `transportclose` and its produce-failure catch); three in
`produceScreenAudioFromStream` (the dead-track fallback, the success, and its `transportclose`);
`produceScreen`'s own screen-producer `transportclose`; **`cleanupMediaAndTransports`** (the
reconnect-teardown site described two paragraphs down — previously described but never counted
here); two in **`setScreenAudioEnabled`** (the explicit off-path write after
`retireScreenAudioProducer`, and the idempotent-return arm when a live producer already exists —
both intentional user-toggle writes, previously excluded from a count that was framed around
*failure* paths only); **`bindScreenAudioTrackEnded`**'s audio-track `onended` handler (described
below under "The audio track needs its own `onended`" — also previously described but never
counted); `retireScreenAudioProducer`; `cleanupScreenAudioState`; `cleanupScreenState`; and
**`handleScreenAudioInterrupt`**. The
"failure path" framing in the previous version of this paragraph undercounted by construction —
several described, intentional sites were never folded into the enumeration. Read the count as
"every site — failure path or otherwise — that this doc describes should appear in the grep",
not as "every failure path". The two audio `transportclose` handlers sit ~1,600 lines apart and
are easy to edit singly; one of them went a whole PR without clearing the flag. Every path that
sets or clears this flag owes an entry here — that is the invariant, and the count is just its
current cardinality.

**`voiceStore.screenAudioVerdict` is a THIRD piece of state, and the toolbar needs all three.**
`videoSettingsStore.screenStreamAudio` is what the user asked for, `isScreenAudioOn` is what
is being sent, and `screenAudioVerdict` is WHICH RUNG the live target sits on.
The toolbar reads the third to decide whether to OFFER the control and the second to decide
what it says; a capable target with audio off and an incapable target both read
`isScreenAudioOn === false`, so that flag alone cannot distinguish "switched off" from
"impossible here".

**It is a VERDICT, not a boolean, and that was a defect found by running the app (#3198 PR 3).**
It shipped as `isScreenAudioCapable: boolean`, and `VoiceControls` recovered a verdict from it
with `isScreenAudioCapable ? 'system-loopback' : 'none'` — a two-value mapping that structurally
could not name `'per-process'`. The live toolbar therefore promised whole-computer sound during an
app-scoped share while `screenAudioTitle`'s `'per-process'` arm sat reachable only from its own
unit test. **A boolean cannot carry a three-rung ladder; widen the channel rather than map again at
the far end.** Consumers that only need "does this offer audio" call `verdictOffersAudio`, so the
policy keeps exactly one encoding. `voiceService.currentScreenAudioVerdict()` is the single
producer — it is the only place that knows both the live source id and the platform — and
`canShareScreenAudio` delegates entirely to it rather than re-deciding. Before it existed the live toggle was enabled on a window share and on
Linux, and the service refused the click afterwards — with the window-specific message, which
sent a Linux whole-screen user to a remedy that could not work.

**A REFUSAL MESSAGE NEEDS EVERY INPUT THE REFUSAL DEPENDS ON — and this one has now been
wrong twice, in opposite directions, for the same structural reason.** Whether a share can
carry sound is a two-input question: the target's shape AND the platform. Answer it from one
input and you will mislabel whichever case the missing input distinguishes.

- **First occurrence:** `screenAudioRefusalMessage` keyed on `sourceId` alone, so a Linux
  WHOLE-SCREEN share got the window text and was told to share a whole screen — which it
  already was. Fixed by splitting the id into three cases.
- **Second occurrence (#3198 PR 2 review):** the same function, still keyed on `sourceId`
  alone, gave a Linux WINDOW share the text whose remedy is "share a whole screen to include
  sound". On Linux that is also silent, so following it costs the user the share they had for
  nothing. The three-way id split could not see this — the case it forgot was not an id shape.

The function now takes `platform` and tests it BEFORE the id shape, because Linux's answer does
not depend on what was picked.

- **Third occurrence, same function, same PR (#3198 PR 2 Phase-8 review):** the parameter was
  added and the branch was written, and the sole production call site was left passing one
  argument — so `platform` defaulted to `null`, the Linux arm was dead outside its own unit
  tests, and both the commit message and the as-built entry (then in CLAUDE.md, now
  `docs/reference/as-built-ledger.md`) recorded the defect as fixed. The
  emphasis below is therefore on **pass**, not on the signature: adding the parameter is the
  half that gets done, and the twice-forgotten half is threading the value that is already in
  scope. See `tests.md` § "The converse: a branch that is OBEYED must be proven
  REACHED" for the test shape that catches it — a caller-level table that VARIES the new input,
  since no helper-level test can. The rule generalises past this one function: **when a refusal's
copy varies by platform, pass the platform — do not infer it from the target.** A `null` platform
(the async probe has not settled) is a third state, not a synonym for "not Linux"; decide what it
should say rather than letting it fall through.

This is the `hardening one copy leaves the mirror weaker` shape: the first fix made the function
look reviewed, and its own docblock cites that fix — which is exactly what stopped the next reader
from asking whether the mirror case was covered.

**`voiceStore.machineScreenAudioCapable` IS THE FOURTH FLAG, live since #3198 PR 3.** It is a
per-MACHINE fact — does this computer have a per-process capture backend at all — pushed once
from main over `audiocap:capability` on the handshake and again on every `did-finish-load`. It
is the third argument to `canCarryScreenAudio`, and it is what makes the `'per-process'` verdict
returnable. The other three answer questions about the SHARE; this one answers a question about
the machine, and a share can be perfectly capable while the machine is not.

Read the four together as: what the user asked for (`screenStreamAudio`), what is being sent
(`isScreenAudioOn`), which rung this target sits on (`screenAudioVerdict`), and whether
this machine could carry it per-process (`machineScreenAudioCapable`).

**It is SUBSCRIBED at every React call site, never read through `getState()`.** The snapshot
arrives asynchronously — main pushes it when the capability handshake settles, which can be after
the picker first renders — so a one-shot read freezes the picker on the pre-push `null` (the
fail-closed pre-addon rungs) with no re-render to correct it, and the app-audio toggle stays
hidden on a machine that supports it. Service-side reads (`voiceService`) use `getState()`
correctly, because they run at click time rather than at render time.

**The argument is OPTIONAL, so the compiler cannot tell you which call sites forgot it.** There
are four — the picker, the capture seam, `setScreenAudioEnabled`, and `canShareScreenAudio` — and
a site that omits it silently answers with the pre-addon rungs. `grep canCarryScreenAudio(`
before assuming a list is complete; that grep is the check, not this count.

**History, because the reachability of this rung moved twice and both moves were deliberate.**
PR 1 declared the verdict and the parameter with no production caller. PR 2 was split on
2026-09-16 and shipped the resolver and the widened protocol, still with no reachable caller —
not an oversight but a decision, because nothing in the repository posted the control message
that would let a share reach the rung. PR 3 built that leg (main constructs the
`MessageChannelMain`, posts `{kind:'start'}`, hands the renderer its port) and threaded the third
argument at all four sites in one change. See
[ADR-0043](../../../docs/adr/0043-per-process-screen-share-audio-capture.md) § As-built addendum —
#3198 PR 3 and [`electron.md`](electron.md) § "IPC contract v28" for the mechanism.

**THE PER-PROCESS AUDIO TRACK DOES NOT COME FROM `getUserMedia`, and that is what makes the
#2161 widening structurally impossible on this rung.** The `'per-process'` arm of
`captureScreenElectron` takes the same `videoOnly()` capture every other arm takes, then invokes
`audiocap:start` and attaches a track built by `createScreenAudioBridge` from the
`MessagePort` main hands over. No `chromeMediaSource: 'desktop'` request appears anywhere in that
arm — the whole-desktop loopback lives in the `'system-loopback'` arm and nowhere else, so a
window target cannot reach one however the policy answers.

**`screenAudioBridge.ts` is WIRED, not dark.** It had zero importers until PR 3 only because
nothing had ever started a capture. It also owns the handoff listener at MODULE SCOPE rather than
per-bridge: main posts the port at the child's `hello`, and `audiocap:start` settles only later on
the child's `started` ack (#3394), so the port routinely arrives before any bridge exists, and the
preload relay hands it over exactly once with no retry. A start that fails after `hello` leaves
its port in that buffer unclaimed — deliberate and bounded (`UNCLAIMED_PORT_LIMIT`, and the
child end is already dead, so no audio ever flows on it). A per-bridge listener therefore lost the port and produced a silent audio-free share —
the `windowLoaded` trap from [`electron.md`](electron.md) § "IPC contract v27", one layer up.
Unclaimed ports are buffered by generation and swept when a newer bridge registers.

**Normal adoption deletes the claim immediately (#3349).** A successful adoption removes the
claim whether the port was already buffered or arrived in flight. A handoff for a generation with
no claim closes immediately when that generation is at or below the current one, covering duplicate
or retired deliveries. Only `stop()` that runs before its handoff arrives installs a self-removing
tombstone, which closes that late port; future generations remain buffered for a later bridge.
The tombstone is therefore a narrow stop-before-handoff race guard, not the normal claim lifetime.

**TEARDOWN IS TWO HALVES AND BOTH RUN FROM `stopScreenAudioHost`.** Releasing the bridge closes
the RENDERER's end of the port; it does not reap the capture child, which holds the OS tap. Every
`killAudiocapHost` caller is a quit or crash hook, and `audiocapChild.ts`'s `handleStop`
"deliberately does NOT exit", so the second half is the zero-argument `audiocap:stop` invoke.
Without it a share the user ended kept a live tap until the app quit or the next share superseded
it. `stopScreenAudioHost` is the right choke point because seven local teardown paths already
route through it behind the remote/local fence — see the paragraph on that fence below; a call
added from a path whose `userId` is not proven local kills the LOCAL capture whenever a REMOTE
peer stops sharing audio.

**Main uses the GRACEFUL stop, never the kill.** `stopAudiocapHost` posts `{kind:'stop'}` and
reaps on a short timer; `killAudiocapHost` reaps immediately. Both destroy the tap, but the
child's `handleStop` is the only caller of the addon's `status()` — the R9 silence detector,
`quiesceProved`, `destroyFailures` — so reaping outright computes all of them and reads none.

### Screen-share audio and source switching — interrupted state (#3394 PR 2)

**The `interrupted` arm is a FIFTH piece of screen-audio state, and it describes a different
fact from the other four.** `ScreenAudioState`'s `mode: 'interrupted'` arm (`voiceStore.ts`)
carries `{ reason: ScreenAudioInterruptReason; generation: number; overrun: 0 }`. The other four —
`screenStreamAudio`, `isScreenAudioOn`, `screenAudioVerdict`, `machineScreenAudioCapable` — are
documented above; all four answer a question about a SHARE that is either about to start or
currently running as intended. `interrupted` answers a different question: a LIVE `per-process`
share whose audio ended WITHOUT the user asking, after `'per-process'` was already reached. It is
distinct from `degraded`, which describes a start that never carried audio in the first place. It
is written by exactly one place, `voiceService.ts`'s `handleScreenAudioInterrupt`, and left by
exactly two events: a new capture (Share sound toggled back on, which claims a fresh generation
and writes a fresh `ScreenAudioState`) or the share ending (`off`, written by
`cleanupScreenState`/`cleanupScreenAudioState`). There is no ambient timeout that clears it on its
own.

**The one-slot replay in `screenAudioInterrupts.ts` exists because nothing orders a
`webContents.send` push against an `invoke` reply.** `audiocap:interrupted` can arrive before
`capturePerProcessScreenAudio` calls `claimInterrupts(started.generation, handler)` — a child that
crashes right after `started` is the concrete case named in the spec. `deliverInterrupt` holds
exactly one pending `{generation, reason}` slot: a push matching the live claim's generation is
delivered immediately, a push OLDER than the live claim is dropped as stale, and anything else
(no live claim yet, or a newer generation) replaces the pending slot. Generations only increase, so
one slot is provably enough: `claimInterrupts` itself drops an early entry that is now stale
(`early.generation < generation`) and replays one that matches (`early.generation === generation`).
`screenAudioInterrupts.test.ts` pins both directions — a push arriving before the claim is replayed,
and an older pending entry is cleared rather than replayed against a newer claim.

**`releaseScreenAudioBridge` vs `stopScreenAudioHost` — an interrupt takes the narrower one,
deliberately.** `releaseScreenAudioBridge` closes only the renderer's end of the port and releases
the interrupt claim; `stopScreenAudioHost` does that AND reaps the capture child over the
`audiocap:stop` invoke. `handleScreenAudioInterrupt` calls `releaseScreenAudioBridge` alone, never
`stopScreenAudioHost`, because main has ALREADY retired the child by the time the push reaches the
renderer — `retire()` in `audiocapHost.ts` reaps the child first and publishes the interrupt last
(see [`electron.md`](electron.md) § "IPC contract v30"). An `audiocap:stop` invoke here would ask
main to stop a session that no longer exists — harmless (main resolves which child to reap from its
own session state and finds none) but a wasted round trip. Every OTHER local teardown — the user
turning audio off, switching source, ending the share — still routes through `stopScreenAudioHost`,
because in each of those the renderer itself is the one ending a still-live child.

**The generation is re-checked before the queued handler runs AND after the retire await — two
separate failure windows, both guarded.** `handleScreenAudioInterrupt` is enqueued on the same
screen-reproduce tail every other screen mutation in this file serializes against (see
"Every camera/screen re-produce path is serialized per source" above), so a concurrent switch or
stop can supersede the bridge before the handler even starts running — the first
`this.screenAudioBridge?.generation !== generation` check catches that. `retireScreenAudioProducer`
is itself a transport round trip, so a second supersession can land DURING that await — the second,
identical check after it catches that window too. Skipping either risks stamping `interrupted` over
a share a successor bridge already owns (I6). Both checks are mutation-proven, including a
queued-then-superseded case.

**An interrupt can land while the audio producer is still being created, and the produce must
not undo it.** `produceScreenAudioFromStream` awaits an SFU round trip for the bridge track, and
`produceScreen` is not serialized on the `screen` tail, so the claimed handler can run DURING that
await. Two rules hold it: an ENDED track after the await means the audio is already gone, so the
producer is discarded and a rejected produce writes no `degraded` over `interrupted`; and whether
the track is a bridge track is decided BEFORE the await, never re-read, since a re-read after the
bridge is released labels a window share's track as the system mix. Found by the Phase-4 red-team
pass; the same window also undid a user's Share-sound OFF, which predates this PR.

**No REMEDY, ever, in `screenAudioInterruptCopy.ts`.** All three `ScreenAudioInterruptReason`
members (`capture-interrupted`, `child-crash`, `protocol-fault`) map to the identical sentence:
"App sound stopped. Your screen is still being shared. Turn on Share sound to try again." The copy
never suggests sharing a whole screen — that would widen the capture past what the user chose,
which is the #2161 failure the rest of this section exists to keep closed. This is a different kind
of message from `screenAudioRefusalMessage`'s REMEDY text: that text names an alternative CAPTURE
(a different share target); this one must never name an alternative POLICY.

**The live region mounts only while interrupted, so it never adds a second `role="status"` beside
the #2153 policy notice.** `VoiceControls.tsx` conditions the `role="status" aria-live="polite"`
region on `useScreenAudioInterruptNotice().interrupted` alone; that hook, in the same file, owns
the store read, the toast and announcement state, and both of their effects. A second,
always-rendered, usually-empty
`<span id="voice-controls-audio-interrupted">` is what `aria-describedby` points at, so the id
target is never dangling whether or not the live region itself is mounted. The live region gets its
text one frame later, via `requestAnimationFrame`, gated by a module-level `lastAnnouncedGeneration`
so the SAME generation is never announced twice — across a VoiceView ↔ PersistentVoiceBar remount,
or after a popped-out toolbar returns (the C16 case). The badge itself
(`.voice-controls__badge`) is a plain 8px dot with no icon — there is no `AlertTriangle` on this
control anywhere — honouring the #2153 T17 reservation that pairs `AlertTriangle` +
`--text-warning-strong` to the media-policy owner notice strip alone. While the dot shows, the
interrupt sentence REPLACES the button's `title` (`MediaButton`'s `badge` prop is that string):
the toast is gone after 10 s, and the spec's original "no title while badged" left a sighted user a
dot with no way to learn what it meant. `aria-describedby` still wins as the accessible
description, so a screen reader does not hear the sentence twice. The toast's expiry is
module-level too (`lastToastExpiredGeneration`), for the same remount reason as the announcement:
per-instance state re-showed it for another 10 s on every navigation while the share stayed
interrupted.

**The two process-tree residuals reach the renderer differently, and neither is an interrupt.**
Both were MEASURED by #3394 PR 2's hardware checks (2026-09-24, macOS 26.6.2), which corrected
what this paragraph used to assume.

- **Safari is a REFUSAL, not a silent share (M3).** Safari and its WebKit content process are
  both launchd-parented, so neither is a descendant of anything the walk can reach, and the owner
  holds no Core Audio process object. The tree is empty, the child reports `fault{target}`, and
  the start settles `target-unresolved`. `voiceService.degradeScreenAudio` stores that reason and
  shows "We couldn't capture that app's sound. Share a whole screen to include sound." in the
  slot-error toast. Before it existed the reason was stored and rendered by nothing, so the share
  went live silent with no message, and that is how M3 found it. A silent share with NO signal
  is still possible for an app whose window owner holds a process object while its audio plays
  through a launchd-parented helper; no such app has been observed.
- **A late helper is silent with no signal, and Chrome does not produce one in ordinary use
  (M2).** A process that connects to Core Audio only after the share starts is not in the
  start-time snapshot, so it is never tapped and nothing detects it. Chrome 149 starts its
  `audio.mojom.AudioService` at browser launch, not on first playback, so a share started
  before playback still captured sound. The residual needs that service to start or restart
  mid-share. The remedy is to toggle Share sound off and on, which starts a new child and a
  fresh snapshot.

It is **pushed by `voiceService.publishScreenAudioCapability`, never pulled by a renderer
effect.** The service is the only place that knows both halves (`currentScreenSourceId` and
the cached platform), and a component effect resolving it through the dynamic `voiceService`
import races every other click in the same commit — that shape broke eleven unrelated
`VoiceControls` tests before it was replaced. It is published at all three sites that change
the source: both `currentScreenSourceId` assignments and `cleanupScreenState`.

**Turning audio OFF must not stop the captured track.** The off path calls
`retireScreenAudioProducer`, NOT `closeProducer('screen-audio')` — the latter runs
`cleanupScreenAudioState`, which stops and REMOVES the audio track from the stream. With
that, a plain On → Off → On could not reuse the live capture, fell through to the
re-capture branch, and replaced the VIDEO track: every viewer interrupted for a change that
was only ever meant to touch audio.

**Three fields describe the live share, and they are maintained together.**
`currentScreenSourceId` (what is being shared), `currentScreenOptions` (the resolution,
frame rate and content type it is ACTUALLY running with, which may differ from the persisted
store for a transient share), and `currentScreenAudioCapable` (whether the capture carries
audio at all). All three are written at both capture-commit sites and cleared in
`cleanupScreenState`. Reading the store instead of `currentScreenOptions` in the audio
re-capture turned an audio-only action into a quality change — a 720p/15fps/detail share
silently became the stored 1080p/60fps/auto.

`currentScreenAudioCapable` exists because the id cannot answer the question on every path:
`getDisplayMedia` (the non-Electron dev/web fallback) records **no source id**, so the
id-based test reported "incapable" for a share that was actively sending audio, locking the
toolbar button and leaving no way to stop the sound short of ending the share.
`canShareScreenAudio` therefore ORs the id test with a live audio track.

**The picker seeds from live state only when the live target was CAPABLE.** On a window
share `isScreenAudioOn` is false because the platform forces it, not because the user chose
it; treating that as an opt-out left the toggle off after switching to a whole screen and
then persisted the `false` over a default-on preference.

**Reconnect teardown is the ONLY thing that can clear the live screen-audio state.**
`cleanupMediaAndTransports` closes producers by hand, and a hand-closed producer does not
fire its `transportclose` handler — so it clears `isScreenAudioOn`, `screenAudioVerdict`
and the three live-share fields itself. Left set, a stale `isScreenAudioOn: true` survived
the reconnect; a user who then started a share with Stream Audio explicitly OFF got no
correction (the zero-audio-track path returns without writing the flag), the switch picker
seeded audio as enabled from it, and the next source broadcast system audio against an
explicit opt-out.

**Install the switched track's `onended` BEFORE the audio-retire await.** That await drains
the transport queue; a source ending or having its permission revoked inside it fires `ended`
on a track with no handler attached, and assigning one afterwards does not replay a missed
event — the screen producer stayed mapped and `isScreenSharing` true over a dead track.

**Every new branch on the switch path must re-assert the currentness fence.** `replaceTrack`
can reject *because* the producer was closed under us, so its `catch` runs with an already
invalid token — the close-and-reproduce fallback added there would otherwise close a share
that is already gone and re-produce it, resurrecting the user's screen and system audio after
they explicitly stopped sharing. The fallback written to fix a broken switch was itself the
branch that walked past the fence.

**The audio track needs its own `onended`.** `transportclose` does not fire when only the
audio track dies — the OS revoking the capture, or the tap failing — so without a handler the
toolbar reported "Audio On" over silence and the next click spent itself clearing a stale
flag. The video producer has always had `track.onended`; the audio one now does too, and it
checks producer identity before acting so a stale track cannot retire its successor.

**Bind it through `bindScreenAudioTrackEnded`, and re-bind on every re-produce.** The TRACK
outlives its producer: `reProduceScreenAudio` swaps in a successor for the same track on a
codec, layering or settings change. A handler closed over the original producer then fails
its own identity check and returns, leaving the successor mapped over a dead track with the
flag stuck true — the first version of this fix covered the initial producer and not its
replacement. Any future path that maps a `screen-audio` producer owes the same re-bind.

**A dead audio track is never published.** macOS 14.2+ without the capture entitlement returns
a LIVE BUT SILENT track — no throw — so `produceScreenAudioFromStream` checks
`readyState === 'live' && !muted` and drops to video-only with a user-visible notice. A
try/catch cannot see this failure; only an explicit check can.

**The audio is the WHOLE SYSTEM MIX, and the copy must say so.** Electron's loopback ignores
`chromeMediaSourceId` entirely, so on a multi-monitor machine a user who picks the second
monitor still broadcasts sound from applications on the first. "Share the audio playing on
this screen" was therefore a privacy claim the code cannot keep; the picker hint and the
changelog both name what is actually sent. This is the same #2161 fact stated from the user's
side rather than the implementation's.

**A `window:` capture target NEVER requests audio.** Electron's desktop audio capture is a
whole-system loopback that ignores `chromeMediaSourceId`, so a window share asking for audio
sends every application's sound to the channel (#2161).
Both the picker and `captureScreenElectron` enforce this, deliberately: the picker states the
correct intent, the capture path is the guard. Per-application audio requires a native addon —
see [ADR-0043](../../../docs/adr/0043-per-process-screen-share-audio-capture.md). Do not "fix" the
silence by widening the audio request.

**`switchScreenSource` replaces the track; it does NOT close the producer.** Viewer tune-in,
`dominantScreenShareId` and `perScreenShareVolume` are all keyed by `producerId`, so a
close-and-reproduce cycle silently drops every viewer — the trap
#1924 documented for codec
reproduces. Keeping the producer avoids the state snapshot/restore dance and the self-echo race
that `fastReproduceScreen` needs; that path closes the producer only because a codec change
genuinely requires a new one.

**Acquire the new capture BEFORE touching the live one.** A cancelled or denied picker must
leave the existing share running. Reversing this ordering still passes most of the suite — the
regression test that catches it is the one asserting the ORIGINAL share survives a capture
failure, and it was verified by mutation.

**THE CAPTURE MAY ALREADY OWN THE AUDIO OUTCOME, so the switch's teardown is CONDITIONAL
(#3349).** Acquiring first has a consequence the ordering rule alone does not state: by the time
`switchScreenSourceQueued` reaches `stopScreenAudioHost()` — which exists to reap the PREVIOUS
share's audio — the per-process arm has already superseded the inherited host and written the
state that must stand. Running it unconditionally destroyed that state in **two opposite
directions**, and the second is the one nobody looks for:

- *Success:* it stopped the bridge the arm had just installed and reaped the child
  `startAudiocapHost` had just started, so `produceScreenAudioFromStream` read a stream whose
  audio track had already ended. **Per-process audio never survived a switch at all.**
- *Refusal:* it replaced the arm's `mode: 'degraded'` and its reason with a bare `mode: 'off'`,
  so a user whose app could not be captured was told nothing instead of why — a mechanism string
  computed and then discarded, which is the failure class this epic exists to close.

`captureScreen` therefore returns `ScreenCaptureResult`, whose `ownsScreenAudioOutcome` the
switch consults: `if (!captured.ownsScreenAudioOutcome) this.stopScreenAudioHost();`.

**It is ownership of the OUTCOME, not "installed a host", and the difference is the whole point.**
A refusal installs nothing yet has still superseded the inherited host and written the state that
must stand, so a field named for the host is false exactly where the second defect lives. The arm
acquires candidate video first, then uses the switch-only currentness predicate to decide whether
to tear down the inherited host. It rechecks currentness after start success or rejection; a stale
outcome returns without global teardown or state writes, while a current post-start bridge or
`addTrack` failure performs full teardown and records degraded state. The returned outcome remains
owned by the arm so the caller cannot clobber a successor.

Three shapes were tried and rejected, each for a reason worth keeping: moving the teardown before
`acquireScreenCapture` silences a share that survives a failed capture (`if (!captured) return;`
keeps the old share running); comparing the bridge reference before and after cannot see a
refusal that had no prior bridge, since both sides are `null`; and a boolean named
`installedScreenAudioHost` routes straight back into the refusal defect.

Mutation-proven in `voiceService.switchScreenSource.test.ts` — reverting the guard kills the
success and reason cases, dropping the arm's supersede kills the child-reaping case, and both
controls survive each. **That suite carries TWO controls on purpose.** The first drives
`captureScreenElectron` directly and proves only that the per-process rung works; the appended
suite is a SIBLING `describe`, so the outer `beforeEach` does not reach it, and a missing piece of
share state makes `switchScreenSourceQueued` return at its "no active screen share" guard with
every case failing exactly as it would if the fix were absent. The second control asserts the
switch reaches the capture at all. A control proves the thing it exercises — mine exercised the
capture, not the switch, and passed throughout.

**A rejected `replaceTrack` is the ONE sanctioned exception to producer preservation:
close and re-produce.** This paragraph previously said the opposite — discard the new capture,
keep the old share — and that was wrong in a way worth recording, because it reads as the
conservative choice. It is not conservative, it is inert: the user picked a different source
and the Switch button silently did nothing. `replaceTrack` rejects when the codec cannot accept
the new track, which is precisely the case where the switch cannot be done in place, so
declining to fall back means the advertised operation simply fails. The fallback costs the
tune-in state keyed by `producer.id` (`dominantScreenShareId`, `perScreenShareVolume`, viewer
consumption — the #1924 trap), so it stays the FALLBACK, never the first attempt, and it sets a
`videoSlotError` rather than letting viewers discover a dead tile. It re-enters `produceScreen`
rather than duplicating the publish path, and hands over the stream it ALREADY holds through
that function's `preAcquired` parameter (the shape `produceAudio` has always had). The first
version re-acquired instead, which quietly undid the acquire-first property: the old producer
is closed by then, so a failed second capture leaves the user sharing nothing — the exact
outcome the ordering exists to prevent, reintroduced by the fallback meant to help.

**A screen producer already in flight cannot be cancelled, so both publication paths re-check
after the await.** `produceEncrypted` round-trips to the SFU. A direct `produceScreen` invocation
claims a fresh screen reproduce generation and revokes any pending or uncommitted audio host
before its first await; a fallback handoff inherits the queued generation and preserves its
pre-acquired audio outcome. Candidate capture state remains local until publication wins, and a
superseded claim stops only its own stream. The screen-audio path compares the transport, owning
stream, and live `screen` producer after its own round-trip. Both paths fail closed: anything
unrecognised is discarded via `discardProducedProducer` instead of being registered or restoring
share state. A current video-publication failure before commit also reaps the host and bridge
before releasing the candidate stream. Cleanup running first is not a defence; only these checks
are.

**`voiceStore.isScreenAudioOn` is LIVE producer state, not the preference.**
`videoSettingsStore.screenStreamAudio` is what the user asked for; `isScreenAudioOn` is what is
actually being sent. They differ whenever the target cannot carry audio, so UI must read the
former for a default and the latter for an indicator. For the sites that maintain it, see the
grep rule above — this paragraph carried its own count for a while and the two disagreed, which
is worse than either being stale. The `transportclose` blocks are near-identical and differ only
in indentation; edit them as a set or one silently goes stale, which is what happened to
`reProduceScreenAudio`'s.

Consequence — **`failClosedEncryptTransform()` must stop the owning capture stream itself**
(via the `cleanup*State()` helpers, keyed off `producer.appData.source`). With `stopTracks:false`,
`producer.close()` no longer stops the capture track, so an E2EE encrypt-transform fail-closed
would otherwise leave the camera/mic **hardware capture light ON** (CWE-212). Do NOT remove that
stream-stop, and do NOT drop `stopTracks: false` from the producer `produce()` calls.

The video-settings subscription handles each source independently. A `preferredVideoCodec`,
`hdrEncoding`, or `prioritizeHdrCodecs` change re-produces every currently active camera and screen
exactly once, including a screen-only call. Draft Apply writes all video fields in one store update,
so changing both HDR switches together causes one transition per source. `supportSvc` /
`supportSimulcast` remain source-scoped shape changes: camera re-produces when either changes;
screen re-produces for SVC, and for simulcast only while its server gate is enabled. These paths
use `liveReproduceCamera()` / `fastReproduceScreen()` and the
existing per-source serializers (`stopTracks:false` + fail-closed capture-stop above). Do not call
`sendTransport.produce` directly. `hardwareAcceleration` is intentionally absent from this live
handler because it changes Chromium's global encoder backend; selecting another backend requires a
full app restart. Codec and HDR settings apply live. A current-session codec capability probe
also reselects active codecs when it finishes. Never persist `codecCapabilities` or `gpuInfo`:
stale GPU/driver results must not admit an HDR target at startup.

The **WebRTC hardware-encode B-signal learner (#2184/#2187)** rides the session-stats loop
(`startPacketLossMonitor`, the 5 s poll driving `learnWebrtcHwSignal`). That loop is **idempotent**
and started from the FIRST producer of any kind — mic (`produceAudio`) **and** camera/screen
initial produce — so `videoSettingsStore.webrtcHwByMime` is learned in no-mic (video/screen-only)
sessions too; do NOT re-gate the monitor start on a mic producer (#2187 item 1). When the learner
observes the ACTIVE codec transition to software-encode (`B=false`), it fires one
`reProduceIfBetterCodec(source, { requireHwImprovement: true })` — the pure
`shouldReselectForHwDowngrade` decides (transition-into-SW + active-codec match) and the
`requireHwImprovement` gate switches only toward a genuinely HW codec, so it cannot oscillate
(SW→SW refused; a pinned `preferredVideoCodec` and hardware-accel-off are correct no-ops). Do NOT
remove the `requireHwImprovement` gate (#2187 item 2). `learnWebrtcHwSignal` is **two-pass**:
`previousHw` is captured for every active source BEFORE any `setWebrtcHwForMime` write, so a
camera+screen pair sharing one codec each fire against the pre-tick value (a single-pass write
would flip `previousHw` to `false` for the second source and its churn guard would suppress
re-selection — do NOT collapse it back to one pass). The B-signal trigger is fire-and-forget with
an explicit `.catch()` that logs `.message` only, but that detached catch is NOT the swap's recovery
contract: a fast swap still rejects after fail-closed cleanup, and a visible `videoSlotError` tells
the user to re-enable the camera or screen share.

**Every camera/screen re-produce path is serialized per source (#2193).** Timer, settings, codec-floor,
layering, and B-signal callers — including both `liveReproduceCamera` and the `fastReproduce*`
helpers — enter the same camera or screen promise tail before selecting a codec or touching a
producer. Camera `replaceTrack` settings work uses that same camera tail. Camera and screen have
separate tails and may run in parallel. The tail's
fulfilled derivative catches the CURRENT operation only for storage as the next tail, so one
rejection cannot poison later work; the queue helper still returns the original CURRENT promise to
its caller with the rejection intact. Source cancellation keeps that tail so stale producer close is
ordered before a same-session restart; only whole-session teardown resets tails for new transports.
Do NOT return the caught derivative to the current caller.

Work is scoped to a **media-session generation** plus a per-source cancellation generation.
Teardown invalidates the session; explicit camera/screen close invalidates that source. Upstream
async observers capture their starting session before awaiting stats/floor work. Every acquisition,
fallback, transport, and mutation boundary re-checks the token; batched stats observations also
retain producer/source identity until application. A stale successful `produce()` is closed locally
and signaled to its owning media-plane socket. Live reacquisition keeps the existing video-on intent
until completion so the public toggle remains an explicit cancel path. Fast replacement failures run
the source cleanup contract, set the user-visible recovery error, and rethrow; live camera
acquisition uses `produceVideo`'s existing visible-error-and-resolve contract. This keeps UI,
participant metadata, capture tracks, and producer state fail-closed without capture resurrection.

**Post-#2242 layering correction:** camera and screen layering route through `pickLayeringCodec`
and the shared codec selector, so the learned B-signal and hardware-first policy remain active in
layered rooms. Layering toggles never remove or replace that selected codec. The encoding plan uses
SVC or simulcast when the codec and gates allow it, then collapses to one encoding. Do NOT restore
the retired SVC-first ladders or make casting toggles codec filters.

## Media-rate policer — renderer side (#2153)

Design: `docs/superpowers/specs/2026-09-23-2153-media-rate-policer-design.md` §5.9. The media-plane
half is `.claude/rules/media-plane.md` § "Media-rate policer (#2153)" — read both together.

- **`producer-paused` / `producer-resumed` resolve a SOURCE, then act on it.** The source comes from
  the payload, else from this client's own producer/consumer map (`resolvePausedSource`), else it is
  unknown. `camera` → the peer's `isCameraPaused`; `screen` → the matching `ActiveScreenShare.paused`;
  `screen-audio` → nothing (no "sound on" indicator exists to switch); `mic` or unknown → the legacy
  `isMuted` toggle. The unknown arm is deliberate: an old media plane sends no `kind`/`source`, and
  the handler must then behave exactly as it did before #2153. A payload that fails
  `parseProducerStateChange` changes no state.
- **The owner latch.** `voiceStore.mediaPolicyPaused` (source → paused `producerId`) is set by a
  `media-policy-notice` for a producer this client STILL owns — a notice that crossed a local close
  in flight is ignored, or it would pin a row nothing but `reset()` could clear. It is cleared in
  exactly four places: a local `closeProducer`, the `producer-closed` self-echo (unconditional on
  `userId`: the map only ever holds this client's producerIds), `reset()`, and the reconnect
  teardown `cleanupMediaAndTransports`. That last one is load-bearing: it closes producers by hand
  and never calls `reset()`, and the old session's `producer-closed` reaches the room before the
  rejoining socket does, so without it a fresh mic stayed locked as "Paused" (red-team R6c). There is
  no "cleared" action on the wire, because the server never lifts a latch.
- **A server-initiated close of ANY local producer stops it locally.** When the media plane's
  pause of a policed producer fails it closes the producer instead, and the owner gets only the
  `producer-closed` self-echo. On this audio pause-failure path the SFU closes exactly one
  producer — there is no screen / screen-audio pairing. A client-side `Producer` outlives its
  server twin, so without this the
  device kept capturing and the closed producer kept sending RTP. The echo handler therefore acts
  when `this.producers.get(source)?.id === producerId`, for all four sources: mic, camera and screen
  through `closeProducer(source)` (a mic close also sets `isMuted`, the same gap
  `permissions-changed` covers), and screen audio through `setScreenAudioEnabled(false)`, the Share
  sound OFF path, which retires the producer and reaps the capture host but keeps the captured track
  so Share sound can be turned back on without replacing the video. Screen and screen audio were
  left out when mic and camera were fixed; #3394 PR 2's review found both (on the desktop-loopback
  rung Share sound could not even be turned back on, because the stale producer read as open).
  A locally-initiated close deletes the map entry before its own echo arrives, so that echo stays a
  no-op. The screen-audio teardown ("rail 2") used to run for any local-user echo, so the echo of a
  close this client made itself undid it: #3394 PR 2's M5 check measured the interrupt handler's
  `interrupted` overwritten with `off` 7 ms later, and a re-produce or source switch retires the old
  producer id while a new capture is live.
- **A video bandwidth violation disables video only.** The owner-only
  `video-bandwidth-disabled` payload is validated before it changes state. The media plane closes
  every current video producer for that user and the screen-audio producer paired with any closed
  screen share. The desktop stops its local camera and screen capture and shows the cooldown and
  ordered troubleshooting steps. Camera and screen publication are refused until the video-only
  cooldown ends; a microphone may continue. The source in the notice is the declared publication
  source, not proof of the physical capture device. The renderer's public wording therefore says
  "video" rather than attributing the stream to a particular device.
- **Camera replacement echoes are order-sensitive.** A local fast replacement
  preserves its live preview when the retired producer's self-echo arrives during
  the swap. A remote camera may reuse its own occupied video slot at
  `maxVideoSlots` when a camera consumer for that same user is still attached;
  unrelated users remain subject to the cap. For a remote camera, a
  `producer-closed` echo clears the tile only when no other camera consumer for
  that user remains attached. The replacement marks video on only after its own
  consumer attaches. If the old remote close arrives before the new-producer
  announcement, the tile may clear
  briefly until the replacement attaches. Do not claim that event order is
  flicker-free or that an unattached pending replacement preserves the tile.
- **No `resume-producer` is ever emitted for a latched producer — all FOUR emit sites are guarded**:
  `toggleMute`, `restoreTestSuspendedProducer`, `resumeLocalProducer` and the solo-exit loop. The
  server refuses the resume too, but that emit carries no ack, so without the client guard the
  refusal would be a silent local resume of a dead producer. Each site has a CONTROL/latched test
  pair in `voiceService.mediaPolicy.test.ts`; the solo-exit and test-restore pairs exist because
  deleting those guards once survived every case.
- **Only the MIC locks in the toolbar.** Mute and unmute pause and resume the SAME producer, so no
  mic toggle can clear a latch — its remedy is leave-and-rejoin, and the notice says so. Camera,
  screen and sound Off/On close and re-produce, which retires the latch, so locking them would remove
  the remedy. The mic notice also sets `isMuted` (via `setMuted` + `applyOptimisticMute`), which is
  what keeps the solo-exit loop from resuming it and the owner's own tile from showing "speaking".
- **`mediaPolicyInterrupt` survives `voiceStore.reset()` by design.** A media-policy
  `force-disconnect` lands before the `io server disconnect` that runs `emergencyCleanup()` →
  `reset()`, and `handleJoinFailure` resets before its `'error'` transition; clearing it there would
  delete the one explanation the user gets. `gracefulReset()` clears it (an account change must not
  carry it into the next session), and so does the dialog's dismiss. **`resetAllStores()` must null
  it explicitly** — it resets through `reset()`, so an eviction set in one test otherwise leaks into
  the next.
- **Screen audio is produced capped, at both produce sites (`produceScreenAudioFromStream` and
  `reProduceScreenAudio`).** `screenAudioProduceOptions()` pins `encodings[0].maxBitrate` and
  `opusMaxAverageBitrate` to the highest tier in the user's `allowedAudioTiers`, mirroring the
  media plane's `resolveAllowedOpusBitrateCeiling` (an unknown tier contributes nothing; no known
  tier floors at `standard`). The mic has a stats loop that re-caps its `maxBitrate` every 5 s;
  screen audio has none, and T0 measured a stock stereo share at about 537 kbps, 2.5× the free
  limit, which the policer would have paused within 10 s. Do NOT remove the cap to "restore
  quality": the server has no screen-audio exemption by design. `opusMaxAverageBitrate` alone is
  not a cap — it lands only in the local SDP answer and does not bind the encoder.
- **All FOUR screen render surfaces handle a paused remote share** through a REQUIRED
  `remotePaused` prop: `VoiceStage` (focus and equal), `StreamBar`, and the Tile view's
  `StreamGridTile` in `ParticipantGrid.tsx`. Required, so the compiler names any new call site.
  Each surface **withholds the stream while paused**, and that is load-bearing: the placeholder
  replaces the `<video>` inside the same component, so on resume a fresh `<video>` mounts while the
  `[stream]`-keyed `srcObject` effect does not re-run unless `stream` itself changes — a resumed
  share would stay black. Every surface has a pause→resume re-attach test.
- Current video bandwidth enforcement closes video producers, so these paused-camera and
  paused-share render paths mainly cover older media-plane versions and other pause events.
- **A paused peer camera renders exactly like camera-off, and that is the design (handoff T12).**
  Camera-off has no glyph, so any "paused" glyph would tell peers the cause. Do not add one. Peers
  never see policy language anywhere: a paused share reads "Screen share paused", true for any cause.
- **T17 — reserved pairings.** `AlertTriangle` + `--text-warning-strong` belongs to the owner notice
  strip; a future QoS indicator must not reuse the pair. `--danger` is the eviction dialog's glyph
  only, never label text (it fails AA as text in 9 of the 30 scheme×theme combinations — see
  `docs/reference/as-built-ledger.md`, #1351).
- **Residuals (spec §7 items 7 and 8, renderer half).** On a paused-video path, the PiP window
  can show a frozen frame for a screen share. A late joiner sees a paused peer camera or screen as a black tile: the consume
  response carries no `producerPaused`, and no plumbing is built for it. A join refused during a
  cooldown on the automatic reconnect path (`resumeAfterReconnect`) tears down through
  `emergencyCleanup()` with no dialog; only `handleJoinFailure` opens it. The popped-out PiP controls
  window shows no notice strip, but `toggleMute`'s guard still holds there.

## Codec selection and status truth (`voiceCodecSelection.ts`, post-#2242)

`voiceCodecSelection.ts` is the canonical codec-order seam for runtime selection and Settings
prediction. Components and camera/screen layering paths may apply router and codec-floor
eligibility, but MUST NOT filter codecs because SVC/simulcast is disabled, duplicate the policy,
or reorder it.

- **Manual intent:** A locally available, backend-eligible, floor-compatible manual target is tried
  first. If it is unavailable or a peer cannot receive its exact RTP profile, discard it for that
  selection attempt and restart Auto from candidate zero; never continue below its normal rank.
- **Exact Auto order:** `hdrEncoding` admits HDR-capable AV1 and VP9 Profile 2 candidates;
  `prioritizeHdrCodecs` changes only the order between HDR software and SDR hardware. With both
  HDR switches and Hardware Acceleration enabled, the candidate groups are
  `AV1-HW HDR → VP9-P2-HW HDR → AV1-SW HDR → VP9-P2-SW HDR → AV1-HW SDR → VP9-P0-HW SDR → H.264-HW → VP8-HW → AV1-SW SDR → VP9-P0-SW SDR → H.264-SW → VP8-SW`.
  With HDR allowed but not prioritized, the SDR hardware group moves ahead of HDR software.
  Within each H.264 group use High → Main → Constrained Baseline. With HDR off, omit both HDR
  groups; with Hardware Acceleration off, omit every HW candidate. HEVC can remain visible as
  unavailable but is never selectable. Both switches default off; persisted `hdrEncoding: true`
  from before the split migrates to both switches on to preserve the user's prior codec order.
- **Backend selector entries:** probe every exact target symmetrically with WebCodecs
  `prefer-hardware` and `prefer-software`. Show a backend row only when its exact probe is
  affirmative; when both pass, show distinct Hardware and Software entries. A Hardware entry is a
  target, not proof; active outbound `powerEfficientEncoder` stats are authoritative. A live
  `false` conservatively demotes every qualified Hardware target of that MIME for the session so
  Auto advances to the next verified backend; a live `true` affirms only the active bare MIME and
  never manufactures HDR/profile support. Runtime selection also requires an affirmative exact
  backend probe for AV1 HDR and VP9 Profile 2; an RTP AV1 capability alone does not prove its
  10-bit target is available. Choosing Software stages global Hardware Acceleration
  off. At app startup, Hardware Acceleration on adds Chromium's
  `WebRtcAV1HWEncode` feature; off calls `app.disableHardwareAcceleration()`. Any backend change
  therefore requires a full app restart before it can take effect. The user selects first; applying
  the setting persists it and relaunches the app afterward. Codec/HDR-only applies do not relaunch.
- **H.264 profile compatibility:** Match H.264 by RFC 6184 profile class, not all six
  `profile-level-id` digits. Level asymmetry can expose a lower local level (for example,
  `64001f` High 3.1 or `4d401f` Main 3.1) that maps to Concord's configured High/Main target.
  Baseline, Constrained High, and Predictive High remain different, unavailable classes.
- **Room codec floor:** `room-codec-floor` carries canonical RTP keys, not only MIME families:
  VP9 Profile 0/2 are `video/vp9:0|2`, H.264 carries a canonical router profile-level-id for
  its RFC 6184 profile class, and AV1/VP8 remain base MIME keys. Use `isCodecKeyInFloor` for both
  runtime and Settings prediction: AV1 `:hdr|:sdr` app targets map to base RTP AV1, bare VP9
  authorizes Profile 0 only, and H.264 levels compare by class. A bare/profileless H.264 floor
  matches only a bare H.264 target; it must never authorize High, Main, or Constrained Baseline.
  These conservative rules contain legacy MIME-only broadcasts rather than treating them as
  profile wildcards. If a manual preference misses the floor, discard that attempt and restart
  Auto at candidate zero; never resume after the manual codec's normal rank. If no locally
  publishable codec matches the floor, retry the same selection without the floor. Keep a working
  producer when reselection finds no replacement. A floor update may replace an active producer
  only when its chosen codec matches a non-null floor; a null or unsatisfiable floor is not proof
  that existing viewers can consume a different codec. An impossible floor cannot close local video.
  Camera and screen layering gate changes re-encode with the active producer codec.
  Floor-driven replacement pins the checked codec and rechecks the floor after transport drain;
  if that codec is no longer shared, it re-publishes the previous codec. Check again after
  asynchronous publication and replace an uncommitted incompatible producer with the old codec,
  draining the transport before the second publication. Automatic hardware-driven codec switches
  and delayed codec-probe switches also require a non-null floor match; shape-only layering changes
  keep the active codec. If the camera track has ended during a protected replacement, carry the
  chosen and active codecs through capture recovery and apply the same post-publication floor check.
  Settings must warn that an out-of-floor local fallback can leave some peers without video; a
  null floor is ambiguous between unconstrained and disjoint claims, so manual preferences must
  not promise automatic fallback for every peer either.
- **Preferred versus In Use:** Preferred is intent: a validated manual choice or Auto's predicted
  target, described as "will try," never "will use." In Use is observation from the exact
  profile-aware camera or screen producer RTP parameters. No producer means no In Use marker; a
  missing runtime profile remains unknown, and a room codec-floor fallback may legitimately make
  Preferred and In Use differ.
- **HDR truth:** Every currently exposed H.264 profile is 8-bit SDR. `640034` is ordinary High
  Profile, Level 5.2 — not High 10 — and current Chromium/libwebrtc plus mediasoup do not expose
  High 10. Never label H.264 as HDR-capable. `video/AV1:hdr` is an application-level 10-bit target
  backed by an exact WebCodecs profile probe (`av01.0.05M.10`), while `video/AV1:sdr` probes
  `av01.0.05M.08`; both map to base RTP AV1. The HDR setting expresses target preference only; a
  negotiated AV1 MIME and WebRTC stats do not prove active encoded bit depth or HDR output.

## IGNIS decoder-budget sampling (`decoderBudgetSampler.ts`)

IGNIS must derive load from **interval deltas**, never lifetime averages or an invented
`average × 1.5` p95. Each consumer owns a lifetime-counter baseline plus the newest 20 usable
interval averages. For each usable interval:

- `currentFps = ΔframesDecoded × 1000 / ΔRTCStatsTimestamp`;
- `intervalDecodeMs = ΔtotalDecodeTime × 1000 / ΔframesDecoded`;
- `p95DecodeMs` is nearest-rank p95 over that consumer's bounded interval history; and
- `rho = p95DecodeMs × currentFps / 1000`.

Classify usable samples as green for `rho < 0.80`, yellow for
`0.80 <= rho < 0.925`, and red for `rho >= 0.925`.

**Forcing a zone locally (`concord.forceDecoderZone`).** IGNIS has shipped twice with
no local repro path: `concord-dev.sh`'s fake-device decodes a synthetic pattern one to
two orders of magnitude under the ~26 ms p95 @30 fps that `rho >= 0.80` requires, so
neither yellow nor red is reachable by using the app. Set
`localStorage['concord.forceDecoderZone']` to `'green' | 'yellow' | 'red'` and that zone
is substituted for the rho-derived one on every **usable** sample. Dev media does produce
usable samples — they are simply always green — which is why substituting the zone works
where faking the stats would not.

It is applied at `classifyAndHandleDecoderZone`, before dispatch, so it drives the real
emit / escalate / pause path and the three-green recovery — **not** just the health badge,
which was already reachable by writing `voiceStore` directly and proves nothing. Read once
per profiling cycle, so a value changed mid-pass cannot classify two consumers differently
in one cycle. An unrecognised value falls through to real measurement rather than pinning
the session to an unintended zone, and a storage accessor that throws reads as absent.

Deliberately NOT gated to dev builds, on the same reasoning as `concord.forceLegacyE2EE`:
support needs it on a user's real machine, the blast radius is self-inflicted (a user can
degrade their own incoming video and nobody else's), and a build gate would remove it
exactly where it is wanted. Clearing the key restores normal behaviour on the next tick.

**It does not make the pause path reachable in a one-peer call.** The sole-active-video
guard still refuses to pause the last remote video, correctly — that is #1540 behaviour,
not an obstacle to work around. Two remote participants are needed to see a pause.

Select at most one active inbound-video report per consumer, in this deterministic order:
negotiated encoding SSRC, positive finite reported `framesPerSecond` (selection evidence only),
newest finite timestamp, then stable report ID. Report identity is ID plus SSRC; identity rollover
starts a fresh segment. Compare RTCStats timestamps to `performance.timeOrigin + performance.now()`:
older than 10,000 ms is stale, while exactly 10,000 ms is accepted.

First sample, stream change, counter reset, out-of-order timestamp, paused consumer,
missing/malformed/future/stale stats, no decoded-frame progress, and finite counters whose derived
FPS, decode time, or rho overflows are **unknown** (`invalid-derived-metrics`). Unknown samples
never enter history. If a profiling cycle has no usable video sample, leave both decoder health and
the green-recovery counter unchanged; never turn missing evidence into green. The worst usable
consumer drives the cycle. Interval-triggered profiling is single-flight: a slow `getStats()` pass
must finish before another timer tick may mutate baselines or recovery state. Never IGNIS-pause the
last active video consumer at its lowest layer because its paused samples would be unknown and no
usable green evidence could ever release it. With another active video present, a paused consumer
remains unknown while that other consumer can provide the three usable green cycles required to
release one IGNIS pause. Delete the triggering consumer's sample segment after any layer/pause
intervention, delete state on every consumer teardown, and reset sampler/single-flight state during
normal or emergency session cleanup.

## Media-plane join connect resilience (`voiceService.ts`, post-#2176)

The voice-join media-plane Socket.IO connection rides through a **transient media-plane
blip** (e.g. a production deploy recreating the single media-plane node) instead of
hard-failing the join:

- **`io()` options:** `transports: ['websocket', 'polling']` **plus `tryAllTransports: true`**.
  `tryAllTransports` is **load-bearing** — with `'websocket'` listed first, engine.io does NOT
  auto-try polling on a failed WS _open_ unless it is set (default `false` since
  socket.io-client 4.7.0). It is consulted ONLY when the initial WS transport fails, so the
  normal (~30ms) WS path is unchanged. Safe because the media-plane is single-instance (no
  sticky-session requirement) and its Socket.IO server advertises polling. Do NOT revert to
  `transports: ['websocket']`.
- **`waitForConnect()`** does NOT reject on the first `connect_error`. With `reconnection: true`,
  a transient failure leaves `socket.active === true` and the Manager auto-retries the connect;
  `waitForConnect` rejects only on a server-side denial (`socket.active === false` — e.g. auth),
  on reconnection exhaustion (`reconnect_failed`), or on the overall `VOICE_CONNECT_TIMEOUT_MS`
  (30s, raised from a flat 10s). Do NOT restore the reject-on-first-`connect_error` behavior — it
  cuts off the built-in reconnection and re-opens the deploy-window hard-fail.

Regression-locked by the `media-plane connect resilience (#2176)` suite in `voiceService.test.ts`.
Polling fallback alone does NOT cover a full media-plane restart (nginx 502s both transports); the
`waitForConnect` ride-through is what survives it. The server-side cause (single-node deploy
recreate) is tracked separately — zero-downtime media deploy (#2178), crash/hang hardening (#2179).

## ICE-server threading (`voiceService.ts` / PiP, post-#3104)

The control plane mints STUN/TURN per voice join (`services/control-plane/pkg/config/turn.go`)
and returns it on the join response as `ice_servers`. Before #3104 the desktop declared but
dropped the field, so a client whose network blocks outbound UDP had no working ICE candidate
and the join timed out.

- **One holder, not a store.** `VoiceService` keeps a private `iceServers: RTCIceServer[] | null`
  (`voiceService.ts:497`), set at the top of `establishMediaSession` (`:3034`) — the single choke
  point both the initial join and the reconnect resume pass through with a freshly authorized
  `joinData`. Do **not** move it into Zustand: these are live HMAC TURN credentials and a store
  exposes them to persist middleware and any state serializer.
- **`ice_servers` is `unknown` on the wire** (`voiceService.ts:390`), not a structured type —
  indexing it is a compile error, so the only way to read it is through `normalizeIceServers`
  (`services/voice/iceServers.ts`), which caps the list at `MAX_ICE_SERVERS` (16), allows only
  `stun:`/`stuns:`/`turn:`/`turns:`, and drops a `turn:`/`turns:` entry missing a string
  `username` or `credential` — an uncredentialed relay can never allocate, so keeping it only
  burns the ICE check budget. A malformed **entry** drops only itself; the list survives.
  "Malformed" **includes an entry that throws on read**: the element read and the per-entry
  normalization sit inside one guard, so a trapped accessor — or a trapped array index — costs
  that entry and nothing else. An all-or-nothing drop would reproduce the very outage #3104
  closes. The guard is silent by construction: the throw's message is attacker-chosen text and
  NC-1 binds on this file.
- **An empty list omits the key.** `iceConfigForTransport()` (`:5437`) returns `{}` rather than
  `{ iceServers: [] }` when the list is null or empty, so a degraded session's transport-options
  object is deep-equal to the pre-#3104 shape. `iceTransportPolicy: 'all'` only appears alongside
  a non-empty list — it is the WebRTC default, stated for the reader, not the working part. Do
  not "simplify" by dropping `iceServers` and keeping the policy. The spread sits as the **last**
  property in both `createSendTransport` and `createRecvTransportForKind`'s transport-options
  object (`:5472`, `:5544`), literally inside the `encodedInsertableStreams` E2EE block — that
  block must survive byte-for-byte; do not reorder around it.
- **Both teardown paths null the field**, and the second does not delegate to the first:
  `cleanupMediaAndTransports()` (`:3251`) and `cleanup()` (`:8238`, comment: "Duplicated
  deliberately: `cleanup()` does not call `cleanupMediaAndTransports()`"). A future refactor that
  makes one call the other must keep both null-sites or verify the delegation actually reaches
  both call graphs.
- **NC-1 — nothing derived from `ice_servers` may reach `console.*`.** No entry object, no
  `urls`/`username`/`credential` string, no object transitively containing one. `logBufferService.ts`
  captures all five console methods into the bug-report ring buffer, which reaches a PUBLIC repo.
  FOUR diagnostics are
  permitted. Two carry derived data and are narrow by construction: `describeIceServers(list)`
  (scheme multiset + count, `voiceService.ts:3037`) and the per-transport candidate-pair type
  from `extractSelectedCandidatePairType` — one of `host | srflx | prflx | relay` and nothing
  else (both in `services/voice/iceServers.ts`). **That second permission binds the VALUE, not the
  call site** — the closed `host | srflx | prflx | relay` enum is what makes it safe, so the same
  helper's output is equally permitted from a non-ICE diagnostic. `[avsync] drift-detected` carries
  `pairAudio`/`pairVideo` from it (see the *A/V playout synchronisation* row above, where they
  distinguish a timestamping defect from differential path drift), and an NC-1 audit must not read
  those as an unlisted fifth diagnostic. Two are FIXED MARKERS carrying only `label`, a
  call-site literal (`send` / `recv-audio` / `recv-video`) that is never read from `ice_servers`
  or from the stats report: `[ice] selected-pair-unresolved` and
  `[ice] selected-pair-stats-unavailable`. **Those last two are load-bearing, not debris.** They
  are the runtime proof for the *ICE selected-pair resolution timing* register entry above, and
  to an NC-1 audit they look exactly like an unlisted `console.debug` on the ICE path — i.e.
  deletable. Deleting them restores the silent gap that left the relay diagnostic dead for the
  whole life of PR #3117 with every test green.
  `describeIceServers` takes `unknown` and is **total**. Production hands it the normalized list,
  but the one function whose whole purpose is to be safe to log cannot rest that guarantee on a
  precondition a future caller may not honour: a non-array, a non-object entry, a `urls` given as
  the legal `string[]` form, and a throwing accessor all degrade instead of propagating, and every
  emitted scheme is drawn from the closed set `stun | stuns | turn | turns | other` — an
  unrecognized scheme is COUNTED, never echoed. Do **not** narrow the parameter back to
  `RTCIceServer[]`: the type re-imports exactly the precondition the totality replaced.
  Locked by the sentinel suite in `tests/unit/services/voiceService.iceServers.test.ts`.

**NC-1 is enforced in two layers, and the SINK is the primary one.** An earlier revision of this
section named only the lint selector, and that selector was blind in both directions — the
statement of enforcement was wrong, not merely incomplete.

**Layer 1 (primary) — the capture-time scrub, `logBufferService.PATTERNS`.** It holds no matter
which module logs, which is what a lint selector can never promise. Four entries sit AFTER the
long-base64 entry (so a longer blob is consumed as `<base64>` first and the narrow band cannot
chop a fragment out of one) and cover: `credential`/`password` redacted BY KEY in the JSON
`"k":"v"` form `stringifyArg` produces and in the bare-key form, whose value may carry EITHER
quote style — `k: 'v'` from `util.inspect`, `k: "v"` from a hand-formatted or JS-object-literal
line. That last combination was redacted by NOTHING until #3117: the JSON entry requires a quoted
KEY and the bare-key entry required a single-quoted VALUE, so `credential: "x"` and
`turnCredential: "x"` satisfied neither. It is two complete alternation branches, not one widened
`["']` class, so each branch's value class excludes only its OWN quote — a shared class stops at
an embedded foreign quote and leaks the rest of the value. Also covered: the
`<unix expiry>:<userID>` TURN username; and a **28-character** standalone base64 token.
That last number is the whole defect: 20 HMAC-SHA1 bytes encode to exactly 27 base64 characters
plus one `=` pad, and the pre-existing long-base64 pattern has a **40-character floor**, so a live
24 h relay credential passed the entire scrub untouched. `pseudonymizeLogUuids` rescued the UUID
half of the *username* at submit time and nothing rescued the credential or the expiry.
The narrow band is pinned to a STANDALONE 27-chars-plus-one-pad token by a lookbehind/lookahead
pair — inside any longer padded token every 27-char window is preceded by another base64
character, so a 32-char token (base64 of 23 bytes) is not matched. It replaces with the existing
`<base64>` token, deliberately: the shape is base64-of-20-bytes, not proof of a TURN credential,
and stamping `<turn-credential>` on an unrelated 20-byte digest would be a false tripwire.
`<turn-username>` is the tripwire — it has no other plausible producer, and a TURN entry always
carries both halves. Locked by the `TURN credential scrub (#3104)` suite in
`tests/unit/services/logBufferService.test.ts`. Its fixture base64-encodes a 20-BYTE literal to
reproduce the 28-character output length, which is the whole defect — the suite's first assertion
pins that length, so a wrong-shaped fixture fails immediately. It deliberately does NOT call
`createHmac`: a live SHA-1 over a user id is a CodeQL weak-crypto finding, and pinning the real
HMAC output instead reads as a credential to gitleaks. Do not "restore" the minting. Production-
shape fidelity is tested on the Go side, in
`services/control-plane/internal/feedback/sanitize_test.go`, which still mints the real way under
a documented `#nosec G505`; that is the test that notices if `turn.go`'s algorithm changes.
The server-side backstop in `services/control-plane/internal/feedback/sanitize.go` carries the
same categories per `observability.md` principle 6, with one stated
asymmetry: RE2 has no lookaround, so the credential entry there pins only the LEADING half, and
pins it as a CONSUMED group — `(^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{27}=`, re-emitting `${1}` — while
dropping the trailing half, so it over-redacts a 28-char prefix inside a 28..39-char run.
Over-redaction is the safe direction for a last-line backstop; do not "fix" it by dropping the
category. **That entry read `\b[A-Za-z0-9+/]{27}=` until #3117, and the `\b` was a hole rather
than a shorthand for the lookbehind:** `\b` needs a word/non-word transition and reasons about
the DELIMITER alone, so a credential whose OWN first character is `+` or `/` — both non-word,
exactly like every realistic delimiter — produced no boundary and matched nothing. Two of the 64
base64 characters, so ~3% of minted credentials reached the public repo unredacted. The client
was never affected: its lookbehind states the condition directly, and
`tests/unit/services/logBufferService.test.ts` now pins that half. The consumed group carries one
narrowing of its own, stated rather than hidden: two credentials written back-to-back with no
separator redact only the first, because the second's only delimiter is the first's pad, already
consumed. No serializer the pipeline sees emits that shape.

**Layer 2 (defence in depth) — one `no-restricted-syntax` selector in the broad
`src/renderer/**/*.{ts,tsx}` block of `eslint.config.mjs`.** It is renderer-WIDE, and the earlier
`src/renderer/services/voice/**` scoping is the thing that must not come back:
`voiceService.getIceServersForPip()` is public on the exported singleton, so any component, store,
hook or error boundary can import it and log the credentialed list one directory over, where the
scoped selector was silent. The selector is a **descendant** match with the sanctioned reducer
carved out BY ANCESTRY —
`CallExpression[callee.object.name="console"] Identifier[name=/^(iceServers|pipIceServers|getIceServersForPip)$/]:not(CallExpression[callee.name="describeIceServers"] *)`
— which permits `console.debug('[ice] servers', describeIceServers(list))` while still flagging
`console.debug(describeIceServers(a), rawList)`. The previous argument-position form (a `>` child
combinator) was chosen to avoid flagging the permitted line and instead left twelve demonstrated
bypasses open: a renamed local, an array index, a destructure, a template literal, a
`JSON.stringify` wrapper, an array literal, a spread, a one-line forwarding helper. The descendant
form closes most of them; **a renamed local (`const l = this.iceServers; console.debug(l)`) still
escapes it by construction**, which is exactly why layer 1 is primary and why this layer must
never be described as complete.

**Do not add a `files:`-scoped block under `src/renderer/` to this config.** A scoped block
replaces a rule key WHOLESALE and the last matching block wins, so the retired voice block both
(a) would have been discarded had it been placed before the broad block, and (b) as placed, turned
OFF the two #754 bare-anchor selectors and the two #1586 `resolveMediaUrl` selectors for its whole
subtree, with no diagnostic anywhere. That was latent only because no `.tsx` lives under
`services/voice/` — the glob is `*.{ts,tsx}`, so the first voice-panel component would have
shipped with four guards silently off. Add renderer selectors to the broad block instead.
`tests/unit/main/eslint-ice-servers-console.test.ts` locks both properties: the NC-1 behaviour, and
that the EFFECTIVE `no-restricted-syntax` for a nested renderer path is a superset of the broad
block's (computed via `calculateConfigForFile`, so it catches the placement half of the trap too).

**PiP.** The PiP window builds a third recv transport (`pipVoiceClient.ts`) with its own `Device`
and `RTCPeerConnection` and never sees `joinData`. The list rides the `create-recv-transport` RPC
result (`CreateRecvTransportResult.iceServers?`), not `VoiceStateResult`: the RPC already carries
the other transport parameters and has exactly one consumer, while `VoiceStateResult` is already
treated as sanitization-sensitive (`sanitizedParticipants`). `PipSignalingProxy` destructures
`iceServers` out of the SFU's raw reply (`pipSignalingProxy.ts:247`, named `_sfuIceServers` and
discarded — `Omit` alone erases only at the type level, not at runtime) and attaches the MAIN
window's list instead, via `voiceService.getIceServersForPip()` (`:257`). `pipVoiceClient.ts` then
re-normalizes the RPC result through `normalizeIceServers` into a local `pipIceServers` (`:233`)
before spreading it into its own transport options. NC-1 binds inside the PiP window too — it
loads the same SPA entry and runs `installLogBuffer()` — so never log `transportInfo` wholesale
there either.

### PiP channel authentication (#3104 D6) — the capability IS the channel name

The `concord-pip` channel used to be **unauthenticated**: `handleMessage` checked the message
*kind*, never the sender, and `respond()` posted every reply back on the same broadcast channel,
which reaches every same-origin document in the partition. Three exploits were demonstrated
against the real proxy — a passive listener harvesting the credentials when a legitimate PiP
opened, an unregistered document *demanding* them, and that same document driving `action: leave`
(which predates #3104). D6 closes all three. **Do not describe this channel as unauthenticated
any more, and do not cite D5's "no new trust boundary" line as evidence of anything** — it was an
argument about the intended peer offered where the guarantee needed was about an arbitrary one.

- **The token comes from the main process, because no renderer-only path exists.** `localStorage`
  is readable per-origin; `BroadcastChannel.postMessage` performs StructuredSerialize *without* a
  transfer list, so a `MessagePort` throws `DataCloneError`; anything placed on a shared channel is
  read by the listener the fix exists to defeat; and `pipId` is broadcast in `ownership-transferred`.
  `pip:open` therefore mints `mintPipSessionToken()` (`src/main/pipSession.ts`, 32 random bytes,
  base64url) onto the `pipWindows` entry.
- **Two disclosure paths, both frame-proven.** `pip:opened { id, token }` pushes to the main
  window at window creation (symmetric with `pip:closed`); `pip:session` returns the token to that
  PiP's **own main frame only** — `resolvePipSender` in `main.ts` reuses the `getOwnedPipWindow`
  checks and additionally requires `isPipMainFrame`, so the opener frame, another permitted frame,
  a foreign origin and a frameless sender all get `null`. The opener is refused *because* it
  already got the push; a second path for the same frame would widen the surface for nothing.
- **BOTH directions moved to `concord-pip:<token>`, and the token is never placed IN a message.**
  This is the one place the shipped code departs from the D6 sketch, and the departure is
  load-bearing: D6 step 4 put the token in the RPC envelope while step 5 moved only the *replies*
  to the private channel, which would have posted the capability on the shared channel and handed
  it to the very eavesdropper being defended against. Possession of the channel is the proof.
  `PIP_CHANNEL_PREFIX` survives only as the prefix — **nothing subscribes to or posts on the bare
  name**, and re-adding a listener there "for compatibility" restores the exact ingress.
- **The envelope's `pipId` is untrusted decoration.** `handlePipReady` / `handlePipClosing` key the
  ownership-transfer map off `session.pipId` (the id main bound to the capability), so one PiP
  cannot hand another PiP's paused consumers back to the main window.
- **Revocation is structural.** `onPipClosed` calls `revokeSession` *before* resuming consumers;
  the channel is closed, so a leaked token talks to nothing rather than being checked against a
  flag at dispatch time. `dispose()` closes every session channel.
- **The PiP fails closed and never downgrades.** `PipVoiceClient` opens no channel in its
  constructor; `init()` calls `openSessionChannel()` first and throws
  `PiP session capability unavailable` when the bridge is missing, the invoke rejects, or the
  answer carries no string token. `sendRpc` rejects on a null channel. There is deliberately no
  fallback to the shared name. The availability cost to a legitimate PiP is nil — the same
  main-process code path that created the window minted the token — and the window stays
  interactive and closable, so a refusal withholds media, never the close button.
- **The main renderer subscribes SYNCHRONOUSLY.** `usePipSignalingProxy` registers `onPipOpened`
  and buffers into `pendingSessions` *before* awaiting the `voiceService` dynamic import, draining
  the buffer when the proxy is constructed. A push dropped while that import is in flight would
  leave that PiP indistinguishable from an arbitrary document for its whole life.
- **NC-1 extends to the token.** It names the channel, so logging it publishes the session. The
  renderer-wide selector's alternation covers `getPipSession` and `pipSessionChannelName` — both
  distinctive; the bare local `token` is deliberately not listed, because a renderer-wide selector
  on that name would be noise. Note the residual: the capture-time `PATTERNS` scrub has no entry
  matching a 43-character base64url token, so layer 1 does **not** cover this secret the way it
  covers a TURN credential. Locked by `tests/unit/services/pipSessionAuth.test.ts` (the three
  exploits, inverted), `tests/unit/main/main.test.ts` § `pip:session`, and
  `tests/unit/main/pipSession.test.ts`.

**What this still does not defend against.** A compromised MAIN renderer frame (it holds every
token, and already holds `voiceService` itself); a compromised PiP main frame (its own capability
is genuine, and `action: leave` remains available to it by design); and anything reachable from
main-process compromise. `MockBroadcastChannel` cannot express these properties — it never
delivers to a third document, which is precisely why the gap stayed invisible. Use
`tests/helpers/fanoutBroadcastChannel.ts` for any future assertion about who can overhear what.

Media-plane side: `iceSelectedUdp`, `iceSelectedTcp`, and `iceTerminalWithoutConnect` live on
`MetricsSnapshot` only (`services/media-plane/src/lib/mediaMetrics.ts`), never
`AggregateMediaMetrics` — that feeds the closed ops-metrics catalog (ADR-0030). Relay attribution
is client-side by necessity: the media plane holds no TURN config
(`services/media-plane/src/config/index.ts:405-408`), and a bridge-mode hairpin rewrites the
relayed source address before the SFU ever sees it — server-side "relayed sessions" counting is
not implementable (#3104 issue AC 7 amended accordingly). See the "TURN relay allocation proof"
subsection in `docs/runbooks/deploys.md` for how to prove a
relay actually allocates, independent of this client-side attribution.

## Casting eligibility toggles (`supportSvc` / `supportSimulcast`, post-#1921)

Two `videoSettingsStore` booleans (default ON, draftable) gate **layering modes**, not codecs and
not forced modes. Codec selection remains independent. Casting kind stays **codec-derived** via
`buildCameraEncodingPlan` / `castingKindForCodec` (`cameraLayering.ts`): AV1/VP9 → SVC,
H264/VP8 → simulcast, else single. A disabled mode collapses that codec's plan to `single`; it
never causes selection of a lower-priority codec. This keeps **AV1+simulcast structurally
unreachable** under any toggle combination (no codec maps to both kinds) while preserving AV1 or
VP9 as a single stream when SVC is off. **Screenshare simulcast is server-gated (post-#1924)**:
`pickScreenCodec` passes
`supportSimulcast && screenLayeringEnabled` into the encoding plan — H264/VP8 screen publishes
3-layer simulcast **only** when the media-plane's `screen-layering-gate` has flipped
the client `screenLayeringEnabled` flag on; AV1/VP9 screen uses SVC when `supportSvc` is enabled
and otherwise stays on the same codec as a single stream; and AV1+simulcast stays structurally
unreachable. A `supportSimulcast` flip reproduces screen (via
`fastReproduceScreen`, `stopTracks:false`) only while the gate is enabled. See
media-plane rules § "Screen layer-selection gate (post-#1924)".

- **Live parameter updates: the BITRATE helper covers EVERY encoding and follows the LADDER
  (#2208); the PRIORITY helper must write encoding 0 ALONE.**
  The instant-update helpers on `voiceService` mutate the object `rtpSender.getParameters()` returned
  and hand it back in a single `setParameters()` — no producer close, reproduce, `replaceTrack` or
  renegotiation. `liveUpdateScreenBitrate` iterates the whole encodings array; writing only
  `encodings[0]` leaves the other layers on their prior caps, which is the #2208 defect — invisible
  on a single-encoding sender and reachable only in a layered H264/VP8 screen share.
  **The two helpers differ in WHAT they write, and this paragraph had the difference BACKWARDS
  until the per-sender regression — the wrong version is a large part of why that defect shipped.**
  `priority` / `networkPriority` are **per-sender in libwebrtc, not per-encoding**:
  `UnimplementedRtpParameterHasValue` rejects a non-default value on any encoding after index 0, and
  BOTH publish paths run it — `PeerConnection::AddTransceiver` (`pc/peer_connection.cc`) and
  `RtpSenderBase::SetParametersInternal` (`pc/rtp_sender.cc`). The retired claim that they are
  "categorical and legitimately uniform across layers" asked whether the LAYERS SHOULD AGREE and
  never asked whether the field is ACCEPTED past index 0 — a value-uniformity question standing in
  for an admissibility one, and both are needed. So `liveUpdateVideoPriority` writes `encodings[0]`
  only, and `buildCameraEncodingPlan` spreads `base` onto rung `q` alone. See the per-sender row in
  the Platform-behavior register above. `maxBitrate` is the one field that plan deliberately
  GRADUATES:
  `q = lowBitrate(cap)` (clamp 0.10×, 120k–250k), `h = midBitrate(cap)` (clamp 0.32×, 300k–800k),
  `f = cap`. So the user-facing setting is the **f-layer ceiling**, not a per-layer value, and
  `liveUpdateScreenBitrate` derives q/h from it through the exported `simulcastLadderBitrates()` —
  the same helper the plan builder itself calls, so the live path and a fresh produce cannot drift.
  Writing the ceiling flat to every layer is wrong in both directions: it raises the aggregate
  ceiling roughly 2.5× (250k+800k+5M → 5M+5M+5M at a 5 Mbps cap), and on a LOWERED setting it pushes
  q and h *above* what produce-time gives them. **Key on INDEX, never on `rid`** — this said the exact
  opposite until #3348, and the rid form made the whole #2208 fix inert. Our `q`/`h`/`f` never
  reaches the sender: `Transport.produce()` rebuilds every encoding through an allow-list that omits
  `rid`, and the send handler then assigns `r${idx}`, so a live sender's rid is ALWAYS `r0`/`r1`/`r2`
  and `rid in ladder` matched nothing — every layer silently took the flat ceiling, which is the
  aggregate-ceiling defect #2208 exists to close, live again behind its own fix. **MEASURED on
  Chromium 152** (2026-09-17): passing `q`/`h`/`f` to `addTransceiver` does preserve them, so the
  engine is not the culprit — mediasoup is, and it is invisible to any test that mocks
  `getParameters()`, which is what `voiceService.extended.test.ts` did. Index is sound because the
  handler's `forEach` preserves encoding order, so position IS the layer. A single-encoding sender
  (SVC, or the screen-layering gate off) has no ladder position and takes the ceiling verbatim,
  which is the f-equivalent — gate that on `encodings.length`, not on rid's absence. Encoding order, `rid`, `scaleResolutionDownBy`, `active` and every unrelated
  RTP field are left untouched, and an empty or missing encodings array stays a safe no-op.
  The audio-side `encodings[0]` writes (`liveUpdateAudioPriority`, and the FEC bitrate adjustment in
  the stats loop) are **correct as written** — and for a STRONGER reason than the one recorded here
  before. The mic producer does publish Opus as one encoding and never simulcasts, but `encodings[0]`
  would be the only legal target for the two priority fields even if it did. The narrower
  justification is what made the video helper's loop look like a defensible divergence rather than
  the same defect one file over: hardening one copy on a reason that does not generalise leaves the
  twin weaker. Do NOT reach for mediasoup-client's `producer.setRtpEncodingParameters()` here:
  it does spread into every encoding, but its handler then renegotiates
  (`createOffer` / `setLocalDescription`), which is exactly what these helpers exist to avoid — and
  it spreads ONE params object uniformly, so it could not express the ladder either.
- **Shared layering selection (`pickLayeringCodec`).** Camera and screen selection use the canonical
  hardware/software and codec-priority passes, filtered by manual preference and codec floor first,
  then retrying without the floor only when no locally publishable codec matches.
  The encoding plan then uses SVC for AV1/VP9 when enabled, simulcast for H264/VP8 when its user and
  server gates allow it, and otherwise one encoding. AV1/VP9 remain SVC-only and never simulcast
  (E2EE structural); disabling SVC leaves the selected codec intact and publishes it as single-stream.
- **All screen render surfaces MUST report demand.** Simulcast screen consumers seed at spatial
  layer 0 and ramp UP only on reported render-size demand, so EVERY surface that renders a remote
  screen `<video>` — `VoiceStage`, `StreamBar`, `ParticipantTile`, and the tile-view
  `StreamGridTile` — reports via `useRenderStateReporter({ source: 'screen', … })`; an unwired
  surface leaves the viewer stuck at the lowest layer (blurry). Tile-shaped surfaces
  (`StreamBar` thumbnails, `StreamGridTile`) route through the shared `useScreenTileVideo`
  hook, which bundles the reporter wiring with the `<video>` srcObject lifecycle so a new tile
  surface cannot forget the demand report — prefer it for any new screen tile. `removeRemoteVideoTile` emits a
  `visible:false` demand on **last-surface** unmount so a torn-down tile does not pin the gate/layer
  (screen-only; camera routes hidden-ness through the pause coordinator). The **PiP window** is a
  separate socket-less `BrowserWindow`, so its screen demand cannot use `useRenderStateReporter`
  directly — `ScreenPipContent` reports render-size via a `set-preferred-layers` RPC over the
  PiP→Main `BroadcastChannel` proxy, addressed to the **PiP's own** consumer id (never the main
  window's paused consumer) via `emitPreferredLayersForConsumer`.
- **PiP teardown owns remote resources (post-#2207).** `PipVoiceClient.dispose()` is single-flight:
  the proxy normalizes the media plane's create-transport `id` into the PiP contract's `transportId`.
  Disposal snapshots that receive-transport ID and the PiP-owned consumer IDs, issues acknowledged
  `close-consumer` RPCs concurrently, awaits every outcome before `close-recv-transport`, and always
  completes local consumer/transport teardown, consumer-map clearing, pending-RPC cancellation, and BroadcastChannel
  close even when a remote close errors or times out. The in-flight `create-recv-transport` RPC is
  the sole pending request preserved through disposal: a late acknowledgement is closed by ID without
  constructing a local transport. A `voice-ended` broadcast is the exception to acknowledged remote
  cleanup: mark the proxy unavailable and cancel in-flight signaling before notifying the component;
  an existing or subsequent disposal then finalizes locally without RPC timeouts because the main
  voice/socket teardown is already the server cleanup backstop. Native
  `BrowserWindow` destruction is graceful: each PiP installs a `beforeunload` guard that calls
  `preventDefault()` and uses `Reflect.set(event, 'returnValue', false)` for Electron's required legacy
  veto signal, awaits the memoized disposal, and requests one retried close that the guard allows.
  React effect cleanup must also synchronously observe the
  disposal promise so a future rejection cannot become unhandled. A full app quit or update install
  is the deliberate exception: after `isQuitting` is set, the main process force-destroys PiP children
  so their renderer guards cannot veto shutdown; the closing main media socket remains the server
  cleanup backstop.
- **PiP consumers are E2EE fail-closed (2026-08-21 PiP E2EE gap).** Because the PiP owns its consumers it owns their
  decryption: `PipVoiceClient` creates a decrypt-only E2EE Worker and attaches the decrypt transform
  inside `consume()` via `ConsumerOptions.onRtpReceiver` — never after `consume()` resolves, which on
  Chromium >=149 leaves the transform empty while ciphertext reaches the decoder. `mic`, `camera` and
  `screen` are all encrypted, so all three go through it. Frame keys come from the main window over
  the existing proxy (`get-frame-key`); the initial key is provisioned before `resume-consumer` and a
  typed Worker miss re-requests the exact `(keyVersion, keyId)`. A missing key is safe — the Worker
  drops undecryptable frames and never enqueues them — but an unattached or bypassed transform is
  not: `consume()` returns `null`, closes the local consumer and issues `close-consumer`, so the tile
  stays silent/black rather than playing ciphertext. The bypass probe reuses the shared
  `decideBypassProbeAction` — and the attach itself reuses `buildDecryptCreationAttach` — so PiP and
  main-window policy cannot drift; its timers are cancelled
  synchronously in `dispose()`, and the Worker is sent `destroy` and terminated so key material does
  not outlive the window.
- **Gate-triggered screen reproduce is serialized.** The `screen-layering-gate` handler and the
  `supportSimulcast`-flip both route through `scheduleScreenLayeringReproduce()` (in-flight/pending
  latch mirroring `scheduleCameraLayeringReproduce`), so rapid gate edges or a toggle-vs-gate race
  coalesce into one queued reproduce instead of overlapping fire-and-forget `fastReproduceScreen()`
  calls.
  `scalabilityMode` stays `'auto'` (no depth
  picker — two switches only). Helper copy (`Settings/castingCopy.ts`) is a pure function of
  `(preferredVideoCodec, supportSvc, supportSimulcast)` that makes the SVC↔simulcast codec
  exclusivity explicit (AV1/VP9 = SVC-only, H264/VP8 = simulcast-only); a codec-inert toggle stays
  **ON + interactive** with "applies if you switch" copy — never disabled.

## Screenshare resolution/fps entitlement clamp (post-#2163)

Free-tier screenshare resolution/fps is clamped against the **stream** entitlement axis
client-side (the SFU does not enforce pixel dims/fps — see `.claude/rules/media-plane.md`
§"Per-user tier media gating"). The policy is **tiered pixel-rate**, not flat: a `StreamMaxPixelRate`
ceiling (free `62_208_000` px/s = 1080p30) on `VideoAxisLimit`, composed with the height ceiling
(1080) and the fps ceiling (60), so **1080p30 and 720p60 admit, 1080p60/1440p/4K are rejected**
("60fps reserved for 720p and below"). The camera axis has no pixel-rate cap (`pixelRate: Infinity`).

- **Single derivation:** `maxFpsForResolution(w, h, axis)` and `clampScreenCapture(w, h, fps, axis)`
  in `src/renderer/utils/policy/videoLimits.ts` are the pure functions all seams derive from; the
  string↔dims map is `SCREEN_RES_DIMS` / `resolveScreenDims` in `src/renderer/utils/ui/screenResolution.ts`.
- **Three enforcement seams:** (1) launch-reset `clampToFreeTier` (`useLaunchReset`) clamps explicit
  persisted over-cap discrete picks (1440p/4K→1080p, 1080p60→1080p30); (2) `voiceService.produceScreen`
  (+ `calculateScreenBitrate`) is the authoritative backstop — it resolves `source`/native to the REAL
  display dims (`getDisplayInfo` → shared `resolveScreenDims`, so a free 720p Native share keeps 60fps
  instead of the old 4K over-clamp) and clamps via `clampScreenForSubscription`; (3) `VideoConfigSection`'s Frame Rate options are
  **resolution-tiered** — the ceiling is derived from the resolution that will actually be captured
  (via `clampScreenCapture`), so free 720p offers 60 while free 1080p/source offer only 30, and a
  resolution change snaps an over-cap fps down + reveals a `PremiumChip`.
- **A clamped Source Native is DISABLED, not just labelled (reverses #2172's display-only gate).**
  `'source'` is the first-run default, so under the display-only marker a free user on a display
  taller than the stream height cap opened the picker on "Source Native 🔒 Premium". They shared
  `'source'`, and produce then clamped it to 1080p without saying so. The picker and Settings ▸ Video
  now both disable that option and show and send `highestFreeScreenResolution(axis.height)` instead.
  The value is `effectiveResolution` in the picker and `effectiveScreenResolution` in Settings. It is
  **derived during render and never written** to the store or the draft, which has three effects:
  it re-resolves on its own when hydration or `getDisplayInfo` arrives after mount; it never
  persists a downgrade computed from the pre-hydrate FREE default (#1301); and an upgrade restores
  Native with no user action. It fails open wherever `effectiveStreamAxis` does. Both surfaces
  also fail open while display info is pending (`displayInfo === null`). **Unavailable display
  info is not pending:** a missing bridge, a rejected IPC, an empty list, or no display with a
  width and height above 0 (0 and NaN are malformed) is treated as a 4K display. The picker,
  Settings and `voiceService.resolveCaptureDims` all read displays through one helper,
  `largestDisplayDims` in `utils/ui/screenResolution.ts`, and fall back to 4K on its `null`. They
  used to carry three copies, which drifted twice: Settings assumed a 1080p display and kept Native
  selected for a share that clamped to 1080p, then the two UIs missed the 0-size guard. **The 4K
  fallback describes the capture, never the device.** Settings keeps the detected display
  separate, and "Your device supports more" needs one; unavailable display info must not claim a
  device it never saw.
  **Every reader of the selection reads the derived value.** In the picker that is the select value,
  the Share payload and the fps ceiling. Settings adds the hint and the bitrate recommendation. One
  raw read re-opens the gap: an ultrawide `'source'` tiers to 22fps while the 1080p actually sent
  admits 30. The trade is width for frame rate: `'1080p'` requests a 1920×1080 box, so a free
  3440×1440 share captures about 1920×804 at 30fps where a clamped Native kept 2580×1080 at 22fps.
  Use a native `<option disabled>`, not `aria-disabled` plus a guard. The `<select>` stays
  focusable and the option stays listed and announced unavailable. `aria-disabled` on a native
  `<option>` does not block the pick. **The 🔒 Premium marker has two behaviours, on purpose.**
  Native is disabled because `'source'` is the default, so leaving it selectable reopens this
  bug. An over-cap fps option stays selectable and snaps back, revealing the upsell chip (#2163).
  Do not "fix" the difference in either direction without revisiting both.
- **Hydration-aware fail-open — one shared gate (#2172):** EVERY clamping seam derives the stream axis
  from `effectiveStreamAxis(sub)` (`videoLimits.ts`), which returns a native (fully-open) axis — fail
  OPEN — when the entitlement is not authoritative: the pre-hydrate window (`!hydrated && !degraded`) OR
  a degraded non-free tier. So the produce clamp (`clampScreenForSubscription`), the in-call
  `ScreenSharePicker` fps ceiling, and `VideoConfigSection`'s fps/camera snap-backs never clamp a premium
  user's choice against the pre-hydrate FREE default (the #1301 data-loss trap the store contract warns
  about). The two destructive `VideoConfigSection` snap-backs additionally gate on `hydrated` directly so
  they never persist a downgrade pre-hydrate. A **degraded FREE** user IS still clamped (the free floor is
  preserved through a degraded reconnect), closing the monetization escape; premium/native is a no-op.
- **Degraded reconnect preserves the last-known tier (#2172):** `subscriptionStore.hydrate()` fails
  CLOSED to FREE only on a FIRST-LOAD failure (`!hydrated`, no authoritative prior value); on a RECONNECT
  failure (`hydrated`) it PRESERVES the last-known-good entitlement and only flips `degraded`, so a
  transient `/entitlements` blip does not clamp a premium user to free (their `tier` stays `premium`, and
  `effectiveStreamAxis`'s degraded-non-free branch fails open). Premium is still only ever reached via a
  successful server fetch/push — a never-premium user can never obtain it via a degraded state; the only
  residue is a just-expired user holding stale premium across sustained fetch failures (bounded,
  self-limiting, moot for anything server-gated).
- **Single source of truth:** `StreamMaxPixelRate` lives in Go `entitlements.go` and flows through the
  DTO → wire → zod (`ws-events.ts`) → `subscriptionStore` `FREE_ENTITLEMENT`. Do NOT hardcode the
  62.2 Mpx/s threshold or the 720 boundary in client code — derive from the axis.

## Attachment size entitlement clamp (post-#2157)

The chat/DM attachment limit derives from the user's live entitlement. Before #2157 it was a flat
`MAX_FILE_SIZE = 26_214_400` (25 MiB) in `attachmentCrypto.ts` — **below** the 32 MiB free floor
the control plane and the pricing page both honour — so free users were refused uploads between
25 and 32 MiB that the server would have accepted.

- **Single derivation:** `resolveAttachmentLimit(input): AttachmentLimit` in
  `src/renderer/utils/policy/entitlementLimits.ts` is the pure function every seam derives from. It
  returns `{ limitBytes, source, entitlementBytes }` — `source` selects the copy branch and
  `entitlementBytes` survives the clamp so the copy can name both numbers honestly.
  `validateFiles` (`hooks/messaging/useFileUpload.ts`) takes the resolved limit and returns **structured
  rejections, never strings**; all copy lives in `components/Chat/AttachmentNotice.tsx`. Keeping
  the enforced number and the displayed number in one object is the point — they drifted apart
  before, which is what made the bug invisible.

- **NO hydration gate here — and that asymmetry with §"Screenshare resolution/fps entitlement
  clamp" is deliberate.** Read `entitlement.maxAttachmentBytes` unconditionally. The store is
  already `FREE_ENTITLEMENT` when unhydrated and preserves last-known-good on a reconnect blip
  (#2172), so a `hydrated`/`degraded` branch here could only ever ESCALATE above the store's
  current value. Screenshare needs `effectiveStreamAxis`'s explicit fail-OPEN because its clamps
  are **destructive and persisted** and the SFU does not enforce pixel dims — over-clamping there
  is unrecoverable data loss. Attachment size is **non-destructive and server-backstopped**:
  under-permitting costs a retry, over-permitting costs a full encrypt plus a 413. Do not
  "harmonize" the two by adding a gate to this one.

- **#1556 seam:** `resolveAttachmentLimit` already accepts `serverMaxUploadBytes` and already
  branches on it; #1556 supplies it at the call site. PR 1 passes nothing, because
  `EffectiveAttachmentBytes` has no production caller and `media/handlers.go` cannot resolve the
  server tier before `MaxBytesReader` (`channel_id` is in the multipart body). A **negative**
  value is a real sentinel meaning unlimited (selfhost) — `entitlements.go` and the header of
  `utils/policy/serverEntitlements.ts` both say so — but PR 1 deliberately treats it as *absent* and
  falls back to the user axis. #1556 must translate the sentinel to a real byte ceiling before
  passing it in.

- **The legacy-path ceiling, and why it is not a policy number.**
  `LEGACY_UPLOAD_PATH_CEILING_BYTES` (renamed from `INTERIM_CLIENT_ATTACHMENT_CEILING_BYTES` in
  #2157 PR 2) bounds renderer memory, not entitlement: `encryptAndBuildForm` is whole-file
  single-shot AES-GCM (~3× file size transient). It only ever narrows.

  It was **not deleted** by the chunked format, and the earlier prediction that it would be was
  wrong. The clamp is now **conditional on the server capability**: a server that does not
  advertise `features.chunkedAttachmentUpload` still receives single-shot uploads, and that path
  still has the whole-file transient. Deleting the ceiling would have removed the bound exactly
  where it is still load-bearing — on every server predating this change.

  `AttachmentLimit.source` therefore stays a **union**, `'entitlement' | 'legacy-upload-path'`,
  and does not collapse to a single value. The two branches say different things to the user: one
  is "your plan allows this much", the other is "this server cannot carry more". A plan upgrade
  moves the first and cannot move the second, so the copy must not conflate them.

  `AttachmentLimitInput.chunkedUploadSupported` is **required, not optional-defaulting**. An
  optional boolean defaulting to `true` would silently un-clamp every caller that forgot it;
  required means `tsc` names every seam that has to decide, and the fail-closed default lives at
  the one place that reads the capability.

  `MAX_DECRYPTABLE_ATTACHMENT_BYTES` on the download side is sized to the **premium entitlement
  plus chunked envelope overhead**, because that path faces bytes the server already holds and the
  chunked format produces files above the upload ceiling. Invariant: **upload ceiling ≤ download
  capability** — never size the download guard to the upload ceiling.

- **Images keep their own ceiling, and it is a different KIND of limit.**
  `IMAGE_STRIP_MAX_BYTES` exists because metadata stripping rewrites EXIF/XMP and needs the whole
  image in hand — the one place a whole-file transient survives the chunked format. It is a
  property of stripping, not of the plan or the server version: no upgrade moves it, and a
  non-image of the same size uploads fine. Say that in the copy, or the refusal reads as
  arbitrary. Stripping and chunking are independent concerns; an image under this ceiling is
  still uploaded in chunks.

- **Measure the body; never trust a declared size.** Both download call sites route through
  `readBoundedBody(response, max)` (`utils/runtime/boundedResponseBody.ts`), which counts bytes off
  `response.body` and cancels the transfer the moment the running total exceeds the cap — so peak
  allocation is bounded by the cap plus one chunk regardless of what the server sends or claims.
  The summary `file_size` gate stays as a fast path that avoids the fetch entirely, but it is
  **server-supplied metadata and is not the bound**; Concord is self-hostable, so "the server is
  honest" is not an assumption this client may make.

  **`Content-Length` is not a bound either, and the naive check fails OPEN.**
  `Number(headers.get('Content-Length'))` is `Number(null)` → `0` when the header is absent,
  `Number.isFinite(0)` is `true`, and `0 > max` is `false` — so the check evaluated cleanly and
  waved the body through. The header is absent on every HTTP/1.1 `Transfer-Encoding: chunked`
  response, absent on HTTP/2 responses that omit it, and carries the COMPRESSED length under
  `Content-Encoding: gzip`. `parseContentLength` therefore returns `undefined` for absent, empty
  and malformed alike — **never `0`**. Found by the #2157 adversarial review (VULN-001) *after*
  this section first shipped describing the broken ordering as correct.

- **Concurrent loads of one attachment are coalesced** onto a single fetch + decrypt via an
  in-flight promise map. One file legitimately appears on several surfaces at once (a message and
  the pinned list; the server does not restrict a file to one message), and the image observer's
  200px `rootMargin` brings them in together. Each surface used to mint its own blob url, and
  every one but the last was dropped from the cache **without being revoked** — unreachable by
  `evictOldestBlob`, pinned for the life of the document, with the byte budget under-reporting
  live memory by a growing margin (VULN-002). Removing the duplicate beats cleaning up after it.

- **The decrypted-blob cache is bounded by BYTES, not entries.** `BLOB_CACHE_MAX_BYTES` with
  `BLOB_CACHE_MAX` retained as a secondary entry cap. An entry-count bound alone made retained
  memory scale as `50 × the largest openable attachment`, so raising the download guard raised
  resident memory 50-fold. Any path that drops an entry from the Map **must revoke its url in the
  same step** — the Map is the only handle eviction has.

- **Eviction never touches a url that is on screen.** `useRetainedBlobUrl` records the file id in
  a `liveSurfaces` registry for as long as a mounted surface renders its url, and
  `evictOldestBlob` skips those, returning `false` when every candidate is live. **Exceeding the
  budget is the correct outcome in that case** — the budget bounds cache *retention*, not what
  the user is currently looking at, and a revoked url under a mounted `<img>` is a silently
  broken image whose `handleSaveImage` fetch then fails into a swallowed catch (VULN-002-C).

  The registry is deliberately **not** a refcount stored on the cache entry. A handoff scheme —
  loader retains, component releases — leaks a permanent reference whenever a surface unmounts
  while its load is still in flight, pinning the entry forever. Keying on "is anything mounted
  showing this?" is derived state owned by one effect, so an abandoned load simply never
  registers.

  **Every surface that obtains a url retains it, `FileAttachment` included** — even though it
  never *renders* one. This rule previously said the opposite, reasoning that the download path
  uses the url transiently with no `await` between the load resolving and `a.click()`. That is
  true of the interval *before* the click and irrelevant: **`a.click()` starts an asynchronous
  browser download that reads the `blob:` url over time**, and for an attachment near the guard
  that read is long-lived. Another attachment loading during it would evict and revoke the url
  mid-read. "No `await` in this function" is not the same as "nothing asynchronous is reading
  this" (#2837 review).

- **Icon rule:** `Lock` belongs to `PremiumChip` and genuine plan gates. A client-capability gap
  (plan allows more than the build can send) uses `Clock` and carries **no** upsell. Telling
  someone to upgrade for something they already bought is worse than saying nothing.

## Per-channel audio standard slider (post-#179)

The channel-settings "Audio Quality" control (`components/Channels/EditChannelModal.tsx`,
voice channels only) is a `ChannelAudioQualitySlider` (`components/Channels/`), NOT the old
`.channel-type-option` box-select. It mirrors the personal `AudioConfigSection` slider and
**shares its CSS** via `components/common/audioQualitySlider.css` (extracted from
`SettingsPage.css`, which now `@import`s it at the top — so the personal slider and
`DMPrivacyControls` are unchanged). Specifics:

- **Stops = `[Personal] + AUDIO_TIER_ORDER`** (8 stops; "Personal" is the leftmost tick →
  emits `null` = each member uses their own setting). `AUDIO_TIER_ORDER` is exported from
  `voiceStore.ts` (single source, mirrors the Go `audioTierOrder`).
- **Lock ceiling = the server's audio tier**, from `serverAudioCeilingTier(server.server_tier)`
  (`voiceStore.ts`) — a binary mirror of Go `entitlements.ServerAudioCeilingTier`
  (`groundspeed`→`standard`; any Mach ladder level `mach1`/`mach2`/`mach3` or `selfhost`→`studio`
  per ADR-0028; fail-closed to `standard`, incl. the retired binary `mach` string). Tiers above the
  ceiling render as native buttons with a lock glyph + accessible locked-state label, never mark
  themselves selected, and show an informational hint without mutating `audio_quality_tier` when activated. Copy is
  informational ("available on Mach-boosted servers") — **no purchase CTA** (the boost flow is
  #1556, not built). `EditChannelModal` reads the server via
  `useServerStore((s) => s.servers.find((sv) => sv.id === channel.server_id)?.server_tier)`.
- **Client gating is UX only** — the control-plane is authoritative (`UpdateChannel` rejects
  above-ceiling writes; join-authorize computes the granted `media_entitlements`). See
  `.claude/rules/media-plane.md` § "Per-channel audio standard". The PATCH
  payload is unchanged (`audio_quality_tier`: tier name or `null`).

## Chat reading position (`MessageList.tsx` + `channelScrollStore`, post-#2006 ×4)

The saved position for a channel or DM is a **message anchor, never a pixel offset**:
`{ messageId, offset }` — the topmost visible row and how far its top sits above the viewport
edge. GIF embeds and image attachments render as fixed-size skeletons until their bytes resolve
(`GifEmbed.tsx` reserves 250×180 until the slug resolves), so a `scrollTop` measured after they
settled lands short when replayed before they do, by exactly the sum of their growth. Three
attempts fixed that symptom at the pixel layer (#2006, #2008, the cold-load ResizeObserver
re-pin); each left a path that restored a stale offset AND set `isNearBottomRef = false`, which
disabled the re-pin that would have corrected it. This rework (#3282) is the fourth and moves
the store off pixels entirely. Do not reintroduce a numeric `scrollTop` into the store under
any name.

- **Bottom is the absence of an entry.** Leaving while `isNearBottomRef` is true clears the key;
  the next visit opens at the latest row and the ResizeObserver keeps it there. There is no
  persisted "near the bottom" state, so a thread can never come back in the band between the
  latest message and the Return to Latest threshold.
- **Landing runs once per key, in a `useLayoutEffect`, after keyed initial history readiness**:
  callers forward `useMessageFetch`'s `isHistoryReady` for the active channel or DM, then it takes
  the first rule that applies: saved anchor → first unread (when the unread rows overflow the
  viewport) → latest. A saved anchor missing from the current page remains pending while `hasMore`
  or `isLoading`; the list takes one provisional latest position without overwriting the saved
  entry, then retries as the user loads history. When history ends, an absent anchor is cleared
  before the unread/latest fallback. Explicit Return to Latest cancels that pending restore.
  Rules 1 and 2 mark the list as not following. An anchor exists only
  because the user left from above the threshold, so for rule 1 the ref is set from that fact,
  never from geometry — at skeleton height the viewport can read near the bottom, and a ref
  derived from it re-pinned the list on the next media resize. Whether the unread rows overflow
  IS a geometry question, measured after the align; if they fit, the list lands at the bottom.
  Geometry decides only whether Return to Latest shows, on landing and again on every resize.
  For both rules the badge is a position, not a seed: how many unread rows still sit below the
  viewport, re-counted on every scroll. The unread rows are always a suffix of the other users'
  rows — the last N at open, then arrivals — so the count needs no per-row flag: others' rows up
  from the bottom until one is fully in view, capped at the run (`unreadBelow`). The open-time
  read already marked those messages read server-side, so the seeded part of that run is not
  reported on leave (`onUnseenOnLeave` carries only what arrived while scrolled up) and does not
  survive a restart. A count larger than the loaded page therefore shows only the rows below on
  that page; the older ones sit above, and the number is what lies ahead. The ResizeObserver
  re-derives the badge with the button: a window that grows, a composer that changes height, or
  media that resolves moves the count without a scroll event. A message that arrives
  while the bottom is already in view puts the list back into following mode instead of counting
  behind a hidden button — unless the rows appended in that one update (a reconnect backfill
  commits every missed message at once) overflow the viewport, in which case pinning would show
  only their tail and mark them all: the list stands on the first of the other users' rows
  instead, as rule 2 would at open, and the badge counts what lies below. "Appended" means the
  rows whose ids the list did not hold before — a page that replaced an evicted tail (a reconnect
  that missed more than a page) is all new, a deleted tail is nothing — never "the rows after the
  previous latest id". What counts as an arrival at all is decided by loading history, not by
  ids: the **first loading cycle for a thread is hydration** (a remount shows cached rows first,
  then the fetch's newer ones, and those are covered by the open-time read), later cycles are
  arrivals (the backfill above), an empty thread's first live message is an arrival because the
  list remembers that a cycle ended on no rows, and a key change on a surviving instance resets
  all of it so the next thread hydrates as a mount would. The effect's cleanup pairs every landing with a leave (it resets the landed key), so a key change on a surviving instance, a StrictMode
  replay, and a list that empties and refills all land afresh; a detached node writes nothing to
  the store. Growth above a restored anchor is absorbed by Chromium's native scroll anchoring on
  `.message-list`, which is why no re-align pass exists; do not set `overflow-anchor: none` on
  that container.
- Rows are found by comparing `dataset.messageId`, never by interpolating an id into a selector;
  call-event rows carry `data-message-id` like every other row so they can anchor.
- **The first-unread landing (rule 2) was built, pulled, and is now back**, because the gap that
  got it pulled is closed. It depends entirely on the server's unread count being accurate at
  mount, and that count only advances when the client posts `/read` — which used to happen
  **only** when a thread was opened (`DMChatArea` on fetch complete, `ChannelList` on channel
  change). A message that arrived while the user was already viewing cleared the *local* badge
  but never posted `/read`, so the *server* count stayed stale; after a refresh the landing put
  the user back on rows they had already read, reproducing the soft-lock rule 2 exists to avoid.
  `MessageList`'s `onLatestSeen` prop closes that gap: it fires when the user has demonstrably
  seen the latest message — another user's message arriving while already at the bottom with the
  document visible AND the window focused (`document.hasFocus()`, the gate the notification sound
  already uses; arrivals shown while unfocused are remembered, every row of a batch counted, and
  marked when focus returns — if they all still fit on screen. The moment the unfocused burst
  outgrows the viewport the list stands on its earliest unseen row as rule 2 would at open, stops
  following, and the badge counts what lies below — at arrival if a later row or batch tips it
  over, or on regain if the viewport shrank meanwhile; Return to Latest or scrolling down then
  marks it as usual. If the user scrolls up or the list unmounts first, those arrivals leave as
  unread instead. A list that empties while mounted (a purge) flushes the pending marker and
  forgets shown-but-unseen arrivals, and a row that lands afterwards with no loading cycle is a
  live arrival, not hydration — the thread is past its loading cycle even though the previous
  latest id is gone (a refetch's refill carries the cycle and lands afresh); an arrival is any
  row whose id the list did not hold, wherever it sits **below the first row it already held**,
  so a reconnect that inserts missed rows before a preserved live tail counts them, while an
  older page that pagination prepends above that row is history and counts nothing (it would
  otherwise badge, and report on leave, rows older than everything read). One
  ceiling, by design: a WebSocket row that lands during the initial fetch carries no provenance
  that tells it from the fetch's own rows, so it is hydration — not marked while viewing, back as
  unread after a restart, the safe direction), or
  reaching the bottom (scroll or Return to Latest) with unseen messages pending — and the parent
  wires it to `useReadMarker` (`hooks/messaging/useReadMarker.ts`), a trailing-debounced
  `markSeen()` that coalesces bursts into one `POST /read`, flushing immediately on unmount or on
  a thread switch (it is keyed on the thread id, not on `post`'s identity) so leaving right after
  reading doesn't lose the marker to the debounce window — and what fires is the `post` captured
  when `markSeen` was called, so a switch cannot mark the NEW thread read with the old thread's
  intent. **The server stamps `/read` with its own clock**, so a timer still running would also
  cover anything that arrives before it fires; `MessageList`'s `onLatestLeft` (the list stops
  following, also fired when the list unmounts under an owner that stays mounted, e.g. a DM
  switching into its call view) and the hook's own hidden-document and window-blur listeners
  therefore flush the pending post the moment the user stops looking, and none adds a request. Callers reject on a non-2xx so a
  429 from the route's 30/min limit is logged rather than read as success. Still lost, by
  design: a read followed by an app quit inside the window — the marker stays one message low,
  which lands the next open a row early, never past unread content. Also not gated, and also by
  design: a live arrival is inserted as a fail-closed placeholder before its decrypt settles
  (#1741), and `onLatestSeen` fires on the placeholder, so a flush inside the decrypt window
  covers a row the user saw blank. No client-side gate can change that — the marker is one
  timestamp per thread, and the open-time read posts on the next visit regardless — so a row
  can only stay unread past its decrypt with a per-message marker, which is server scope. The
  same server clock is why a message committed while a flush is in flight is marked read: the
  request carries no cutoff, and initiating it at the boundary orders nothing against delivery.
  Closing that window means `/read` accepting the last seen message as an explicit cutoff — a
  control-plane contract change, declined for the client-side rework (#3289) and not taken
  silently. **The
  open-time read is still posted by its existing callers** (`DMChatArea.handleFetchComplete`, `ChannelList`'s
  effects on `activeChannelId` and on the voice-linked text chat, and the explicit mark-as-read
  in `ChannelContextMenu`) — `onLatestSeen` is additive, not a replacement:
  it covers "read while viewing", the open-time post covers "read by opening", and a thread that
  is opened and immediately closed still needs the latter since nothing was ever "seen" under
  the former's rules. Every production `MessageList` owner wires the hook — `ChatView`,
  `DMChatArea`, and `VoiceTextChat` (a DM call or a voice-linked channel, choosing the route by
  `isDMCall`, its target as the persistence key so it lands like the others, the DM open-time
  read posted once per target **entry** when the drawer's fetch completes since a reopened
  drawer's backlog is hydration — the guard clears when the target changes, so a call that comes
  back to a conversation after another target reads its backlog again as opening it would, while
  a reconnect refetch of the same target does not — its rollback and fence the same shape as `DMChatArea`'s below and keyed **per
  target** because no mount site keys the panel, so one instance survives a target change and a
  marker queued for the next target must not fence the previous one's rollback, and the local DM
  count cleared before marking because the active conversation may be another one) — a list
  without it silently reports nothing. `DMChatArea` posts its open-time
  read **once per thread**: the fetch hook fires completion after every successful fetch, and a
  reconnect refetch's page is read as it is seen, not by arriving; a non-2xx is rejected like the
  live marker's, rolling the local count back and letting the next completion retry. It also
  fences the open-time rollback by a per-thread read generation advanced **when a marker is
  queued** at the seen event, before the debounce, **and when a newer open-time attempt is
  posted** — neither component is keyed at its mount site, so a quick return to a thread while
  its first read is still in flight posts a second one: the open-time `/read` restores the
  cleared count on failure, and a failure that lands inside the debounce window, in flight,
  after the marker succeeded, or after a newer attempt was posted must not put back a count that
  newer claim clears; if every claim fails, the local count stays low, the safe direction.
- **The surviving ceiling: the count is read once, at mount, via lazy `useState`.** A count that
  changes after mount — including one advanced by this very fix, on a *different* mount of the
  same thread — is not re-read. This is the safe direction: a stale-*low* read lands the user a
  few rows early or at the bottom instead of mid-scrollback, never past unread content. Do not
  "fix" this by re-reading the count on every render; that reintroduces the anchor-fighting
  behavior the `useLayoutEffect`'s single run guards against. Two consequences to know: a count
  larger than the loaded page lands at the top of that page and requests the older page (the
  landing does not re-run when it prepends, so the user reads up from where the loaded history
  starts); and a server switch whose `/servers/:id/unread` response lands after the active
  channel was selected reads zero for that channel — the response excludes the active one — and
  lands at the latest message, exactly as every open did before this rule existed.
- `isNearBottom(list)` is the single definition shared by the scroll handler, the landing
  decision, the ResizeObserver, and the Return to Latest button. Keep it one function;
  `rowNearBottom(list, row)` is the same band asked of one row, for the previous latest row
  after a new one has already grown the content.
- **The landing's own scroll event is recognised and skipped.** Assigning `scrollTop` fires a
  `scroll` event a frame later, when siblings below the list may still be settling their
  mount-time layout (StrictMode double-runs every one of them in dev), so the viewport can read
  transiently taller and the list "near the bottom". The handler treats the first event after a
  landing whose `scrollTop` is at or below the landing value as that echo and does not re-decide
  from it; a scroll down is never the echo. Without this, the echo flipped the list into
  following mode and the next media resize pinned it to the bottom, or left the button hidden
  until the user nudged the wheel. The skip is armed only by an anchor landing (a bottom landing
  leaves the ref true, and eating the first scroll-up would keep it true), and the load-more
  check runs before it, so an anchor restored within 50 px of the top of the loaded page still
  fetches the page above it.
- **The ResizeObserver watches the scroll container as well as the content wrapper**, and when
  the list is not following it re-derives the Return to Latest button from geometry. Content
  growth below the viewport and a sibling changing the viewport's height both move the bottom
  without a scroll event; a state refreshed only by scroll events goes stale under a still
  viewport.

- **`scrollToMessage` is the only way to scroll a list to a message, and it returns a boolean.**
  It always runs `cancelPendingRestore()` first, so a failed call still consumes a not-yet-restored
  anchor; without that, the restore snaps the list back after the jump gave up. For a mounted row
  it clears the landing echo, stops following the bottom (or the ResizeObserver re-pins it),
  scrolls (`behavior: 'auto'` under Reduce Animations or the OS reduced-motion setting), focuses
  the row with `preventScroll`, and starts the 2 s highlight, which carries a static inset bar so
  it shows without colour or motion. It never calls `onLatestSeen`: a jump is not reading the
  latest message. A row that is not loaded is reached by `loadUntil` (cap 10 requests, 100 messages
  a page in a channel, 50 in a DM), driven by `useJumpToMessage`, whose outcomes are
  `reached | too-far | missing | failed | cancelled`. A failure reaches the user through the search
  card or `JumpNotice`; there is no second way to scroll a list programmatically. The pinned panel
  closes with its Jump click and takes focus with it, so when a jump from it fails and focus sits on
  `<body>`, `ChatView` and `DMChatArea` give the composer focus (`focusComposerIfLost`); a reached
  jump leaves focus on the row, and focus the user already moved is never taken. The search card
  scrolls its failure line into view, since the card may sit at the edge of the results list.

Regression-locked by the `scroll position preservation` suite in `MessageList.test.tsx`, whose
first case reproduces the report — leave from the bottom, remount at skeleton heights, grow —
and was confirmed to fail against the pixel-offset code before the rework.

## Electron Security

- Context isolation is ON — all IPC through preload bridge only
- No `@electron/remote`, no `nodeIntegration: true`, no `eval()`
- No `dangerouslySetInnerHTML` without sanitization
- No `shell: true` in `child_process`

## Styling

- CSS custom properties for theming — 32 selector blocks (15 schemes × dark/light + `:root` + generic `[data-theme='light']`)
- **Every `var(--token)` must resolve.** A reference to a custom property no block declares is
  invalid at computed-value time, so the **whole declaration is dropped** and the property does
  not render — a silent visual defect, not a fall back to a sensible default.
  `desktop/tests/unit/styles/css-var-references.test.ts` fails the build on any such
  reference that carries no usable fallback; its sibling `design-tokens.test.ts` checks the
  inverse, that every *declared* token exists in all 32 blocks. Never silence a failure by
  adding a literal fallback — a fallback on an undefined token is exactly what hid this class
  for so long, because the declaration still paints and the eye never flags it (#3270).
- **A foreground and its background move together, or not at all.** Resolving a `var()` proves
  nothing about whether the result is readable, and the two guards above are both blind to it:
  repointing a background at a theme token while its foreground stays a literal is a defect
  neither can see. It is the ordinary shape of the mistake, not an exotic one — #3285 shipped
  three of them, including white-on-`#ffff00` at 1.07:1 in the high-contrast theme, which is the
  one theme a user selects *because* they need contrast.
  `desktop/tests/unit/styles/contrast-pairs.test.ts` resolves every rule that sets both a
  foreground and a background through all 34 blocks and fails on anything below 4.5:1 that is not
  in `contrast-pair-allowlist.txt`. That list is a ratchet in **three** directions and the third is
  what makes the other two mean anything: an unlisted failure fails the build, a listed pair that
  has been *fixed* fails until its line is deleted, and a listed pair that has got **worse than its
  recorded ratio** fails too. Each entry therefore stores the accepted worst ratio, not just the
  pair. Keyed on the pair alone — which is how this shipped first — an entry is a permanent excuse
  at any ratio, and a listed failure can slide from 4.4:1 to 1:1 with the suite green. Its measurement lives in `contrastPairs.ts` precisely so the allowlist
  generator and the test cannot drift apart, which is how the #3270 allowlist once went off by one.
  Two things it structurally cannot see, so do not read a green as more than it is: a rule that
  inherits its background from an ancestor (that needs the DOM), and any fill whose result depends
  on what is painted behind it — `rgba()`, `color-mix()`, or a gradient whose bottom layer is
  translucent. A `linear-gradient` with opaque stops **is** measured, at its worst point sampled
  along its length and at every stop, with stops placed as CSS places them and translucent stops
  interpolated premultiplied; a layer painting one colour throughout (a scrim) is composited over
  it first. Two layers that both vary stay unresolvable, because each runs in its own direction and
  pairing them point by point pairs colours that never meet. A first argument that is not a
  direction or an angle is read as a stop, so a colour syntax it cannot parse leaves the fill
  unresolvable rather than dropped. Until gradients were measured the guard skipped every one, and
  20 brand-button rules sat below the floor with it green — Concord light at 1.20:1. **Element
  `opacity` is invisible to it too:** a dimmed control blends its label and its fill into whatever
  is behind it, so dim a text-bearing control with a fill chosen to be dim, never with `opacity`.
  **A `filter` is invisible to it for the same reason**, and a child cannot undo its parent's: the
  inactive voice tile's `saturate(0.7) brightness(0.9)` sat on the tile and took Morky's initials
  from 5.04:1 to about 3.49:1, so it now sits on the banner, avatar image and video only, and
  `identity-fill-labels.test.ts` fails a `filter` on anything else in `ParticipantTile.css`.
  **A row that holds a label dims its imagery, never itself:** offline member and friend rows
  faded to 0.45 and took the identity initials pair and the name with them (about 1.9 to 2.4:1 on
  Morky dark), so the offline state now dims `.member-avatar-img` only, and the same guard fails
  `opacity` or `filter` on the row rule itself. **One class, one stylesheet:** every component
  stylesheet is global, and a lazily loaded one lands last, so two stylesheets styling the same
  class at equal specificity restyle each other by load order. Server Settings' own
  `.invite-generate-btn` restyled the invite modal's brand button once Settings had been opened;
  it is now `.server-settings-invite-btn`, and the guard pins `.invite-generate-btn` to
  `InviteToServerModal.css`. Theme tokens are read as whole declarations, not lines: Pride writes its
  `--gradient-brand` across eight lines, and a per-line read measured Concord's gradient in its
  place.
  **Its own extraction is the part most likely to be wrong.** Five separate gaps shipped and were
  caught in review — states stripped inside `:not()`, only the last selector of a comma list kept,
  colour keywords treated as unparseable, the theme file excluded along with its painted rules, and
  the first rather than the last of repeated declarations taken. Each made a pair *unmeasured*
  rather than mis-measured, which is the dangerous direction: a skipped pair and a passing pair are
  identical in the output. Between them they hid 64 pairs. When changing the extractor, add a case
  that fails under the old behaviour and **run that mutation** — reading the code cannot tell you
  whether the assertion is attached to it.
  Theme blocks all match the same element, so `:root` is laid under each one before tokens resolve;
  a scheme that does not redeclare a token still gets it through the cascade, and reading only a
  block's own map skipped that entire scheme.
  **A `:hover` rule that changes only the background keeps the base rule's foreground**, and the
  test pairs them for exactly that reason: the worst pair in the tree is a hover state.
- **There is no `--on-danger`-shaped token for every family, and the palettes are not
  contrast-validated.** `--on-accent`, `--on-accent-secondary`, `--on-danger` and `--on-success`
  exist. **`--accent-secondary` is not one colour.** It is yellow only in Concord; other schemes
  make it orange, pink, green, purple, teal, brown or dark red. So text on it takes
  `--on-accent-secondary`, never a background token or a literal. The Premium chip drew
  `--bg-primary` (1.20:1 in light) and the admin role badge drew `#000000` (1.69:1 on Eclipse
  light). Each block's value is black or white by the fill's luminance, the same rule as
  `contrastColor`, so a block that moves `--accent-secondary` must redeclare it. Hover fills have no
  on-colour of their own, so one foreground serves both a fill and its hover and cannot be optimal
  for both. Choose such a value against **every** fill it must serve, not just the obvious one —
  and note the answer differs per mode: the custom-theme derivers in `utils/ui/colorUtils.ts` take
  black in dark and white in light for the same role. When adding a derived theme variable there,
  add it to `THEME_VARIABLE_KEYS` as well; `apply` walks the returned object but `clear` walks that
  list, and a key in one and not the other survives a theme switch as a stale inline style on
  `documentElement` that outranks the scheme replacing it.
- **Text on the brand gradient takes `--on-brand`, on `background: var(--brand-fill)`.**
  `--gradient-brand` is the identity: banners, profile headers and flourishes that carry no text
  keep it. A control that puts a label, an initial or an icon on the brand takes the pair instead.
  Each theme block chooses it to hold 4.5:1 at **every** point of the fill: `--on-brand` is black,
  white or the block's dark `--bg-primary`, and where no label colour holds on the gradient as it
  is, `--brand-fill` darkens an end (Spooky, Cotton Candy light, Driftwood light, Defacto light)
  or lays a black scrim over the flag (Pride). `--bg-primary` on `--gradient-brand` was the old
  pairing and read 1.20:1 in Concord light; literal `#fff` read 1.07:1 on high contrast's yellow.
  Custom themes derive the pair with `deriveBrandPair` in `utils/ui/colorUtils.ts`. A hover on a
  brand control lifts (`translateY` plus shadow) rather than fading or brightening: the pair is
  tuned close to the floor in several schemes, and `opacity: 0.9` took 15 of them below it. The
  same holds for any filled button with a tuned label, `.btn-primary` and the red
  `.key-recovery-prompt__danger` included; `identity-fill-labels.test.ts` fails a fade on them.
  **Initials on another user's colours take that user's pair, never the viewer's label:**
  `identityInitialStyle(resolveUserAccentColors(json))` sets both `fill` and `text`, derived by
  `deriveBrandPair` over the user's own gradient, and a scrim it needs sits over that gradient,
  not over the viewer's `--gradient-brand`. The raw `gradient` is for surfaces with no text —
  profile banners, the voice tile's banner, scheme swatches — and
  `tests/unit/styles/identity-fill-labels.test.ts` pins where it may be read. White on Hacker's
  green was 1.37:1. **A modifier class that replaces a brand fill declares its own label**, like
  `.login-submit-btn--danger`: the ratchet pairs a rule's own colour and background, so a modifier
  that sets only a background keeps the base rule's `--on-brand` unmeasured, and the account-reset
  red kept it at 4.05:1 in Concord.
- **An image whose colours cannot follow the theme ships as a light/dark pair, and CSS picks
  one (post-#3395).** Page CSS cannot recolour an SVG loaded through `<img>`, so a mark drawn in
  a fixed colour disappears in half the themes. The auth wordmark drew white letterforms at
  1.00:1 against Defacto light. Ship a variant for the other mode, following the pair convention
  the KLIPY logo already uses (`logoAssetLight` in `klipyProvider.ts`). Render **both** variants
  and hide the wrong one with CSS keyed on `data-theme`, as `ConcordWordmark` does:
  - **Key on `data-theme`, never on a JS choice of `src`.** `main.tsx` writes the attribute before
    React's first render, and `settingsStore` keeps it current, including a
    `prefers-color-scheme` listener under "System". A `matchMedia` read in a component is taken
    once per render and goes stale when the OS flips while it is mounted, which is how
    `GifPicker` and `UserPopover` still behave.
  - **Hide-only rules.** A rule that un-hides must pick a `display` value, and that value fights
    the call site's own sizing class.
  - **Key the light variant's hide on `:root:not([data-theme='light'])`, not on `dark`,** so an
    unset or unexpected theme falls back to the original asset rather than showing neither.
  - **Both images carry the real alt text.** The hidden one is `display: none`, which removes it
    from the accessibility tree, so exactly one is announced in either theme.
  - **Which variant is visible is a Chromium assertion** (`tests/e2e/auth-wordmark.spec.ts`).
    jsdom applies no stylesheet, so Vitest can pin only the markup, the rules and the asset pair.
- **Focus indicators draw in `var(--state-focused)`, never the accent** — rings (`outline`,
  `box-shadow`) and focus borders alike. `--state-selected` is the accent; a focus indicator in
  that colour reads as part of an adjacent selected highlight, which is what #798 split the tokens
  to prevent. `tests/unit/styles/focus-ring-token.test.ts` is an allowlist: every focus-context
  indicator is a solid `--state-focused`, paints nothing, or is a named exception (`--danger` on an
  invalid field, `currentColor`, the SSO brand blue, lightbox white). A translucent tint needs a
  solid indicator beside it, and a rule that removes the outline must draw something else.
  `link-contrast.test.ts` holds the token to 3:1 on all three surfaces in every block and keeps it
  distinct from the accent; a block whose `--accent-secondary` misses overrides it with a hex
  value. Three contexts the per-block guard cannot see: **high contrast** declares its own token
  (a scheme's literal would otherwise win); **custom themes** derive it with `liftToContrast`, and
  their inline tokens also beat high contrast, as every custom token does; an **inset ring** paints
  on the control's own fill, so on an accent-filled selected state it needs a `--bg-*` band deeper
  than its `outline-offset` to put its inner edge on a measured surface (`--on-accent` misses 3:1
  against the accent in 7 blocks).
- BEM naming for complex components
- Prettier: 100 char width, single quotes, trailing commas, 2-space indent

## Picker geometry and arrow linkage (`GifPicker`/`EmojiPicker`, post-#2370)

**The GIF picker's arrow had never rendered — for the entire life of the feature.**
`.gif-picker { overflow: hidden }` clipped the `::after` caret in full, and the fragment
that survived the clip was background-on-background with no border. Two facts made this
invisible in CI: `GifPicker.test.tsx` could only assert that `--gif-picker-arrow-x` was
*set*, not that the caret was visible (jsdom computes no clipping and no paint), and a
green suite therefore proved a property adjacent to the one that mattered. Treat this as
the standing reason a picker arrow/caret change gets a visual pass, not just a green
suite — see the org-wide "visual changes are verified visually" practice.

- **The containing-block trap.** A picker's `::after` arrow is `position: absolute` inside
  the picker box, which is `position: fixed` and therefore its own containing block. A
  positioned descendant IS clipped by that box's `overflow`. `overflow: hidden` clips at
  the **padding-box** edge with **no margin** — so any caret that protrudes past the
  picker's own border, however slightly, is silently clipped away with no error, no
  warning, and no visual signal beyond "the arrow is gone".
- **The fix is `overflow: clip` plus `overflow-clip-margin`, not `overflow: visible`.**
  `visible` would also let the picker's own scrollable body content spill out; `clip` still
  clips at the border-box scroll boundary of ordinary content while `overflow-clip-margin`
  extends *only* the clip boundary itself, which is exactly what a small fixed-size
  decoration (an arrow, not scrollable content) needs. The margin must be `>=` the
  caret's own protrusion — see `ARROW_HALF_CHORD` below (~8.49px for the shared 12x12
  caret; both pickers use a 10px margin, with headroom).
- **Measure with `offsetWidth`/`offsetHeight`, NEVER `getBoundingClientRect()`.**
  `getBoundingClientRect()` reports the **transformed** box. A picker that carries
  a CSS entry animation is on that animation's first keyframe when its
  `useLayoutEffect` runs at mount, so the rect it reads is the *scaled* size.
  `.emoji-picker--popover` animates in from `scale(0.95) translateY(4px)`, which
  made it measure 95% of its real height — for a ~400px box that is ~20px short,
  and since `top = anchorTop - measuredHeight - GAP` the picker's bottom edge
  landed ~8px BELOW the anchor's top and its caret protruded into the button it
  points at. The `offset*` properties are layout values and ignore transforms.
  **This is invisible to the test suite by construction:** jsdom runs no
  animations and applies no transforms, so a behavioural test passes either way.
  The guard is a source pin asserting the anchored branches read `offset*`, plus
  the visual pass — it was found by eye on a running client, not by CI. The GIF
  picker has no entry animation and so was never affected, which is exactly why
  it uses `offset*` too: one measurement being correct by accident is not a
  property worth preserving. `EmojiPicker`'s LEGACY branch deliberately still
  reads the rect, because its seven non-composer consumers must stay
  byte-identical; that is a recorded residual, not an oversight.
- **Offsets on the arrow resolve against the PADDING box, not the border box.** A caret's
  horizontal offset (`left: var(--picker-arrow-x)`) is computed relative to where the
  containing block's `left` was placed — CSS's `left` on an absolutely-positioned
  descendant resolves against the ancestor's padding box. Omitting the ancestor's own
  `border-width` from that computation (`anchorCenterX - left`, missing `- borderWidth`)
  lands the caret exactly one border-width off from the anchor's true centre — a 1px
  visual bug that is easy to introduce and easy to miss in review, because 1px is within
  normal jitter tolerance for a manual visual check that isn't specifically zoomed in.
- **`arrowInset` is derived, never pinned per-picker.** The minimum distance a caret's
  centre may sit from the picker's left/right edge — so the caret's rotated corners never
  spill past the picker's own rounded corner — is
  `ceil(cornerRadius + ARROW_HALF_CHORD - borderWidth)`, where `ARROW_HALF_CHORD = 6 *
  Math.SQRT2` (~8.4853, the half-diagonal of the shared 12x12 caret rotated 45deg). Two
  pickers with different `cornerRadius` values (GIF: 10, emoji: 8) derive different insets
  (18 and 16 respectively) from the SAME formula — pinning one shared literal for both
  either grazes the tighter-cornered picker or wastes pixels on the other.
- **The shared primitive is `utils/ui/pickerAnchor.ts`, and it has a hard boundary.**
  `PICKER_ANCHOR_GAP`, `VIEWPORT_GUTTER`, `ARROW_HALF_CHORD`, `arrowInset()`, and
  `resolveAnchoredPlacement()` are pure functions over plain numbers — no React import, no
  DOM node, no ref, no `useEffect`. If a future change to this file needs any of those, it
  has become a component/hook, which is a primitive the project lead explicitly declined
  in favor of duplicated-but-simple per-component logic; that is a new architectural
  decision, not a drive-by addition to this module. Each picker's own `useLayoutEffect`
  measures its rendered box — with `offsetWidth`/`offsetHeight` on the anchored path, per
  the transform rule above; `EmojiPicker`'s legacy branch is the one deliberate exception
  and still reads `getBoundingClientRect()` to stay byte-identical for its seven
  non-composer consumers — and calls into this module, which never touches the DOM itself.
- **A suppressed arrow is `display: none` on the `::after`, and nothing else.** No DOM
  reorder, no `tabindex` change, no conditional handler — a picker whose top was
  viewport-clamped (its bottom edge is no longer adjacent to its anchor) or whose anchor
  centre falls outside the picker's own horizontal span suppresses the caret this way.

## Chat header actions — icon row with floating labels (post-#1351)

The four controls (`expiration` / `search` / `pin` / `purge`) are uniform 36x28 icon buttons whose
label appears on hover or focus. Four rules, each of which cost a defect to learn.

**The pill is out of flow, and that is not a shortcut.** The group is flush with the header's right
edge, so a pill in the flow must displace a sibling or slide the whole group — and a row that moves
under the pointer is what makes fast icon-to-icon travel feel unstable. `position: absolute` means
nothing reflows at all.

**The label is `content: attr(aria-label)`, never a second copy of the wording.** Every one of these
buttons already carries an `aria-label`, and an `aria-label` takes precedence over descendant AND
generated content when computing an accessible name — so the pill structurally cannot cause a double
announcement. Do not add a visible `<span>` label back: `.chat-header-purge-label` is kept in the DOM
but visually hidden precisely so the name survives, and re-showing it makes purge the one control
that is not an icon.

**Remove `title` when you add a pill.** The native tooltip fires ~1s later and shows the same words
a second time. `title` on these buttons is now a bug, not a fallback.

**Purge carries no resting border, and a rule that thinks it does is a rule that never ran.** The
control went `border-left` (read as a broken button) to full border (read as a stray outline once its
three neighbours became equal-weight icons) to none. What makes this worth writing down is not the
design walk but how the last step was found: `.chat-header-purge-button { border: ... }` is (0,1,0)
and `.chat-header-actions > button { border: 1px solid transparent }` is (0,1,1), so the transparent
edge had ALREADY won and the declaration had been inert for a whole feedback round while its comment
argued at length for it. Its `:hover` arm is live, because a pseudo-class scores in the class column
and puts that selector at (0,2,0). The danger edge is a hover state now — it arrives with the pointer
that could act on it.

**Read duplicate-selector findings as cascade evidence, not style nits.** Six `css:S4666` hits on this
PR were all real: two byte-identical blocks, a `transition` overridden by three later rules, a
`transition-delay` stub superseded by a full shorthand, and a label rule styling a clipped element.
None changed a pixel, and that is the point — each made the first occurrence of a selector read as
the effective one when it was not.

**`prefers-reduced-motion` must come LAST, and a high-specificity arm inside it must set only the
property it needs.** A media query carries no specificity of its own, so the block ties with the plain
`transition` rules and wins only on source order. It sat above the three timing rules here and
measured as half-applied: the scale was suppressed, `transition-duration` still read `0.09s`. Moving
it to the end fixed two of three arms; `[data-warm='true']` scores in the class column, putting that
selector at (0,3,1), which source order alone does not reach. Folding it into the grouped arm then
measured WORSE than leaving it out — the group also sets `transform`, so at (0,3,1) it outranked the
right-anchored `:last-child` arm below and shoved the two rightmost pills back to `translateX(-50%)`,
half a label off their own edge. It ships as its own rule setting `transition-duration` alone. The
DELAY is left intact throughout: an intent gate is not motion, and dropping it would reintroduce the
pill-flash the gate exists to prevent.

**Hover timing is `useHoverIntent` (`hooks/ui/useHoverIntent.ts`), and it changes ONLY the delay.**
Which pill shows stays pure `:hover`, so the hook needs no per-item props and its attribute cannot
disagree with what the pointer is over. `warmUpMs` (450ms) deliberately EXCEEDS the CSS open delay
(400ms): if the group warmed during the first pill's wait, that pill's `transition-delay` would be
recomputed mid-delay and open early — the gate would fire late on entry and not at all thereafter,
defeating both halves.

**A registered `@property` transitioned at 0s duration is NOT a reliable scheduled flip.** The warm
group was first built that way — `transition: --warm 0s 130ms` to set and `0s 600ms` to clear — and
it was measured in the running app: 900ms after the pointer left the group `--warm` was still `1`,
and the gate resolved to `0s` rather than `0.4s`. It set forward and never came back, so the group
latched warm and the intent gate was permanently absent. **The failure looked like success** — pills
appeared promptly, which reads as snappy rather than broken — and only surfaced because the resolved
`transitionDelay` was read rather than the animation watched. Use real state and a real timer.

## Application font (Settings ▸ Appearance ▸ Fonts, post-#1642, layered in #2366)

The user-selectable application font is governed by a single pure resolver and a single settings sink that writes one attribute per font layer — never ad-hoc per-component font logic.

- **Two modes (#2366):** `fontMode: 'one' | 'area'`. **One Font** applies the `appFont` pick everywhere. **Font by Area** sets four areas separately: **Messages** (`.message-list` and its empty/loading state `.message-list-empty`, which renders with no `.message-list` ancestor — server chat, DMs, voice text chat), **Headings** (every `--font-display-stack` site outside the two regions: titles, section and modal headers, primary buttons, initials), **Navigation** (`.layout-server-bar`, `.layout-folder-bar`, `.layout-channel-panel`, `.layout-member-space`) and **Interface** (everything else). **The Interface area and the One Font pick are the same key, `appFont`**, so switching modes never changes body text; the per-area keys `fontHeadings`/`fontNavigation`/`fontMessages` persist while in One Font and are simply not applied. Overlays and the message composer sit outside the regions and follow Interface/Headings. `ui/Modal`, `ContextMenu`, `MemberProfileCard` and `UserProfileModal` portal to `ModalPortalHostContext ?? document.body` (the host keeps them inside a top-layer settings dialog). **An overlay rendered in place inside a region inherits that area's font — `position: fixed` does not change DOM ancestry — so portal any new one.** Design: `docs/superpowers/specs/2026-09-23-2366-layered-fonts-design.md`.
- **Resolver (source of truth):** `resolveFontLayers` in `src/renderer/utils/ui/effectiveFont.ts` is pure (no DOM/store) and returns `{ interface, headings, navigation, messages, brand, pickerLocked, lockReason }`. It wraps `resolveEffectiveFont`, which still owns Interface precedence: **Dyslexic Support > explicit user pick > theme-bundled font > app default**. Dyslexic Support sets every layer, `brand` included, to OpenDyslexic. **`'default'` on every area means "Match Interface", and the picker says exactly that.** The Interface list opens with two defaults: **Theme Default** (`'default'`, dynamic — the theme's bundled body font where it has one via `SCHEME_FONTS`, else Source Sans) and **Concord Voice Default** (`CONCORD_DEFAULT_FONT` = `'sourcesans'`, the base fonts kept on every theme). Headings match Interface through `headingsMatchingInterface` in BOTH modes: an explicit Interface pick drives headings; Concord Voice Default drives them to `'concord'`, a Headings-only derived value (`HeadingsFontId`) that pins the brand display face Droidiga through `--font-stack-concord`, Agency's Atkinson display face included; a theme-bundled font is a BODY font and never reaches them, so Interface on Theme Default leaves headings on the theme's display face. Navigation and Messages stay `'default'` in One Font and inherit, so their text follows Interface and their headers follow Headings. Font by Area: each area is its own key, and an explicit pick overrides the match. **Labels name the setting they follow.** The defaults shipped as "Match the app" (Messages, Navigation), "Theme default" (Headings) and "Concord Voice Default" (Interface, meaning `'default'`). The first named no setting a user could find. In Font by Area a Headings default ignored the Interface pick while One Font honoured it. The last was wrong under Agency, where the no-pick default is Atkinson. The picker previews each default in the face it applies, and `headingsMatchingInterface` is exported so the preview and the resolver share one rule. Q1 (`themeVsUser`) and Q2 (dyslexic-off restore) are parameters, not branches scattered across the UI.
- **Single sink, one attribute per layer:** one `settingsStore` subscriber over `(appFont, dyslexicSupport, colorScheme, fontMode, fontHeadings, fontNavigation, fontMessages)` makes ONE `resolveFontLayers` call and `applyFontLayers` writes `data-appfont` (Interface — the name is kept because existing rules and tests key on it), `data-font-headings`, `data-font-nav`, `data-font-messages` and `data-font-brand` on `<html>`. Do NOT add another font DOM write anywhere — dyslexic/theme/mode feed the **resolver**, not the DOM.
- **Rehydration validates font state.** The persist `merge` passes appearance through `sanitizeFontSettings`: any unknown font id (in `appFont` or the three area keys) falls back to `'default'` and any unknown `fontMode` to `'one'`. Before #2366 a corrupt stored `appFont` counted as an explicit pick and displaced a theme-bundled font. The new keys need no `migrate` step because `merge` spreads persisted appearance over the defaults.
- **CSS — every font rule sits on `body` or a region root, never on `:root`.** The 32 theme blocks declare their tokens on `<html>`, and a declaration on a descendant beats an inherited value with no specificity comparison at all. Each selectable face has ONE stack variable (`--font-stack-<id>`) declared inside the base `:root {` block — derived, not themed, and never a new `:root {` block (the design-tokens drift guard counts them). `--font-stack-concord` is the one stack with no selectable id: it serves only the derived Headings value `'concord'`. Rules at the end of `styles/index.css`: `[data-appfont='<id>'] body { font-family }`, `[data-font-headings='<id>'] body { --font-display-stack }`, and one rule per id for `[data-font-nav='<id>'] :is(<four region roots>)` plus `[data-font-messages='<id>'] :is(.message-list, .message-list-empty)` that sets BOTH `font-family` and `--font-display-stack`, so an area's own font covers its headers, author names and initials too. `'default'` has no rule on any layer. **This retired `:root[data-appfont='opendyslexic']`**, the (0,2,0) rule that only TIED `[data-scheme='…'][data-theme='light']` and had to stay last in the file — demoting it once broke 16 of 32 theme/mode combinations, every survivor dark. The body font is still set on `body` rather than through `--font-body-stack`: that token route was tried and rejected for the same tie.
  - **Themed scope roots re-declare the display stack, so the rules name them.** `useUserThemeScope` puts `data-scheme`/`data-theme` on another user's profile surface (profile card and modal, popover, DM profile, voice tile), which re-matches a (0,2,0) theme block and re-declares `--font-display-stack` on that element — beating the value it would inherit. The headings rule therefore also targets `body [data-scheme]` (0,2,1) and each area rule its `[data-scheme]` descendants (0,3,0), so an area still beats Headings inside its region. The viewer's font is a reading preference; the viewed user's theme supplies colours only, and keeps its display face only when the viewer has no pick.
  - **The wordmark keeps the brand face.** `Titlebar.css` reads `--font-brand-stack`, declared as `var(--font-display-stack)` in the base `:root` block, so it resolves on `<html>` against the theme's display face and a Headings pick (declared on `body`) cannot reach it. Only `[data-font-brand='opendyslexic'] body` redefines it — an accommodation outranks branding; an ordinary OpenDyslexic PICK does not reach the wordmark.
  - **Cascade proof lives in Chromium.** `tests/e2e/design-tokens.spec.ts` reads computed values on `body` and on probe region elements (including themed scope roots and the empty message state) across agency/concord × light/dark; jsdom returns `''` for every custom property, so **Vitest structurally cannot make these assertions**, and `tests/unit/styles/design-tokens.test.ts` only proves the rules are present (every layer × explicit id, the stack variables, no `:root` font rule, brand only under OpenDyslexic, one region list per layer whose classes still exist as `className` literals, and no hard-coded body font in renderer CSS outside `SSOButton.css` and the base `body` rule).
  - **What #2366 fixed on the body side:** 53 sites in component CSS spelled out `font-family: 'SourceSans', sans-serif`, and an inherited value loses to any declaration on the element itself regardless of specificity — so those sites ignored the user's pick entirely, for every font. They now say **`font-family: inherit`**, matching the idiom already used in ~12 component files. Most are form controls and buttons, which do not inherit a family by UA default (`<input>`/`<select>`/`<textarea>`/`<button>` get Chromium's system control font); the rest are ordinary labels hardcoded alongside them. It was invisible at the default font because the hardcoded family WAS the default. Review then found controls with **no** font rule at all ("Forgot password?", "← Back to Connection Options") rendering in Arial under Dyslexic Support, so `styles/index.css` now carries a zero-specificity **`:where(button, input, select, textarea) { font-family: inherit }`** reset: author origin beats the UA sheet, and any component rule still wins. **Never hardcode a body family in component CSS — use `inherit` or nothing.**
  - **The one deliberate survivor** is `SSOButton.css`, which keeps `'Roboto'` because Google's Sign-In branding mandates it. It carries a comment saying so; do not "fix" it to `inherit`. Everything else still hardcoding a family is monospace/code (invite codes, diagnostics, version strings), which correctly does not track the body font.
- **Theme-bundled fonts (post-#1643):** a scheme may bundle a body font via the `SCHEME_FONTS` map in `effectiveFont.ts` (Agency → `atkinson`); `themeBundledFontFor(colorScheme)` feeds it to the resolver, applied through the **same sink** as the Interface layer when the user hasn't made an explicit pick (soft theme-lock, `lockReason: 'theme'` — the picker stays interactive so a pick overrides per the shipped `user-wins` config). **The picker highlights the SAVED choice, never the applied one**: under Agency with no pick, Theme Default stays selected and an "Active with the current theme" chip marks Atkinson. It mirrors the codec list's Preferred / In Use (`.font-option-in-use` copies `.settings-codec-status`'s colour pair). #1643 first highlighted the applied font instead, so a dynamic choice could never look selected. Its accent badge read 2.68:1, and it was removed with its contrast-allowlist entry. Its display face lives in the theme's own `--font-display-stack`, so do NOT add display fonts to `SCHEME_FONTS`. The Agency `--font-body-stack` override was **reset to the canonical default** (NOT deleted — `design-tokens.test.ts` requires every one of the 32 theme blocks to declare it); `--font-body-stack` has **no** consumer: the last one, `CategoryManagerPanel.css`'s input, ignored every font setting and now says `inherit` (#2366). Do NOT re-add a per-scheme `--font-body-stack` override to apply a theme body font — that path is dead; route it through `SCHEME_FONTS` + the sink.
- **Dyslexic hard-lock (post-#1644):** the Accessibility ▸ Display "Enable Dyslexic Support" toggle (`AccessibilitySection.tsx`, writes only `dyslexicSupport`) is the resolver's top layer — it overrides every pick, every area and a theme-bundled font with OpenDyslexic, and changes the wordmark. `FontSection` renders the lock when `lockReason==='dyslexic'` in BOTH modes: the mode radios and every option become `aria-disabled` (options kept as native `<button>` for S6819 + WCAG 1.3.1/3.3.2 discoverability) with `aria-describedby` → a visible lock note + a back-link, and each area summary reads "OpenDyslexic · Locked". A JS **activation guard** (`if (locked) return`) is load-bearing: it stops a locked control from writing, preserving **`DYSLEXIC_WRITES_APPFONT = false`** — the resolver falls through to the prior picks automatically when the toggle is turned off (Q2-restore is structural; never snapshot/restore font keys in a handler). The cross-section back-link uses the `settingsNavStore` focus-request primitive (`requestFocus(section, controlId)`) consumed by `SettingsPage`'s focus effect (switch pane → deferred `getElementById` → `details.open=true` → `scrollIntoView` → `.focus()`); Settings panes are mutually exclusive, so this primitive is the only cross-section focus path.
- **Store setters are load-bearing.** `appFont`, `dyslexicSupport`, `fontMode`, `fontHeadings`, `fontNavigation` and `fontMessages` live on `AppearanceSettings`; their `setAppFont`/`setDyslexicSupport`/`setFontMode`/`setFontHeadings`/`setFontNavigation`/`setFontMessages` setters MUST exist with those exact names — the draft layer (`draftSettingsStore.ts`) write-through and Revert both call `set<Key>` by derived name, so a missing setter silently breaks live-preview/revert. The keys are flat for the same reason. They ride the encrypted preferences blob at `v: 1` and are NOT applied on pull, like every font key.
- **The tray keys follow the same contract.** `appearance.trayIconStyle` (Settings ▸ Appearance ▸ Tray Icon) is flat on `AppearanceSettings` with a `setTrayIconStyle` setter the draft layer calls by name, rides the preferences blob at `v: 1`, and is NOT applied on pull. The tray menu's unread row reads `recentUnreadTargets`, a LIFO stack in `unreadStore` that `dmStore` also pushes to: it is not persisted, `clearAll` empties it, and readers filter out entries that are no longer unread or are muted. `setOwnPresence` is the single call site for changing your own presence, shared by the user popover status menu and the tray menu. See [`electron.md`](electron.md) § "IPC contract v33".
- **Fonts are self-hosted, license-cleared.** New faces go in `public/branding/Concord-Voice/fonts/` with a root-relative `@font-face` (never a CDN — privacy). Update `fonts/LICENSES.md`. OFL / commercial-cleared only; Baron Neue is BLOCKED (personal-use-only). A new face also needs its id in `AppFontId`/`APP_FONT_IDS`, a `--font-stack-<id>` variable and a rule on every layer — the design-tokens test enforces the last two.
- **The picker** is `FontSection.tsx` (composed by `AppearanceSection`), using the draft pattern (`setDraftAppearanceSetting(<key>, …)`). The mode is a `<fieldset>` of native radios styled as `.settings-mode-pill` — a saved setting, not tabs. **The inputs carry `settings-mode-radio`**, because the shared highlight is `.settings-mode-pill:has(.settings-mode-radio:checked)`: the toggle first shipped with an `.active` class of its own, and #3428 retired `.active` from that rule in a PR merged eight minutes after this one, leaving the selected mode unmarked with both suites green. `FontSection.test.tsx` now reads the selector out of `SettingsPage.css` and asserts the radios carry it. That shared checked-pill rule carries the selection on an **inset `--text-primary` ring** (#3457), not the fill alone: the fill measured 1.06–1.27:1 against the track, below WCAG 1.4.11's 3:1, and `--accent-primary` misses 3:1 in three blocks (worst 2.19:1, Concord light) while `--text-primary` clears it in all (worst 8.76:1) — so the Audio and Video toggles changed with it. One Font renders the original list; Font by Area renders `<details name="font-areas">` rows (native exclusive group — one open at a time) whose summary shows the area's current font in that font. `'sourcesans'` is labelled **Concord Voice Default** in the Interface list, where it carries the brand heading face too, and **Source Sans** in the three area lists, where it is the face alone. Theme Default, Concord Voice Default and System Default each carry a one-line hint, since the first two render identically on every non-bundling theme. **The hint and the In Use chip are each option's accessible DESCRIPTION, never its name**: both are `aria-hidden` inside the `<button>` and referenced by its `aria-describedby`, which the description computation still reads, so the name stays the visible label ("Concord Voice Default", not "… Active with the current theme") for screen readers and voice control. The chip's claim rests on every non-bundling theme block declaring the same display face `--font-stack-concord` pins; `design-tokens.test.ts` asserts that for all 30. An always-mounted `<output>` (implicit role `status`, a polite live region) says per-area picks are kept while One Font is selected.
- **Font Size lives in this section too (post-#2367)** — native radios in a `<fieldset>` below the typeface controls, deliberately OUTSIDE the dyslexic lock: the hard lock governs typeface, and turning on a typeface accommodation must never lock text size. It writes `fontSize` through the same draft pattern; `applyFontSize` → `data-fontsize` is unchanged. The continuous UI Scale slider stays in Accessibility ▸ Display — see § UI Scale below.

## UI Scale (Settings ▸ Accessibility ▸ Display, post-#2367 part 2)

UI Scale has **two engines, chosen by shell capability, never both**. Pure helpers live in `src/renderer/utils/ui/uiZoom.ts`; the applier is `applyUiScale` → `applyUiZoom` in `settingsStore.ts`, beside the other DOM sinks. Design: `docs/superpowers/specs/2026-09-23-2367-ui-zoom-design.md`.

- **With the zoom bridge** (`electron.window.setZoomFactor`, IPC contract v29 — see [`electron.md`](electron.md) § "IPC contract v29"): real Electron page zoom over 0.5–2.0. `--ui-scale` is **pinned to 1**, or text would be scaled by the zoom AND the variable. Zoom-in is capped by width — `computeAppliedZoom(chosen, innerWidth × currentZoom)` = `chosen <= 1 ? chosen : min(chosen, max(1, unzoomedWidth / 800))` — and re-evaluated on every `resize`. **Without it** (an older shell running this SPA): exactly the pre-#2367 behaviour, `--ui-scale` clamped to the legacy 0.85–1.3 and the slider at that range. `SPA_MIN_CONTRACT` stays 19 because this degrades rather than demands.
- **The stored value is the CHOICE, not what is applied.** `appearance.uiScale` is 0.5–2.0 for every shell (clamped by `clampUiScale` on set AND on rehydration). Any JS that mirrors `--font-scale` must use `cssUiScaleFor(uiScale, hasZoomBridge())`, never the stored value — `ParticipantGrid`'s pill band did, and would have doubled under 2× zoom. `var(--font-scale)` in CSS or inline styles is correct under both engines.
- **The change guard is load-bearing, not an optimisation.** Zooming fires `resize`, which calls the applier again; only the `UI_ZOOM_EPSILON` guard stops a second bridge call. The epsilon is 4× the worst-case rounding noise of `innerWidth × applied`, which is why the loop cannot start. It must never swallow an **exact endpoint** (the chosen scale, or 1): a 1.59375 width cap that became an uncapped 1.6 is a 0.006 step, and with the epsilon alone the page stayed short of the choice for good while the hint read "Limited to 159%" on a wide screen. Endpoints go through unless equal, which stays loop-free because a resize at an endpoint recomputes the same value or a cap within 0.0025 of it. The first call per document is unconditional (`appliedUiZoom === null`), so a zoom factor that survived a reload is brought back to a known value, and a zero-width (minimised) window keeps its last factor.
- **PiP windows never zoom** (`isPipWindow()`, the `#/pip/` test `App.tsx` uses). They share this module and store, and page zoom does not propagate between windows, so skipping the applier keeps them at 1×.
- **`appliedUiZoom` is runtime-only store state**, excluded by `partialize` — it describes this window at its current width. The slider reads it for the "Limited to N% at this window size" hint, compared in **whole percent** so rounding never produces "limited to 200%, widen to use 200%". The hint is an always-mounted `<output>` referenced by the slider's `aria-describedby`: it changes when the WINDOW is resized, not when the control is touched, so it has to be a live region that already exists.
- **The slider commits on release, not per drag step.** A drag moves a local value (thumb and label only); the draft — and so the zoom — is written on the native `change` event, which fires on pointer release and on each keyboard step. Zooming on every `input` event re-lays out the slider under a stationary pointer: measured in Electron 44, a 200 px drag then ran the value backwards twice and stopped at 1.35 instead of 1.75. React's `onChange` cannot carry the commit (it is the `input` event, and on release the value is unchanged so React does not fire it), and the local value takes only `input` events so a React-reported `change` cannot pin the thumb against later store updates.
- **Context menus must stay clampable under zoom.** `ContextMenu` flips, then clamps into `[8, viewport − size − 8]`, and caps a menu taller than the viewport with inline `max-height` + `overflow-y: auto` — **only when it cannot fit**. Do not move that overflow into `.ctx-menu` CSS: `.ctx-submenu` flyouts are absolutely positioned outside the menu box, and any non-visible overflow on `.ctx-menu` clips every submenu in the app.

## GIF playback gating (post-#2369)

The gated GIF surfaces answer to one pure resolver, `resolveGifPlayback` in `src/renderer/utils/ui/gifPlayback.ts`. It is DOM-free, store-free and total over all 24 input combinations, mirroring the `resolveEffectiveFont` shape above.

- **Scope, stated precisely because the setting's name does not.** Gated: `GifEmbed` (both kinds), `ImageAttachment` and its lightbox, and `GifPicker` tiles. **NOT gated: animated profile media** — premium avatars and banners keep their frames through `processGIFTier1Image` (#1302) and are mounted as plain `<img>` by `MessageAvatar`/`MemberItem`, so they animate regardless of focus or of the hover setting. That is a deliberate scope line, not an oversight: they are identity chrome rather than content, they are small, and gating them is a separate change with its own product question about whether "GIF Playback" should mean someone else's avatar. **If you extend the gate there, update this paragraph and the user-facing copy together** — the setting is named unqualifiedly and the changelog entry says "GIFs", so scope lives here or nowhere.

- **Two axes, not one — this is the rule the whole feature turns on.** The **hover gate chooses the ELEMENT** (`surface: 'animated' | 'still'`); **window focus chooses whether the mounted element RUNS** (`playing`). Collapsing them into one boolean is the obvious implementation and it breaks in both directions: unmounting the `<video>` throws away the `HTMLMediaElement.pause()` that made the pause free, and mounting an animated element for a Reduce-Animations user starts fetching mp4 bytes they fetch none of today. `GifEmbed` evaluates its still branch BEFORE its `animatedKind === 'video'` branch, so under Reduce Animations without hover there is no `<video>` mounted to pause — which is exactly why the two fields are separate.
- **`'auto'` follows Reduce Animations; it never writes it.** `REDUCE_MOTION_WRITES_GIF_PLAYBACK = false`, the same half of the `DYSLEXIC_WRITES_APPFONT` precedent: the follow is re-derived on every read, so turning Reduce Animations off restores prior behaviour *structurally* rather than by replaying a snapshot some handler had to remember to take. The **other** half — the dyslexic hard lock — deliberately does NOT transfer. Dyslexic Support is a declared accessibility requirement whose value is being undefeatable; `reduceAnimations` is a broad appearance preference not even wired to `prefers-reduced-motion`. A hard lock here would delete the feature in the configuration the reporter most likely runs and could not express "Reduce Animations off, hover-only on", which is the reporter's own case.
- **Focus comes from `useWindowFocus`** (`src/renderer/hooks/ui/useWindowFocus.ts`), a `useSyncExternalStore` module singleton — one listener pair and one snapshot however many components subscribe. Its `focus`/`blur` listeners are registered in the **BUBBLE phase, and that is load-bearing**: those events do not bubble but they DO capture, so a capture-phase window listener fires for the focus of every inner element and would pause every GIF in the app the moment a user tabs to a button. Pinned by a test that dispatches `focus` on a button and asserts nothing changed. Do not "tidy" a `, true` onto those listeners.
- **Two invariants on `AttachmentDisplay.tsx` that must not be simplified.** (1) `useRetainedBlobUrl` stays ABOVE the gate and `url` is NEVER nulled to pause — moving the hook below, or nulling `url`, reintroduces #2157 VULN-002-C directly, re-decrypting and revoking a live blob on every alt-tab. (2) The `<button class="attachment-image-btn">` stays mounted whenever `url` is non-null, with the playback gate strictly INSIDE it; when paused it renders a sized placeholder `<div>` and keeps its own `aria-label`, so its accessible name never depends on the `<img>`'s `alt`. Gating the button itself destroys keyboard focus on every alt-tab — on return focus is on `<body>` and the user has lost their place in the message list.
- **The picker deliberately diverges, and does NOT consult the resolver.** `GifPicker`'s `GifMedia` reads `useWindowFocus()` directly. Reduce Animations and hover-only never reach it: users need to see the animation to choose a GIF (QA #571 item #6A) and a grid that animates only the tile under the pointer is unusable. Unfocus-pause *does* reach it, because #6A's rationale is false when the window is unfocused. Passing a verdict in here would silently import the hover gate with it.
- **Pause by driving the element, never by remounting it.** `/api/v1/klipy/media` is rate-limited 300/min per user with a hard 429 and Electron main injects the bearer per request, so every media-element mount is a real authenticated origin request on a cache miss. Roughly 20 embeds × 15 alt-tabs exhausts the budget and fails as broken GIFs. `pause()`/`play()` re-request nothing. For an animated `<img>` — where no API pauses anything — swap the `src` between `animatedUrl` and `stillUrl` on **one** element rather than rendering two JSX branches, so React reuses the DOM node and nothing reflows.
- **`play()` needs a total guard.** It is specified to return a Promise, but jsdom returns `undefined` (so `.catch` on it throws a `TypeError`) and a synchronous throw is separately reachable under an autoplay-policy refusal. Guard both; a refused start leaves the element paused, which degrades correctly. Do **not** log the refusal — `logBufferService` captures `console.*` into a buffer that reaches a public repo through the feedback pipeline.
- **Do not bump `blob.v` in `preferencesSync.ts`.** `gifPlayback` is additive within `v: 1`. That file rejects a non-`1` blob **wholesale**, so a `v: 2` would silently disable all cross-device theme and layout sync for every not-yet-updated device in the fleet. Accepted consequence: in a mixed fleet an older client rewrites the blob without `gifPlayback` and the key is dropped, recovered from `persist` on the device that set it. The field syncs but does **not** apply cross-device — it inherits `reduceAnimations`'s deliberately-absent `applyRemoteAppearance` entry, and closing that is #1642, not this. Do not describe this feature as cross-device.
- **The setting's chrome is native radios in a `<fieldset>`, not `<button>`s.** `GifPlaybackControl.tsx` + its co-located `.css` are rendered by `AccessibilitySection` between Reduce Animations and Dyslexic Support. The two remaining `<button>` option groups do not give a single choice its semantics, a live WCAG 4.1.2 gap that new controls do not inherit. `.theme-option` is a plain `<button>` collection whose selection lives only in a CSS class: no group role and no state. `.font-option` is partway there: its `<fieldset>`/`<legend>` gives it group semantics, but it marks the pick with `aria-pressed`, which announces independent toggles rather than one choice of N. `.font-size-option` was a third until #2367 rebuilt Font Size as radios when it moved the control to Appearance. The Audio and Video Configuration Basic/Advanced toggles (`.settings-mode-toggle`) had a different wrong shape — `role="tab"` spans in a `role="tablist"`, which announces a tabpanel for what is a persisted setting — and are radios too now. Each of those groups carries its own `name` (`audio-settings-mode`, `video-settings-mode`) because both render on one page: a shared name merges them into one arrow-key group, and a render-only test cannot see it, because jsdom never unchecks the rest of a group when a checked radio is attached, so both groups still read as checked (Chromium would uncheck one). The keyboard-walk test in `VoiceAudioSection.test.tsx` is what catches it. The quality-tier labels above the Audio slider are `<button type="button" aria-pressed>`, like the stop labels of the three sibling sliders (`ChannelAudioQualitySlider`, DM privacy, friend-request privacy); the `<input type="range">` below them holds the value, named "Audio quality" with the tier label as its `aria-valuetext`. A locked premium tier keeps `aria-disabled="true"` and is never natively `disabled` (O1), so activating it by click or keyboard still snaps back to the highest free tier and shows the Premium chip. Settings therefore carries two option-group idioms on purpose; retrofitting the remaining two is out of scope until someone takes it on deliberately. The hint sits in a `role="status"` region referenced by `aria-describedby` because its text changes as a side effect of a *different* control, and it describes the **resolved behaviour** rather than the enum — `'auto'` and `'always'` are behaviourally identical while Reduce Animations is off and the enum alone cannot say so.
- **`file_type` is NOT authoritative for whether an attachment animates — the BYTES are.** `classifyFileType` maps a MIME type to `photo | animated | …` on the uploading client, and that value is **persisted**. Two formats are undecidable from MIME: `image/webp` covers both still and animated WebP, and an APNG is routinely reported by the OS as `image/png`. Both were therefore stored as `photo` and escaped the hover gate and the unfocus pause entirely — and because the value is stored, correcting the classifier would only fix uploads made *after* the fix, leaving every animated WebP already in a channel permanently ungated. `ImageAttachment` therefore sniffs the decrypted bytes (`utils/ui/animatedImage.ts`) and uses `sniffed ?? (file_type === 'animated')`. Three rules if you touch it: read a **bounded prefix via `blob.slice`**, never the whole blob (this path holds a `Blob` precisely so a 256 MiB attachment is never materialised contiguously); return **`null`, not `false`**, whenever the bytes cannot decide, because a false "still" is the exact silent mis-gating the module exists to close; and walk the **PNG chunk table** rather than scanning for the literal `acTL`, which occurs inside compressed image data. GIF is deliberately not sniffed — `image/gif` already classifies correctly and `null` keeps it that way.

- **Accepted and recorded:** refocus restarts an `<img>`-path animation from frame 0. There is no still frame for an E2EE attachment because the server never sees plaintext, and no API resumes an animated `<img>`. Do not add a cross-fade to soften it — a fade implies a continuity this path structurally cannot provide.

## Adaptive sidebar dock (post-#2510, geometry post-#2653)

The four content sidebars (DM Threads / Friends, Server Channels / Members) share one resizable,
pinnable `DockShell`. Below a width threshold each renders a **compact rail** instead of its
standard list. Compactness is derived from width and never persisted.

### Three width constants, deliberately distinct

`stores/ui/layoutStore.ts:29–36` exports three numbers that must never be collapsed into one:

| Constant | Value | Meaning |
|---|---|---|
| `SIDEBAR_COMPACT_BREAKPOINT` | 135 | the standard↔compact presentation boundary |
| `SIDEBAR_MIN_WIDTH` | 44 | the resize floor `clampSidebarWidth` enforces (`:71`) |
| `LEGACY_COLLAPSED_WIDTH` | 56 | the pre-#2653 rail width a legacy `'collapsed'` panel migrates to (`legacyRightDock`, `:149–150`) |

`LEGACY_COLLAPSED_WIDTH` exists because a migrating user's stored intent was "the old rail", not
"the new floor" — pointing that migration at `SIDEBAR_MIN_WIDTH` would silently narrow every
panel a pre-#2653 user had collapsed. A **fourth** 56 lives at `DockShell.tsx:105`
(`RAIL_COMPACT_MIN_WIDTH`, the badge/stroke density band boundary); it coincides numerically and
is a different concept. Do not deduplicate any of these by value.

The breakpoint is the single definition of the boundary: `DockShell` and `preferencesSync.ts:69`
both key on the import, and the three suites that carry it (`DockShell.test.tsx`,
`AppLayout.test.tsx`, `preferencesSync.test.ts`) import the constant rather than restating the
number. **Never find-replace `180` in `layoutStore.ts`** — the `180`/`400` at `:169–174` and the
`160`/`340` at `:182–194` are legacy panel-width *import* ranges that coincidentally equalled the
old breakpoint and the max widths; `layoutStore.test.ts`'s `['below', 179, 159]` case locks them.

### Two layers, two mechanisms

*Which* presentation to render is a **JS** decision on the stored width against the exported
constant, and must stay that way — `preferencesSync` shares the same constant to project
`dock.width` into the legacy `collapsed`/`expanded` fields of the synced preferences blob, so a
CSS-only boundary would leave it with nothing to read. *How big things are* once compact is
chosen is **pure CSS** off `--dock-width`, a custom property `DockShell` publishes on the surface
(`DockShell.tsx:252`) alongside the inline `width` it already sets.

Container queries were considered and rejected for the first layer only (they would dissolve the
shared constant) and are unnecessary for the second (the one-line property suffices). **Do not
read the #2653 spec's container-query rejection as a blanket ruling** — it is scoped to the
presentation decision.

### The rail geometry block

`AppLayout.css:282–339` is the geometry section; the custom properties themselves —
`--rail-gutter` / `-cell` / `-icon` / `-icon-sm` / `-avatar` / `-divider` / `-badge` /
`-badge-font` — are declared **once**, at `:290–306`. `DirectMessages.css`, `MemberList.css`,
`ChannelList.css` and the dock chrome only consume them. Add a new rail size by extending that
block, never by writing a literal into a component stylesheet.

- `--rail-cell: clamp(31px, calc(var(--dock-width) - 2 * var(--rail-gutter) - 1px), 44px)`. The
  `- 1px` is the surface border, and it is what removes the pre-existing 1px horizontal clip.
- **Every derived size is `calc(var(--rail-cell) * <n> / 44)` — length × number ÷ number, valid
  everywhere. Never reintroduce a unitless `--rail-scale` intermediate.** `calc(var(--rail-cell)
  / 44)` divides a length by a *number*, which yields a **length**, not a ratio — so every
  consumer became `20px * 1px`, i.e. length squared, invalid at computed-value time. Custom
  properties are unvalidated at declaration, so this failed **silently at use**: icons, emoji and
  avatars simply stopped being sized, and the `, 36px` fallback below did **not** fire, because
  the property was declared, merely invalid. This is a genuinely non-obvious CSS trap and it
  shipped once already (fixed by `f11d56b08`) — do not re-derive it from the stylesheet.
- The static `.dock-shell__surface { --dock-width: 240px }` fallback (`AppLayout.css:125`) is
  **load-bearing**: if the inline style ever fails to apply, the cell resolves to the 44px upper
  clamp rather than zero.
- `data-rail-density` is `'dense'` when `width < RAIL_COMPACT_MIN_WIDTH` (`DockShell.tsx:105`,
  value 56), `'compact'` at or above, and absent entirely in the standard presentation. The
  constant is named for the band it **opens** because the comparison is `<`: 56 is `compact`, and
  the widest `dense` shell is **55**. Its predecessor `RAIL_DENSE_MAX_WIDTH` asserted an inclusive
  ceiling the comparison never implemented — do not rename it back. The band steps the two values
  that cannot scale continuously: count badges 16px/10px → the channel rail's already-proven
  14px/9px, and lucide `stroke-width: 2.25`.
- **The dense `.lucide` stroke rule is scoped to the seven named rail containers, NOT to the
  surface** (`AppLayout.css:313–326`). "`AttributedPopover` is body-portalled" was true but never
  sufficient: `FriendsList` renders `ContextMenu`, `MemberProfileCard`, `AddFriendModal` and
  `CategoryManagerPanel` **inline**, so a surface-wide `[data-rail-density='dense'] .lucide`
  thickened all four below shell 56. Do not restore the surface-wide form on the portal argument.
- `--rail-avatar` is consumed with a `, 36px` fallback (`DirectMessages.css:97–98`) because that
  avatar rule also applies outside the compact rail, where the property is not declared.

**`--sp` never multiplies rail geometry** — a multiplied cell overflows the physical panel.
`--font-scale` composes on badge *text* only, outside the geometry:
`calc(var(--rail-badge-font) * var(--font-scale, 1))`.

**Never scales:** focus outlines (2px), the active inset ring (2px inset box-shadow), presence
dots (10px + 2px ring), the channel group count box (14px/9px — already at the floor in both
bands), 1px hairline borders, the lip (8×56, `AppLayout.css:380–399`), the resize-handle hit
area, and `.member-compact-grid`'s `repeat(5, 44px)` (body-portalled, outside the surface).

**Byte-identity contract — geometry only:** at any shell width ≥ 57 the compact rail renders with
the pre-#2653 computed **geometry**, and a geometric difference there is a bug. Shell 56 has
exactly one intended geometric delta — the cell computes 43px instead of a 44px box overflowing a
43px content area. That 1px declip is expected; do not file it as a regression.

**Badge text is the second, deliberate carve-out — it is outside the contract.** The DM and
Members count badges moved from a bare `font-size: 10px` to
`calc(var(--rail-badge-font) * var(--font-scale, 1))`, so they match pre-#2653 only at
`--font-scale: 1`. At any other user font scale they differ at **every** shell width, ≥ 57
included. That is intended — the badge renders a numeral, so it is text and should follow the
text scale — and it is what the `--font-scale` composition two paragraphs up already implies.
Read the contract as: geometry frozen ≥ 57, badge text now scales.

### DM↔Server parity is the invariant

Friends and Members present the same vocabulary for the same concepts: the same Offline icon, the
same muted count-badge treatment for an inactive group, search in **both** presentations
(a standard input plus a compact rail trigger opening a left-placed `AttributedPopover`), and
header affordances that do not collide with the dock chrome. A change to one rail that is not
mirrored in the other is a regression of #2510's purpose.

Friends filters **before** the section build, so categories, the Online/Offline built-ins,
pending requests and the compact rail all inherit the term; filtering after the build would leave
sections whose counts disagree with their contents. The header incoming badge stays
term-independent — it is the "you have mail" signal, not a result count.

### Offline reads as inactive, not as a fault

Both rails render `Moon` for the offline group — never `WifiOff` (reads as a network fault) and
never `CircleMinus` (Concord has no `idle` state for `Moon` to collide with, but it does have
`dnd`, which that glyph resembles). `Moon` is also a single continuous path, so it survives the
dense rail intact.

**The two rails' fallbacks are NOT symmetric — parity covers the Offline glyph, not the
fallback.** `MemberList`'s `Users` is the no-emoji fallback for **every** group, role groups
included; only `group.key === 'offline'` takes the moon (`MemberList.tsx:47–51`; role keys are
`role-<id>` and can never match). A blanket swap would moon every role group.

`FriendsList` splits by section *kind* first (`CompactSectionIcon`, `FriendsList.tsx:98–110`):
`pending` → `Clock`; `builtin` → `Users` for `online` and `Moon` for anything else; a no-emoji
**category** → `Folder`, not `Users`. So its offline branch keys on `section.kind === 'builtin'`
rather than on key equality. That is correct today — the only builtin keys are `online` and
`offline`, so a category can never take the Moon — but a third builtin would take it silently.
Do not read "DM↔Server parity" as licence to make either file's fallback match the other's.

The `--offline` badge modifier pairs `--text-primary` on `--bg-tertiary`. Its `:hover` /
`[aria-expanded='true']` rule stepping the fill to `--bg-secondary` is **load-bearing, not
decoration** — both triggers already set their own hover fill to `--bg-tertiary`, so without it
the muted badge dissolves into the button exactly when the pointer is on it.

**Both modifiers opt OUT of the Pride light text-halo with a separate, later-source-order
`text-shadow: none` rule in `pride-flourishes.css` — never with a `:not()` on the halo group
itself.** The halo block exists for dark-on-accent badges; the muted numeral is already light and
the halo would smear it. The `:not()` form is **forbidden**, not merely disfavoured:
`tests/unit/styles/accent-fill.test.ts` pairs each `--accent-fill` text surface with a halo by
canonicalized selector, and a `:not()` appended to the group entry stops the *base* selector
matching, which the test reads as a missing halo. The base badge still carries the accent fill and
still needs its halo; only the modifier does not. A maintainer "restoring the documented
`:not()`" re-breaks that guard — this rule previously described the `:not()` approach, and
`84e207cdc` replaced it for exactly this reason. (Both blocks are cited by selector rather than by
line — they move whenever a flourish is added.) Contrast
against WCAG 2.1 SC 1.4.3 (4.5:1 — the badge renders a numeral, so it is text) is recorded for
all 34 declaration blocks in the #2653 spec §5.1. **Do not re-derive it.**

### The compact rail prefers a configured emoji over a generic glyph

Channel emoji, friend-category emoji and member-role emoji all win over their fallback icon. For
channels the discriminator is **CSS, not TSX**: `ChannelItem` renders both nodes unconditionally,
so `ChannelList.css:839–846` hides `.channel-type-icon` under `:has(.channel-custom-emoji)` and
lets the emoji through at `--rail-icon-sm`. The accompanying `margin: 0` is required — the base
`.channel-custom-emoji` carries a `margin-right` that would push the mark off-centre in a centred
cell. `:has()` is supported in Electron 43's Chromium.

Vitest runs with the default `css: false`, so jsdom applies no stylesheet at all: a `display` or
`visibility` assertion about this rule passes for the wrong reason. Lock the DOM contract in unit
tests (both nodes present for the rule to select between; the accessible name unaffected either
way) and leave the rendered result to the Playwright visual baseline.

### The Friends header is ONE dock row, delivered by a portal

`FriendsFlexSpace` passes `DockShell` a `header` **resolver**. In the standard presentation it
returns an empty `.friends-list-header--dock` host `div` and captures the node in state;
`FriendsList` receives that element as its `headerHost` prop and `createPortal`s its
`[title | actions]` markup into it. The dock therefore renders **one** row —
`[title | actions | pin]`, spec §4 item 2a — rather than floating an actions-only pin over a
second row `FriendsList` draws for itself. The markup stays in `FriendsList` because all of the
state behind it does: the pending badge, the search term that mutes it, and both modals. Do not
"simplify" this by lifting that state into `FriendsFlexSpace`; the portal exists to avoid exactly
that. It is a portal into a dock-supplied host — **not** markup relocated into `FriendsFlexSpace`.

`headerHost` has **three** distinct states and each is load-bearing: `undefined` = not docked
(standalone render, tests) → render the row in flow, as before; `null` = docked but the host ref
has not attached yet → render nothing this commit; an element → portal. Collapsing `undefined`
and `null` renders the row twice or never.

Compact deliberately resolves to `null`: the spec preserves compact behaviour exactly, so the rail
keeps its own action row and the dock header carries only the pin. `null` rather than `undefined`
is also what keeps `DockHeader`'s `headerContent === null && !showPinButton` early-return
reachable (`DockShell.tsx:205–217`) — with `undefined` an interface-locked compact dock renders an
empty padded, bordered strip. Separately, a **non-null** `header` is what drops
`dock-shell__header--actions-only`, the absolutely-positioned overlay that used to collide.

The compact header carries `padding: 6px 0` — **no side padding**. The pin's focus ring draws 4px
outside its box, and at `SIDEBAR_MIN_WIDTH` the row's content box is 43px against a 31px cell, so
a 6px side gutter leaves exactly 0 and the surface's `overflow: hidden` clips the ring. The gutter
is re-homed onto `.dock-shell__header > :not(.dock-shell__pin)` (`AppLayout.css:194–224`), the
only children that ever wanted it. The `h3` carries `title="Friends"` plus `min-width: 0` and
ellipsis so the hard truncation at 135px stays recoverable (SC 3.3.2).

## API

- Fetch with auth token from `useAuthStore`
- Renderer API/WebSocket/media URL construction MUST go through `src/renderer/services/system/runtimeServerBase.ts` (`apiUrl`, `getApiBase`, `getWsBase`, `mediaUrl`, `captureRuntimeServerSelection`, `runtimeServerSelectionIsCurrent`, `setRuntimeServerBase`, `resetRuntimeServerBase`). Async auth/recovery flows MUST retain a `RuntimeServerSelection` and fence every continuation with `runtimeServerSelectionIsCurrent`; comparing only the URL is not ABA-safe. Do not import `API_BASE`/`WS_BASE` directly in auth, recovery, media, websocket, or provider code that must follow a self-hosted server selected at runtime. `API_BASE`/`WS_BASE` remain build-time defaults only.
- MSW for test mocking — not direct fetch mocks
- Handle loading, error, and empty states for all async operations
- Avatar, banner, and server icon fields from `/api/v1/media/*` use `AuthenticatedMediaImage` or `useAuthenticatedMediaUrl`: fetch with the active account session, display a component-owned Blob URL, and revoke it when the account, selected server, or component changes. Do not put a raw server media path in `<img src>`; it resolves against the SPA origin and cannot carry account authentication. External image origins are not loaded by this identity-media path. `resolveMediaUrl` remains for local `data:`/`blob:` previews and non-managed local media sources. See [`.claude/rules/electron.md`](electron.md) §"API URLs … MUST be absolute".
- Group-DM `ConversationAvatar` icons use `apiFetch` on the canonical conversation endpoint (`/api/v1/media/dm-icons/${encodeURIComponent(conversationId)}`) and render a component-owned Blob URL; `iconUrl` is a presence/source marker, not a credentialed destination. Bind request/publication/display to conversation, current user, `authGeneration` and runtime-server selection epoch; abort/revoke on disposal and decode failure. Ordinary bearer/session rotation retains the same owner. The shared identity-image loader does not replace this participant-bound flow.

## WebSocket reconnection resilience (post-#1768)

**A transient control-plane disconnect must not touch the media-plane session.** The control-plane WS drops with 1006 routinely (proxy-edge churn; mitigated server-side by the `heartbeat_ack` data frame, which since #3328 the hub emits UNSOLICITED on its own 54s tick **whenever the socket has been idle since the previous tick** — a socket already carrying traffic gets nothing — as well as echoing each client heartbeat — see `services/control-plane/internal/websocket/messages.go`), and the voice call rides a *separate* socket that stays healthy through it. `useConnectionRecovery` therefore tears voice down (`voiceService.emergencyCleanup()` + `lastVoiceChannelId` capture) ONLY at grace-period expiry (preflight entry — a genuine sustained outage, where continuing the call would mean unbounded staleness against key-revocation/membership events), and the rejoin consumption lives in the `recovery_a`/`preflight` reconnect branch, captured BEFORE `connectionStore.reset()` (which nulls the stash — the pre-fix grace-branch read it after `reset()`, making auto-rejoin dead code). Do NOT move `emergencyCleanup` back into `handleConnectionLoss` — first-1006 teardown destroyed healthy in-progress voice joins on every blip (the 2026-08-21 incident).

The control-plane WebSocket client (`src/renderer/services/messaging/websocketService.ts`) auto-reconnects via an exponential-backoff loop. The `navigator.onLine === false` short-circuit in `createConnection()` (added by #1657) skips the guaranteed-to-fail ws-ticket POST while offline and waits for the browser `'online'` event. But `navigator.onLine` is **NOT reliable in Electron** — it can stick `false` across a server-deploy network flap, and the `'online'` edge can be missed. The offline gate therefore MUST arm a **bounded fallback** (`onlineFallbackTimer`, `ONLINE_FALLBACK_MS`) alongside the one-shot `'online'` listener; when the timer fires it forces a real reconnect via `createConnection(signal, /* forceDespiteOffline */ true)`, bypassing the gate. Without it the client strands in `RECONNECTING` forever and only an app restart recovers it (the #1768 symptom). Do NOT remove the fallback or make the offline gate the sole reconnect path; do NOT "fix" it by simply calling `scheduleReconnect()` from `armOnlineRetry` — that retry re-hits `isKnownOffline()` and re-defers, so the force flag is load-bearing. Both the fallback timer and the listener are cleared together in `clearOnlineRetry()` (called on `disconnect()` and on a successful open) so a torn-down service can't zombie-reconnect.

## Recovery-A teardown is not logout teardown (post-#2199)

`resetService.ts` is a **four-tier** taxonomy, ordered narrowest to widest —
`recoveryReset` → `softRestart` → `gracefulReset` → `nuclearReset`. The tier is chosen by the
**transition class**, not by how much cleanup feels safe:

> **If the account did not change, do not use a primitive that clears account-scoped state.**

- **`recoveryReset()` — same account, same token, transport blipped.** Its only caller is
  `useConnectionRecovery.handleReconnected`'s `recovery_a`/`preflight` branch. It calls
  `e2eeService.fencePendingOperations()` and **clears nothing**. Do NOT add store clears to it,
  and do NOT call `gracefulReset()` from a same-account recovery path — that was the #2199 bug.
  `gracefulReset` clears 22 stores — plus the outbound `MessageQueue`, the search index, the
  friend-eligibility cache and renderer E2EE key custody, which are not stores — while
  `hydratePostLogin` restores 6, and the difference
  included `draftMessageStore` and the outbound `MessageQueue` (**client-authored — no server
  copy exists, so no hydrator can restore them; a "complete Recovery-A hydrator" is not merely
  bigger, it is impossible**) plus `activeServerId` (which bounced the user out of the channel
  they were reading). The fix is subtraction: nothing is cleared, so client-authored state is
  never lost.
- **Authoritative membership + message refresh (#2329).** Preserving state fixes the data-loss
  half, but a WS reconnect replays only subscriptions plus a presence snapshot; it does NOT
  redeliver `member_removed` / `channel_access_revoked` events or messages missed during the
  outage — a server/channel the user was removed from while offline would otherwise stay visible
  until reload, and the active conversation would be missing outage-window messages. So after
  `hydratePostLogin(guard)` the `recovery_a`/`preflight` handler re-fetches both, **session-
  guarded** so an in-flight fetch cannot clobber a newer session on an account switch:
  `useServerStore.getState().fetchServers(guard)` then `useFriendStore.getState().fetchRequests(guard)`
  — both now take an optional `HydrationLifecycleGuard` and re-check `isHydrationLifecycleCurrent(guard)`
  before any committing mutation (`fetchServers` before its `purgeMissingServerState` channel/unread
  side-effects too, not only its `set()`) — followed by a global `connection-recovered` `CustomEvent`
  that `useMessageFetch` listens for and re-fetches the mounted channel under its own
  aborted/channel/E2EE-operation guards (the same shape as its existing `e2ee-key-delivered`
  listener). Memberships refresh **before** the message event so a revoked channel is dropped before
  it would be re-fetched, and `isHydrationLifecycleCurrent(guard)` is re-checked between each step.
  Do NOT add an UNguarded refetch to this path (a bare `fetchServers()`/`fetchRequests()` without the
  guard, or a direct message refetch bypassing `useMessageFetch`'s guards) — that account-switch
  clobber is exactly what the guard threading closes. Regression-locked by the
  `Recovery-A authoritative refresh (#2329)` suite in
  `useConnectionRecovery.recoveryCycles.test.ts` (message backfill, membership purge + new request,
  and two `fetchServers`/`fetchRequests` superseded-guard session-safety cases).
- **Why the missing hydration was invisible.** Nine renderer effects key on `accessToken`, so
  login and session-restore hydrate for free when it transitions `null → value`. Recovery-A's
  defining property is that the token does **not** change, so none of them re-fire — the
  convenience and the bug are the same mechanism. Never rely on an `accessToken`-keyed effect to
  rehydrate a same-account transition. The `grace_period` branch of the same handler is the
  reference shape: it does no reset at all.
- **`recoveryReset` must NOT call `resetPostLoginHydrationLifecycle()`.** The caller's
  `beginPostLoginHydrationGuard()` already invokes it (`postLoginHydrationLifecycle.ts`), and a
  second call would abort the guard it is about to create.
- **`recoveryReset` must NOT clear E2EE keys or `useE2EEStore.ready`.** `handleReconnected`
  gates `validateEpochsOnReconnect` and `processPendingKeyRequests` on
  `e2eeService.isInitialized`, so clearing the service would break the same handler and force a
  full key re-derivation on every blip. Clearing only the store flag produced
  `(ready = false, isInitialized = true)` — the #2199 split-brain, latent because `ready`'s sole
  consumer is the `needsSSOUnlock && !ready` gate in `App.tsx` and `reset()` cleared both flags.
  Leaving both alone makes them agree by construction rather than by a sync step.
- **`gracefulReset()` MUST call `e2eeService.clearKeys()` — every login-screen/reload path clears
  renderer keys (CWE-212).** Before #2199 only `userStore.logout` cleared renderer key custody, so
  a login-screen transition left the prior account's `wrappingKey` and raw base64 `sessionKeys`
  resident. The fix lives in `gracefulReset`, not `nuclearReset`, because **all** of gracefulReset's
  callers reach the login screen (`apiClient.handleRefreshFailure` `rememberMe=true` refresh
  failure; `App.tsx` session-restore failure) or a full renderer reload (`softRestart`), and
  `nuclearReset` calls `gracefulReset` — so putting it there covers every path at once. Putting it
  only in `nuclearReset` (the first cut) missed the common `rememberMe=true` case, which uses
  `gracefulReset` (Codex #2327 review). `clearKeys()` is **renderer-only** — it does not touch the
  safeStorage `secure-e2ee.dat` or the main-process in-memory copy, so a `rememberMe=true`
  next-launch restore and a `softRestart` soft-reload both re-derive keys normally;
  `tokenManager.clearTokens()` (nuclearReset-only) wipes the main+disk halves. This is safe ONLY
  because `recoveryReset` — the sole same-session continuation — does NOT call `gracefulReset`;
  before the recoveryReset split, gracefulReset had to preserve keys for the old Recovery-A path.
  Do NOT downgrade `gracefulReset` back to a bare `fencePendingOperations()`, and do NOT route a
  same-account recovery through `gracefulReset`.
- **The float-vs-phase ordering is deliberate, not a bug.** `handleReconnected` floats the
  reset+hydrate and flips `connectionStore.phase` to `stable` synchronously. A genuine
  authoritative refresh failure means the session is dead and hydration is moot, regardless of
  the transport-recovery phase, so `apiClient` routes it through the remember-me-aware
  `gracefulReset` / `nuclearReset` contract. `main.tsx` eagerly registers those synchronous reset
  callbacks; auth-lifecycle checks before and after reset keep a stale failure from clearing a
  successor session. `clearAccessToken()` trips the
  hydration guard's authStore subscription, which aborts the continuation cleanly. Do NOT "fix"
  this by moving `connectionStore.reset()` into the floated callback — post-#2199 the UI is already
  usable during hydration, so that would strand the recovery overlay over a working app if
  hydration never settles.

Regression-locked by `tests/unit/hooks/useConnectionRecovery.recoveryCycles.test.ts` (the real
`recoveryReset` against real stores, 5 consecutive cycles — verified to fail when reverted to
`gracefulReset`) and the `recoveryReset (#2199)` / `nuclearReset E2EE key custody (#2199,
CWE-212)` suites in `tests/unit/services/resetService.test.ts`. Founding incident:
#2199, surfaced by the
#1234 review
(PR #2191). Design:
`2026-07-16-2199-recovery-a-rehydration-design.md`.

## Step-up refusal surfaces (MFA settings, purge, post-#2765 Phase-8)

Every step-up-gated route (`internal/stepup`, see `.claude/rules/backend.md`) is read by
`classifyStepUpRefusal` (`services/system/stepUpRefusal.ts`) — the ONE parse of the wire body,
shared by the MFA settings actions (`mfaStepUp.ts`), the recovery-key first-store retry
(`MFASetup.tsx`), the purge-fence toggle (`privacyStore.ts`) and the DM purge (`purgeApi.ts`).
Four independent copies of this parse used to drift; a fix to one (a new status, a new flag) left
the others reading the old contract. It adds `unavailable` (503, the budget could not be
evaluated) and `inlineFactorRequired` (409, D1) to the existing kinds, and carries the server's
`message` on `failed` rather than discarding it.

Every Family-A surface collects its credentials through the shared `StepUpCredentials` stage
(`components/Auth/StepUpCredentials.tsx`, state from `hooks/auth/useStepUpFactor.ts`), both
soft-locks included: the MFA settings actions (#4, #5, #6, #9, #10), the three session
revocations (#7), backup-code regeneration (#8), the DM/group purge step-up (`PurgeMessagesModal`,
`dm.purge`), the purge-protection disable dialog (`PurgeFenceStepUpDialog`,
`privacy.purge_fence_disable`), DM Clear (`DMThreadRemovalDialog`, `dm.clear`), the message-delete
soft-lock (`DeleteRefusalModal`) and the channel/server purge soft-lock (`SoftLockStage`).
The dangerous-action (D1) hosts and the MFA-enforcement toggle (#3456) collect theirs through
`DangerousActionStepUpDialog`, one wrapper over the same stage (see the "Dangerous-action"
bullets below): delete channel (`DeleteChannelModal`, `channels.delete`), delete server
(`DeleteServerModal`, `servers.delete`), ban and kick-with-purge (`purgeOnModeration`,
`members.ban`, `members.kick_purge`), delete role (`RoleDeleteFlow`, `roles.delete`), role
create/update (`RoleEditorPanel`), channel and category override upserts (`OverridePanel`),
Server Settings save (`ServerSaveStepUpDialog`, `servers.update`), server icon and banner upload
(`ImageCropEditor`), shorten retention (`MessageExpirationEditor`,
`channels.expiration_shorten`), and the toggle's OFF (`MfaEnforcementSetting`,
`servers.mfa_enforcement_disable`). A channel or server purge refused by its D1 gate is the
exception: it does not use the dialog but opens the `'mfa'` stage inside `PurgeMessagesModal`,
which mounts the same stage on its own `dangerousFactor` instance. That stage words the answers
the dialog words in the same sentences and keeps the chosen range: a flagged 429 (the spent
budget) shows one banner and locks its primary with focus on Cancel, and a 503 shows
`STEP_UP_RETRY_TEXT` with a live retry. The soft-lock stage still ends in a result on both.
The role editor runs one write at a time: `startWrite` ignores a second write while one is out
or its dialog is up, and the rail's create control is `aria-disabled` (still focusable, guarded
click) meanwhile. Its "Set up verification" asks to discard whenever the open role form differs
from the selected role (`formIsDirty`), from the write dialog and the delete flow alike.
A re-sent retention change goes through `updateExpirationPolicy(scope, request, context)` against
the dialog's capture, and an unsent request is `aborted`, not `ambiguous`. A plain 403 to that
re-send closes the dialog and leaves the editor's own lock as the one visible refusal.
The retention handoff also binds its session key to the displayed policy's revision, window and
backfill state. A changed baseline abandons the pending step-up; consent from the previous policy
cannot resend a shortening after the new policy reaches the editor. Retain the staged window for
fresh confirmation unless the new policy already applies it; account or scope changes discard it.
`MFAVerifyPrompt` and `StepUpFields` are deleted. Family B (the sign-in challenge: `Login.tsx`,
`MFAChallengeModal.tsx`) still uses `MFAMethodPicker`, `WebAuthnPrompt` and `BackupCodeInput`
directly. There, backup codes belong to the authenticator app, so `getAvailableCategories` offers
them only when `methods` names `totp` (picker spec C16, C50; #3567): a sign-in challenge leaves a
recovery-only TOTP out of `methods` and its backup codes go with it, and `totp` itself is kept when
excluding would leave nothing. The shared step-up stage does not use it; its offered set comes from
`GET /api/v1/mfa/step-up`.

**Pin-aware message expiration (#3459).** The retention editor gains a staged "Include
pinned messages" switch, and every retention surface learns one more fact: whether pins
expire with the rest. The field is `ExpirationPolicy.includePinned?: boolean` (the server's
EFFECTIVE value; `undefined` means "the server did not say", which is not `true`).
`PinnedRetentionOption` renders only when `isPinnedRetentionAvailable` holds: the policy is
`ready` (a refresh that keeps a held policy counts as ready, and draws the switch locked rather
than unmounting it, so a focused switch keeps focus; a switch that does unmount while focused
hands focus to the active window stop), `typeof policy.includePinned === 'boolean'`, the shown window is non-null, and
`useExpirationPinnedPolicyUnsupported()` is false. That selector reads `features.expirationPinnedPolicySupported` and
**fails open**: it is true only for a capabilities payload that parsed and did not state
`true`, so a fetch still loading or failed leaves the control available, following the
`mfaEnforcementCapability` precedent. The capability is a UX gate; an older server answers the
field with a 400 and mutates nothing. The switch is staged like the window stops (the same
fresh-read, baseline and revision fence), uses `aria-disabled` and a guarded `onChange`
rather than native `disabled`, and **`include_pinned` is sent only when the person changed it**
(`includeToSend`; a window-only change omits it, so the server keeps an existing timer's value).
The `set` request schema takes it as `z.boolean().optional()`, never nullable, and `clear` and
`resume` refuse it. Apply routes by what changed: a window change keeps its confirmation plus one
pin line, pins turning ON open their own `ConfirmActionModal` ("Expire pinned messages too",
confirm label "Expire pinned messages", with the existing acknowledgement checkbox), and pins
turning OFF delete nothing and apply at once. **What the pin copy may claim follows the
retroactive mode:** only "Apply to existing messages" restamps existing pins under the new window,
so only then does the pin line say "any older than <window>"; under "Only new messages", and in the
pins-only confirmation (which is `new_only` by construction), each kept pin gets back the stamp it
was parked with under whatever window was in force, so the copy says pins "whose timer has already
run out". While a direct apply is out (`applying`), the stops and the switch are locked
(`stageable`): a change staged then would move `operationRef` past the request, and the editor would
drop an answer the store still commits. While a refresh keeps the held policy (`loading` with a
policy present), the view keeps describing that policy (`viewState`) so an open confirmation does not
retitle itself; `editable` and the switch's render gate still read the real state. The step-up dialog keeps purpose
`channels.expiration_shorten` and only its intro and primary label vary (`stepUpCopy`), with the
frozen request keeping `include_pinned` on the re-send. The handoff's session key carries the
policy identity (#3717), so if another manager moves the window or the pin switch while the dialog
is up, the dialog ends and the code-carrying re-send is never sent. Status text lives in an always-mounted
`<output>` (its native role is status), and the OFF sentence is hedged ("may still be deleted in the next few
minutes") because a stamp already due is not rescued. An announcement speaks for the revision and pin claim its
answer carried: an answer older than the policy already shown says nothing, and a newer revision
landing afterwards clears it, as does the same revision arriving with a different or absent claim
(the X14 equal-revision drop after a rollback).

The composer clause is **one sentence**: `expirationClause` appends `", except pinned messages"`
when `includePinned === false` and a window is set ("Messages are Encrypted End-to-End and expire
after 24 hours, except pinned messages"), and the backfill qualifier stays last. `true`, an
absent field and a null window add nothing, and `unavailable` still returns null: pins are
claimed as kept only from a server-sent `false`. `mergeExpirationPolicy` has a drop-only rule at
an EQUAL revision (X14): an incoming policy whose `includePinned` is `undefined` drops the
current one's claim and keeps the rest of the current policy (a stale pending read must not undo a
completed backfill), because after a rollback the older server answers at the same revision
without the field, and a held "except pinned messages" would outlive the binary that deletes
newly pinned rows. Presence is never added at an equal revision, and that includes the older
exception that lets a completed backfill replace a pending one: when the pending policy had no
`includePinned`, the completion is taken without its claim. Both pinned panels
(`PinnedMessagesPanel`, `DMPinnedMessagesPanel`) render `PinnedKeptNote`, one static sentence
("Pinned messages are kept. Unpinning one puts it back on the timer, and it's deleted within
minutes if its time has already run out."), under the same rule (`pinnedKeptNoteVisible`):
nothing for an unavailable policy, an absent field or no window. The owners (`ChatView`,
`DMChatArea`) pass the policy in; the panels do not fetch. The system row
(`MessageExpirationEventMessage`) keeps its fact-first, attribution-in-`<bdi>` structure: a
`changed` event whose `previousWindowSeconds` equals the window is a pins-only change and reads
"Pinned messages now expire after 24 hours" or "Pinned messages are now kept" under the `Pin`
glyph, and a set or change under `false` reads "Messages now expire after 24 hours, except
pinned messages". A live frame and a durable row carry the same three optional fields
(`include_pinned`, `previous_include_pinned`, `previous_window_seconds`), copied only when sent.
An unknown `previousWindowSeconds` is never read as equal. **The UI copy (both confirmation
variants, the step-up intro and labels, the status sentences and the panel note) was authored
without a `frontend-designer` handoff file**; the design is in
`docs/superpowers/specs/2026-10-09-3459-pin-aware-expiry-design.md` §11. The composer wording
and the fact-first system row deliberately differ from the issue's examples (a second sentence
"Pinned messages are kept." and attribution first); see the CHANGELOG entry.

- **`submitMfaStepUp`** (`mfaStepUp.ts`) is the one submit path for the six MFATierSelector
  actions and the other seam handlers (`MfaSeamHandler`). It returns an `aborted` kind, distinct
  from `networkError`, when the request refused to dispatch because the account or server
  selection changed under it: nothing was sent, so nothing is reported as a network failure. Its
  `context` option binds the request to the capture of the `run` that called it
  (`apiFetchInContext`), and `MfaSeamHandler` makes `context` a required trailing argument, so no
  seam handler can send outside the run's capture (C82). `toStepUpSubmitOutcome` maps the result
  into the hook's terms: the four field refusals, `enrollmentRequired`, `rateLimited` and
  `sessionExpired` go to the hook as refusals; every other answer is `answered`, because the code
  may be spent.
- **`codeField`** (`submitMfaStepUp`'s options) exists because `POST /mfa/totp/disable` predates
  the seam and binds the code as `code` rather than `mfa_code`; every other seam route uses the
  default. #8 (`POST /mfa/backup-codes/regenerate`) binds `code` too.
- **One purpose per route.** `StepUpCredentials` takes a `purpose` (`StepUpPurpose` from
  `components/Auth/stepUpPurpose.ts`, mirroring the server's `stepup.Purpose` values the renderer
  uses). Begin sends `{"purpose": purpose}` and the server accepts the minted WebAuthn token ONLY
  on that route (#3453 RS11), so a surface names the request its code is actually sent with: per
  ACTION where one stage serves several (`MFATierSelector`'s `actionPurpose`, `MFASetup`'s
  TOTP-setup vs key-register step, the three sessions routes). `purpose: null` only where the
  route takes no inline token, and then no read runs and no security key is offered. #8 is
  `purpose: null` with `floorMethods: ['totp']`: it checks an authenticator-app code and nothing
  else, so it also sets `allowBackup: false` and sends the code as `code`. `reset-totp` is
  `floorMethods: ['totp']` with purpose `mfa_settings.totp_disable`, so the read may add a key,
  and also sends `code`. `revoke-webauthn` verifies the password only: `enabled: false`. With no
  factor hook to bind it, its modal captures the request context when it opens, and a stale
  capture ends in `sessionExpired` with nothing sent.
- **`floorMethods`** are offered whatever the read or a refusal says, and `offered = floor ∪ read`
  (C4, C26). A failed read leaves the floor, and a re-read never removes a floor member, so a
  `ready` read with `methods: []` cannot empty #8. With `purpose: null` there is no read.
- **`seed` and G2.** A refusal-triggered surface (single revoke #7, the delete and purge
  soft-locks) passes the refusal that opened it as `seed`. The hook reads `seed` ONLY when an
  instance starts, so the seed must reach the hook in the same render that sets `enabled`: an
  imperative call in the enabling commit would be erased by the instance reset. `mfaRequired`
  seeds `intersectInline(methods)`; `methods: null` seeds nothing; `passwordRequired` on a
  `whenNoMfa` leg seeds `[]`; `enrollmentRequired` is terminal at once. A `ready` read replaces a
  seeded set. `unavailable` and `unsupported` keep it, with its strongest member as the default
  and no backup code (G2).
- **The #7 and #8 route adapters** (`services/system/stepUpRouteAdapters.ts`:
  `adaptSessionsRefusal`, `adaptBackupCodeRegenerateRefusal`) read routes that predate the seam
  and write their own bodies, so they bypass `classifyStepUpRefusal`. Each matches its route's
  strings EXACTLY (`===`, never `includes` or case-folded) and returns `null` for every response
  it does not own, so the surface's own handling runs instead of a guess; rewording a server
  string degrades to `null`, never to a factor error on the wrong field. #7 reads
  `authenticateForRevoke`: `auth_required` becomes `mfaRequired` with `methods: null` because its
  list is `users.mfa_methods` and is never read (C2); `password_required`, `Incorrect password`,
  `Invalid MFA code` and a 401 map to their kinds. #8 reads `RegenerateBackupCodes`:
  `Incorrect password` and `Invalid TOTP code` map to field refusals, `TOTP is not enabled` is
  `null` and `BackupCodeRegenerateStage` matches that exact 400 to its terminal `totpRemoved`
  result itself (no in-band sentinel), and the missing-field 400 is `failed`. On both routes a 429
  (the `RateLimitByUser` limiter, which answers before the handler reads anything) is
  `rateLimited`, which proves the code was not spent, and a 401 is `sessionExpired`. A #8 200 without a non-empty `backup_codes`
  list is `failed`, never an empty success: the old codes may already be gone. No #7 dialog reads
  `mfaMethods` or `hasMFA`: revoke-all and the mode change enable the hook when the modal opens
  (`whenNoMfa`, read-driven), so an email-only account gets the password field. The #7 dialog is
  keyed by its action (`sessionStepUpKey`), and a refusal that lands while one is open is ignored
  rather than re-pointing it at another session. Single revoke's credential-free DELETE is sent
  under a capture, and its answer opens the dialog, sets the banner or applies the revoke only
  while that capture is current.
- **The enrolment state.** A 403 with `mfa_enrollment_required: true` (a server that enforces MFA
  and an account with no inline factor) is matched first in `classifyForbidden`, with or without
  `delete_rate_limited`, and becomes the hook's terminal `enrollmentRequired` status.
  `StepUpCredentials` renders "Set up an authenticator app or security key in Settings to do
  this." with no input, no Retry and no `role="alert"`; the primary is `aria-disabled`, focus goes
  to the heading, and nothing takes danger styling. `ErrorBanner` returns null for it
  (`stepUpBanner`), because a banner would say it twice. It is never routed to `failed`. A host
  that passes the optional `onSetUpVerification` prop gets one more control: a "Set up
  verification" button (`step-up__link`) after the sentence. Focus still goes to the heading, so
  the sentence is read before the button is reached. Without the prop the markup is unchanged,
  so a host that does not pass it renders exactly as before. The hosts that pass it are
  `DeleteRefusalModal`, both purge stages and `DangerousActionStepUpDialog` (for every D1 host
  and the toggle's OFF); the toggle's inline enrolment note carries the same button. The button
  acts only through `factor.confirmCurrent(capture)`: while the account and server the stage
  opened for (and the host's `capture`, when it passes one) are current. After a change it ends
  the stage as `sessionExpired` and calls nothing, because the enrolment state is terminal and
  stands through a switch, and a click would otherwise write a return slot naming the previous
  account's server into the next session.
- **`openVerificationSetup`** (`utils/ui/openVerificationSetup.ts`) is what those buttons call.
  In order: (1) await the caller's `confirmDiscard`, if any, **while the host dialog is still
  open**, so a declined discard returns with nothing closed (D-4); (2) call the caller's
  `closeHost`; (3) `openSettings('app')` and `requestFocus('security', 'section-mfa')`; (4) record
  `returnTo` in `settingsOverlayStore.verificationReturn`. Only Server Settings hosts pass
  `confirmDiscard`, and every one of them asks about the WHOLE page, not just its own form:
  General's name, icon and banner are page state, so they outlive a switch to Roles or Members,
  and leaving from either section drops them. `ServerSettingsPage` passes its own `confirmDiscard`
  to `MemberListPanel` (and on to `ModerationDialog`), and its `pageIsDirty` predicate to
  `RoleEditorPanel`, which folds it into the panel's one question with its own form, so the person
  is asked once, never twice. It resolves false, and opens nothing, after a declined
  discard or when the account or server changed while the discard was asked. The gated action is
  abandoned and never retried on return: a frozen destructive request must not outlive a
  Settings excursion, so the person repeats it. **Never close the host before the guard
  resolves.**
- **The return slot is one-shot and in memory.** `verificationReturn` is `{kind:'chat'}` or
  `{kind:'serverSettings', serverId, section}`. It is never persisted, is dropped when the
  overlay closes, and is cleared by `gracefulReset`. When a TOTP or key setup completes in
  Security while it is set, `VerificationReturnButton` shows one "Back to …" button;
  `returnFromVerificationSetup` takes the slot (so it acts once). **Both returns leave App
  Settings, whose draft layer goes with it, so an unapplied change holds the return** exactly as
  it holds "Back to app": while `hasPendingDrafts` (`draftSettingsStore`, the predicate
  `useDraftActions` reads too) is true, nothing is taken and nothing closes, and the button is
  `aria-disabled` with "Apply or revert your settings changes first." as its description; the
  Apply/Revert prompt is already on screen. A change made during the Server Settings refetch puts
  the slot back and holds too. "Back to chat" closes the
  overlay. "Back to Server Settings" **refetches that server's permissions through
  `fetchServerPermissions` before reopening** (D-6): the permission events refresh only the
  active server, and Server Settings can be open for another one, which would otherwise come back
  on the masked snapshot taken before setup. A failed refetch still reopens it. An account or
  server change during the refetch reopens nothing. Closing or replacing Settings during the
  refetch cancels the return before it can reopen the old page or restore its target over a newer
  excursion; the consumed overlay snapshot must still be current. **Neither return leaves focus on
  `<body>`**, though the button that held it unmounts in both. "Back to chat" closes the native
  dialog, whose own focus return has nowhere to go because its invoker (the step-up link) is gone,
  so `SettingsOverlayHost` focuses the composer, then the channel list, then the server rail, after
  any close that left focus on `<body>`. "Back to Server Settings" swaps the page inside a dialog
  that is already open, so `ServerSettingsPage` focuses its active section's nav item when it
  mounts with nothing focused. Opened any other way, focus is already somewhere and stays.
- **Dangerous-action hosts share `DangerousActionStepUpDialog`**
  (`components/Auth/DangerousActionStepUpDialog.tsx`), a `ui/Modal` at `width="small"` titled
  "Confirm it's you" (constant: the title is the `aria-labelledby` target). It wraps
  `StepUpCredentials` + `useStepUpFactor` with `passwordLeg: FACTOR_ONLY_LEG`,
  `readFailure: 'passwordOnly'` and `allowBackup: true`, and a `seed` from the refusal that opened
  it (none for the toggle's OFF, which prompts before it sends). The host owns the request:
  it freezes what it sent first (`FrozenRequest`, `services/system/dangerousActionRequest.ts`)
  and `send(mfaCode, context)` resends exactly that plus `mfa_code`; it never re-reads its form.
  The first send carries no code. `sendFirst` returns the adapter's `mfaRequired` or
  `enrollmentRequired` to open the dialog; any other refusal throws the server's sentence for
  the host's own modal. A request the server never gates (a plain kick) passes `gated = false`,
  so only the enrolment refusal opens the dialog for it.
- **The first send's capture is the dialog's (C82).** `sendFirst` takes
  `captureApiRequestContext()` before it sends, sends through `apiFetchInContext`, and returns
  that capture with the refusal. A verification refusal that lands once that account or server
  is no longer current throws `FIRST_SEND_SESSION_CHANGED` and opens no dialog. The host keeps the
  capture in its pending state and passes it as the dialog's `capture` prop, which goes to
  `stepUpActivation` and `StepUpCredentials`, so the re-send and "Set up verification" work
  against the account and server the first send went out as, never one the dialog opened under
  later: account A's frozen request must never go out with account B's token and code.
  `updateServer` and `ImageCropEditor`'s upload do the same, and so do the role and override
  writes: `permissionStore`'s `sendWrite` captures before a code-less first send and returns the
  capture on every `refused` outcome, `stepUpSeedOf` (`services/system/permissionWriteStepUp.ts`)
  hands back `{ refusal, context }` only while that capture is current, and `failureTextOf` words
  a stale verification refusal as `FIRST_SEND_SESSION_CHANGED`. `RoleEditorPanel`,
  `RoleDeleteFlow` and `OverridePanel` keep the context in their pending state and pass it as
  `capture`. `PurgeMessagesModal` does the same for the stages a purge challenge opens: the
  `'mfa'` and `'softlock'` stages, and the DM `'stepup'` stage when a refusal opened it, keep
  `runPurge`'s capture (`stageCapture`) and pass it to `stepUpActivation` and `StepUpCredentials`;
  the DM stage opened before anything was sent takes none, because its hook's own capture is the
  right one. `MessageExpirationEditor` sends its first shortening PATCH against a capture it takes
  first, refuses a challenge that lands after a server change with `FIRST_SEND_SESSION_CHANGED`,
  and keeps the capture in `PendingShorten`. The message-delete path does the same through the
  controller: `useChatController`'s `sendDelete` captures before a fresh delete, a refusal that
  lands after an account or server change fills no slot, and `DeleteRefusalState.context` (the
  first refusal's, kept across retries) is what `DeleteRefusalModal` passes to `stepUpActivation`
  and `StepUpCredentials`. Every host that opens a step-up from a refused send follows this rule;
  a host that prompts before it sends (the toggle's OFF) takes none. Hosts never capture after
  the answer lands. Everything the dialog words or acts
  on comes from that pending state, never a live prop: the delete hosts freeze the target's id
  and name (the intro and the store removal), the Server Settings save its `serverId`, the
  upload its endpoint and `extraFields`, and the role create its generated default name
  (`RoleEditorPanel` builds the request once per create, so a role another administrator adds
  while the dialog is up cannot rename what was verified).
  A host whose request carries a claim of its own passes a `dispatch` to `sendFirst` and
  `resendWithCode`. Ban and kick-with-purge route BOTH sends through `sendPinClaim` (#3458):
  - a purge that promises to keep pins is rechecked before the code-carrying re-send, exactly as
    before the first send;
  - `include_pinned` and the pin mode are frozen in the pending action with the rest of the
    request;
  - a refused claim sends nothing: the first send throws `PIN_CLAIM_UNCONFIRMED_MESSAGE` into the
    confirmation, and the re-send returns it to the dialog as a status-less refusal, which the
    banner words.
- **The `'none'` leg and `FACTOR_ONLY_LEG`.** `StepUpPasswordLeg` is `'always' | 'whenNoMfa' |
  'none'`. `'none'` never shows a password field, because no D1 gate and not the toggle reads a
  password. Hosts pass the exported constant `FACTOR_ONLY_LEG`, not the quoted literal, for the
  reason `LEG_ONLY_WITHOUT_MFA` exists: a literal assigned to a name matching "password" trips
  SonarQube S2068 and detect-secrets. A `passwordRequired` or `invalidPassword` refusal or seed
  on this leg takes the default arm (the code is spent, no notice, the host words it) and never
  the `missing: password` arm, which would aim focus at a field that is not there. With
  nothing offered and status `ready`, the primary sends with no factor: a code-less request is
  not charged against the budget, so the server's answer decides (`mfa_required` mounts the
  picker, `mfa_enrollment_required` ends in the enrolment state), and the client never predicts
  the refusal.
- **`adaptDangerousActionRefusal`** (`stepUpRouteAdapters.ts`) is a route adapter, not new arms in
  `classifyStepUpRefusal`, because the classifier maps 429 and 503 by status alone and its four
  existing consumers depend on that. The adapter owns a 429 only with
  `step_up_budget_exhausted === true` (`rateLimited`; the code was not spent) and a 503 only with
  `step_up_budget_unavailable === true` or `lock_conflict === true` (`unavailable`). A 403 goes
  through the classifier and passes `enrollmentRequired`, `mfaRequired` and `invalidMfaCode`
  through; `deleteRateLimited`, `passwordRequired`, `invalidPassword` and `failed` return `null`,
  since no D1 gate produces them. A 401 is `sessionExpired`. Everything else, including an
  unflagged 429 or 503 (the gated route's own limiter or failure), is `null`, and the host's
  own mapping runs. Do not add substring matches or fold the flags into the classifier.
- **The swap rule.** A host that already confirms in a `ConfirmActionModal` (delete channel,
  delete server, delete role, ban, kick with purge, shorten retention) does not open the dialog
  over it. `ConfirmActionModal` closes itself in the continuation that resolves `onConfirm`, so
  the host's `onConfirm` records the refusal and resolves, `isOpen` goes false for the
  confirmation, and the dialog renders in its place. `useStepUpHandoff` carries the mechanics:
  `handOff` flags the confirmation's own close synchronously so `confirmClosed` swallows it and
  the pending action survives (it must not run the host's end), and `ending` is true for the one
  commit between the dialog closing and the host's `onEnd`, so a host that opens its
  confirmation on `pending === null && !ending` does not flash it back open. `endStepUp` calls
  `onEnd` one commit later, so a host its parent unmounts on `onEnd` does not take the dialog
  with it before the dialog's focus fallback runs. Hosts with no confirmation (role save, override
  upsert, Server Settings save, toggle OFF) open the dialog over themselves; `ImageCropEditor`
  nests it over its own modal. On close, focus goes to what opened the dialog if it is still
  connected, else to the host's `focusFallback` (channel list, server rail, role list, the
  switch), never `<body>`. `focusTargetIn` returns only an element that can take focus: not
  disabled (a disabled fieldset included), not inside `[inert]`, and rendered
  (`checkVisibility`, where the environment has it).
- **The dialog locks on a rate limit and cannot be cancelled mid-flight.** A `rateLimited` answer
  locks the primary (`aria-disabled`, guarded click) until the dialog is reopened and moves focus
  to Cancel, because no retry can pass until the budget resets. Cancel is natively `disabled`
  while `phase === 'submitting'`: `Modal`'s `dismissable` covers only Escape, the backdrop and the
  built-in close button, and a destructive request the server may already have accepted cannot be
  undone by closing the dialog. A security key's ceremony leaves Cancel reachable until the request
  goes out, so a layout effect moves focus from Cancel to the (`aria-disabled`, still focusable)
  primary as `submitting` starts; Chromium would otherwise drop it to `<body>`. `unavailable`, an
  unowned refusal and an `aborted` send (nothing went out, `STEP_UP_RETRY_TEXT`) show a banner
  and focus the primary, since a retry is one click. After `unavailable` the code is cleared as
  possibly spent and the TOTP "just used" hint shows, so the primary waits for the next code: the
  adapter folds the budget's 503 (charged before any verify) and the lock-conflict 503 (which can
  land at commit, after the code was verified) into one kind, and the hook takes the safe reading
  of both. A new activation clears the previous
  attempt's banner, so an attempt that ends without reaching `submit` (a cancelled key) never
  leaves an older sentence beside its own. `sessionExpired` shows no banner: the stage's terminal
  state says it. `onSuccess` runs only while the request context is still current, and an answer
  of ANY kind that lands once it is not ends the stage as `sessionExpired` (`outcomeUpdate`)
  rather than returning to a live code field for an action that may already have gone through.
- **The step-up budget and how to reset it locally.** A D1 gate and the toggle's OFF share the
  MFA-settings budget, 5 attempts per 15 minutes per user, charged only when a request carries a
  code. A code-less first request costs nothing, and a verified success clears it. Testing the
  gates repeatedly locks you out; reset with `redis-cli DEL stepup:mfa_settings:<userID>`.
- **The toggle** (`MfaEnforcementSetting`, mounted at the end of General in Server Settings;
  state in `useMfaEnforcement`). **Visibility comes from `GET /servers/:id/mfa-enforcement`:**
  pending renders nothing, 200 renders the switch, 403 or 404 renders nothing (not the owner or a
  raw-bit Administrator, or a server that predates the route), and any other failure renders a
  row with no value and Retry. **Enrolment comes from `GET /mfa/step-up`**
  (`fetchStepUpRequirements`), never `/mfa/status`, and is read only once the switch is shown:
  `ready` with no usable method is unenrolled, `ready` with methods is enrolled, and every other
  outcome is unknown. ON is refused up front only when the account is KNOWN unenrolled or the
  server is KNOWN too old; unknown leaves it live, because the server decides. ON is
  `aria-disabled`, not `disabled`, so it stays in the tab order and names why. ON sends no code
  and is not optimistic: the value changes on the server's 200. OFF always opens the dialog first.
  The component re-reads on `server_permissions_changed` for its server through the same jittered,
  coalesced `createJitteredRefetch` the permission refresh uses (§3.8), cancelled on unmount, a
  server change and an account change, and re-reads enrolment on `permissions_changed`. A read
  that lands for an account no longer signed in is dropped. A refused ON restarts the read it
  aborted, and an ON error is cleared by a later read that finds the setting ON (not by one that
  finds it OFF, nor by the read the failure itself starts).
- **`mfaEnforcementCapability` has four states**, like `chunkedUploadCapability`: `loading`,
  `supported`, `confirmed-unsupported` and `error`. `ServerCapabilitiesSchema` declares
  `features.mfaEnforcedDangerousActions` (zod strips an undeclared key, so without the line it is
  unreadable). Only `confirmed-unsupported`, a payload that parsed and lacks the key, disables ON
  and says this server version cannot require MFA yet. `loading` and `error` leave ON live: a
  transient capabilities failure must not claim the server is too old. OFF stays available in
  every state.
- **The set-up state outside Server Settings** reaches only the **active** server.
  `permissionStore.mfaRestrictedByServer` is written only by `fetchServerPermissions`, from
  `mfa_restricted` on `GET /servers/:id/permissions` (stored only when true; not persisted, not
  logged, cleared on `reset`). `MfaRestrictedNotice` (a banner under the channel-sidebar server
  header, dismissible per server for the app session through
  `settingsOverlayStore.dismissedMfaNotices`) and `MfaRestrictedMenuItem` (in the server, channel
  and member context menus, not dismissible) read it. The route is not fanned out, so a masked
  member of a server that is not active sees no item until it is opened. The masked owner or
  Administrator cannot open Server Settings, which is why both live outside it. The second source
  is reactive and is not this flag: a `mfa_enrollment_required` refusal from a gated action puts
  the dialog or stage into its enrolment state, with the same link, and sets nothing in the
  store.
- **SMS reads "Coming soon".** The offered set never contains email or SMS, even from a refusal
  that lists them. #9 sends `methods: ['email']` and has no SMS control; the tier card's SMS
  stays "Coming soon" and cannot be selected.
- **`preparing` is a hook input** (#6 recovery-key replace, #10 Recovery Circle). A host that
  prepares before it sends (the key material, the Shamir split and public-key fetches) takes
  `captureApiRequestContext()` when the step opens, starts preparing then, and passes `preparing`
  to the hook; `firstMissing` reports it last, so the primary stays `aria-disabled` and the guard
  shows "Getting things ready…". `stepUpActivation(…, { capture })` then calls
  `run(submit, capture)` (C82), `submit` only transmits, and the click handler awaits nothing
  before `run`. Awaiting preparation inside `submit` would start the ceremony late and lose the
  user-activation window. `preparing` is not part of the instance key, so toggling it never
  resets the dialog. MFASetup's first recovery-key store, after the TOTP confirm, also captures
  before it reads the keys and sends under that capture. #10's preparation takes an
  `AbortController` that its effect aborts on unmount, and it zeroes the exported PKCS8 bytes,
  each plaintext share and each share's raw AES key once they are used.
- **`focusOnReady`** is for a dialog that opens straight onto step-up: when the opening read first
  lands `ready`, focus goes to the password field if one is shown, else to the active panel. It
  fires once per instance, only while focus is still unclaimed (the dialog, the heading or
  nowhere), and never on a later re-read.
- **A WebAuthn 429 is a notice, not a key error.** A 429 from inline begin or finish becomes the
  hook's `webauthnRateLimited` notice ("Too many attempts. Try again in a few minutes.") with no
  re-read and focus on the primary. It is not `INVALID_WEBAUTHN`: the key is fine and the quota
  is spent. A `rateLimited` refusal of the gated request is not this notice; its surface words
  that one.
- **Begin's rpId must be the relying party of the server the proof goes to.** Every server
  shares one renderer origin, so the browser's own rpId check cannot tell them apart, and a
  server could name another server's relying party in begin and relay the assertion.
  `beginWebAuthnInlineVerification` (`services/system/webauthnInlineStepUp.ts`) therefore decodes
  begin's `publicKey` through `parseWebAuthnOptions` (`utils/webauthnOptions.ts`, the parser and
  `rpIdBelongsTo` rule the sign-in challenges use; see [`electron.md`](electron.md) § "The rpId
  is bound to the server the proof goes to") against `context.serverSelection.apiBase`. The
  `context` is required on begin and finish, so apiFetch sends both to that one server; without
  it, finish would follow a server switch made during the ceremony and carry the assertion to a
  server begin never checked. Every key the parser does not name (`extensions`, `hints`) is
  dropped, so the server's object never reaches `navigator.credentials.get`. A refusal throws
  before the ceremony and becomes `INVALID_WEBAUTHN`. So does a self-hosted server whose rpId
  is the parent of its API host: the read still offers the key, and begin then refuses it.
- **The single-flight latch belongs to an attempt.** `runningRef` holds the id of the attempt
  that set it. Ending the attempt (a method switch, disabling, unmounting) releases it, and a
  run's `finally` releases it only while it still holds that run's id, so an older request still
  out never latches the instance that replaced it. A change to any instance-key input
  (`enabled`, `purpose`, `readFailure`, `passwordLeg`, `allowBackup`, `floorMethods`) also ends
  the attempt, in the layout-effect cleanup: a surface closed and reopened while a signal-less
  `submit` hangs is activatable at once, and the old run's outcome lands on nothing.
- **The soft-lock challenge carries a classified `refusal`.** `purgeApi`'s `softLockChallenge`
  returns `{view, refusal}`, where `refusal` is the `StepUpFactorRefusal` the delete-refusal
  mapper already derived (`softLockSeed`), so the stage seeds the hook from it. Nothing matches
  on copy text.
- **An unsent mint is "not sent" (D7).** On the delete and purge soft-locks, `mintPasswordStepUpToken`
  reporting `unsent`, and an `AbortError` from the route, map to `{kind:'aborted'}`: nothing is
  shown, the code is not cleared and nothing is reported as a password or network failure.
  `PurgeResult` has `{kind:'notSent'}` for it.
- **A submitted TOTP code is spent.** The server accepts each code at most once per 30-second
  step and can accept one yet still fail the request, so the hook clears the code and remounts
  the panel's input (`attempt` bumps its `key`) after any outcome that may have spent it, and the
  primary stays `aria-disabled` until a fresh code is typed. It also clears the code on a refusal
  of the code itself (`invalidMfaCode`) and on one that changes what is asked (`mfaRequired`,
  `enrollmentRequired`, `sessionExpired`, and `passwordRequired` on a `whenNoMfa` leg). Only
  `invalidPassword`, `passwordRequired` on an `always` leg and `rateLimited` keep it: the seam
  checks the password before it reads the code, and a route limiter answers before it reads
  anything, so the code is still the user's to send once the limit lifts. Whether a TOTP
  acceptance is recorded (S2a) is a different question, answered by `codeProvenUnspent`. The
  sign-in challenge (the login page's two-factor step and `MFAChallengeModal`) remounts its code
  input empty after any refusal or failed request, since a refused code there is wrong or spent.
  `onCodeChange` reaches `TOTPInput`/`BackupCodeInput` through the panel and fires on every edit
  (including `''` while the code is incomplete), so editing a completed code clears the stored
  value rather than leaving the primary enabled against a value no longer typed.
- **The sign-in challenge requests its email code.** When the login page's two-factor step or
  `MFAChallengeModal` shows email mode for a challenge whose `methods` lists `email`,
  `useSignInEmailCode` (`components/Auth/signInEmailCode.ts`) posts the challenge token to
  `POST /api/v1/auth/mfa/email/send`: `/auth/mfa/verify` answers an email code only after that
  route has sent one. An sms-only list sends nothing, since SMS has no send route. The guard is
  module state kept per token, not a ref in one mounted instance, so StrictMode's replay, a
  switch away and back, and a remount (App renders the modal in the restoring tree and again in
  the main tree) all reuse the send already out or answered; only a `failed` answer removes its
  entry. The send's error has its own line below the code input and
  never uses the verify error slot. A network error, a 5xx, the 30 s timeout, and the rate
  limiter's 429 (the only 429 that carries `Retry-After`; its `message` names the wait) are
  retryable and offer "Send a new code", which moves focus to the code input. Any other 4xx,
  including the handler's duplicate-send 429, is final, and a retry after a timeout can draw that
  429, which is then true. Everything sent for a challenge goes to the server that raised it.
  The login page keeps that selection with its own challenge. For `MFAChallengeModal` the code
  that raises the challenge records it before calling `showChallenge`, through
  `recordChallengeIssuer` (`services/system/challengeIssuer.ts`, first record wins): `useSSOFlow`
  records the selection it reserved at `begin`, and `apiClient`'s refresh records the selection
  it captured before awaiting `refreshToken()`. Those are the only two `showChallenge` callers.
  The modal reads `challengeIssuerFor` and never captures a selection at render, because a
  selection that moved before React committed would send the token to the new server. A token
  with no record fails closed: nothing is sent, and the send line and a verify both say the
  server changed. A recorded selection that is no longer current is refused the same way. The
  issuer record and the send guard both expire with the server's 5-minute challenge TTL
  (`CHALLENGE_TTL_MS`, matching `challengeTTL` in `internal/mfa/challenge.go`): an older entry
  counts as absent and each new entry prunes the expired ones, so neither map grows for the life
  of the process, while a remount within the TTL still asks once. A late answer for a superseded
  challenge, or one that lands after the surface leaves email mode, shows nothing. Two answers
  that land after a move are not dropped: an SSO completion always reaches `useSSOFlow`'s fence,
  which clears main's owner-scoped refresh credential and revokes the session (stopping it at the
  modal left both alive), and a renderer verify accepted after the move is revoked at the server
  that issued it, through `loginSessionRevoke.ts`, which the login page shares.
- **A password leg that is `always` stays mounted through an `mfa_required` refusal.** The seam
  verifies the password factor FIRST, so `mfa_required` is exactly what a correct password with no
  code receives. Hiding the field on that refusal (as `PurgeMessagesModal` once did, mirroring an
  earlier `PurgeFenceStepUpDialog` defect fixed in #2792) sends the next submit with no password,
  draws `password_required`, and burns a second attempt from the same 5-per-15-minute budget the
  purge itself spends. `StepUpCredentials` keeps the field on an `always` password leg (#1 and #2)
  in every state that can still submit. There is no SSO-passwordless case that justifies dropping
  it: SSO accounts hold a real password hash (`.claude/rules/backend.md` § "Step-up policy is owned
  by `internal/stepup`"), so an `mfa_required` refusal is never evidence the account has none. #3
  uses a `whenNoMfa` password leg: the field appears only when no inline method is offered.

- **The code field renders only when the account holds an inline method** (PR 2 amendment). The
  method comes from `GET /mfa/step-up` or an `mfa_required` refusal's `methods`, never from
  `/mfa/status` `methods` or any other `users.mfa_methods` list. It is never rendered
  unconditionally. Email and SMS are never offered as step-up factors: every list is intersected
  with `{webauthn, totp}` (G1), and an empty intersection is the no-usable-method state ("Your
  account's verification method can't be used here. Add an authenticator app or security key in
  Settings.").
- **`fetchStepUpRequirements`** (`services/system/stepUpRequirements.ts`) never throws. Its outcomes
  are `ready`, `unsupported` (404 only: the handler never answers 404, so the server predates the
  route), `unavailable` (429, any 5xx, a non-abort network failure, a malformed 200), `refused`
  and `aborted` (an `AbortError`, from the signal or from `apiFetch`'s pre-dispatch fence;
  the service's result is never rendered as such, but the hook treats an `aborted` read that
  is still current as `unavailable`). Any read, whatever it answered, that lands after the
  account or server changed ends the instance in `sessionExpired` rather than applying. `refused` carries a reason: `session` (a 401 that survived the
  refresh), `account` (403 `account_disabled`), `emailUnverified` (403 `EMAIL_NOT_VERIFIED`) or
  `client` (any other 4xx except 404 and 429). It is terminal on every route: no Retry and no
  password field.
- **Per-route read-failure policy.** #1 `dm.purge`: `block`. #2: `passwordOnly`. #3: `block`. An
  `unavailable` read on a `block` route shows the blocked state with Retry; on `passwordOnly` it
  leaves the password field alone, because #2's budget is refunded on success and a probe costs
  nothing there. `unsupported` shows the password field alone on EVERY route, `block` included; a
  later refusal mounts the picker. Backup codes are offered only when a `ready` read reported
  `backup_code_available`, TOTP is offered and the surface allows them.
- **Fieldset and phase rules.** The stage's fieldset is `disabled` while `phase === 'submitting'`
  and the modal is not dismissable. During `ceremony` the fieldset stays enabled but the password
  is `readOnly` (C37), and so is any host field the activation captured (`MFASetup`'s key name),
  so the switch links and Cancel stay live; switching, Escape or close abort the ceremony. The primary is `aria-disabled` with a guarded click, never `disabled`, including
  while `submitting`: a natively disabled button drops focus to `<body>`, and an outcome with no
  field notice would leave it there. A terminal status (`refused`, no usable method,
  `sessionExpired`) also empties the host's password, since nothing can send it any more.
  `sessionExpired` is reached by a refusal too: a route's 401 after `apiFetch`'s refresh retry,
  which `toStepUpSubmitOutcome`, `SessionStepUpDialog` and both route adapters forward. The
  stage's terminal sentence is then the only one: `stepUpBanner` returns `null` for it, the
  stage-less key revoke uses `passwordOnlyBanner`, and DM Clear's factor path sets no banner.
- **Enter in a field presses the host's primary** (design §4.3). The password field and the code
  input call `primaryRef.current.click()` on a plain Enter (`isPlainEnter` in `MFAFactorPicker.tsx`:
  no modifier, not mid-IME-composition, not a key auto-repeat — a held Enter must not press the
  primary again after a refusal), so a key goes through `stepUpActivation`'s guard exactly
  as a click does — busy does nothing, incomplete names what is missing. Never call `run` from a
  key handler. No host wraps the stage in a `<form>`, and the handler calls `preventDefault`, so a
  future form ancestor cannot submit twice.
- **`run` is single-flight, and no WebAuthn token outlives a submit.** A synchronous `useRef` guard
  is set before the first `await` (C6). `run` works against the context its instance captured when
  it OPENED, or the caller's capture (C82), and requires both to still be current: a password typed
  for one account or server is never sent to another, even when the switch lands before the
  activation or before a host's own capture. It rechecks the auth generation and runtime server before the ceremony, before
  finish and immediately before `submit` (C45, C75), plus its attempt id and abort signal (C56).
  An account or server change discards the token AND the prepared payload, sends nothing, and ends
  in terminal `sessionExpired`; a stale attempt is dropped silently. `submit` runs once; the token
  is never held for a retry. The attempt ends in a layout-effect cleanup, in the same commit that
  disables the instance: a passive cleanup runs a task later, and a finish resolving in between
  would pass the pre-submit gate after the dialog closed.
- **`StepUpSubmitOutcome`** is `success | refusal | answered | transport | aborted`. `aborted` means
  the request provably never left, so it spends nothing and is not reported as a network failure:
  `clearDMHistory` maps `apiFetch`'s pre-dispatch abort to it, and `mintPasswordStepUpToken` reports
  an unsent request as `unsent`, which Clear surfaces as "not sent" rather than a password error.
  #2 passes `run`'s capture through `disablePurgeFence(credentials, context)` and
  `updatePrivacy(…, context)` to `apiFetchInContext`, and the store returns `aborted` for that fence;
  every surface binds its gated request to the run's own capture. That fence stops only a request
  not yet sent, so a host's own side effects after its `submit` awaits (an answer banner, a result
  stage, `onClose`, a cache-clearing event) run only while `apiRequestContextIsCurrent(context)`
  holds: an answer that lands after an account or server change belongs to the old one. The hook
  guards only its own state.
- **Six-digit acceptance (C12, C30, C41).** The hook calls `noteTotpAccepted` (the in-memory
  `totpAcceptedStore`, cleared by `gracefulReset`) when the submitted value, with spaces and
  hyphens stripped, is exactly `/^[0-9]{6}$/`, whichever panel was active. That predicate leans on
  the server's code formats staying disjoint: authenticator codes are six digits and backup codes
  are not. It records on `success`, `answered` and `transport` (the server may have accepted the
  code), and on any refusal except `invalidMfaCode`, `invalidPassword`, `mfaRequired`,
  `passwordRequired` and `rateLimited`, which prove the code unspent. The TOTP panel then shows
  the recent-code hint until the end of the next 30-second period.
- **One re-read (C13, C25, C32).** After `invalidMfaCode`, or after begin answers `400 No WebAuthn
  credentials registered`, the hook re-reads the requirements once, in the background. One
  response causes at most one read. `ready` replaces the offered set and, if the active method
  left it, switches to the new default with "Your verification methods changed. Use the one
  shown."; `refused` is terminal; anything else changes nothing. A read's result applies only
  while its attempt id is current and its signal is live (C57). A new `run` cancels a re-read
  still in flight: the refusal that run gets is newer than anything the older read can say.
- **`PurgeMessagesModal` closes when its scope changes while open.** ChatView, DMChatArea and
  GroupInfoPanel keep it mounted across a conversation change, so a new `context:scopeId` under
  an open dialog calls `onClose` rather than carrying a chosen range, a typed PURGE or a step-up
  stage onto the next scope.
- **An empty password always blocks on an `always` password leg** (#1, #2), whatever factor is
  supplied. Every account holds a password hash (`.claude/rules/backend.md` § "Step-up policy is
  owned by `internal/stepup`"), so a submit without one can only earn `passwordRequired` and
  spend a unit of the route's budget. Do not relax this for a "passwordless" account: that
  premise is false, and PR 2 briefly shipped the relaxation before reverting it.
- **A code panel counts as filled only at its factor's shape**: six digits for TOTP (spaces and
  hyphens stripped), eight letters or digits for a backup code (trimmed). A shorter value keeps the
  primary `aria-disabled` and the guard shows the panel's "Enter…" message, because every send
  spends a unit of the route's rate-limited budget and a partial code cannot pass.
- **DM Clear sends no factor-less probe when purge protection is on.** "Continue" is a local stage
  change; the first Clear request carries the factor, so no budget unit is spent discovering what
  to ask for. With protection off, Clear stays one click.
- **Colour.** The error glyph strokes `--text-primary`: `--danger` measured below 3:1 on the tinted
  error fill in two schemes (2.63:1 Cotton Candy light, 2.91:1 Foxden). `--danger` is used only for
  the box's border and tint, never as text. `refused`, no-usable-method and cancelled are
  statuses and take no danger styling.

## Chat surfaces and the inline message edit (#1959)

**More than one chat panel can be mounted at once, and two can show the same channel.**
`MainView` renders the voice text chat side panel beside `ChatView`, and `PersistentVoiceBar`
renders it as a drawer beside `ChatView` or `DMChatArea`. When the main view shows the voice
channel's linked text channel, both panels list the same rows. Anything that ties a message row
to "the" composer must therefore name its panel, or it acts on whichever panel comes first in the
page. The first version of #1959 did not, and review found three defects: an edit opened in both
panels, `autoFocus` pulled focus into the other panel, and a save or cancel focused the first
composer in the page. That last one put a voice-panel user in the main channel's composer, so
their next message went to a different conversation.

- **A chat surface is one panel that pairs a message list with its composer.** Each owner
  (`ChatView`, `DMChatArea`, `VoiceTextChat`) takes `const surfaceId = useId()`, sets
  `data-chat-surface={surfaceId}` on its root, and passes `surfaceId` to `MessageList`, which
  hands it to every `Message`, and to `DeleteRefusalModal`. The prop is required on all three, so
  a new owner that forgets it fails to compile. A new owner of a message list must do all three.
- **Find a panel's composer or row only through `components/Chat/chatSurface.ts`.**
  `findSurfaceComposer`, `findSurfaceMessageRow` and `focusSurfaceComposer` compare the
  attribute rather than build a selector from the id, and skip elements of a surface nested
  inside. A surface with no composer is a no-op. Never fall back to a page-wide
  `.message-input-textarea`.
- **The open edit is `chatStore.editingMessage: { surfaceId, messageId } | null`.**
  `setEditingMessage` opens it; `clearEditingMessage(surfaceId, messageId?)` is compare-and-clear,
  so one row or panel cannot close another's. The row clears its own edit on save, cancel and
  unmount; the unmount clear keeps an abandoned edit from reopening, and taking focus from the
  composer, when the user returns. One edit is open at a time across the app.
- **One rule says what is editable: `canEditMessage`** (`utils/chat/latestEditableOwnMessage.ts`).
  The row's Edit actions and the composer's Up Arrow shortcut both use it: own, an ordinary
  message, server-acknowledged, readable, and with a body. The body rule refuses the #1741
  decrypt placeholder (`content: ''`, no flags), which nothing else marks. Delete keeps
  `canModify`, so an unreadable own message is deletable but not editable.
- **The shortcut.** `shouldEditLastMessage` in `MessageInput.tsx` fires only for a plain Up Arrow
  in an empty composer with no staged file, no reply and no IME composition, after the typeahead
  router. `useEditLastMessage` opens the newest own message only if it is editable, never an
  older one, and does nothing while its panel already has an editable edit open, which would
  otherwise lose that edit's draft.
- **A save that does not reach the server is given back.** `useChatController.editMessage`
  resolves `true` once saved or when the message is gone. On any other outcome the row reopens
  the edit with the submitted text and a `role="alert"` line only if no edit is active when the
  failure settles. An active edit in the same surface keeps priority; when another surface is
  editing, the failed draft and alert remain local to the mounted row until manually reopened.
  A retained failed draft survives content updates until cancel or resubmit clears its failure flag.
  While editing, the draft adopts a changed `message.content` only if the user has not changed it.
- **An edit is held to the per-message character limit (#3857).** `useMessageCharLimit`
  (`hooks/messaging/`) is the one source of that limit, the live entitlement clamped by tier, for the
  composer, `SyntaxHelpModal` and the edit box; the composer's `maxLength` prop stays a test/override
  seam. The limit is enforced only by the client (under E2EE the server sees only ciphertext). The composer
  sends overflow as a `.md` attachment; an edit has no such path, so `MessageEditBox` refuses an
  over-limit save. `evaluateEdit` (`utils/messaging/messageCharLimit.ts`) is the single guard behind
  both Save and Enter: it measures the TRIMMED draft, the same text a save sends, and the boundary is
  inclusive. Over the limit, Save is disabled, Enter does nothing, the box stays open with the text
  intact (never truncated), and the reason, linked by `aria-describedby`, names the actual limit. The
  reason's `role="status"` element stays mounted and empty under the limit, so its text is announced
  when it appears. That reason also covers a user who dropped from premium to free and opens an old
  message over 5,120. An `n/max` counter shows from 75% of the limit. Like the composer, the edit box
  discards input that would take the draft past `DOS_PROTECTION_LIMIT` (1 MiB). Never compare the raw draft with the original or
  the limit, and never hand `onSubmit` anything but the verdict's `trimmed`.

## Delete refusal flow (delete-rate soft-lock, #3455)

The server refuses message deletes past a burst threshold and asks for a factor
(`.claude/rules/backend.md` § "Delete-rate soft-lock"). Before #3455 the desktop
swallowed every refusal into a `console.error`; every one is now visible.

- **Classification is by flag, never by status alone.** Several logically
  distinct refusals share one status: two 429s (route limiter, spent budget) and
  three 503s (soft-lock unavailable, budget unavailable, lock conflict).
  `services/messaging/deleteRefusal.ts` (`toDeleteRefusalView`) is the ONE place
  that reads them and returns a `DeleteRefusalView`: `confirm` (with `methods`),
  `password`, `wait` (`reason: 'requests' | 'verification'`), `unavailable` (all
  three 503s, Close-only, no countdown) or `failed`. The modal titles the two
  waits differently: `requests` is "Deleting too quickly", `verification` is "Too
  many attempts" with "Too many verification attempts.", and with no
  `Retry-After` (the budget never sends one, and its window is 15 minutes) it
  says "Try again in a few minutes." rather than "shortly". A 429 is `verification` when
  `step_up_budget_exhausted === true` or the body is the exact string
  `Too many verification attempts`; never a substring match. `Retry-After` is
  parsed with a finite and non-negative guard, since the header may be an HTTP
  date. `classifyStepUpRefusal` gained the kind `deleteRateLimited`, matched
  first on `delete_rate_limited === true && mfa_required === true`; the existing
  consumers that do not own a delete route map it to their generic failure arm.
  `mfa_enrollment_required` (a server that enforces MFA, an account with no inline
  factor) maps to the `enroll` view, with or without `delete_rate_limited` and its
  `Retry-After`, and renders the enrolment state, never `failed`: no input, no
  Retry and no countdown. It carries a "Set up verification" button (#3456):
  `DeleteRefusalModal` passes `onSetUpVerification`, which calls `openVerificationSetup` with
  `returnTo: {kind:'chat'}` and closes the modal through its Cancel path. The delete is
  abandoned, never retried on return (see "Step-up refusal surfaces").
  The DM route never answers it: `confirmDMDeleteTx` applies the own rule only,
  because a DM belongs to no server and has no enforcement flag.
- **`useChatController.sendDelete(id, step?)`.** A body is sent **only** when a
  factor is present (`{mfa_code}`, or `{step_up_token}` after a password
  exchange — see "Password step-up token" below); a first delete has no body,
  as before, and goes out in the same tick. There is one refusal slot (`deleteRefusal`): a refusal for
  any other message while it is filled is discarded. Duplicate deletes for an id in
  flight are a no-op (an in-flight `Set`); a 404 on a **retry** counts as gone and
  removes the row; a non-JSON body (an intermediary's error page) falls back to
  the mapper's own copy; nothing is set after unmount; an `AbortError` from
  `apiFetch` (account or server changed under it) reports nothing. The slot is
  cleared when `ctx.id` changes or the refused message leaves the store, and a
  refusal or transport failure that lands after `ctx.id` changed is discarded:
  clearing alone let a response still in flight refill the slot, showing the
  old message's refusal in the new chat, where confirming it retried that
  message against the new chat. A success still removes the row from the chat
  it was sent from. The vanished-message effect is not that guard, though it
  hides the defect one commit later, because it looks the message up in the
  current chat; a test for this records every render after the switch. It is
  hook-local state, not store state. Three consumers mount the hook and each
  renders `DeleteRefusalModal`: `ChatView.tsx` (`messages.delete`),
  `DMChatArea.tsx` (`dm.message_delete`) and `VoiceTextChat.tsx`.
- **`DeleteRefusalModal`** (`components/Chat/`): views confirm, password, enroll,
  wait, unavailable and failed. The three credential views (confirm, password,
  enroll) are one `StepUpCredentials` stage on a `whenNoMfa` password leg, with
  `readFailure: 'passwordOnly'`, `allowBackup: true` and the route's purpose.
  `softLockSeed(view)` turns the refusal into the hook's `seed`, in the render
  that sets `enabled`: confirm seeds its `mfaRequired` methods, password seeds
  `passwordRequired` (the empty set on this leg), enroll seeds
  `enrollmentRequired`. A `ready` read replaces the seeded set (G2), so the
  hook, not the view, decides which factor shows. The stage titles all three
  "Confirm it's you" so the dialog name does not change mid-flow, and uses
  `focusOnReady`. `onConfirm(step, context)` returns `Promise<StepUpSubmitOutcome>`
  so `run` can await it and bind the retry to its capture. `dismissable={false}`
  while submitting. A refusal after submit is the hook's to render (a wrong code
  remounts the input empty; #3466: a submitted code is spent). The countdown is
  computed from the `openedAt` of the response that carried the header, against
  the wall clock, not by counting ticks; the ticking text sits outside any live
  region and a `role="status"` node is written only at zero, so a screen reader is
  not interrupted every second. There is no auto-retry, no `--danger` and no glyph,
  and no copy names the setting or the server state. A refused password exchange that no field
  can answer (the 423/429 lockout, an older server, a failed lookup, `mfa_required` naming no
  method) ends the challenge in the Close-only `failed` view with `passwordStepUpRefusalMessage`,
  as purge's `endExchangeRefusal` does (`mintRefusalRetry` in `useChatController`); the field
  never empties in silence.
- **Focus return.** On close, focus goes to the message row
  (`[data-message-id]`, found by attribute comparison, never a built selector),
  else the composer (`.message-input-textarea`), never `<body>`. Both are looked
  up inside the modal's own chat surface (its required `surfaceId` prop, #1959),
  never page-wide: see § "Chat surfaces and the inline message edit". It runs in the
  parent's effect, after `Modal`'s own restore-to-invoker, because the invoker is
  detached by the time a refusal arrives. The three row wrappers in
  `MessageList.tsx` gained `tabIndex={-1}` so a row can take that focus.
- **Purge soft-lock stage.** A channel or server **self**-purge that trips the
  soft-lock returns `softLockChallenge` from `purgeApi.ts` (routed only when
  `delete_rate_limited` is set on the channel or server route; the DM and group
  routes keep their older fence). `PurgeMessagesModal` goes configure → softlock →
  result. The stage is `StepUpCredentials` too, seeded by the challenge's
  classified `refusal` (never by matching copy), and re-sends the same purge with
  `mfaCode` or `currentPassword`, using
  the `messages.channel_purge` or `messages.server_purge` purpose; an enrolment
  refusal returns the `enroll` challenge, and an unsent mint or an `AbortError`
  returns `notSent`, which `runPurge` treats as the hook's `aborted`. `purgeApi`
  exchanges a channel/server password for a `step_up_token` before the route
  sees anything. Other soft-lock
  403s become `softLockFailed`, and the budget 429 becomes `verificationLimited`;
  both may say nothing was purged, because the gate runs before any batch. A
  400 carrying `step_up_unavailable: true` (an own-rule purge by an account
  with neither a password nor an authenticator, which no step-up can pass) is
  also `softLockFailed`, with the server's own text as the remedy; before
  #3509's review it fell through to "Something went wrong". The stage heading
  takes focus on entering `stepup` or `softlock`, and again when the soft-lock
  view changes inside the stage: a mint that names MFA after the password was
  sent swaps the focused password field for a code or security-key prompt,
  and without the second trigger focus fell to `<body>`, outside the dialog.
  A first-purge challenge (the soft-lock, or a DM step-up) opens its stage only while the
  request context it was sent under is current.
  Every submit goes through `runPurge`, which drops an outcome that lands after
  the dialog closed or reopened: the open effect bumps `openGenerationRef`, and
  close resets `busy`. Without it a purge still in flight when the dialog was
  closed reported "Purged N messages." inside the next, unrelated one.
- **`.totp-error` uses `--text-primary`.** It was `--error-color` on
  `--bg-secondary`, which the #3455 measurement found below 4.5:1 in 9 of the 30
  scheme×theme combinations (worst: Spooky dark 3.45:1, Cotton Candy light
  3.49:1). Every MFA prompt's error text changed, not one surface; the refusal
  copy carries the error signal, so colour was never load-bearing. The
  contrast guard reads stylesheet pairs only, so refusal text takes the class and
  never an inline colour, which would hide the next regression.
  `.purge-modal__softlock-error` follows the same rule.
  Do not "restore" the red.
- **Password step-up token (#3509).** The own-rule routes — both message
  deletes, both self-purges and DM Clear — never receive the password. After a
  `password_required` refusal the existing password field collects it, and
  `services/system/stepUpToken.ts` posts it ONCE, through `apiFetch`, to
  `POST /api/v1/auth/step-up/password` with `{current_password, purpose}`; the
  route is retried with `{step_up_token}`. That module is the only place an
  own-rule password is sent and the only reader of the mint's refusals, so all
  three flows (`useChatController`, `purgeApi`, `dmVisibilityApi` behind
  `DMThreadRemovalDialog`) put the same copy on the password field. The
  exchange and the route are ONE operation (#3509 review): each flow captures
  an `ApiRequestContext` (`services/system/requestContext.ts`) just before the
  mint and passes it to both requests, so `apiFetch` admits the route against
  the account and server the mint ran under. If another account signed in or
  another server was selected between them, the route throws the pre-dispatch
  `AbortError` and is never sent, so a token minted by account A is never
  spent by a destructive request sent as account B, whose permissions could
  widen it (a self-scoped purge becoming an all-author one). A flow that
  sends no password calls `apiFetch` with no context, unchanged.
  `apiFetchInContext` passes no third argument then, which keeps existing
  two-argument call assertions valid. The copy on the field covers: a wrong
  password, the shared login lockout (423) or a 429, a 404/405 from a server
  older than the endpoint (its own `unsupported` copy, so version skew never
  reads as a password problem), and any other failure; a transport failure is a
  refusal, never a throw. A 403 `mfa_required` from the mint (the account gained
  an authenticator after the route asked for a password) is NOT field copy:
  delete and purge move to their code view with the `mfa_methods` the mint named
  (`mintMfaMethods`), and delete and purge fall back to the field copy only when
  the mint named no methods. Clear's `mfaRequired` result always carries
  methods — the ones the mint (`mfa_methods`) or Clear's own 403 (`methods`)
  named, or a code prompt when neither named any (`namedMfaMethods`) — and its
  MFA stage is `StepUpCredentials` with purpose `dm.clear`, so an
  account whose one factor is a security key runs the ceremony there. Clear's
  post-request work (`applyClearResult`, the refetches, the error and the close)
  runs only while `answerIsCurrent(lifecycle, context)` holds: the auth lifecycle
  AND `apiRequestContextIsCurrent`, so a runtime-server switch while a Clear is in flight —
  the first, uncredentialed one included — applies nothing (D20). That uncredentialed Clear is
  also sent under its capture, so a switch before it leaves sends nothing at all. Before
  #3509's review it was a bare numeric field that dropped the methods, and such
  an account could never finish a Clear. `dm.clear` is therefore in
  `STEP_UP_PURPOSES` as well as `PASSWORD_STEP_UP_PURPOSES`. Every password submit empties the field the moment
  it is sent, and a retry clears the previous attempt's error at submit start
  (the hook and the soft-lock state reset in the purge modal), so
  neither a sent password nor a stale refusal sits on screen while the next
  attempt runs. The mint must never answer a wrong password with 401:
  `apiFetch` would refresh and resend it. The route's own refusal of a token carries
  `password_required` AND `step_up_token_invalid`; `classifyStepUpRefusal`
  keeps it `passwordRequired` with `tokenExpired: true`, and the stage puts
  "Your confirmation expired. Enter your password again." (`STEP_UP_TOKEN_EXPIRED_MESSAGE`)
  on the emptied password field and focuses it — never in a banner. DM Clear is
  no exception: `clearDMHistory` returns `passwordRequired` with `tokenExpired: true`
  for that refusal, and `passwordRefused` is left to the mint's own refusals. In the hook the exchange sits inside the in-flight dedupe
  and the `sentFrom` stale-context guard: a mint refusal that lands after the
  chat changed is discarded like any other refusal, and a minted token still
  confirms the delete against the chat it was sent from. Purposes come from
  `PASSWORD_STEP_UP_PURPOSES` in `stepUpPurpose.ts`, which a parity test pins
  to Go's `ownRulePurposes` in both directions. The DM/group purge is a hard
  flow and still sends `current_password` with its code. DM Clear maps its 400
  to `stepUpImpossible` on `step_up_unavailable: true`. It falls back to the
  opening words of its copy only for a server older than the flag, so an
  edit to that copy no longer silently turns the outcome into a refusal.
- **Local reproduction.** Make one delete, find the key with `docker exec
  concordvoice-redis redis-cli -a "$REDIS_PASSWORD" --scan --pattern
  'stepup:delete_softlock:*'`, then `SET <key> 15 KEEPTTL`; the next delete trips
  within 30 s. For the 503, `CONFIG SET min-replicas-to-write 1` (writes fail with
  NOREPLICAS, reads and auth keep working), delete, then set it back to 0. Run on
  2026-09-30 against a local Redis: the scan found the server and day keys,
  `SET … KEEPTTL` kept the 30 s TTL and the next delete tripped, and while writes
  were refused the delete returned the soft-lock 503 as `/health` and `/readyz`
  stayed 200. #3456 reuses it.

## Continuation-token adoption (post-#2415)

`POST /users/me/password` and `PUT /users/me/keys` advance the credential epoch, so the
credentials that authorized the request are dead as it commits. Both may return a
best-effort continuation pair — `access_token`, `refresh_token`, `session_id` — minted under
the new epoch; adopting it is the only thing that keeps the session alive. The fields are
optional by contract and their absence is a **security outcome**, never a transport error.
Custody and ordering on the main-process side (new lifecycle, new `CredentialOwner`,
`persistE2EESessionKeys` after `storeRefreshToken`) are in
[`.claude/rules/electron.md`](electron.md) § Token Storage.

- **Absent fields route to `failClosedToReauth` with `success: false` — never a retry, never
  a silent 401.** ChangePassword sends `pair === null` *and* a declined adoption CAS through
  `failClosedToReauth` (`stores/auth/userStore.ts:233-244`), which returns `{ success: false }`
  (`:243`). Returning `success: true` would flash a green "Password changed successfully!"
  immediately before an involuntary bounce to Login. Do NOT retry the request: `PUT
  /users/me/keys` is rate-limited 3/min/user and `POST /users/me/password` 5/min/user
  (`internal/api/router.go`), so a retry burns a third of the key-replacement budget per
  attempt.
- **The Login / ReplaceMyKeys path uses component-local `setErrors`, NOT
  `authStore.loginNotice`.** `loginNotice` is consumed by a `useState` initializer
  (`components/Auth/Login.tsx:387-390`) plus a **mount-only** effect (`:396-400`), and Login
  is already mounted during key recovery and does not remount — a staged notice would never
  render, reproducing the exact silent failure #2415 exists to close. `adoptResetContinuation`
  therefore closes the modal prompt, clears the access token, and calls `setErrors({ general:
  KEY_RESET_REAUTH_NOTICE })` (`:885-896`), mirroring `abortKeyRecovery`. Closing the prompt
  first is required, not cosmetic: it is a native `<dialog>` opened with `showModal()` that
  owns a focus trap, so leaving it open strands the user away from the sign-in form they now
  have to use. Do NOT *also* stage `loginNotice`; a later fresh mount would replay it stale.
- **A store action that changes `accessToken` or `sessionId` can synchronously CANCEL an
  in-flight `changePassword`.** `beginPasswordChange` (`stores/auth/userStore.ts:179-201`) installs
  an `authStore` subscription that cancels the active change whenever the watched session id
  differs (or, before a session id exists, the access token), and Zustand notifies subscribers
  **synchronously inside `set`**. Continuation adoption legitimately changes both, so it
  re-points `lifecycle.watchedAccessToken` / `watchedSessionId` BEFORE the store write
  (`:341-343`) — otherwise the watcher observes the successor session and cancels the very
  operation that just re-secured itself. Any new credential-mutating path reachable from
  inside a password-change lifecycle MUST re-point the watch first, or it will do the same.

- **A DECLINED adoption CAS must NOT route through `failClosedToReauth`.** The CAS
  can only decline because a successor lifecycle became current, so the decline is
  itself the authoritative supersession signal. `failClosedToReauth`'s `isCurrent()`
  is blind to it — the lifecycle, abort flag and user id are all unchanged by a
  generation-only supersession — so it would call `nuclearReset()` and destroy the
  SUCCESSOR's credentials, its E2EE custody, and (via the owner-blind
  `clearTokens()`) its freshly persisted disk token. Return the re-auth result
  directly instead. Do NOT "fix" this by adding a generation clause to
  `isCurrent()`: that is stricter at every `assertPasswordChangeCurrent` site,
  including inside the committed-2xx classifier, where it reports a change that
  COMMITTED as "cancelled" and invites a retry with a password that no longer
  works — the exact failure #2422 fenced off.

**Two things not to "improve".**

- **The 401 carries no distinguishing signal, and that is deliberate.** `ErrBlocked`,
  `ErrEpochMismatch` and `ErrUnavailable` all collapse into one generic body
  (`services/control-plane/internal/middleware/auth.go:70-74`, `abortUnauthorized`
  `:125-128`) to deny an attacker an epoch oracle. No downstream 401 can carry enough
  information to produce the notice, so classifying after the fact is **impossible**, not
  merely inferior. Do not "improve" the notice by reading the 401.
- **"Fields present" is NOT a liveness guarantee.** `Op.Commit` retries the owner-scoped CAS
  once then gives up (`services/control-plane/internal/credepoch/credepoch.go:315-329`), so a
  Redis outage can leave the blocked marker live for up to `blockedTTL` = 5 min (`:41`) while
  the handler still returns 200 **with** a valid pair; every request on that pair then 401s
  generically. This is fail-closed and acceptable — the ordinary 401 →
  `handleRefreshFailure` path is the backstop. Do not add a liveness probe to "confirm" an
  adopted pair.

## WebSocket payload validation (post-#709)

All incoming WebSocket events are validated at the dispatch boundary in `websocketService.handleMessage` using zod (`zod` v4.x). Each of the 85 event schemas lives in `desktop/src/renderer/types/ws-events.ts`, exported as `WebSocketEventSchema` (a `z.discriminatedUnion('type', [...])`). Some schemas deliberately have no registered handler, and that is not an oversight: `heartbeat_ack` has no consumer at all, and five of the six server-role events (#2359) are validated purely so the boundary recognises them. `auth_renew_result` is envelope-only like `connected`, `connection_ready` and `heartbeat_ack`: it is consumed inside `wsService.handleMessage` as the in-band token-renewal ack and has no `wsService.on()` subscriber. A valid-but-unhandled event falls harmlessly through to `wsService.on()` subscribers, whereas an UNRECOGNISED discriminator calls `incrementWireViolation()` — so the schemas alone fix a live defect where every role mutation corrupted the connection-quality signal on every connected member's client.

**E2EE content invariant (#1741):** Every content-bearing message add/edit handler routes through `decryptAndStoreMessageContent`; metadata-only updates must not decrypt or overwrite content. Adds and edits share one per-message `message-content` operation lane. Insert a fail-closed placeholder before asynchronous add decryption so a newer edit has a row to update; only the newest live operation may write, index, notify, or speak. Delete, unmount, and account teardown invalidate continuations and remove unresolved placeholders. Search deletion records the message UUID for each active backfill generation, so an already-running decrypt can neither re-index nor surface deleted plaintext; this tracking is bounded, and overflow invalidates the affected backfill fail closed. The deletion signal also removes any copy already emitted into an open search result.

**Guarded history and secondary views (#1741):** Initial and paginated history
fetches bind decrypt and publication to a request-local E2EE guard and message-ID
invalidation journal. Preserve newer live edits, arrivals, and optimistic rows; never
restore a live deletion. During an initial fetch, an edit/delete for a fetched-but-
unloaded ID triggers one fresh fetch. Pagination retries the same cursor once and
leaves it retryable after a second conflict without publishing a partial page. Pin
batches and DM preview-cache decrypts assert the current channel guard just
before publication; previews also recheck conversation and ciphertext identity.
Authoritative access revocation is terminal; ordinary rotation remains retryable.

**Pattern for adding a new WS event handler:**

1. **Define the wire schema** in `ws-events.ts`. Use `UUID`, `ISOTimestamp`, and the existing primitives from section 1. Be explicit about required vs `.optional()`. Server-emitted fields default to required; renderer-only enrichment fields are `.optional()`. For nullable wire fields (server may emit literal `null`), use `z.string().nullable().optional()` — the renderer normalizes `null → undefined` at the store boundary.
2. **Add the schema to the discriminated union** at the bottom of `ws-events.ts` (currently has 85 members).
3. **Export a payload-type alias** under section 5: `export type MyEventPayload = z.infer<typeof MyEventSchema>['data'];`. This is the type that propagates into the handler via `Extract<WebSocketEvent, { type: 'my_event' }>`.
4. **Register the handler** in `useWebSocketMessages.ts` via `wsService.on('my_event', (msg) => { ... })`. The generic `on()` signature infers the event type from the string literal — `msg.data` is automatically narrowed to your payload type. No `as { ... }` cast.
5. **Never write `if (!msg.data.required_field) return;` for schema-required fields.** Required fields are structurally guaranteed at the dispatch boundary. Defensive checks for them are dead code at best and a misleading signal at worst (suggesting the field can be missing when the schema says it can't).
6. **Normalize null → undefined at the store boundary** for fields the schema marks `.nullable()`. Wire shape = `string | null | undefined`; store shape = `string | undefined`. The pattern is `data.field ?? undefined` when copying into a store payload.
7. **Add a test** to `tests/unit/types/ws-events.test.ts` covering schema validation (happy path + reject malformed). Handler-behavior tests live in `tests/unit/hooks/useWebSocketMessages*.test.ts`. Do NOT write tests that call handlers directly with malformed data to assert in-handler rejection — those test a layer that no longer exists (zod rejects before the handler runs). Equivalent boundary-rejection coverage is in `tests/unit/services/websocketService.dispatch.test.ts`.

**Wire-violation telemetry:** every schema rejection at the dispatch boundary increments `useConnectionStore.wireViolationCount` — a connection-quality signal surfaced in connection diagnostics. A spike indicates server/client schema drift.

**Permission-refresh events (#3456).** `server_permissions_changed` (`{server_id}`) and
`permissions_changed` (`{}`) both handle only "re-read": neither carries a direction or any
permission data, and `permissions_changed` is byte-identical for a gained and a lost factor.
`PermissionsChangedSchema` is `data: z.object({})`, which accepts `{}` and rejects `null`.
Both handlers delegate to `createPermissionRefresh` (`services/system/permissionRefresh.ts`),
created per effect in `useWebSocketMessages` and disposed with its handlers:

- `server_permissions_changed`: ignored for a server not in `serverStore`. One timer per server
  (`createJitteredRefetch`) with uniform 0-5 s jitter (`SERVER_REFRESH_JITTER_MS`); an event that
  arrives while the timer is pending is **dropped**, not re-armed. When it fires: refetch that server's permissions if they
  were ever read, refetch the active channel's if it belongs to that server, and evict every other
  cached `channelPermissions` of that server (`evictChannelPermissions`).
- `permissions_changed`: a 300 ms trailing debounce. A server-list fetch already in flight began
  before the change, so the refresh waits it out, then makes one `fetchServers()` of its own,
  then re-reads the active server's and active channel's permissions. Three requests at most,
  never one per server. Every other cached `serverPermissions`, `mfaRestrictedByServer` and
  `channelPermissions` entry is evicted (`evictServerPermissions`, `evictChannelPermissions`),
  raising its read floor so an in-flight pre-change read commits nothing, and is re-read when
  that server or channel is next opened; a first read already in flight for a server or channel
  that was never cached is not fenced. Servers other than the active one keep a stale
  `servers[].permissions` until the next `fetchServers`; none of its readers makes a D1
  decision.
- **A failed refetch is not retried** and nothing re-arms itself: the stale display stands until
  the next navigation. That is what keeps the burst bound (`GET /servers/:id/permissions` is
  capped at 30/min/user) honest; do not add a retry.
- Timers are cleared by `dispose()` and whenever `authGeneration` changes (an account switch, not
  a token rotation). Both effective-permission fetchers carry a per-key sequence fence and an
  auth-lifecycle re-check after their await, so a response that loses a race writes nothing.
  `reset()` drops the `permissions:*` read-sequence keys, so that map does not grow with every
  server and channel visited in a session.

**PII safety:** schema validation runs on opaque values; the scrubber in `ws-events.ts` ensures any error path that logs payload context redacts known-PII fields (content, display_name, etc.) before emission. See `.claude/rules/observability.md` for the broader logging discipline.

**Entitlement gating primitive (post-#1297):** the `entitlements_changed` event feeds the entitlement data layer — a `subscriptionStore` (Zustand, mirrors `clientConfigStore`) holding the capability set, plus a `useEntitlement(selector)` hook for selective reads. The store is hydrated at login from `GET /api/v1/entitlements` and live-updated by the `entitlements_changed` handler (full `EntitlementDTO` on the wire — `services/control-plane/internal/entitlements/dto.go`; keep the zod schema in lockstep). Gating is read-only client UX with **zero per-action server calls**. On a fetch error the store **fails closed to a `FREE_ENTITLEMENT` floor on a FIRST-LOAD failure** (`!hydrated` — a user who never authenticated as premium can never obtain it via a degraded state), but on a **RECONNECT failure** (`hydrated`) it **preserves the last-known-good entitlement** and only flips `degraded` (#2172), so a transient blip does not clamp a premium user to free. Premium is still reached only via a successful server fetch/push. The lock UI that consumes `useEntitlement` (PremiumChip/PremiumGate/SubscriptionPage) lands in #1304/#1602.

## Role-reorder payload contract (`roleHierarchy.ts`, post-#2359)

The reorder payload is EXACTLY the set of roles whose current position is strictly below the
actor's ceiling, minus the default role, minus non-default managed roles — in the chosen order,
highest authority first. **Nothing more, nothing less.** Both halves are load-bearing, and each
is a distinct real bug:

- **Nothing more.** PR #2839 sent the whole display list. The server refuses any payload naming
  a role at or above the actor's own position, so it 403s for every non-owner. The owner
  short-circuits that check, which is why it passed all development testing.
- **Nothing less.** The obvious correction — sending only the roles the user dragged — is WORSE.
  `applyRolePositions` renumbers only the named ids and leaves omitted roles where they are.
  Proven by executed probe: with `@all`=0, A=1, B=2, C=3, D=4, sending the subset `[D, C]`
  returns **HTTP 200** and leaves A=1 C=1 and B=2 D=2 — two collisions, committed, no error
  anywhere. Over-sending fails loudly; under-sending fails silently.

The client defends this structurally rather than by convention:

- **Branded payload type.** `RoleReorderPayload` (`types/server.ts`) carries a `__brand`, so the
  display list cannot inhabit it. `buildReorderPayload` in
  `desktop/src/renderer/utils/policy/roleHierarchy.ts`
  is its only constructor.
- **Four-group partition.** `partitionRoleHierarchy` splits a server's roles into `pinned`,
  `managed`, `aboveCeiling`, and `band`. Exactly one group — `band` — is ever projected into a
  payload. Test order is load-bearing: pinned wins over managed, and both win over the ceiling
  test.
- **Built at Apply time, never stored.** `buildReorderPayload` is called on the Apply click from
  the RECONCILED hierarchy. A payload that cannot be held cannot go stale, so #2839's
  stale-pending-order failure is unrepresentable rather than fixed.

`@all` (the default role) is never named in the payload. Omitting it is what makes the server
take its `offset = 1` path and reserve position 0 for it, which renders the "default role must be
last" rule structurally unreachable from the client.
