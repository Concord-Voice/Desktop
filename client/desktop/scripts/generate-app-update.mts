#!/usr/bin/env -S npx tsx
// Generator for client/desktop/app-update.yml.
//
// Reads UPDATE_ENDPOINT_URL from src/constants/updateEndpoint.mts and emits
// the electron-updater app-update.yml YAML to stdout. Invoked from
// .github/workflows/build-desktop.yml (Generate app-update.yml step) via
// `npx tsx scripts/generate-app-update.mts > app-update.yml`.
//
// Exposes a pure `renderAppUpdateYaml()` for unit testing; the CLI shim at
// the bottom runs the renderer only when invoked directly.

import { UPDATE_ENDPOINT_URL } from '../src/constants/updateEndpoint.mts';
import { fileURLToPath } from 'node:url';

export function renderAppUpdateYaml(url: string = UPDATE_ENDPOINT_URL): string {
  return `provider: generic\nurl: ${url}\n`;
}

/* istanbul ignore next -- thin CLI entry shim; renderAppUpdateYaml is covered by tests */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(renderAppUpdateYaml());
}
