#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

function sha512Base64OfFile(filePath) {
  const buf = readFileSync(filePath);
  return createHash('sha512').update(buf).digest('base64');
}

/**
 * Walk rootDir recursively and collect all paths whose basename equals the
 * given basename. Returns every match (caller checks for 0 or >1).
 */
function findArtifact(basename, rootDir) {
  const matches = [];
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) walk(full);
      else if (entry === basename) matches.push(full);
    }
  }
  walk(rootDir);
  return matches;
}

export function verifyManifest(manifestPath) {
  const errors = [];
  let manifest;
  try {
    manifest = parseYaml(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    return { ok: false, errors: [`failed to parse yaml: ${err.message}`] };
  }
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    return { ok: false, errors: ['manifest has no files array'] };
  }

  const manifestDir = path.dirname(manifestPath);
  for (const entry of manifest.files) {
    if (!entry.url || !entry.sha512) {
      errors.push(`manifest entry missing url or sha512: ${JSON.stringify(entry)}`);
      continue;
    }
    const matches = findArtifact(entry.url, manifestDir);
    if (matches.length === 0) {
      errors.push(`missing artifact ${entry.url}: not found under ${manifestDir}`);
      continue;
    }
    if (matches.length > 1) {
      errors.push(`ambiguous artifact ${entry.url}: ${matches.length} matches found`);
      continue;
    }
    const artifactPath = matches[0];
    let actual;
    try {
      actual = sha512Base64OfFile(artifactPath);
    } catch (err) {
      errors.push(`missing artifact ${entry.url}: ${err.message}`);
      continue;
    }
    if (actual !== entry.sha512) {
      errors.push(
        `sha512 mismatch for ${entry.url}: manifest=${entry.sha512.slice(0, 12)}… actual=${actual.slice(0, 12)}…`
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

// CLI entry: accepts one or more manifest paths; exits non-zero on any failure.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: verify-update-manifest.mjs <manifest.yml> [more.yml...]');
    process.exit(2);
  }
  let failed = false;
  for (const p of args) {
    const result = verifyManifest(p);
    if (result.ok) {
      console.log(`OK: ${p}`);
    } else {
      failed = true;
      console.error(`FAIL: ${p}`);
      for (const e of result.errors) console.error(`  - ${e}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
