// Build-time entry: bundled by scripts/build-bend.mjs into src/core/generated/policy.mjs.
// Only the side-effect-free accounting functions cross into the package.
// Inherited from pi-time-tracker; the only change is where the Bend sources live.
import Engine from "../src/core/engine.bend";
import Audit from "../src/core/audit.bend";

type Maybe = { $: "Some"; value: string } | { $: "None" };
type Pure = { evaluate: (text: string) => Maybe };

const engine = Engine as unknown as Pure;
const audit = Audit as unknown as Pure;
if (typeof engine.evaluate !== "function" || typeof audit.evaluate !== "function") {
  throw new Error("Bend modules must expose evaluate(text)");
}

export const evaluateIntervals = (text: string): Maybe => engine.evaluate(text);
export const evaluateAudit = (text: string): Maybe => audit.evaluate(text);
