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

## TLS Modes

- **Let's Encrypt / public CA:** supported.
- **Imported private CA:** supported after the OS trust store trusts the CA.
- **Local self-signed:** supported only after the OS trusts the certificate. This
  slice does not implement in-app certificate consent or certificate pin
  persistence.

For server-side TLS setup, see the [self-host quickstart](https://github.com/Concord-Voice/Self-Hosted/blob/main/docs/runbooks/selfhost-quickstart.md) in the Self-Hosted repo.
