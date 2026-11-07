/**
 * Seq numeric bounds: the recall tool must never accept a seq large enough to
 * stall expansion.
 *
 * ⚠️ 2026-11-07 — regression cover for a host-freezing defect. `parseSeqSpec`
 * used to accept any digit string, so `recall(type:"seq", id:"9007199254740992")`
 * reached `expandSelections`, where `for (seq = start; seq <= end; seq += 1)`
 * never advances: at 2^53 `seq + 1 === seq` in IEEE-754, so the loop spins
 * forever. The freeze is synchronous — no timer fires, the tool call never
 * returns, and the host must be restarted. Both the parser and the expander are
 * guarded now; these tests pin both layers.
 * @module dsh-compaction-vcc/test/seq-bounds
 */
import assert from "node:assert/strict";
import test from "node:test";
import { expandSelections, parseSeqSpec } from "../src/recall.js";

/** The smallest integer where `n + 1 === n`, i.e. where a `+= 1` loop stalls. */
const FIRST_STALLING_SEQ = 2 ** 53;

test("parseSeqSpec rejects seqs outside the safe integer range", () => {
  const cases = [
    String(FIRST_STALLING_SEQ),
    String(FIRST_STALLING_SEQ + 1),
    "999999999999999999999",
    "1-9007199254740992",
    "9007199254740992-9007199254740993"
  ];
  for (const raw of cases) {
    const { selections, errors } = parseSeqSpec(raw);
    assert.equal(selections.length, 0, `${raw} must not yield a selection`);
    assert.equal(errors.length, 1, `${raw} must report exactly one error`);
    assert.match(errors[0], /safe integer range/u);
  }
});

test("parseSeqSpec accepts the largest safe seq", () => {
  // Number.MAX_SAFE_INTEGER is inclusive: the loop advances there, so it stays legal.
  const { selections, errors } = parseSeqSpec(String(Number.MAX_SAFE_INTEGER));
  assert.deepEqual(errors, []);
  assert.deepEqual(selections, [{ start: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER }]);
});

test("parseSeqSpec rejects seq 0 and negative seqs", () => {
  // The durable log numbers events from 1, so 0 addresses nothing.
  assert.match(parseSeqSpec("0").errors[0], /starts at 1/u);
  assert.match(parseSeqSpec("-1").errors[0], /invalid seq selection/u);
});

test("expandSelections never stalls on an unsafe range", () => {
  // The parser guards this, but expandSelections is exported and callable with a
  // hand-built selection array, so it must be safe on its own. If the guard were
  // missing this test would hang rather than fail — the assertion is the return.
  const out = expandSelections([{ start: FIRST_STALLING_SEQ, end: FIRST_STALLING_SEQ }]);
  assert.deepEqual(out, []);
});

test("expandSelections still expands ordinary ranges and dedupes overlaps", () => {
  assert.deepEqual(expandSelections([{ start: 3, end: 5 }]), [3, 4, 5]);
  assert.deepEqual(
    expandSelections([{ start: 3, end: 5 }, { start: 4, end: 7 }]),
    [3, 4, 5, 6, 7]
  );
});
