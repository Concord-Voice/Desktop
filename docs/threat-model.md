# Threat model — Desktop

| Field | Value |
|---|---|
| Repository | Concord-Voice/Desktop |
| Visibility | Public |
| Last reviewed | 2026-11-23 at commit `89ce877c` |
| Owner | Concord Voice maintainers |
| Review when | A change to authentication, a trust boundary, or exposed surface; and at each release |

Written from the attacker's side first, as the baseline of priorities for reviewers and
scanners. To report a vulnerability, see [`SECURITY.md`](../SECURITY.md).

## System summary

**Purpose.** The Electron desktop client for Concord Voice: chat, voice, video and screen
share, with message and media encryption done on the device. It connects to the hosted
service and to self-hosted servers that the user chooses.

**Production components.**

- **Main process** (`desktop/src/main/main.ts`): one shell window that hosts up to four
  connection views (`desktop/src/main/shellWindow.ts`), credential custody, meaning that
  main holds each connection's refresh token and sign-in state
  (`desktop/src/main/tokenManager.ts`), the updater (`desktop/src/main/updater.ts`), the
  IPC registry (`desktop/src/main/ipc/registry.ts`), and the sign-in flows
  (`desktop/src/main/ipc/sso.ts`).
- **Preload** (`desktop/src/preload/preload.ts`): the `contextBridge` API, about 100 IPC
  call sites. It runs sandboxed and imports only `electron`.
- **Renderer** (`desktop/src/renderer/`): the React application. It holds the access token,
  the keys derived from the account password and all decrypted content
  (`desktop/src/renderer/services/e2ee/e2eeService.ts`).
- **Native capture child** (`desktop/native/concord-audiocap/`): a C++ addon for
  per-application audio, run in a utility process (`desktop/src/main/audiocapHost.ts`).

**Deployment modes.** (1) Hosted service: the view may load a remote renderer from the
hosted renderer origin, chosen by `desktop/src/main/spaLoader.ts`, with a signed local cache
and the bundled renderer as fallbacks. (2) Self-hosted server: the view always runs the
bundled renderer, in its own session and profile directory
(`docs/self-hosted-client.md`). (3) Development: a local dev server on `http://localhost:*`.

**Build and release workflows.** `.github/workflows/build-desktop.yml` and
`.github/workflows/release.yml` build unsigned artifacts. The release workflow attests each
artifact's build provenance and attaches an attested CycloneDX SBOM to each. Neither holds a
signing key or writes a release. Signing, notarization and publication happen in a
separate release pipeline outside this repository (`docs/release.md`). The other workflows
are scanners and gates (CodeQL, Semgrep, OSV, secret and IOC scanning, lockfile registry
checks).

**Tests.** `desktop/tests/` (unit, integration, Electron end-to-end), native tests and fuzz
targets under `desktop/native/concord-audiocap/test/`, and contract fixtures under
`services/control-plane/`. The fixtures are data for parity tests; no server is built here.

**Other folders, none shipped in the application.** `tools/concord-bridge/` is a local
developer tool that starts AI agent workers. `infrastructure/signing/linux-update.pub` is a
public key. `scripts/` holds CI and supply-chain checks. `desktop/spikes/` holds spikes.

## Assets

Ranked by value to an attacker.

1. **Message and media plaintext, and the keys that open it.** The wrapping key derived
   from the account password, the wrapped private key, channel keys and media frame keys,
   held in the renderer (`desktop/src/renderer/services/e2ee/e2eeService.ts`).
2. **Persisted session secrets.** The refresh token and the E2EE session keys, encrypted
   with the OS keychain through `desktop/src/main/secureStorage.ts` and stored per profile
   under `userData`.
3. **Code-execution integrity.** The installed binary, the renderer code it loads, and the
   update path. Whoever controls these controls assets 1 and 2 for every user.
4. **Main-process authority.** OS browser launch, file save, clipboard, screen and audio
   capture, microphone and camera, tray, window lifecycle, update install.
5. **Account identity.** The access token and session in the renderer, the OAuth and MFA
   ceremonies in main, and the per-installation machine identifier
   (`desktop/src/main/machineId.ts`).
6. **Connection isolation.** One server must not read or act for another: separate
   sessions, custody and capture ownership per connection.
7. **Trust anchors in the binary.** The Linux update public key
   (`desktop/src/main/linuxUpdatePublicKey.ts`), the renderer-cache manifest keys
   (`desktop/src/main/spaCache/spaManifestPublicKey.ts`), the Windows publisher list
   (`desktop/src/shared/allowedWindowsPublishers.ts`).
8. **Personal data on the device.** Server list (`connections.json`), approvals, window
   state, logs, cached media.
9. **CI credentials and provenance.** The GitHub App key `PUBLIC_MIRROR_APP_PRIVATE_KEY`
   (repository secret, used by three workflows), `SONAR_TOKEN`, and the build attestation
   identity of `.github/workflows/release.yml`.

## Adversaries

| Adversary | Goal | Starts with | Does not have | A failure grants |
|---|---|---|---|---|
| Hostile or compromised server operator (a self-hosted server the user chose, or a compromised hosted service) | Read plaintext; take over the client; reach the user's local network | Full control of every API, WebSocket and media-plane response, the key directory, and client config | The user's account password, until the user signs in to that server; code execution in the client; other connections' sessions | Plaintext, or code execution with the preload bridge |
| Remote peer (authenticated user in a shared server or DM) | Run script in another user's client; phish; exhaust resources | Messages, markdown, names, attachments, invites, media frames, reachable through the server | Control of the server or the transport | Renderer compromise: plaintext, keys in use, the IPC surface |
| Controller of the remote renderer origin or its delivery path | Ship hostile renderer code to hosted-service users | The renderer origin, its hosting account, or a trusted certificate for it | The binary signing keys | The whole renderer trust domain for every hosted user |
| Network attacker | Intercept or alter traffic; freeze updates | On-path position; possibly a mis-issued certificate | Signing keys; the user's keys | Session theft, renderer substitution, update freeze |
| Compromised dependency or CI input | Put code into the shipped app or steal CI credentials | An npm package, a GitHub Action, a fork pull request, the synced agent tooling | Write access to `main`; signing keys | Code in every user's client, or the App token |
| Compromised developer machine or AI agent | Land hostile changes; widen an IPC class; exfiltrate secrets | A checkout, local tooling, agent permissions | Review bypass; signing keys | A reviewed-looking change that weakens a boundary |
| Local attacker (another process or another OS user on the device) | Steal tokens and keys; replace an update; drive the app | File access as the user or another user; loopback sockets; the `concord:` scheme | The OS keychain secret, unless running as the same user | Session and key theft, code execution at next install |
| Holder of a lost or shared device | Use the signed-in account; read history | The unlocked or powered-off device | The account password, unless Remember Me kept the keys | Account access and decryptable content |
| Anonymous web page or link sender | Drive the client through a deep link or the OAuth callback | A link the user opens; a page in the user's browser | Any app credential | An unwanted join or friend prompt, or a confused sign-in |

## Attack surface

"Reduction" marks a row that exists for convenience or legacy.

| # | Entry point | Code path | Who can reach it | Untrusted input | Reduction |
|---|---|---|---|---|---|
| S1 | IPC channels (82 classified, contract v37) and the one raw listener, `connection:whoAmI` | `desktop/src/main/ipc/registry.ts`, `desktop/src/main/ipc/channelClassification.ts`, `desktop/src/main/ipc/connection.ts`; privileged sinks in `desktop/src/main/ipc/saveImage.ts` (file write), `desktop/src/main/ipc/openExternal.ts` (OS browser), and the PiP, clipboard, capture-source, quit, relaunch and update-install handlers in `desktop/src/main/main.ts` | Any script in a bound view or PiP | Every argument; sender frame state | |
| S2 | Console capture for bug reports | `desktop/src/renderer/services/system/logBufferService.ts` | Any code that logs; server and peer strings that reach a log call | Log arguments, scrubbed at capture | |
| S3 | Remote renderer load and reload | `desktop/src/main/spaLoader.ts` | Hosted service, renderer origin | Client config JSON; all renderer code | |
| S4 | Signed renderer cache (`spa-cache:` scheme) | `desktop/src/main/spaCache/verifyManifest.ts`, `desktop/src/main/spaCache/cacheProtocol.ts` | Renderer origin; local file writer | Manifest, signature, cached files | |
| S5 | Bundled renderer (`app:` scheme) | `desktop/src/main/appProtocol.ts` | Any script in a view | Request URL | |
| S6 | Frame-origin allowlist entries for `file:` and `http://localhost:*` | `desktop/src/main/ipc/frameValidation.ts` | Unreachable while the navigation gate holds | Frame URL | Yes: legacy and dev origins stay accepted in packaged builds |
| S7 | Navigation and `window.open` | `desktop/src/main/connectionSession.ts` | Any script in a view | Target URL | |
| S8 | Message rendering (markdown, mentions, emoji, code highlight) | `desktop/src/renderer/components/Markdown/MarkdownContent.tsx`, `desktop/src/renderer/components/Markdown/sanitizeSchema.ts` | Authenticated users; server | Message text | |
| S9 | Embeds, GIFs, attachments, remote media | `desktop/src/renderer/utils/messaging/messageSanitizer.ts`, `desktop/src/renderer/utils/crypto/attachmentChunkedCrypto.ts`, `desktop/src/renderer/utils/ui/resolveMediaUrl.ts` | Authenticated users; server | URLs, ciphertext, media bytes | |
| S10 | Encrypted media frames | `desktop/src/renderer/services/e2ee/mediaEncryption.ts`, which calls the parsers in `desktop/src/renderer/services/e2ee/av1ObuParser.ts` and `desktop/src/renderer/services/e2ee/h264NalUnit.ts` | Call participants; media plane | Encoded frames | |
| S11 | API, WebSocket and media-plane responses | `desktop/src/renderer/services/system/apiClient.ts`, `desktop/src/renderer/services/messaging/websocketService.ts` | Server | All response bodies and events | |
| S12 | Recipient public keys | `desktop/src/renderer/services/e2ee/participantPublicKeys.ts` | Server | Key bytes and versions from `/api/v1/users/{id}/public-key` | |
| S13 | Auth responses handled in main (refresh, SSO, MFA, attestation) | `desktop/src/main/tokenManager.ts`, `desktop/src/main/authResponse.ts`, `desktop/src/main/attestationService.ts` | Server; identity providers | JSON bodies, tokens | |
| S14 | OAuth loopback listener on 127.0.0.1 | `desktop/src/main/ssoLoopback.ts` | Any local process; any page in the user's browser | Query and POST body | |
| S15 | `concord:` deep links (invite, friend, account erasure) | `desktop/src/main/deepLink.ts` | Unauthenticated: any page or local process | URL | |
| S16 | Self-hosted server probe and approval | `desktop/src/main/selfHostedProbe.ts`, `desktop/src/main/guardedRequest.ts`, `desktop/src/main/egressPolicy.ts`, `desktop/src/main/selfHostedApprovals.ts` | User-entered origin; that server | Origin, DNS answers, redirects, discovery JSON | |
| S17 | Update feed and artifacts | `desktop/src/main/updater.ts`, `desktop/src/main/updateSafety.ts`, `desktop/src/shared/updateEndpoint.ts` | Feed host: one public release address fixed in the binary at build time, the same for every connection, so a self-hosted server cannot be the feed host for its users; network; local cache writer | Manifest, installer, detached signature | |
| S18 | Permission requests (media, display capture, clipboard, HID) | `desktop/src/main/connectionSession.ts`, `desktop/src/main/capturePolicy.ts` | Any script in a view | Permission name, frame details | |
| S19 | Native audio capture and its port relay | `desktop/src/main/audiocapHost.ts`, `desktop/src/preload/audiocapRelay.ts` | Foreground view; the child process | Source id; PCM quanta; child messages | |
| S20 | Billing sheet | `desktop/src/main/billing/billingWindow.ts` | Hosted view; payment provider pages | URL; third-party page content | |
| S21 | Local state files under `userData` | `desktop/src/main/connectionsFile.ts`, `desktop/src/main/selfHostedApprovals.ts`, `desktop/src/main/tokenManager.ts` | Local file writer | JSON, ciphertext | |
| S22 | Developer mode (opens DevTools) | `desktop/src/main/main.ts` | Foreground view | Boolean | Yes: convenience in release builds |
| S23 | Dependencies, lockfiles, Actions | `desktop/package.json`, `.github/workflows/`, `.github/dependabot.yml` | Build-time | Package and action code | |
| S24 | Workflows on `pull_request_target` | `.github/workflows/labeler.yml`, `.github/workflows/workflow-validate.yml`, `.github/workflows/classify-release-comment.yml` | Build-time: any fork pull request | PR metadata | |
| S25 | Agent tooling sync, local agent bridge, spikes | `.github/workflows/sync-tooling.yml`, `tools/concord-bridge/README.md`, `desktop/spikes/connection-footprint/README.md` | Build-time; developer machine | Tooling repository content; worker output | Yes: developer convenience and experiments kept beside production code. Control on the sync: the workflow limits the change to `.claude/` and one script, refuses symlinks and opens a draft pull request; `CODEOWNERS` names the security team as owner of both paths; otherwise ordinary pull-request review only |

## Trust boundaries

| # | Boundary | Actors | What crosses | Control | Proof path |
|---|---|---|---|---|---|
| B1 | Renderer to main | View script, main process | Requests for privileged actions | Every channel has an admission class. The registry admits the sender synchronously: main frame, bound view, role, frame URL allowed for the service kind | `desktop/src/main/ipc/registry.ts`, `desktop/src/main/ipc/connectionSender.ts`, `desktop/src/main/ipc/frameValidation.ts` |
| B2 | Renderer process to OS | Renderer, Chromium sandbox | Node and OS access | `sandbox`, `contextIsolation`, no `nodeIntegration` on every window and view constructor; on connection views they are pinned last so no caller can loosen them | `desktop/src/main/shellWindow.ts`, `desktop/src/main/browserWindowConfig.ts`, `desktop/src/main/splashWindow.ts`, `desktop/src/main/billing/billingWindow.ts` |
| B3 | Connection to connection | Hosted view, self-hosted views | Cookies, credentials, capture, tray, OS browser | One session and one custody per service; custody is taken from the main-held binding, never from a renderer argument; foreground-only classes | `desktop/src/main/connectionSession.ts`, `desktop/src/main/connectionRegistry.ts` |
| B4 | Remote content to DOM | Peers, server, renderer | Text, links, media | Sanitizer schema with no raw HTML; link protocol allowlist checked three times; meta CSP | `desktop/src/renderer/components/Markdown/sanitizeSchema.ts`, `desktop/src/renderer/components/Markdown/SafeLink.tsx`, `desktop/src/main/ipc/openExternal.ts`, `desktop/index.html` |
| B5 | View to other origins | View script | Top-level navigation, new windows | For navigation the renderer starts: an origin allowlist per service kind. Every `window.open` is denied. Only https goes to the OS browser, and only from the foreground view. This gate is the only layer for navigation (W8) | `desktop/src/main/connectionSession.ts` |
| B6 | Server to plaintext | Server operator, client | Ciphertext and wrapped keys only | Encryption and key unwrap on the device; server holds no key | `desktop/src/renderer/services/e2ee/e2eeService.ts`, `desktop/src/renderer/utils/crypto/crypto.ts` |
| B7 | Main to disk | Main, local file system | Refresh token, E2EE session keys | OS keychain encryption; on Linux only keyring-backed ciphertext is written or read; atomic 0o600 writes | `desktop/src/main/secureStorage.ts`, `desktop/src/main/tokenManager.ts` |
| B8 | Renderer origin to shell | Hosted service, shell | Renderer code | HTTPS, exact origin pin, IPC contract check; the cache needs a valid manifest signature, hashes and freshness | `desktop/src/main/spaLoader.ts`, `desktop/src/main/spaCache/verifyManifest.ts` |
| B9 | Update feed to binary | Feed host, updater | Installer bytes | Linux: Ed25519 signature against a bundled key. Windows: Authenticode, publisher allowlist, issuer pin, checked at download and at install. macOS: OS signature and notarization checks | `desktop/src/main/updater.ts`, `desktop/src/main/verifyLinuxSignature.ts`, `desktop/src/main/verifyWindowsSignature.ts`, `docs/policies/update-trust-model.md` |
| B10 | User-chosen origin to local network | Self-hosted origin, main | Outbound requests from main | Address classes: metadata, link-local and reserved ranges are never dialed; loopback, private, unique-local and carrier-grade NAT ranges only after a native approval; every resolved address is checked; cross-origin redirects refused | `desktop/src/main/egressPolicy.ts`, `desktop/src/main/guardedRequest.ts` |
| B11 | Main to native child | Main, capture child, renderer | Audio samples, control messages | Utility process with an allowlisted environment. The preload relay accepts only a decodable audio buffer from the child and sends the child only a credit message it builds itself; anything else closes both ports. The page gets a second, preload-made port | `desktop/src/main/audiocapHost.ts`, `desktop/src/preload/audiocapRelay.ts` |
| B12 | Payment page to app | Third-party page, main | Navigation result | No preload, in-memory partition, all permissions denied, host allowlist for the main frame | `desktop/src/main/billing/billingWindow.ts` |
| B13 | Packaged app integrity | Local attacker, binary | Code loaded at start | Five Electron fuses, asar integrity, read back from the produced app in CI | `desktop/forge.config.ts`, `desktop/scripts/verify-packaged-app.mts` |
| B14 | Contributor to CI authority | Fork PR, workflows | Tokens, attestation identity | Actions pinned by commit; `pull_request_target` jobs check out the base commit only; release workflow has attestation permissions and no secret, and attests build provenance and a CycloneDX SBOM for each artifact; the Semgrep job, which holds pull-request and code-scanning write grants, takes its scanner lock, rules and ignore file from a trusted commit (the protected workflow commit or the pull-request base), not from the pull-request tree | `.github/workflows/release.yml`, `.github/workflows/workflow-validate.yml`, `.github/workflows/semgrep.yml`, `docs/release.md` |
| B15 | OS and local processes to main | Browser pages, local processes, main | OAuth callback parameters; `concord:` URLs | Callback listener bound to 127.0.0.1 on an ephemeral port, one exact path, a body cap and a timeout; one `state` value compared in constant time; PKCE verifier made and kept in main. Deep links must match a closed scheme, host and code shape, and their channels are classed hosted-only | `desktop/src/main/ssoLoopback.ts`, `desktop/src/main/oauth/pkce.ts`, `desktop/src/main/deepLink.ts`, `desktop/src/main/ipc/channelClassification.ts` |

## Security objectives

A change must keep each of these true. Each is written so a reviewer can test it.

1. Every `ipcMain` registration goes through `registerIpc` with a row in `CHANNEL_CLASSES`;
   the only exception is `connection:whoAmI`. Admission contains no `await`.
2. No window or view (connection views, PiP, splash, billing) is created without
   `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`. No build flag
   turns these off.
3. A handler takes custody, service and connection from the admitted sender only. A
   renderer-supplied origin is a cross-check, never a selector.
4. A self-hosted view never loads the remote renderer or its cache, and never runs on the
   default session.
5. No refresh token, OAuth code, PKCE verifier or provider secret crosses from main to a
   renderer.
6. Nothing is written to disk as a secret unless the OS keychain protects it. When it does
   not, sign-in fails closed.
7. Rendered message content contains no raw HTML, no script, and no link protocol other
   than http, https and mailto.
8. No renderer-initiated top-frame navigation leaves the view's allowed origins. No in-app
   window opens for a remote URL.
9. No update is installed unless its platform check passed in the installing session.
   A missing signature refuses the install.
10. The remote renderer is loaded only from the pinned hosted origin over HTTPS, and only
    for the hosted service.
11. Main never dials metadata, link-local or reserved addresses, and dials loopback,
    private, unique-local and carrier-grade NAT addresses only for an origin the user
    approved in the native dialog.
12. No media is published without an encrypt transform. It attaches in the sender-creation
    callback, before the offer; a failure aborts the publish and stops the capture. A frame
    that fails to parse or decrypt is dropped
    (`desktop/src/renderer/services/voice/voiceService.ts`,
    `desktop/src/renderer/services/e2ee/mediaEncryption.ts`).
13. Key material, tokens, invite codes and ICE credentials never reach a log line.
14. Workflows that run for fork pull requests never execute pull-request code with a
    secret or a write token in scope.
15. No message text and no attachment bytes leave the device unencrypted: every send, edit
    and upload encrypts first, and a failed encryption stops it. A message or attachment
    that fails to decrypt shows an error or a pending state, never the ciphertext and never
    a plaintext fallback (`desktop/src/renderer/hooks/messaging/useMessaging.ts`,
    `desktop/src/renderer/hooks/messaging/useChatController.ts`,
    `desktop/src/renderer/services/messaging/dmMessageSender.ts`,
    `desktop/src/renderer/hooks/messaging/useFileUpload.ts`,
    `desktop/src/renderer/hooks/messaging/useMessageFetch.ts`,
    `desktop/src/renderer/components/Chat/AttachmentDisplay.tsx`).

## Attack paths

Each row is a hypothesis to test, not a finding. Ranked by what a failure grants.

| # | Attacker goal | Path through the surface | Boundary that must hold | Existing control | A failure grants | Tags |
|---|---|---|---|---|---|---|
| P1 | Run code in every hosted user's renderer | Take the renderer origin or a certificate for it, serve altered code (S3) | B8 | HTTPS, exact origin pin, contract check | Plaintext, keys in use, the full bridge | A08, A03, V12, V15, CWE-494, PR |
| P2 | Read E2EE content as the server | Answer the key directory with a key the operator holds (S12), wait for the next key wrap | B6 | Server-side key-version checks; a device-side floor on RSA key size (`desktop/src/renderer/utils/crypto/crypto.ts`), which does not show who supplied the key; no device-side verification of the key's owner is wired (`desktop/src/main/authority/README.md`) | Keys wrapped after the change | A04, A06, V11, CWE-345, PR |
| P3 | Reach main from a compromised renderer | Call a channel whose handler trusts its payload, or a class that is too wide (S1) | B1 | Admission classes, per-handler validators, classification tests | File write, OS browser, capture, credential clears | A01, A06, V2, V4, V8 |
| P4 | Script execution from a message | Markdown, mention, emoji or highlight output that survives the schema (S8) | B4 | Sanitizer schema, script-free CSP, XSS corpus tests | Renderer compromise as that user | A05, V1, V3, CWE-79 |
| P5 | One server acts for another | A background or self-hosted view calls a foreground or hosted-only action (S1, S18) | B3 | Foreground and hosted-only classes; per-service sessions; capture lease | Cross-connection capture, phishing over the visible view | A01, V8, V17 |
| P6 | Install a hostile or stale binary | Control the feed: serve an old signed build, or say "up to date" (S17) | B9 | Artifact signatures; manifest hash | Users pinned to a known-vulnerable build | A08, A03, V15, DE, RC |
| P7 | Replace the installer locally | Write the updater cache between verification and execution (S17) | B9 | Verify at install; documented residual race | Code execution at install | A08, CWE-367, PR |
| P8 | Take the session from disk | Read profile files as the same user, or from a device image (S21) | B7 | Keychain encryption; Linux keyring tag check; fuses | Refresh token and session keys | A04, V14, V7 |
| P9 | Use the client to probe the local network | Enter or redirect to an internal address; rebind DNS (S16) | B10 | Address tiers on every resolved address; approval ceremony | Requests to internal services from the user's machine | A01, A06, V4, CWE-918 |
| P10 | Hijack a sign-in | Race the loopback callback, or replay a code (S14) | B15, B3 | Loopback bind, ephemeral port, single `state`, PKCE (`desktop/src/main/oauth/pkce.ts`), one flow per provider | A session bound to the wrong identity | A07, V10, V6 |
| P11 | Cross-account action by link | Send a `concord:` link, wait for an account switch (S15) | B15 | Strict code shapes; hosted-view-only delivery; owner fence on queued codes | An invite or friend prompt in another account | A06, V2 |
| P12 | Code into the build | Malicious package version, action, or tooling sync content (S23, S25) | B14 | Commit-pinned actions, lockfile registry check, IOC and OSV scans, review | Code in the shipped app | A03, A08, V15, LLM03, GV, ID |
| P13 | CI credential theft | A fork pull request reaches a job with a token (S24) | B14 | Base-commit checkout, no checkout in the labeler, minimal permissions | The App token or a write token | A03, A02, V13 |
| P14 | Native memory corruption | Malformed capture input reaches the addon or the ring (S19) | B11 | Utility process isolation, fuzz targets, per-quantum validation | Code execution in the child | A06, A10, V15 |

## Weakest ground

Ranked. Scans start here. These describe where the design is thin, not present defects.

1. **W1. The remote renderer is trusted on transport alone.** Live renderer code is
   authenticated by HTTPS and an origin pin. Signature and hash checks cover only the
   fallback cache. One control stands between the renderer origin and every asset in the
   renderer. The trust model document states this boundary
   (`docs/policies/update-trust-model.md`).
2. **W2. One source for recipient keys.** The client wraps channel keys to public keys that
   the server supplies. The account-key authority verifier exists in the binary and nothing
   calls it (`desktop/src/main/authority/README.md`). There is no second layer against an
   operator-held key. The account password that signs the user in is also the input that
   unwraps the user's private key (`desktop/src/renderer/components/Auth/Login.tsx`,
   `desktop/src/renderer/utils/crypto/crypto.ts`), so confidentiality against the operator
   rests on the server not keeping it.
3. **W3. The renderer is one compromise domain.** Decrypted content, the access token and
   usable key handles share one script context with all message rendering. The sanitizer
   schema calls itself the sole XSS defence
   (`desktop/src/renderer/components/Markdown/sanitizeSchema.ts`); the CSP is a meta tag
   with inline styles allowed and a wildcard first-party subdomain in `connect-src`.
4. **W4. IPC surface that each release widens.** The contract has moved through 37
   versions. Sender admission is central, but payload validation is written per handler,
   and `desktop/src/main/main.ts` is over 4,000 lines of them. A new handler with a weak
   validator is admitted like any other.
5. **W5. Parsers of untrusted bytes.** AV1 and H.264 frame parsers, chunked attachment
   decryption, the markdown plugin chain, the C++ capture addon, and the authority codec.
6. **W6. Update trust has no freshness and no atomic install.** A feed controller can hold
   users on an old signed build. Verification and execution are separate steps on a
   user-writable cache. macOS has no app-level check and relies on the OS. All three are
   documented residuals.
7. **W7. Long-lived secrets at rest under one OS control.** Remember Me keeps the refresh
   token and E2EE session keys on disk, protected only by the OS keychain. On Windows and
   Linux any process running as the user can ask it; on macOS the item is bound to the
   application. Fuses not set in `desktop/forge.config.ts` keep Electron's defaults.
8. **W8. Navigation and frame-origin guards have one layer each.** The frame-origin
   allowlist is wider than packaged builds need (S6); only the navigation gate keeps a
   frame from being there. The navigation gate covers navigation that the renderer starts,
   and connection views have no second gate behind it
   (`desktop/src/main/connectionSession.ts`). A redirect can only start from an origin the
   gate already admitted.
9. **W9. A user-chosen server is trusted after one dialog.** Approval is the only gate for
   dialing loopback, private, unique-local and carrier-grade NAT addresses, and certificate
   trust is the OS store with no pinning.
10. **W10. Build inputs outside this repository.** Signing happens elsewhere, so the build
    provenance and SBOM attestations are the only link from source to signed binary. Agent
    tooling is copied in weekly from another repository by a pull request. `CODEOWNERS` names
    the security team as owner of its paths; otherwise it gets ordinary pull-request review
    only. One GitHub App key with write access serves three workflows.

## Hardening and surface reduction

Ranked. Each names the weakest-ground item it answers.

| # | Kind | Action | Answers |
|---|---|---|---|
| H1 | Add a second layer | Verify renderer bytes locally before they run: load the remote renderer only through the signed-manifest path, so the origin alone cannot change code | W1 |
| H2 | Add a second layer | Wire the account-key authority verdict into key wrapping and show key changes to the user, with first-sight pins held in main | W2 |
| H3 | Narrow surface | Move key handling and decryption out of the document that renders remote content, or deliver CSP as a response header from the protocol handlers with no inline styles and exact hosts | W3 |
| H4 | Add a second layer | Give every channel a declared payload schema that the registry enforces before the handler, and fail the build when a row has none | W4 |
| H5 | Remove surface | Drop `file:` and the dev origin from the packaged frame allowlist | W8 |
| H6 | Add a second layer | Gate main-frame redirects on connection views with the same allowlist that `will-navigate` uses, as the billing view already does | W8 |
| H7 | Add a second layer | Add signed manifest freshness for binary updates, and install from a location the user cannot write, or re-verify by handle at execution | W6 |
| H8 | Narrow surface | Set the remaining Electron fuses on purpose (Node options, file-protocol privileges), and record the decision beside the five that are set | W7 |
| H9 | Narrow surface | Shorten what Remember Me keeps: bind the persisted keys to an OS user-presence check where the platform offers one | W7 |
| H10 | Add a second layer | Fuzz the frame parsers and attachment decryption in CI as the capture ring already is; use OWASP WSTG client-side cases for the markdown chain | W5 |
| H11 | Add a second layer | Offer certificate pinning or a shown fingerprint for approved self-hosted origins | W9 |
| H12 | Remove surface | Remove Developer mode from release builds or put it behind a native confirmation | W4 |
| H13 | Remove surface | Move `tools/concord-bridge/` and `desktop/spikes/` out of the product repository | W10 |
| H14 | Narrow surface | Give each workflow its own narrowly scoped App credential in place of the one shared key | W10 |

## Assumptions and unknowns

- **Prerequisite.** The OS, its keychain and its certificate store are not compromised. An
  attacker with administrator rights on the device is out of scope.
- **Prerequisite.** Signing keys, notarization and release publication are held by a
  release pipeline outside this repository. This model covers the client's checks of the
  result. The release steps in `docs/policies/update-trust-model.md` are provided facts.
- **Prerequisite.** Server-side authorization, rate limits and key storage belong to the
  server repositories. This model treats every server as untrusted input.
- **Prerequisite.** A self-hosted server needs a certificate the OS trusts
  (`docs/self-hosted-client.md`).
- **Exclusion.** A user who changes the local clock, or who has physical access to an
  unlocked signed-in session, is outside the update and cache freshness guarantees
  (`docs/policies/update-trust-model.md`).
- **Exclusion.** Screen-capture protection is best effort, not a guarantee against recording.
- **Exclusion.** Objective 15 covers message text and attachment bytes. Data sent beside
  them is visible to the server: channel, sender and timing, mention and reply references,
  and an attachment's size
  (`desktop/src/renderer/services/messaging/websocketService.ts`,
  `desktop/src/renderer/hooks/messaging/useFileUpload.ts`). Event rows that the server
  writes carry no message text and are shown without decryption after a shape check.
- **Privacy roles (provided fact).** For a self-hosted server the operator is the data
  controller; for the hosted service Concord Voice LLC is. Users must be at least 16. See
  `docs/privacy-policy.md` sections 15 (age and minors, COPPA) and 18.1.

## Standards alignment

All frameworks are alignment targets. None is a claim of compliance or certification.

| Framework | What it prioritises here |
|---|---|
| OWASP Top 10:2025 | A08 and A03 for the renderer and update trust chains (P1, P6, P12); A01 for IPC and connection isolation; A04 for key handling; A05 for message rendering |
| OWASP ASVS 5.0, with the OWASP Cheat Sheet Series as review method | V3 and V1 for the renderer; V11 and V14 for keys at rest and in use; V10 and V6 for the OAuth and MFA custody in main; V17 for media encryption and capture; V15 for the build chain |
| NIST CSF 2.0 | PR for boundaries B1 to B15; DE for update-freeze and tamper signals, which are thin today; GV and ID for build inputs |
| NIST SP 800-63-4 | Session lifetime and authenticator handling for Remember Me, MFA and security keys |
| FIPS 140-3 | Algorithm choice only (AES-GCM, RSA-OAEP, Ed25519); no validated module is claimed |
| OWASP Top 10 for LLM Applications 2025 | LLM03 Supply Chain, for agent tooling that arrives by pull request (S25, P12) |
| NIST AI RMF 1.0 | Agent tooling that can change this repository (S25): review of agent-made changes to boundary files |
| GDPR (anchor), with UK GDPR and DUA Act, CCPA/CPRA, VCDPA, TDPSA, CTDPA, RIDTPPA, PIPEDA and Quebec Law 25, Australia Privacy Act 1988, Mexico federal law, COPPA | The client stores personal data on the device and sends it to a controller the user chose. Drives lawful basis and minimisation for local state and logs, clearing credentials on logout, the account-erasure deep link, breach notice by the controller, and children's data rules (`docs/privacy-policy.md`) |
| HIPAA | A hardening target only: no BAA is offered and no compliance is claimed. Raises the priority of W2, W3 and W7 |
| SOC 2, ISO/IEC 27001, CIS Critical Security Controls | Change control over `CHANNEL_CLASSES`, trust anchors and workflows; evidence that packaged-app checks ran |
