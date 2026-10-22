import type { AccessType, ConcordAgentRole, HarnessType } from "../config/fleet-matrix.js";

/**
 * Dialogue invariant: `maxDialogueTurns: N` allows exactly N dispatcher
 * replies. The initial dispatch is not a reply. A worker that pauses again
 * after the Nth reply trips the breaker (CIRCUIT_BREAKER_EXHAUSTED).
 *
 * Terminal states (COMPLETED, FAILED, CIRCUIT_BREAKER_EXHAUSTED) never accept
 * a reply. The bridge runs no verification step of its own, so there is no
 * VERIFICATION_FAILED state.
 */
export type SessionStatus =
  | "RUNNING"
  | "AWAITING_INPUT"
  | "PERMISSION_GATE"
  | "COMPLETED"
  | "CIRCUIT_BREAKER_EXHAUSTED"
  | "FAILED";

export type ReplyBlock = "not-paused" | "terminal" | "budget-exhausted";

export interface SessionExecution {
  harness: HarnessType;
  model: string;
  effort: string;
  access: AccessType;
  maxTurns: number;
}

export interface SessionOptions {
  sessionId: string;
  agentRole: ConcordAgentRole;
  maxDialogueTurns: number;
  initialPrompt: string;
  execution: SessionExecution;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  contextFiles?: string[];
  admittedBy?: string;
}

export interface DialogueEntry {
  turn: number;
  workerStatus: "AWAITING_INPUT" | "PERMISSION_GATE";
  workerQuestion?: string;
  dispatcherReply?: string;
}

export class SessionStateMachine {
  public readonly sessionId: string;
  public readonly agentRole: ConcordAgentRole;
  public readonly maxDialogueTurns: number;
  public readonly initialPrompt: string;
  public readonly execution: SessionExecution;
  public readonly worktreePath: string;
  public readonly branch: string;
  public readonly baseCommit: string;
  public readonly contextFiles: string[];
  public readonly admittedBy?: string;
  public repliesUsed = 0;
  public failureReason?: string;
  public readonly dialogueHistory: DialogueEntry[] = [];
  private status: SessionStatus = "RUNNING";

  constructor(options: SessionOptions) {
    this.sessionId = options.sessionId;
    this.agentRole = options.agentRole;
    this.maxDialogueTurns = options.maxDialogueTurns;
    this.initialPrompt = options.initialPrompt;
    this.execution = { ...options.execution };
    this.worktreePath = options.worktreePath;
    this.branch = options.branch;
    this.baseCommit = options.baseCommit;
    this.contextFiles = [...(options.contextFiles ?? [])];
    this.admittedBy = options.admittedBy;
  }

  public getStatus(): SessionStatus {
    return this.status;
  }

  public isTerminal(): boolean {
    return this.status === "COMPLETED" || this.status === "FAILED" || this.status === "CIRCUIT_BREAKER_EXHAUSTED";
  }

  public replyBlock(): ReplyBlock | null {
    if (this.status === "CIRCUIT_BREAKER_EXHAUSTED") return "budget-exhausted";
    if (this.isTerminal()) return "terminal";
    if (this.status !== "AWAITING_INPUT" && this.status !== "PERMISSION_GATE") return "not-paused";
    if (this.repliesUsed >= this.maxDialogueTurns) return "budget-exhausted";
    return null;
  }

  public canReply(): boolean {
    return this.replyBlock() === null;
  }

  public isCircuitBroken(): boolean {
    return this.status === "CIRCUIT_BREAKER_EXHAUSTED";
  }

  /** The question the worker is currently paused on, if any. */
  public pendingQuestion(): DialogueEntry | undefined {
    const last = this.dialogueHistory.at(-1);
    return last && last.dispatcherReply === undefined ? last : undefined;
  }

  /** Worker paused with a question or a permission request. */
  public recordPause(workerStatus: DialogueEntry["workerStatus"], question?: string): void {
    if (this.isTerminal()) throw new Error(`Session ${this.sessionId} is terminal (${this.status})`);
    this.dialogueHistory.push({ turn: this.dialogueHistory.length + 1, workerStatus, workerQuestion: question });
    this.status = this.repliesUsed >= this.maxDialogueTurns ? "CIRCUIT_BREAKER_EXHAUSTED" : workerStatus;
  }

  /** Dispatcher answered the pending question; the worker is running again. */
  public recordReply(reply: string): void {
    const block = this.replyBlock();
    if (block !== null) throw new Error(`Session ${this.sessionId} cannot accept a reply: ${block}`);
    const pending = this.pendingQuestion();
    if (pending) pending.dispatcherReply = reply;
    this.repliesUsed += 1;
    this.status = "RUNNING";
  }

  public complete(): void {
    if (this.isTerminal()) throw new Error(`Session ${this.sessionId} is terminal (${this.status})`);
    this.status = "COMPLETED";
  }

  public fail(reason?: string): void {
    this.failureReason = reason;
    this.status = "FAILED";
  }
}
