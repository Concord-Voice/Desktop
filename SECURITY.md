# Security

> **Reporting a vulnerability?** Do not open a public issue. Follow the
> [Concord Voice disclosure policy](https://github.com/Concord-Voice/.github/blob/main/SECURITY.md).

## Threat model summary

- The desktop client treats every server, every message and every update feed as untrusted.
- The renderer holds decrypted content and keys in use. It is sandboxed and isolated, and
  it reaches the OS only through IPC channels that check their sender.
- Each server connection has its own session, credentials and capture ownership.
- Refresh tokens and sign-in ceremonies stay in the main process. Secrets on disk are
  protected by the OS keychain, or not written.
- Updates are installed only after a per-platform signature check.
- The thinnest ground is the trust placed in remotely delivered renderer code, in
  server-supplied public keys, and in the size of the IPC surface.

The full model, with adversaries, attack surface, trust boundaries and ranked hardening
work, is in [`docs/threat-model.md`](docs/threat-model.md).

## Guidance for automated review

This section is review guidance for people, AI agents and scanners. It is not the
disclosure scope; the disclosure policy above defines that.

**Report**

- An IPC handler that acts before sender admission, is registered outside the registry, or
  trusts a renderer-supplied origin, path or identifier.
- Any path from remote content to script execution, raw HTML, or a link protocol other
  than http, https and mailto.
- A secret (token, key, OAuth material, invite code, ICE credential) that reaches a
  renderer it should not, a log line, or disk without keychain protection.
- A way for one connection to read or act for another.
- A weaker window preference, navigation rule, CSP, fuse, or update signature check.
- A workflow change that gives pull-request code a secret or a write token.

**Do not report**

- Behaviour that needs administrator rights on the device, or a compromised OS keychain.
- Residual risks that `docs/policies/update-trust-model.md` already records, unless you
  show a new path to them.
- Missing server-side checks. Those belong to the server repositories.
- Test fixtures, spikes and probes that do not ship in the application.

**Severity**

- Critical: remote code execution, a bypass of update authenticity, account takeover
  without the victim's action, or loss of content confidentiality (plaintext or keys) for
  users other than the attacker.
- High: renderer-to-main escalation, cross-connection access, or access to another user's
  data, session or credentials that needs the victim's action or the victim's device.
- Medium: a missing second layer on a boundary that still holds; local-only disclosure.
- Low: hardening and surface reduction with no current path.
