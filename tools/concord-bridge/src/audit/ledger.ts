import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Append-only, hash-chained audit ledger.
 *
 * Storage: one JSON object per line in `<auditDir>/ledger.jsonl`, mode 0600.
 * Each record carries `prev_hash` (the previous record's `hash`, or 64 zeros
 * for the first) and `hash = sha256(prev_hash + "\n" + canonical(record
 * without hash))`. `verifyChain()` recomputes every link, so an edited,
 * reordered, inserted or deleted line is detected. This is tamper-EVIDENT,
 * not tamper-proof: whoever can write the file can rewrite the whole chain.
 *
 * Secrets that match the patterns in `redactSecrets` are replaced before any
 * string reaches disk.
 */

export const GENESIS_HASH = "0".repeat(64);
export const LEDGER_FILE = "ledger.jsonl";
const MAX_FIELD_CHARS = 16_000;

export interface DialogueRecord {
  turn: number;
  workerStatus: string;
  workerQuestion?: string;
  dispatcherReply?: string;
}

export interface AuditEntryInput {
  taskId: string;
  event: "dispatch" | "reply";
  timestamp?: string;
  initiator: {
    harness: string;
    repliesUsed: number;
    maxDialogueTurns: number;
  };
  admission?: {
    criterion: string;
    detail?: string;
  };
  execution: {
    agentRole: string;
    sovereignOwner: string;
    harnessUsed: string;
    modelResolved: string;
    effortPinned: string;
    access: string;
    durationMs: number;
    exitCode: number | null;
    signal?: string | null;
    status: string;
    failureReason?: string;
  };
  worktree: {
    branch: string;
    path: string;
    baseCommit: string;
    headCommit: string;
  };
  prompt: {
    initialPrompt: string;
    reply?: string;
    contextFiles?: string[];
    dialogueHistory?: DialogueRecord[];
  };
  results: {
    outputSummary?: string;
  };
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type LedgerRecord = { [key: string]: JsonValue } & { hash: string; prev_hash: string; task_id: string };

type Replacer = (match: string, ...groups: string[]) => string;

const SECRET_KEYS = "password|passwd|secret|token|api[_-]?key|authorization";
const keepKeyRedactValue: Replacer = (_m, key, sep) => `${key}${sep}[REDACTED]`;

const SECRET_PATTERNS: Array<[RegExp, string | Replacer]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private-key]"],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, "[REDACTED:anthropic-key]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED:api-key]"],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "[REDACTED:stripe-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED:github-token]"],
  [/\bgithub_pat_\w{20,}/g, "[REDACTED:github-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws-key]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:chat-service-token]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED:jwt]"],
  // Quoted and bare values are two patterns: one combined regex exceeds the
  // complexity budget, and the quoted form must win so "a b" is fully redacted.
  [new RegExp(String.raw`\b(${SECRET_KEYS})(\s*[:=]\s*)(?:"[^"]*"|'[^']*')`, "gi"), keepKeyRedactValue],
  [new RegExp(String.raw`\b(${SECRET_KEYS})(\s*[:=]\s*)(?!\[REDACTED\])\S+`, "gi"), keepKeyRedactValue],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    const replacer: Replacer = typeof replacement === "string" ? () => replacement : replacement;
    out = out.replace(pattern, replacer);
  }
  return out.length > MAX_FIELD_CHARS ? `${out.slice(0, MAX_FIELD_CHARS)}…[truncated]` : out;
}

function sanitize(value: unknown): JsonValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v));
  if (typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = sanitize(v);
    }
    return out;
  }
  return null;
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    // Code-unit order, not localeCompare: the hash chain must not depend on locale.
    const keys = Object.keys(value).sort(compareCodeUnits);
    const entries = keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k]));
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeHash(prevHash: string, body: { [key: string]: JsonValue }): string {
  return createHash("sha256").update(`${prevHash}\n${canonicalJson(body)}`).digest("hex");
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  brokenAtLine?: number;
  reason?: string;
}

export class AuditLedger {
  public readonly auditDir: string;
  public readonly ledgerPath: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(auditDir = ".agent-bus/audit") {
    this.auditDir = path.resolve(auditDir);
    this.ledgerPath = path.join(this.auditDir, LEDGER_FILE);
  }

  private readLines(): string[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.ledgerPath, "utf-8");
    } catch {
      return [];
    }
    return raw.split("\n").filter((l) => l.length > 0);
  }

  private lastHash(): string {
    const lines = this.readLines();
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed: unknown = JSON.parse(lines[i]);
        if (typeof parsed === "object" && parsed !== null && "hash" in parsed && typeof parsed.hash === "string") {
          return parsed.hash;
        }
      } catch {
        // A corrupt tail line is chained over; verifyChain() still reports it.
      }
    }
    return GENESIS_HASH;
  }

  public writeEntry(entry: AuditEntryInput): Promise<LedgerRecord> {
    const next = this.writeQueue.then(() => this.append(entry));
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async append(entry: AuditEntryInput): Promise<LedgerRecord> {
    await fs.promises.mkdir(this.auditDir, { recursive: true, mode: 0o700 });
    const timestamp = new Date(entry.timestamp ?? Date.now()).toISOString();
    const body = sanitize({
      schema: "concord-bridge-audit-v2",
      task_id: entry.taskId,
      event: entry.event,
      timestamp,
      initiator: entry.initiator,
      admission: entry.admission,
      execution: entry.execution,
      worktree: entry.worktree,
      prompt: { ...entry.prompt, contextFiles: entry.prompt.contextFiles ?? [], dialogueHistory: entry.prompt.dialogueHistory ?? [] },
      results: entry.results,
    });
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("audit entry did not serialize to an object");
    }
    const prevHash = this.lastHash();
    const withPrev = { ...body, prev_hash: prevHash };
    const record = { ...withPrev, hash: computeHash(prevHash, withPrev) } as LedgerRecord;
    const handle = await fs.promises.open(this.ledgerPath, "a", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.appendFile(`${JSON.stringify(record)}\n`, "utf-8");
    } finally {
      await handle.close();
    }
    return record;
  }

  /** Newest first. Corrupt lines are skipped, never thrown. Limit is clamped to 1..200. */
  public query(options: { taskId?: string; limit?: number } = {}): LedgerRecord[] {
    const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 10) || 10));
    const lines = this.readLines();
    const results: LedgerRecord[] = [];
    for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || !("task_id" in parsed) || typeof parsed.task_id !== "string") {
        continue;
      }
      if (options.taskId !== undefined && parsed.task_id !== options.taskId) continue;
      results.push(parsed as LedgerRecord);
    }
    return results;
  }

  public verifyChain(): VerifyResult {
    const lines = this.readLines();
    let prev = GENESIS_HASH;
    for (let i = 0; i < lines.length; i++) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        return { ok: false, entries: i, brokenAtLine: i + 1, reason: "unparseable line" };
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, entries: i, brokenAtLine: i + 1, reason: "not an object" };
      }
      const { hash, ...rest } = parsed as { [key: string]: JsonValue };
      if (rest.prev_hash !== prev) {
        return { ok: false, entries: i, brokenAtLine: i + 1, reason: "prev_hash does not match previous record" };
      }
      if (typeof hash !== "string" || computeHash(prev, rest) !== hash) {
        return { ok: false, entries: i, brokenAtLine: i + 1, reason: "hash mismatch" };
      }
      prev = hash;
    }
    return { ok: true, entries: lines.length };
  }
}
