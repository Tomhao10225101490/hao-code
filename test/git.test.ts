// Tests for the git tools against real (temporary) repositories.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  gitCommitTool,
  gitLogTool,
  gitStatusTool,
} from "../src/tools/git.js";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "hao-code-git-test-"));
}

function initRepo(dir: string): void {
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);
  git(["config", "commit.gpgsign", "false"]);
}

test("git_status shows untracked files and git_commit commits them", async () => {
  const dir = tempDir();
  initRepo(dir);
  writeFileSync(path.join(dir, "a.txt"), "hello\n");
  const ctx = { cwd: dir };

  const status = await gitStatusTool.run({}, ctx);
  assert.match(status, /a\.txt/);

  const committed = await gitCommitTool.run(
    { message: "add a.txt" },
    ctx,
  );
  assert.match(committed, /add a\.txt/);

  const statusAfter = await gitStatusTool.run({}, ctx);
  assert.ok(!statusAfter.includes("?? a.txt"), "a.txt should be committed");

  const log = await gitLogTool.run({}, ctx);
  assert.match(log, /add a\.txt/);
  assert.match(log, /Test User/);
});

test("git tools fail gracefully outside a repository", async () => {
  const dir = tempDir(); // deliberately no git init
  await assert.rejects(
    () => gitStatusTool.run({}, { cwd: dir }),
    /Not a git repository/,
  );
  await assert.rejects(
    () => gitLogTool.run({}, { cwd: dir }),
    /Not a git repository/,
  );
});

test("git_commit requires approval at the registry level", () => {
  assert.equal(gitCommitTool.requiresApproval, true);
  assert.equal(gitStatusTool.requiresApproval, false);
  assert.equal(gitLogTool.requiresApproval, false);
});
