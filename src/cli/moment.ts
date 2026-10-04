/**
 * Resolving a moment the person states for a correction. The CLI owns this because
 * the daemon speaks epoch milliseconds only: "14:30" is a local-human notion, and the
 * CLI runs in the same session as the person who typed it.
 */

/** A moment that has not happened yet is never a correction. */
const FUTURE = "that moment is in the future";

/**
 * `HH:MM` on today's local date, an ISO-8601 timestamp, or epoch milliseconds.
 * Anything else is refused rather than guessed, and a future moment is refused
 * because the ledger records what happened, not what is planned.
 */
export function parseMoment(raw: string, now: number): number {
  const value = raw.trim();
  if (value === "") throw new Error("--at needs a moment: HH:MM, an ISO timestamp, or epoch milliseconds");
  if (/^\d{12,}$/.test(value)) {
    const ms = Number(value);
    if (!Number.isSafeInteger(ms)) throw new Error(`not a usable epoch: ${raw}`);
    if (ms > now) throw new Error(FUTURE);
    return ms;
  }
  const clock = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours > 23 || minutes > 59) throw new Error(`${raw} is not a clock time`);
    const local = new Date(now);
    const at = new Date(local.getFullYear(), local.getMonth(), local.getDate(), hours, minutes, 0, 0).getTime();
    if (at > now) throw new Error(`${FUTURE}; ${raw} is later today, so pass a date for the day you mean`);
    return at;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`cannot read ${JSON.stringify(raw)}: use HH:MM, an ISO timestamp, or epoch milliseconds`);
  if (parsed > now) throw new Error(FUTURE);
  return parsed;
}
