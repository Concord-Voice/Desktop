/** Canonical public host for invite links (Slice 2 will serve a landing page here). */
export const INVITE_HOST = 'invite.concordvoice.chat';

/**
 * 8 chars from the ambiguity-stripped charset in
 * services/control-plane/internal/invites/code.go:
 *   ABCDEFGHJKLMNPQRSTUVWXYZ abcdefghjkmnpqrstuvwxyz 23456789
 * Upper excludes I,O (keeps L); lower excludes i,l,o; digits exclude 0,1.
 *
 * This is one of THREE independent copies of the charset predicate — the others
 * are `INVITE_CODE_PATTERN` in
 * internal-reference and
 * `INVITE_CODE_RE` in desktop/src/main/deepLink.ts. #1557's
 * variable-length vanity slugs must relax all three; missing the Worker copy is
 * a validation bypass on the anonymous edge path.
 */
const CODE_CLASS = 'A-HJ-NP-Za-hj-km-np-z2-9';
const INVITE_CODE_RE = new RegExp(`^[${CODE_CLASS}]{8}$`);

export function isValidInviteCode(code: string): boolean {
  return INVITE_CODE_RE.test(code);
}

export function buildInviteUrl(code: string): string {
  return `https://${INVITE_HOST}/${code}`;
}

/** Characters that separate a URL from surrounding prose. */
const URL_DELIMITER = /[\s<>"')]/;
const SLASH: ReadonlySet<string> = new Set(['/']);
const TRAILING_PUNCTUATION = new Set(['.', ',', '!', '?', ';', ':', "'", '"', ')', ']', '}']);

/**
 * Each run of non-delimiter text, from its first `http://` / `https://`
 * (case-insensitive) to the run's end. Same matches as
 * `/https?:\/\/[^\s<>"')]+/gi`, without the unbounded class: the split class
 * matches one character and the scheme regex has no repetition, so the scan
 * stays linear on hostile input.
 */
function urlCandidates(text: string): string[] {
  const out: string[] = [];
  for (const run of text.split(URL_DELIMITER)) {
    // Match on the original string: toLowerCase() can change its length (U+0130),
    // which would shift any index taken from the lowered copy.
    const m = /https?:\/\//i.exec(run);
    if (m && run.length > m.index + m[0].length) out.push(run.slice(m.index));
  }
  return out;
}

function trimTrailing(value: string, chars: ReadonlySet<string>): string {
  let end = value.length;
  while (end > 0 && chars.has(value[end - 1])) end--;
  return value.slice(0, end);
}

/**
 * Find canonical invite-link codes in free text. ONLY exact-host
 * `https://invite.concordvoice.chat/{code}` URLs match (host parsed via the URL
 * API for exactness — no bare codes, no look-alike hosts, https only). Deduped,
 * capped (default 3) — the anti-probing / anti-amplification rule.
 */
export function extractInviteCodes(text: string, max = 3): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const cand of urlCandidates(text)) {
    let code: string | null = null;
    try {
      // Strip trailing punctuation that can never be part of a canonical invite
      // URL but may appear when a link ends a sentence or sits inside brackets.
      const trimmed = trimTrailing(cand, TRAILING_PUNCTUATION);
      const u = new URL(trimmed);
      if (u.protocol === 'https:' && u.host === INVITE_HOST) {
        const path = trimTrailing(u.pathname.replace(/^\/+/, ''), SLASH);
        if (isValidInviteCode(path)) code = path;
      }
    } catch {
      // not a URL — skip
    }
    if (code && !seen.has(code)) {
      seen.add(code);
      out.push(code);
      if (out.length >= max) break;
    }
  }
  return out;
}

/** Render-gate: never resolve invites in a message whose content isn't decrypted. */
export function messageInviteCodes(
  content: string,
  flags: { pendingKeys?: boolean; decryptFailed?: boolean }
): string[] {
  if (flags.pendingKeys || flags.decryptFailed) return [];
  return extractInviteCodes(content);
}
