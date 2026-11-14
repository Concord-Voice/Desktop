'use strict';
/**
 * Seeds a throwaway Concord profile for the Electron e2e (#86 Task 10).
 *
 * Runs under the Electron binary (NOT as node), so `app.getPath` resolves exactly as
 * the shell's own main process will under the same environment. It loads the BUILT
 * `pinUserDataPath` — the production resolution, the first thing main.ts imports —
 * and refuses to write anything unless the resulting userData sits beneath the temp
 * root. That is the pre-launch guard: the real profile is never opened for writing.
 *
 * The ledger and connections.json are written through the production writers
 * (`appendApprovalRecord`, `writeConnectionsFile`), never by hand.
 *
 * argv: <dist/main dir> <temp root> <JSON {"origins": string[]}>
 * stdout (exit 0): one JSON line {"userData": string, "serviceIds": string[]}
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const [, , distMain, tempRoot, payload] = process.argv;

function fail(code, message) {
  process.stderr.write(`[seedProfile] ${message}\n`);
  app.exit(code);
}

/** Resolves symlinks in the longest existing prefix (macOS: /var -> /private/var). */
function real(p) {
  let head = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(head)) {
    tail.unshift(path.basename(head));
    head = path.dirname(head);
  }
  return path.join(fs.realpathSync(head), ...tail);
}

function isBeneath(root, candidate) {
  const rel = path.relative(real(root), real(candidate));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

try {
  require(path.join(distMain, 'pinUserDataPath.js'));
  const userData = app.getPath('userData');
  if (!isBeneath(tempRoot, userData)) {
    fail(3, `userData resolved to ${userData}, outside ${tempRoot}; refusing to seed`);
  } else {
    fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
    const { appendApprovalRecord } = require(path.join(distMain, 'selfHostedApprovals.js'));
    const { writeConnectionsFile } = require(path.join(distMain, 'connectionsFile.js'));
    const { serviceIdForApiBase } = require(path.join(distMain, 'selfHostedProfile.js'));
    const { origins } = JSON.parse(payload);
    const now = new Date().toISOString();
    const entries = [];
    let ok = true;
    for (const origin of origins) {
      const saved = appendApprovalRecord({
        origin,
        approvedAt: now,
        lastSeenAddress: '127.0.0.1',
        tierAtApproval: 'tier2',
      });
      if (!saved) {
        ok = false;
        break;
      }
      entries.push({
        serviceId: serviceIdForApiBase(origin),
        origin,
        addedAt: now,
        lastForegroundAt: null,
      });
    }
    if (!ok) {
      fail(4, 'appendApprovalRecord refused a record');
    } else {
      writeConnectionsFile(userData, entries).then(
        () => {
          process.stdout.write(
            `${JSON.stringify({ userData, serviceIds: entries.map((e) => e.serviceId) })}\n`
          );
          app.exit(0);
        },
        () => fail(5, 'writeConnectionsFile failed')
      );
    }
  }
} catch (err) {
  fail(6, err instanceof Error ? err.message : 'seed failed');
}
