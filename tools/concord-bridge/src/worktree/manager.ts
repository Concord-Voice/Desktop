import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Invariants this module enforces (rows 1, 2 and 6 of the PR #3954 review):
 *
 *  1. No shell is ever involved: every git call is `execFile("git", argv)`.
 *  2. A branch or ref name must pass a strict allowlist AND
 *     `git check-ref-format --branch` before it reaches a git command that
 *     creates anything, so it can never be parsed as an option, a path, or
 *     shell syntax.
 *  3. Every worktree lives in its own folder named after the session id,
 *     strictly inside `worktreesRoot`. A target that already exists is
 *     refused, never cleaned up, so no request can make the bridge delete a
 *     directory it did not create.
 *  4. Nothing in this module recursively deletes a directory. Removal goes
 *     through `git worktree remove`, which refuses paths that are not
 *     registered worktrees.
 */

const BRANCH_ALLOWLIST = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const SESSION_ID_ALLOWLIST = /^[A-Za-z0-9_-]{1,80}$/;
const SHA_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;

export class WorktreeError extends Error {}

export interface WorktreeCreateOptions {
  sessionId: string;
  branch: string;
  baseRef?: string;
}

export interface WorktreeInstance {
  path: string;
  branch: string;
  baseCommit: string;
  cleanUp: () => Promise<void>;
}

/** Pure, synchronous part of branch validation (no git needed). */
export function validateBranchNameSyntax(branch: string): void {
  if (typeof branch !== "string" || !BRANCH_ALLOWLIST.test(branch)) {
    throw new WorktreeError(`Invalid branch name: must match ${BRANCH_ALLOWLIST.source}`);
  }
  if (branch.includes("..")) {
    throw new WorktreeError("Invalid branch name: '..' is not allowed");
  }
  if (branch.endsWith(".lock") || branch.endsWith("/") || branch.endsWith(".")) {
    throw new WorktreeError("Invalid branch name: forbidden suffix");
  }
  if (branch.includes("//") || branch.split("/").some((part) => part.startsWith("."))) {
    throw new WorktreeError("Invalid branch name: empty or dot-prefixed path component");
  }
}

function validateRef(ref: string): void {
  if (ref !== "HEAD" && !SHA_PATTERN.test(ref)) {
    validateBranchNameSyntax(ref);
  }
}

export function validateSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !SESSION_ID_ALLOWLIST.test(sessionId)) {
    throw new WorktreeError("Invalid session id");
  }
}

/** True when `child` is strictly inside `parent` (never equal, never above). */
export function isStrictlyInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: MAX_GIT_OUTPUT,
    shell: false,
    windowsHide: true,
  });
  return stdout;
}

export class WorktreeManager {
  public readonly repoRoot: string;
  public readonly worktreesRoot: string;

  constructor(repoRoot: string = process.cwd(), worktreesRoot?: string) {
    this.repoRoot = path.resolve(repoRoot);
    this.worktreesRoot = worktreesRoot
      ? path.resolve(worktreesRoot)
      : path.join(this.repoRoot, ".worktrees");
  }

  /** Allowlist + `git check-ref-format --branch`. Throws on any failure. */
  public async validateBranch(branch: string): Promise<void> {
    validateBranchNameSyntax(branch);
    let normalized: string;
    try {
      normalized = (await runGit(["check-ref-format", "--branch", branch], this.repoRoot)).trim();
    } catch {
      throw new WorktreeError("Invalid branch name: rejected by git check-ref-format");
    }
    if (normalized !== branch) {
      throw new WorktreeError("Invalid branch name: git normalizes it to a different name");
    }
  }

  /** Resolve a ref to a full commit SHA. The ref must be HEAD, a SHA, or pass the branch allowlist. */
  public async revParse(ref: string, cwd: string = this.repoRoot): Promise<string> {
    validateRef(ref);
    const sha = (await runGit(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], cwd)).trim();
    if (!SHA_PATTERN.test(sha)) {
      throw new WorktreeError(`rev-parse returned a non-SHA value for ${ref}`);
    }
    return sha;
  }

  public async branchExists(branch: string): Promise<boolean> {
    validateBranchNameSyntax(branch);
    try {
      await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], this.repoRoot);
      return true;
    } catch {
      return false;
    }
  }

  /** Paths changed on `branch` relative to its merge-base with `baseRef`. */
  public async changedPaths(branch: string, baseRef = "HEAD"): Promise<string[]> {
    validateBranchNameSyntax(branch);
    validateRef(baseRef);
    const out = await runGit(["diff", "--name-only", `${baseRef}...${branch}`, "--"], this.repoRoot);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  public targetPathFor(sessionId: string): string {
    validateSessionId(sessionId);
    const target = path.join(this.worktreesRoot, sessionId);
    if (!isStrictlyInside(this.worktreesRoot, target)) {
      throw new WorktreeError("Resolved worktree path escapes the worktrees root");
    }
    return target;
  }

  public async createWorktree(options: WorktreeCreateOptions): Promise<WorktreeInstance> {
    const targetPath = this.targetPathFor(options.sessionId);
    await this.validateBranch(options.branch);
    const baseCommit = await this.revParse(options.baseRef ?? "HEAD");

    await fs.promises.mkdir(this.worktreesRoot, { recursive: true, mode: 0o700 });
    if (fs.existsSync(targetPath)) {
      throw new WorktreeError(`Worktree target already exists: ${targetPath}`);
    }

    if (await this.branchExists(options.branch)) {
      await runGit(["worktree", "add", "--", targetPath, options.branch], this.repoRoot);
    } else {
      await runGit(["worktree", "add", "-b", options.branch, "--", targetPath, baseCommit], this.repoRoot);
    }

    await this.registerWorker(options.sessionId, targetPath);

    return {
      path: targetPath,
      branch: options.branch,
      baseCommit,
      cleanUp: async () => {
        await this.cleanupWorktree(targetPath);
      },
    };
  }

  /**
   * Remove a bridge-managed worktree. Refuses any path outside the worktrees
   * root. There is deliberately no filesystem fallback: if git cannot remove
   * it, the error surfaces and the directory stays.
   */
  public async cleanupWorktree(worktreePath: string): Promise<void> {
    if (!isStrictlyInside(this.worktreesRoot, worktreePath)) {
      throw new WorktreeError("Refusing to remove a path outside the worktrees root");
    }
    await runGit(["worktree", "remove", "--force", "--", path.resolve(worktreePath)], this.repoRoot);
    await runGit(["worktree", "prune"], this.repoRoot);
    await fs.promises.rm(this.markerPath(path.basename(worktreePath)), { force: true });
  }

  private markerDir(): string {
    return path.join(this.repoRoot, ".agent-bus", "workers");
  }

  private markerPath(sessionId: string): string {
    validateSessionId(sessionId);
    return path.join(this.markerDir(), `${sessionId}.json`);
  }

  private async registerWorker(sessionId: string, worktreePath: string): Promise<void> {
    await fs.promises.mkdir(this.markerDir(), { recursive: true, mode: 0o700 });
    const real = await fs.promises.realpath(worktreePath);
    await fs.promises.writeFile(this.markerPath(sessionId), JSON.stringify({ path: real }), {
      mode: 0o600,
      flag: "wx",
    });
  }

  /**
   * Recursion guard: true when `dir` is (inside) a worktree that a bridge in
   * the main checkout created for a worker. A bridge launched inside a worker
   * finds its own repoRoot registered in the main checkout's marker directory.
   */
  public static async isBridgeWorkerCheckout(dir: string): Promise<boolean> {
    let commonDir: string;
    let real: string;
    let files: string[];
    try {
      commonDir = (await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir)).trim();
      real = await fs.promises.realpath(dir);
      files = await fs.promises.readdir(path.join(path.dirname(commonDir), ".agent-bus", "workers"));
    } catch {
      return false;
    }
    const markerDir = path.join(path.dirname(commonDir), ".agent-bus", "workers");
    for (const file of files) {
      try {
        const parsed: unknown = JSON.parse(await fs.promises.readFile(path.join(markerDir, file), "utf-8"));
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "path" in parsed &&
          typeof parsed.path === "string" &&
          (real === parsed.path || isStrictlyInside(parsed.path, real))
        ) {
          return true;
        }
      } catch {
        // A corrupt marker is skipped.
      }
    }
    return false;
  }
}
