// Hand-written types for the generated policy module.
export type BendMaybe = { $: "Some"; value: string } | { $: "None" };
/**
 * Interval totals as rows joined by `\n`: `group,total`, where `total` is
 * the union duration in raw milliseconds. A valid empty batch returns `Some`
 * with `worktime-v1\n`; invalid input returns `None`.
 */
export declare function evaluateIntervals(text: string): BendMaybe;
/**
 * Receipt audit rows are joined by `\n` as `group,status,durableMs,copies`.
 * `status` is 0 consistent, 1 legacy, 2 missing, 3 checkpoint-only, 4 mismatch,
 * or 5 conflict; `durableMs` is milliseconds. A valid empty batch returns
 * `Some` with `worktime-audit-v1\n`; invalid input returns `None`.
 */
export declare function evaluateAudit(text: string): BendMaybe;
