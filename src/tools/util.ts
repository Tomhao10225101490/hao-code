// Small helpers shared by tool implementations.

/** Extract a required string argument, or throw an actionable error. */
export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Missing or invalid "${key}" argument: expected a non-empty string.`,
    );
  }
  return value;
}

/** Extract an optional integer argument. */
export function optionalInt(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid "${key}" argument: expected a number.`);
  }
  return Math.trunc(value);
}

/** Truncate long tool output so a single result cannot flood the context. */
export function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    `\n... [output truncated: ${text.length - maxChars} more characters]`
  );
}
