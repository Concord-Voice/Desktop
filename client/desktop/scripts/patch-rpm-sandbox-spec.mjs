#!/usr/bin/env node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleRequire = createRequire(import.meta.url);

export const RPM_SPEC_TEMPLATE_MODULE = 'electron-installer-redhat/resources/spec.ejs';

export const RPM_APP_DIR_LINE = '/usr/lib/<%= name %>/';
export const RPM_SANDBOX_ATTR_LINE =
  '%attr(4755, root, root) /usr/lib/<%= name %>/chrome-sandbox';

export function patchRpmSpecTemplateSource(source) {
  if (source.includes(RPM_SANDBOX_ATTR_LINE)) {
    return { source, changed: false };
  }

  const marker = `${RPM_APP_DIR_LINE}\n`;
  if (!source.includes(marker)) {
    throw new Error(
      `electron-installer-redhat spec template is missing expected app directory line: ${RPM_APP_DIR_LINE}`
    );
  }

  return {
    source: source.replace(marker, `${marker}${RPM_SANDBOX_ATTR_LINE}\n`),
    changed: true,
  };
}

export function patchRpmSpecTemplateFile(specPath) {
  const source = fs.readFileSync(specPath, 'utf8');
  const result = patchRpmSpecTemplateSource(source);
  if (result.changed) {
    fs.writeFileSync(specPath, result.source);
  }
  return result;
}

export function resolveRpmSpecTemplatePath() {
  return moduleRequire.resolve(RPM_SPEC_TEMPLATE_MODULE);
}

function isCliInvocation() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCliInvocation()) {
  const specPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : resolveRpmSpecTemplatePath();

  const { changed } = patchRpmSpecTemplateFile(specPath);
  const status = changed ? 'patched' : 'already patched';
  console.log(`[patch-rpm-sandbox-spec] ${status}: ${specPath}`);
}
