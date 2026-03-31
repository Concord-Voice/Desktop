import React from 'react';

/**
 * Matches a single "emoji atom": either a presentation emoji or a text-default
 * emoji followed by the variation selector (VS16). Characters like ☠ (U+2620) are
 * \p{Emoji} but NOT \p{Emoji_Presentation} — VS16 promotes them to emoji display.
 */
const EMOJI_ATOM = /(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/u;

/**
 * Matches complete emoji sequences including:
 * - Regional indicator pairs (country flags: 🇺🇸)
 * - Tag sequences (subdivision flags: 🏴󠁧󠁢󠁥󠁮󠁧󠁿)
 * - ZWJ sequences (🏴‍☠️, ❤️‍🔥, 👁️‍🗨️, 👨‍👩‍👧)
 * - Skin tone modifiers (👋🏽)
 * - Keycap sequences (1️⃣)
 *
 * Built from EMOJI_ATOM to keep regex complexity under SonarQube's limit of 20.
 */
export const EMOJI_REGEX = new RegExp(
  String.raw`(?:\p{Regional_Indicator}{2}` +
    String.raw`|\p{Emoji_Presentation}[\u{E0020}-\u{E007E}]+\u{E007F}` +
    String.raw`|${EMOJI_ATOM.source}(?:\u{200D}${EMOJI_ATOM.source}|\p{Emoji_Modifier}|\uFE0F?\u{20E3})*)`,
  'gu'
);

// Regex for mention patterns — supports both:
// - Token format: <@userId>, <@&roleId> (inserted by autocomplete, handles spaces in names)
// - Plain format: @username, @all, @here (typed manually or legacy)
const MENTION_REGEX = /<@&?[\w-]+>|@[\w.-]+/g;

// Token pattern matchers for resolving UUIDs to display names
const USER_TOKEN_RE = /^<@([\w-]+)>$/;
const ROLE_TOKEN_RE = /^<@&([\w-]+)>$/;

/** Precomputed lookup maps for O(1) mention token resolution. */
export interface MentionLookup {
  users: Map<string, string>; // userId → display name
  roles: Map<string, string>; // roleId → role name
}

/**
 * Detect emoji-only messages and return the count.
 * Returns 0 if the message contains any non-emoji text.
 * Uses Unicode emoji properties to match all standard emoji sequences.
 */
export function getEmojiOnlyCount(text: string): number {
  if (!text || text.length === 0) return 0;
  const stripped = text.replaceAll(EMOJI_REGEX, '').replaceAll(/[\s\u{FE0F}\u{200D}]/gu, '');
  if (stripped.length > 0) return 0;
  const matches = text.match(EMOJI_REGEX);
  return matches ? matches.length : 0;
}

/**
 * Returns a CSS class for emoji-only messages based on emoji count.
 * 1 emoji = largest (48px), linearly scales down to base (24px) at 5+.
 */
export function getEmojiSizeClass(count: number): string {
  if (count <= 0) return '';
  if (count === 1) return 'emoji-jumbo-1';
  if (count === 2) return 'emoji-jumbo-2';
  if (count === 3) return 'emoji-jumbo-3';
  if (count === 4) return 'emoji-jumbo-4';
  if (count === 5) return 'emoji-jumbo-5';
  return '';
}

/** Resolve a mention token to a display string using precomputed lookup maps. */
export function resolveMentionDisplay(token: string, lookup: MentionLookup): string {
  // User token: <@userId> → @displayName
  const userMatch = USER_TOKEN_RE.exec(token);
  if (userMatch) {
    const display = lookup.users.get(userMatch[1]);
    return display ? `@${display}` : token;
  }
  // Role token: <@&roleId> → @roleName
  const roleMatch = ROLE_TOKEN_RE.exec(token);
  if (roleMatch) {
    const name = lookup.roles.get(roleMatch[1]);
    return name ? `@${name}` : token;
  }
  // Plain format (@username, @all, @here) — return as-is
  return token;
}

/** Render emoji spans within a text segment (no mention handling). */
export function renderEmoji(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  EMOJI_REGEX.lastIndex = 0;
  while ((match = EMOJI_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <span key={match.index} className="emoji">
        {match[0]}
      </span>
    );
    lastIndex = EMOJI_REGEX.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

export function renderContent(text: string, lookup: MentionLookup): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  // Combine emoji and mention patterns into a single pass
  // Process mentions first, then emoji within non-mention segments
  const mentionMatches: Array<{ index: number; length: number; text: string }> = [];
  MENTION_REGEX.lastIndex = 0;
  let mentionMatch: RegExpExecArray | null;
  while ((mentionMatch = MENTION_REGEX.exec(text)) !== null) {
    mentionMatches.push({
      index: mentionMatch.index,
      length: mentionMatch[0].length,
      text: mentionMatch[0],
    });
  }

  if (mentionMatches.length === 0) {
    // No mentions — render with emoji only (existing behavior)
    return renderEmoji(text);
  }

  for (const m of mentionMatches) {
    // Render text before this mention (with emoji)
    if (m.index > lastIndex) {
      parts.push(...renderEmoji(text.slice(lastIndex, m.index)));
    }
    // Resolve token to display name and render as highlighted span
    const display = resolveMentionDisplay(m.text, lookup);
    parts.push(
      <span key={`mention-${m.index}`} className="mention-highlight">
        {display}
      </span>
    );
    lastIndex = m.index + m.length;
  }

  // Render remaining text after last mention
  if (lastIndex < text.length) {
    parts.push(...renderEmoji(text.slice(lastIndex)));
  }

  return parts;
}
