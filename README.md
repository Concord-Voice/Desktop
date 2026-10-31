# Concord Voice Desktop

<a href="https://sonarcloud.io/summary/new_code?id=Concord-Voice_Desktop"><img align="right" src="https://sonarcloud.io/api/project_badges/quality_gate?project=Concord-Voice_Desktop" alt="Quality gate" /></a>

[![Lines of Code](https://sonarcloud.io/api/project_badges/measure?project=Concord-Voice_Desktop&metric=ncloc)](https://sonarcloud.io/summary/new_code?id=Concord-Voice_Desktop)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=Concord-Voice_Desktop&metric=coverage)](https://sonarcloud.io/summary/new_code?id=Concord-Voice_Desktop)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Concord-Voice_Desktop&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=Concord-Voice_Desktop)
[![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Concord-Voice_Desktop&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=Concord-Voice_Desktop)
[![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=Concord-Voice_Desktop&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=Concord-Voice_Desktop)
[![Main CI](https://github.com/Concord-Voice/Desktop/actions/workflows/main-ci.yml/badge.svg)](https://github.com/Concord-Voice/Desktop/actions/workflows/main-ci.yml)

[![AI Code Assurance](https://sonarcloud.io/api/project_badges/ai_code_assurance?project=Concord-Voice_Desktop)](https://sonarcloud.io/summary/new_code?id=Concord-Voice_Desktop)
[![Dependabot](https://img.shields.io/badge/Dependabot-enabled-success?logo=dependabot)](./.github/dependabot.yml)
[![license](https://img.shields.io/badge/license-CVSL%201.0-blue)](./LICENSE)
[![security](https://img.shields.io/badge/security-policy-green)](https://github.com/Concord-Voice/.github/blob/main/SECURITY.md)
[![E2EE](https://img.shields.io/badge/E2EE-AES--256--GCM%20%2F%20RSA--OAEP%204096-success)](https://github.com/Concord-Voice/Self-Hosted/blob/main/docs/architecture.md)
[![platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-blue)](https://github.com/Concord-Voice/Desktop/releases/latest)
[![SonarQube Cloud](https://sonarcloud.io/images/project_badges/sonarcloud-dark.svg)](https://sonarcloud.io/summary/new_code?id=Concord-Voice_Desktop)

The Concord Voice desktop app for Windows, macOS, and Linux.

**Website:** [www.concordvoice.com](https://www.concordvoice.com) | **Wiki:** [Desktop wiki](https://github.com/Concord-Voice/Desktop/wiki) | **Security:** security@concordvoice.com

---

## Introduction

Concord Voice is a privacy-first place to talk with your friends, your community, or your team. It gives you voice calls, video, screen sharing, and chat. Your device encrypts each message before it leaves, so our servers hold only scrambled data that we cannot read. You can use our hosted service, or you can run the same software on your own hardware.

This repository holds the desktop app. It is the program you install on your computer to join servers, talk, and chat.
It works with the hosted service and with servers that people run themselves.

Get the newest version from the [Releases page](https://github.com/Concord-Voice/Desktop/releases/latest).
The app also updates itself when a new version is out.

For guides and background, see the [Desktop wiki](https://github.com/Concord-Voice/Desktop/wiki).

---

## Technical overview

Electron desktop application and the concord-bridge development workspace.

Use Node.js 24 and the checked-in npm lockfiles:

```bash
cd desktop
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

The bridge has its own lockfile and commands under `tools/concord-bridge`.

Local checks run through [pre-commit](https://pre-commit.com/) (secret scanning,
workflow lints, Semgrep, Prettier, ESLint and tsc):

```bash
pipx install pre-commit
pre-commit install --hook-type pre-commit --hook-type commit-msg
```
Root contract fixtures, legal documents and scripts are required build inputs.
The encryption engine and event schema remain in-tree.

CI packages unsigned test artifacts. Signing and publication remain outside this
repository; Alpha's desktop release lane remains authoritative during extraction.
The update endpoint and its trust model are unchanged.

See [the extraction record](docs/extraction/D1.md) for scope and CI deviations.

---

## Security

The app encrypts messages on your device with AES-256-GCM and wraps keys with RSA-OAEP 4096. It keeps credentials in the operating system keychain. The renderer runs with context isolation and the sandbox on, and every IPC channel checks its sender.

Report a vulnerability by email to security@concordvoice.com. Do not open a public issue for it. The [security policy](https://github.com/Concord-Voice/.github/blob/main/SECURITY.md) describes the disclosure process.

---

## Contributing

We welcome help. Read the [contributing guide](https://github.com/Concord-Voice/.github/blob/main/CONTRIBUTING.md) and the [code of conduct](https://github.com/Concord-Voice/.github/blob/main/CODE_OF_CONDUCT.md) before you open a pull request. Report bugs and request features in our [feedback repository](https://github.com/Concord-Voice/Concord-Voice/issues).

---

## License

This repository uses the Concord Voice Source License 1.0 (CVSL 1.0). Anyone can read the source. Personal and non-profit use is free. Commercial self-hosted use by a for-profit or government entity needs a commercial license. On 2030-02-15 the license converts to AGPL-3.0-or-later.

See [LICENSE](./LICENSE) for the full terms.

---

## Contact

- **Website:** [www.concordvoice.com](https://www.concordvoice.com)
- **Security:** security@concordvoice.com
- **Privacy:** privacy@concordvoice.com
- **General:** contact-us@concordvoice.com
