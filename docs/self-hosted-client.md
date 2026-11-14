# Self-Hosted Desktop Client

The desktop client can connect to a self-hosted Concord Voice control plane. The
main process must validate the server origin first.

## Requirements

- A running self-hosted control plane reachable over HTTP(S).
- `/api/v1/client/config` and `/api/v1/server/capabilities` must both be reachable without authentication.
- Non-localhost servers must use HTTPS.
- The operating system or a public CA must trust the certificate.

## Connection Flow

1. Choose **Self-Hosted** in the desktop connection selector.
2. Enter the server origin, for example `https://concord.example.com`.
3. The main process normalizes the origin and rejects credentials and unsafe
   schemes. It then probes both public discovery endpoints with Electron
   `net.fetch` and `credentials: 'omit'`.
4. Only after a successful probe may the renderer route auth storage and runtime
   API/WebSocket/media URLs to that origin.

SaaS remains the default. Self-hosted selection is session-scoped in the
renderer. The client isolates the persisted refresh token, E2EE key material,
token metadata, and machine ID under `profiles/<sha256(origin)>/`. That directory
sits inside the pinned desktop `userData` root.

## Connection Model

Each service runs in its own view inside one desktop window: CVNet (SaaS) and every
approved self-hosted server get a separate view, with at most four views live at once.
The CVNet view keeps Electron's default session. A self-hosted view uses its own
session at `profiles/<sha256(origin)>/session`, so its cookies, cache and local UI
storage are separate from every other service.

The shell records which connections to restore in `connections.json`, at the
`userData` root:

```json
{
  "version": 1,
  "connections": [
    {
      "serviceId": "selfhost-0123456789abcdef",
      "origin": "https://concord.example.com",
      "addedAt": "2026-11-09T00:00:00.000Z",
      "lastForegroundAt": null
    }
  ]
}
```

- The file holds no secrets and grants nothing. It is written with mode `0o600`
  through a temp file and a rename.
- Each entry is checked again at every startup. An entry is dropped when it has a
  missing or extra key, when its origin is not canonical or does not derive its
  `serviceId`, or when it names a self-hosted origin that is not in the approvals
  file. Only the first 16 entries are read.
- `lastForegroundAt` only chooses which view is shown first. Nothing reads it to
  decide whether a connection is allowed.

The first launch of a shell that has this file creates it from the files an older
shell left. If `active-profile.json` names an approved self-hosted server, that
server is listed, and CVNet is listed after it when the root `token-meta.json` holds
a Remember Me sign-in. Otherwise only CVNet is listed. Those older files are only
read. Nothing is moved, rewritten or deleted.

CVNet's view is always open, whether or not the file lists it. When CVNet is brought
to the front and has no entry, an entry is added for it then, so the next launch can
show it first. That entry decides only which view is shown first.

A new self-hosted connection starts with the default device-level UI settings. Its
settings are not copied from CVNet. Per-server settings are tracked in
[Self-Hosted#113](https://github.com/Concord-Voice/Self-Hosted/issues/113).

**Downgrading.** An older shell ignores `connections.json` and restores the profile
named by `active-profile.json`, whose path is unchanged. Only the local UI storage in a
self-hosted `session/` directory is lost to it.

**OAuth callback ownership.** Each connection's view can hold one ephemeral OAuth
callback listener on `127.0.0.1`. When a view starts a new one, for example to retry a
sign-in, its previous listener is closed. The listener also closes whenever its
connection moves on: a reload, a lost renderer, a credential change or disposal. A
listener is never shared between connections. Another connection's port, or a
connection's own port from a listener that has since closed, is refused as unknown.

## Voice and capture across connections

Only one connection can be in a voice call at a time, because the microphone can
only be in one call.

- **Joining while another connection is in a call.** The Join control's description
  says so before you click: "Your microphone is in a call on another connection.
  Joining here will ask before ending that call." Clicking Join opens a dialog with
  two choices. **Join** ends the call on the other connection and starts this one.
  **Stay** keeps the existing call; nothing changes and no error is shown.
- **The other connection sees you leave.** When a call moves, the connection that
  lost it leaves the channel the usual way, so other people in that call see you
  leave. When you next view that connection, a banner says "Your call ended because
  your microphone moved to another connection." It stays until you dismiss it or
  join again. Nothing rejoins on its own.
- **The dialog is drawn by the operating system,** not by Concord Voice, so it
  follows your OS appearance rather than the app's theme.
- **Microphone and camera tests** follow the same rule. A test cannot start while
  another connection is in a call, and a running test stops when you switch to
  another connection.

**Terminology.** These messages say "connection" for each server you are signed in
to. When [#88](https://github.com/Concord-Voice/Desktop/issues/88) settles the name,
every message changes together.

## TLS Modes

- **Let's Encrypt / public CA:** supported.
- **Imported private CA:** supported after the OS trust store trusts the CA.
- **Local self-signed:** supported only after the OS trusts the certificate. This
  slice does not implement in-app certificate consent or certificate pin
  persistence.

For server-side TLS setup, see the [self-host quickstart](https://github.com/Concord-Voice/Self-Hosted/blob/main/docs/runbooks/selfhost-quickstart.md) in the Self-Hosted repo.
