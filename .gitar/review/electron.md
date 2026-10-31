# Desktop review guidance

This repository is public. It holds the Electron desktop client in `desktop/`: main process (`src/main`), preload (`src/preload`), renderer (`src/renderer`, React + Zustand) and shared code (`src/shared`).

## Electron security

- Never disable `contextIsolation` or `sandbox`, in any build. Never enable `nodeIntegration` or use `@electron/remote`.
- Every IPC handler that reaches a privileged side effect (filesystem, keychain, network, shell, notifications, screen capture, auth flow) validates its sender first. `ipcMain.handle` handlers use `requireTrustedSender` from `src/main/ipc/frameValidation.ts` and return before any side effect for an untrusted frame.
- Every IPC payload is checked with a runtime type guard at the handler.
- `contextBridge` exposes only what the renderer needs. A new preload method or channel is a contract change and needs the contract version bumped.
- `shell.openExternal` only through the existing allowlisted helper.

## Renderer

- Incoming WebSocket payloads are validated at the dispatch boundary by the zod `WebSocketEvent` union; handlers use the narrowed type, not `any`.
- Build server URLs through `runtimeServerBase` (`apiUrl`, `mediaUrl`), never by string concatenation.
- No `innerHTML`, `document.write`, `eval`, `new Function`, or `dangerouslySetInnerHTML` with user content.
- No `any` and no non-null assertions in auth, crypto or E2EE code.
- Renderer or CSS changes should come with screenshots in both light and dark themes in the PR. Flag a visual change that has none.

## Tokens and key material

- Credentials and E2EE keys persist only through Electron `safeStorage` (`src/main/secureStorage.ts`), and only for remember-me sessions. Never localStorage or plaintext files.
- Never log tokens, keys or message payloads.
- A transient 401 must not delete persisted refresh tokens for a remember-me session.

## E2EE

- AES-256-GCM, RSA-OAEP 4096, ECDH P-384+, Argon2id; CSPRNG only. No new PBKDF2 call site.
- Flag any encryption opt-out, fallback, or `isEncrypted`-style branch.
- Key epochs: writes stamp the epoch the client attests; reads decrypt with the labelled epoch.
