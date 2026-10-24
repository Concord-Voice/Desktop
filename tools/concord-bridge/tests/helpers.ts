import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HarnessRunner, RunOptions, RunnerResult } from "../src/runners/base.js";

/** A throwaway git repository under the OS temp dir. Never the developer checkout. */
export function makeTmpRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "concord-bridge-test-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Bridge Test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "fixture\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  return dir;
}

export function removeTmp(dir: string): void {
  if (dir.startsWith(fs.realpathSync(os.tmpdir()))) fs.rmSync(dir, { recursive: true, force: true });
}

export function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

export class FakeRunner implements HarnessRunner {
  public readonly command = "fake";
  public readonly calls: RunOptions[] = [];
  constructor(private readonly script: Array<Partial<RunnerResult>> = []) {}
  buildArgs(): string[] {
    return [];
  }
  async run(options: RunOptions): Promise<RunnerResult> {
    this.calls.push(options);
    const next = this.script.shift() ?? {};
    return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, status: "COMPLETED", ...next };
  }
}
