/**
 * Mention parsing, encoding, and rendering utilities.
 *
 * Mentions are parsed from plaintext BEFORE encryption. The parsed mention targets
 * are encoded as a msgpack binary addendum and sent alongside the encrypted content.
 * The server processes the addendum ephemerally for RBAC enforcement and notification
 * routing, then discards it — mention data is NEVER persisted or broadcast.
 *
 * On the receiving side, the client decrypts the message and scans for mention
 * patterns to render highlights and trigger local notifications.
 */

import { encode } from '@msgpack/msgpack';

// ── Types ──

/** A mention target identified during text parsing. */
export interface ParsedMention {
  type: 'user' | 'role' | 'everyone' | 'here';
  /** Raw text matched (e.g., "@alice", "@all") */
  raw: string;
  /** Start index in the source text */
  start: number;
  /** End index (exclusive) in the source text */
  end: number;
  /** Resolved ID (user UUID or role UUID). Undefined for everyone/here. */
  id?: string;
  /** Display label for rendering (username, role name, "all", "here") */
  label: string;
}

/** The wire-format addendum sent alongside a message (msgpack-encoded). */
export interface MentionAddendum {
  /** Mentioned user UUIDs */
  u?: string[];
  /** Mentioned role UUIDs */
  r?: string[];
  /** @all mention */
  e?: boolean;
  /** @here mention */
  h?: boolean;
}

/** Context for resolving @mentions during parsing. */
export interface MentionResolveContext {
  /** Server members: username → user ID */
  members: Map<string, string>;
  /** Server members: display name (lowercase) → user ID */
  displayNames: Map<string, string>;
  /** Mentionable roles: role name (lowercase) → role ID */
  roles: Map<string, string>;
}

// ── Parsing ──

/**
 * Parse @mention patterns from message text and resolve them against the
 * current server/conversation context.
 *
 * Recognized patterns:
 * - @all, @everyone → everyone mention
 * - @here, @online  → here mention
 * - @rolename       → role mention (if role exists and is mentionable)
 * - @username        → user mention (matched against members)
 *
 * Only mentions that were inserted via autocomplete should generate addendum
 * entries. This parser is used for recipient-side scanning (render highlights)
 * and as a fallback for manual typing detection.
 */
export function parseMentions(text: string, ctx: MentionResolveContext): ParsedMention[] {
  const mentions: ParsedMention[] = [];
  // Match both token format (<@userId>, <@&roleId>) and plain format (@username, @all)
  const mentionRegex = /<@&?([\w-]+)>|@([\w.-]+)/g;
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(text)) !== null) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;

    // Token format: <@userId> or <@&roleId>
    if (raw.startsWith('<@')) {
      const id = match[1];
      if (raw.startsWith('<@&')) {
        // Role token
        mentions.push({ type: 'role', raw, start, end, id, label: id });
      } else {
        // User token
        mentions.push({ type: 'user', raw, start, end, id, label: id });
      }
      continue;
    }

    // Plain format: @name
    const name = match[2];
    if (!name) continue;
    const nameLower = name.toLowerCase();

    // Check special keywords first
    if (nameLower === 'all' || nameLower === 'everyone') {
      mentions.push({ type: 'everyone', raw, start, end, label: 'all' });
      continue;
    }
    if (nameLower === 'here' || nameLower === 'online') {
      mentions.push({ type: 'here', raw, start, end, label: 'here' });
      continue;
    }

    // Check roles (case-insensitive)
    const roleId = ctx.roles.get(nameLower);
    if (roleId) {
      mentions.push({ type: 'role', raw, start, end, id: roleId, label: name });
      continue;
    }

    // Check members by username (case-insensitive)
    const userId = ctx.members.get(nameLower);
    if (userId) {
      mentions.push({ type: 'user', raw, start, end, id: userId, label: name });
      continue;
    }

    // Check members by display name (case-insensitive)
    const userIdByDisplay = ctx.displayNames.get(nameLower);
    if (userIdByDisplay) {
      mentions.push({ type: 'user', raw, start, end, id: userIdByDisplay, label: name });
    }
  }

  return mentions;
}

// ── Addendum Encoding ──

/**
 * Build a MentionAddendum from a list of parsed (and autocomplete-selected) mentions.
 * Returns null if there are no mention targets.
 */
export function buildAddendum(mentions: ParsedMention[]): MentionAddendum | null {
  if (mentions.length === 0) return null;

  const users = new Set<string>();
  const roles = new Set<string>();
  let everyone = false;
  let here = false;

  for (const m of mentions) {
    switch (m.type) {
      case 'user':
        if (m.id) users.add(m.id);
        break;
      case 'role':
        if (m.id) roles.add(m.id);
        break;
      case 'everyone':
        everyone = true;
        break;
      case 'here':
        here = true;
        break;
    }
  }

  const addendum: MentionAddendum = {};
  if (users.size > 0) addendum.u = [...users];
  if (roles.size > 0) addendum.r = [...roles];
  if (everyone) addendum.e = true;
  if (here) addendum.h = true;

  // Return null if empty after dedup
  if (!addendum.u && !addendum.r && !addendum.e && !addendum.h) return null;
  return addendum;
}

/**
 * Encode a MentionAddendum to a base64 string (msgpack binary blob).
 * This is the wire format sent as the `mention_meta` field.
 */
export function encodeMentionMeta(addendum: MentionAddendum): string {
  const packed = encode(addendum);
  // Convert Uint8Array to base64
  let binary = '';
  for (const byte of packed) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
}

// ── Recipient-Side Scanning ──

/**
 * Check if the current user is mentioned in a decrypted message.
 * Used by recipients after decryption to determine if they should
 * show a mention notification.
 */
export function isUserMentioned(
  text: string,
  currentUserId: string,
  _currentUsername: string,
  _currentDisplayName: string | undefined,
  memberRoleIds: string[],
  ctx: MentionResolveContext
): { mentioned: boolean; mentionEveryone: boolean } {
  const mentions = parseMentions(text, ctx);
  let mentioned = false;
  let mentionEveryone = false;

  for (const m of mentions) {
    if (m.type === 'everyone' || m.type === 'here') {
      mentioned = true;
      mentionEveryone = true;
    } else if (m.type === 'user' && m.id === currentUserId) {
      mentioned = true;
    } else if (m.type === 'role' && m.id && memberRoleIds.includes(m.id)) {
      mentioned = true;
    }
  }

  return { mentioned, mentionEveryone };
}

// ── Rendering Helpers ──

/** A segment of message text, either plain text or a mention. */
export interface MessageSegment {
  type: 'text' | 'mention';
  content: string;
  mention?: ParsedMention;
}

/**
 * Split message text into segments for rendering, where mention patterns
 * are separated from plain text.
 */
export function segmentMessage(text: string, ctx: MentionResolveContext): MessageSegment[] {
  const mentions = parseMentions(text, ctx);
  if (mentions.length === 0) {
    return [{ type: 'text', content: text }];
  }

  // Sort mentions by start position
  const sorted = [...mentions].sort((a, b) => a.start - b.start);
  const segments: MessageSegment[] = [];
  let cursor = 0;

  for (const m of sorted) {
    // Add plain text before this mention
    if (m.start > cursor) {
      segments.push({ type: 'text', content: text.slice(cursor, m.start) });
    }
    segments.push({ type: 'mention', content: m.raw, mention: m });
    cursor = m.end;
  }

  // Add remaining text after last mention
  if (cursor < text.length) {
    segments.push({ type: 'text', content: text.slice(cursor) });
  }

  return segments;
}
