/**
 * Regressions for the 2026-11-07 audit (v0.7.0).
 *
 * Every case here encodes a defect that shipped in 0.6.x. They are grouped in
 * one file because they share an origin: the fork's host-compatibility work was
 * applied case by case instead of against the host's real type shapes, and the
 * failures were all silent (swallowed by a catch, or a no-op loop).
 * @module dsh-compaction-vcc/test/audit-0.7.0
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  compileNodes,
  compileNoisePatterns,
  DEFAULT_NOISE_PATTERNS,
  DEFAULT_TOOL_KEY_FIELDS,
  estimateDeepSeekTokens,
  estimateEntryTokens,
  isCjkChar
} from "../src/compiler.js";
import { fenceCode, selectCompactableRange } from "../src/region.js";
import { sessionEventAt, sessionEvents, hasSessionEventAccess } from "../src/session-compat.js";

const CONFIG = {
  textTokens: 512,
  userTextTokens: 1024,
  toolCallTokens: 128,
  toolResultExcerptTokens: 256,
  includeReasoning: false,
  stripNoiseXml: true,
  noisePatterns: compileNoisePatterns(DEFAULT_NOISE_PATTERNS),
  toolKeyFields: DEFAULT_TOOL_KEY_FIELDS,
  toolArgTools: ["read"],
  hideTools: []
};

test("host 0.2.x tool results (role:'tool') reach the checkpoint", () => {
  // Defect: the main loop only branched on assistant/user, so every real tool
  // result — role "tool", toolCallId on the message — produced no entry and
  // stats.toolResults stayed 0. The `-> result N` pointer still worked, which is
  // exactly why the loss went unnoticed.
  const nodes = [
    { seq: 1, message: { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", arguments: '{"path":"a.js"}' }] } },
    { seq: 2, message: { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "文件正文内容" }] } }
  ];
  const { entries, stats } = compileNodes(nodes, CONFIG);
  assert.equal(stats.toolResults, 1, "tool results must be counted");
  const text = entries.map((entry) => entry.text).join("\n");
  assert.match(text, /\[tool\]/);
  assert.match(text, /文件正文内容/);
  assert.match(text, /\(seq 1 -> result 2\)/);
});

test("tool output is excerpted to toolResultExcerptTokens", () => {
  // Defect: `excerptToolResult` had zero call sites outside tests, so the
  // toolResultExcerptTokens budget was inert.
  const long = "工具输出内容 ".repeat(3000);
  const { entries } = compileNodes(
    [{ seq: 1, message: { role: "tool", toolCallId: "c1", content: [{ type: "text", text: long }] } }],
    { ...CONFIG, toolResultExcerptTokens: 40 }
  );
  assert.ok(entries[0].text.length < long.length / 4, "the excerpt must be far smaller than the input");
  assert.match(entries[0].text, /elided|truncated/u);
});

test("fenceCode survives a body with very many backtick runs", () => {
  // Defect: Math.max(...runs) spread one argument per run; ~130k runs threw
  // RangeError: Maximum call stack size exceeded, aborting the whole compile.
  // Bodies that large are legal under the default checkpointCap.
  const text = "`a".repeat(200_000);
  const out = fenceCode(text);
  assert.equal(out.split("\n")[0].length, 3, "each run is length 1, so the fence stays at 3 backticks");
  assert.ok(out.includes(text), "content bytes must be preserved");
});

test("fenceCode picks a fence longer than the longest embedded run", () => {
  const out = fenceCode("a ```` b ``` c");
  assert.equal(out.split("\n")[0], "`````");
});

test("selectCompactableRange returns null when the newest node alone exceeds retainTokens", () => {
  // Defect: keepFromIdx landed exactly on turns.length (one past the last index),
  // surfaceNodes[keepFromIdx] was undefined, and the host's
  // toolPairingBalancedBefore threw "surface seq undefined not found". Automatic
  // compaction swallowed that as a warning; manual compaction called it busy.
  const seqs = [10, 20, 30, 40];
  const session = {
    surface: { nodes: seqs },
    eventAt(seq) {
      if (seq === 10) return { seq, type: "system/message", data: {} };
      return { seq, type: "user/message", data: { source: { kind: "user" } } };
    }
  };
  const measurement = {
    // The newest node alone blows the 20480 ceiling.
    nodes: [{ seq: 10, tokens: 100 }, { seq: 20, tokens: 100 }, { seq: 30, tokens: 100 }, { seq: 40, tokens: 50_000 }]
  };
  assert.equal(selectCompactableRange(session, measurement, 1, 20_480), null);
});

test("legacy events arrays are read by seq, not by array position", () => {
  // Defect: `events[seq]` was off by one because the log numbers events from 1
  // while array indices start at 0. Call sites re-check event.seq, so it failed
  // safely — but one-position lookups never resolved.
  const session = { events: [{ seq: 1, type: "a" }, { seq: 2, type: "b" }, { seq: 3, type: "c" }] };
  assert.equal(sessionEventAt(session, 1)?.seq, 1);
  assert.equal(sessionEventAt(session, 3)?.seq, 3);
  assert.equal(sessionEventAt(session, 99), undefined);
});

test("hasSessionEventAccess distinguishes a missing log from an empty one", () => {
  assert.equal(hasSessionEventAccess({ snapshotEvents: () => [] }), true);
  assert.equal(hasSessionEventAccess({ eventAt: () => undefined }), true);
  assert.equal(hasSessionEventAccess({ events: [] }), true);
  assert.equal(hasSessionEventAccess({}), false);
  assert.equal(hasSessionEventAccess(null), false);
  assert.deepEqual(sessionEvents(null), []);
});

test("East Asian and Indic scripts carry CJK character density", () => {
  // Defect: isCjkChar covered ideographs only, so kana/hangul/Thai/Devanagari
  // took the 0.3 English branch and the DeepSeek estimate undercounted them ~2x.
  for (const char of ["あ", "ア", "한", "글", "ก", "ह", "中"]) {
    assert.equal(isCjkChar(char), true, `${char} must count as CJK density`);
  }
  for (const char of ["a", "Z", "0", " "]) {
    assert.equal(isCjkChar(char), false, `${char} must stay in the non-CJK class`);
  }
  // The estimate must now sit near countTokens instead of half of it.
  const japanese = "これはにほんごのテストです";
  assert.ok(estimateDeepSeekTokens(japanese) > estimateEntryTokens(japanese) * 0.4);
});
