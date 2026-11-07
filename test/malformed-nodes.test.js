/**
 * Malformed session nodes must never abort a whole compile.
 *
 * ⚠️ 2026-11-07 — regression cover. Compaction compiles a region of durable
 * events in one pass; before these guards, a single node whose `content` was
 * null, or an array carrying a null block, threw
 * `Cannot read properties of null (reading '0' | 'type')` and the ENTIRE
 * compilation failed. The host's pre-step handler catches that error as a
 * warning, so the visible symptom is silent: the compaction simply does not
 * happen and the context keeps growing. Skipping the offending node keeps the
 * rest of the region lossless.
 * @module dsh-compaction-vcc/test/malformed-nodes
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  compileNodes,
  compileNoisePatterns,
  DEFAULT_NOISE_PATTERNS,
  DEFAULT_TOOL_KEY_FIELDS,
  projectToolResultText
} from "../src/compiler.js";

const CONFIG = {
  textTokens: 512,
  userTextTokens: 1024,
  toolCallTokens: 128,
  toolResultExcerptTokens: 256,
  includeReasoning: false,
  stripNoiseXml: true,
  noisePatterns: compileNoisePatterns(DEFAULT_NOISE_PATTERNS),
  toolKeyFields: DEFAULT_TOOL_KEY_FIELDS,
  toolArgTools: [],
  hideTools: []
};

/** One node carrying the given content under the given role. */
const node = (seq, role, content) => ({ seq, message: { role, content, source: { kind: role === "user" ? "user" : "agent" } } });

test("a null content node does not abort the whole compile", () => {
  for (const role of ["user", "assistant"]) {
    const { entries } = compileNodes(
      [node(1, role, null), node(2, "user", [{ type: "text", text: "存活" }])],
      CONFIG
    );
    // The surviving node still compiles; the broken one contributes nothing.
    assert.equal(entries.length, 1, `${role}: the healthy node must survive`);
    assert.match(entries[0].text, /存活/u);
  }
});

test("a null block inside content does not abort the whole compile", () => {
  const { entries } = compileNodes(
    [node(1, "user", [null, { type: "text", text: "保住了" }])],
    CONFIG
  );
  assert.equal(entries.length, 1);
  assert.match(entries[0].text, /保住了/u);
});

test("a missing content property is skipped, not thrown", () => {
  const { entries } = compileNodes(
    [{ seq: 1, message: { role: "user", source: { kind: "user" } } }],
    CONFIG
  );
  assert.deepEqual(entries, []);
});

test("a non-array content is skipped, not iterated", () => {
  for (const content of ["字符串", 42, {}, { length: 1 }]) {
    const { entries } = compileNodes([node(1, "user", content)], CONFIG);
    assert.deepEqual(entries, [], `${JSON.stringify(content)} must not compile`);
  }
});

test("a null message node is skipped", () => {
  const { entries } = compileNodes([{ seq: 1, message: null }, { seq: 2, message: undefined }], CONFIG);
  assert.deepEqual(entries, []);
});

test("projectToolResultText tolerates non-arrays and null blocks", () => {
  assert.equal(projectToolResultText(null), "");
  assert.equal(projectToolResultText(undefined), "");
  assert.equal(projectToolResultText("nope"), "");
  assert.equal(projectToolResultText([null, undefined, { type: "text", text: "ok" }]), "ok");
  assert.equal(projectToolResultText([{ type: "image" }]), "[image]");
});

test("tool-call pointer recovery survives a null first block", () => {
  // `content[0]` being null used to throw in the pre-pass that maps a tool call
  // id to its result seq, losing every `-> result N` pointer in the region.
  const nodes = [
    { seq: 1, message: { role: "tool", content: [null], toolCallId: "call-1", source: { kind: "agent" } } },
    node(2, "assistant", [{ type: "text", text: "后续正文" }])
  ];
  const { entries } = compileNodes(nodes, CONFIG);
  assert.equal(entries.length, 1);
  assert.match(entries[0].text, /后续正文/u);
});
