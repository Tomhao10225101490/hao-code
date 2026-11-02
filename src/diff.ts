// A small line-based diff producing unified-diff-style output, used to show
// the user exactly what a write/edit will change before they approve it.
//
// The core is a classic LCS dynamic program. Common prefixes/suffixes are
// trimmed first (the usual case: a small edit inside a big file), and if the
// remaining middle is still huge it falls back to "replace the whole block"
// rather than building an enormous DP table.

export type DiffOpType = "context" | "add" | "remove";

export interface DiffOp {
  type: DiffOpType;
  text: string;
}

const MAX_DP_CELLS = 9_000_000; // 3000 x 3000 lines worst case

export function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  const ops: DiffOp[] = [];

  // Trim the common prefix.
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    ops.push({ type: "context", text: oldLines[start] });
    start++;
  }

  // Trim the common suffix.
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  const suffix: DiffOp[] = [];
  while (
    oldEnd > start &&
    newEnd > start &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    suffix.unshift({ type: "context", text: oldLines[oldEnd - 1] });
    oldEnd--;
    newEnd--;
  }

  const a = oldLines.slice(start, oldEnd);
  const b = newLines.slice(start, newEnd);

  if (a.length === 0) {
    for (const line of b) ops.push({ type: "add", text: line });
  } else if (b.length === 0) {
    for (const line of a) ops.push({ type: "remove", text: line });
  } else if (a.length * b.length > MAX_DP_CELLS) {
    // Too large for the DP table: present the middle as a wholesale replace.
    for (const line of a) ops.push({ type: "remove", text: line });
    for (const line of b) ops.push({ type: "add", text: line });
  } else {
    // dp[i][j] = LCS length of a[i..] and b[j..].
    const n = a.length;
    const m = b.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () =>
      new Array<number>(m + 1).fill(0),
    );
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] =
          a[i] === b[j]
            ? dp[i + 1][j + 1] + 1
            : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push({ type: "context", text: a[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ type: "remove", text: a[i] });
        i++;
      } else {
        ops.push({ type: "add", text: b[j] });
        j++;
      }
    }
    while (i < n) ops.push({ type: "remove", text: a[i++] });
    while (j < m) ops.push({ type: "add", text: b[j++] });
  }

  ops.push(...suffix);
  return ops;
}

/** Split text into lines, treating a trailing newline as a terminator. */
function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export interface UnifiedDiffOptions {
  /** Unchanged lines shown around each change. Default 3. */
  context?: number;
  oldLabel?: string;
  newLabel?: string;
}

interface AnnotatedOp extends DiffOp {
  /** 1-based line number in the old file, for context/remove ops. */
  oldNo?: number;
  /** 1-based line number in the new file, for context/add ops. */
  newNo?: number;
  /** Count of old lines consumed before this op (0-based position). */
  oldBefore: number;
  /** Count of new lines consumed before this op (0-based position). */
  newBefore: number;
}

/**
 * Produce a unified diff of two texts. Returns "" when there are no changes.
 * Output resembles `diff -u`: --- / +++ headers, @@ hunks, " "/-"+" lines.
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  opts: UnifiedDiffOptions = {},
): string {
  if (oldText === newText) return "";
  const context = opts.context ?? 3;
  const oldLabel = opts.oldLabel ?? "a";
  const newLabel = opts.newLabel ?? "b";

  const ops = diffLines(toLines(oldText), toLines(newText));

  // Annotate each op with the line numbers it consumes.
  let oldNo = 1;
  let newNo = 1;
  const annotated: AnnotatedOp[] = ops.map((op) => {
    const out: AnnotatedOp = { ...op, oldBefore: oldNo - 1, newBefore: newNo - 1 };
    if (op.type !== "add") out.oldNo = oldNo++;
    if (op.type !== "remove") out.newNo = newNo++;
    return out;
  });

  // Group changes into hunks, each padded with `context` unchanged lines.
  const changeIdx = annotated
    .map((op, i) => (op.type === "context" ? -1 : i))
    .filter((i) => i >= 0);
  if (changeIdx.length === 0) return "";

  const hunks: Array<[number, number]> = []; // [startIdx, endIdx) into annotated
  let hunkStart = Math.max(0, changeIdx[0] - context);
  let hunkEnd = Math.min(annotated.length, changeIdx[0] + context + 1);
  for (let k = 1; k < changeIdx.length; k++) {
    const idx = changeIdx[k];
    if (idx - context <= hunkEnd) {
      hunkEnd = Math.min(annotated.length, idx + context + 1);
    } else {
      hunks.push([hunkStart, hunkEnd]);
      hunkStart = Math.max(0, idx - context);
      hunkEnd = Math.min(annotated.length, idx + context + 1);
    }
  }
  hunks.push([hunkStart, hunkEnd]);

  const formatRange = (start: number, count: number): string =>
    count === 1 ? `${start}` : `${start},${count}`;

  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const [s, e] of hunks) {
    const hunkOps = annotated.slice(s, e);
    const oldCount = hunkOps.filter((o) => o.type !== "add").length;
    const newCount = hunkOps.filter((o) => o.type !== "remove").length;
    // For a zero-count side, GNU diff reports the line *before* the hunk,
    // which is exactly the "consumed before" position of the first op.
    const oldStart =
      oldCount > 0
        ? (hunkOps.find((o) => o.oldNo !== undefined)?.oldNo ?? 1)
        : hunkOps[0].oldBefore;
    const newStart =
      newCount > 0
        ? (hunkOps.find((o) => o.newNo !== undefined)?.newNo ?? 1)
        : hunkOps[0].newBefore;
    out.push(
      `@@ -${formatRange(oldStart, oldCount)} +${formatRange(newStart, newCount)} @@`,
    );
    for (const op of hunkOps) {
      const sign = op.type === "context" ? " " : op.type === "remove" ? "-" : "+";
      out.push(`${sign}${op.text}`);
    }
  }
  return out.join("\n");
}
