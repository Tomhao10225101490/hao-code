// Tests for the LCS-based unified diff utility.

import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines, unifiedDiff } from "../src/diff.js";

test("identical texts produce an empty diff", () => {
  assert.equal(unifiedDiff("a\nb\nc\n", "a\nb\nc\n"), "");
  assert.equal(unifiedDiff("", ""), "");
});

test("diffLines marks additions and removals", () => {
  const ops = diffLines(["a", "b", "c"], ["a", "x", "c", "d"]);
  assert.deepEqual(
    ops.map((o) => `${o.type}:${o.text}`),
    ["context:a", "remove:b", "add:x", "context:c", "add:d"],
  );
});

test("new file diff is all additions with a zero-count old range", () => {
  const diff = unifiedDiff("", "a\nb\n", {
    oldLabel: "/dev/null",
    newLabel: "b/new.txt",
  });
  assert.match(diff, /^--- \/dev\/null$/m);
  assert.match(diff, /^\+\+\+ b\/new\.txt$/m);
  assert.match(diff, /^@@ -0,0 \+1,2 @@$/m);
  assert.match(diff, /^\+a$/m);
  assert.match(diff, /^\+b$/m);
});

test("single-line change uses the short range form", () => {
  const diff = unifiedDiff("x\n", "y\n");
  assert.match(diff, /^@@ -1 \+1 @@$/m);
  assert.match(diff, /^-x$/m);
  assert.match(diff, /^\+y$/m);
});

test("a change in the middle shows context lines", () => {
  const oldText = "a\nb\nc\nd\ne\nf\ng\n";
  const newText = "a\nb\nc\nD\ne\nf\ng\n";
  const diff = unifiedDiff(oldText, newText);
  assert.match(diff, /^@@ -1,7 \+1,7 @@$/m);
  assert.match(diff, /^ b$/m);
  assert.match(diff, /^-d$/m);
  assert.match(diff, /^\+D$/m);
  assert.match(diff, /^ g$/m);
});

test("distant changes form separate hunks", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
  const changed = [...lines];
  changed[0] = "CHANGED1";
  changed[19] = "CHANGED20";
  const diff = unifiedDiff(lines.join("\n") + "\n", changed.join("\n") + "\n", {
    context: 1,
  });
  const hunks = diff.match(/^@@ .* @@$/gm) ?? [];
  assert.equal(hunks.length, 2);
  assert.match(diff, /^-line1$/m);
  assert.match(diff, /^\+CHANGED20$/m);
});

test("nearby changes merge into one hunk", () => {
  const oldText = "a\nb\nc\nd\ne\n";
  const newText = "A\nb\nc\nD\ne\n";
  const diff = unifiedDiff(oldText, newText, { context: 3 });
  const hunks = diff.match(/^@@ .* @@$/gm) ?? [];
  assert.equal(hunks.length, 1);
});

test("deleted file diff is all removals with a zero-count new range", () => {
  const diff = unifiedDiff("a\nb\n", "", {
    oldLabel: "a/gone.txt",
    newLabel: "/dev/null",
  });
  assert.match(diff, /^@@ -1,2 \+0,0 @@$/m);
  assert.match(diff, /^-a$/m);
  assert.match(diff, /^-b$/m);
});
