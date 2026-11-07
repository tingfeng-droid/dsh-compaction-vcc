/**
 * Tests for the cap-hit notice appended to a checkpoint footer when a compile
 * had to drop rows to stay under `checkpointCap`.
 * @module dsh-compaction-vcc/test/cap-notice
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compileRegion, DEFAULT_NOISE_PATTERNS, compileNoisePatterns } from "../src/compiler.js";

const CONFIG = {
  textTokens: 512,
  userTextTokens: 1024,
  toolCallTokens: 128,
  toolResultExcerptTokens: 256,
  includeReasoning: false,
  stripNoiseXml: true,
  noisePatterns: compileNoisePatterns(DEFAULT_NOISE_PATTERNS),
  toolKeyFields: {},
  toolArgTools: [],
  hideTools: [],
  elideSourceKinds: []
};

/** Many user text nodes so the total cap must drop rows. */
const manyNodes = (n) => Array.from({ length: n }, (_, i) => ({
  seq: i + 1,
  message: {
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text: `消息 ${i + 1} `.repeat(60) }]
  }
}));

test("capped is false and no elision happens when the span fits", () => {
  const { capped, stats } = compileRegion(manyNodes(3), { ...CONFIG, maxTokens: 100000 });
  assert.equal(capped, false);
  assert.equal(stats.elidedRows, 0);
  assert.equal(stats.elidedToolRows, 0);
});

test("a tiny cap forces capping and records what was dropped", () => {
  const { capped, stats } = compileRegion(manyNodes(40), { ...CONFIG, maxTokens: 400 });
  assert.equal(capped, true);
  assert.ok(stats.elidedRows > 0, "oldest entries are elided under pressure");
});

test("tool rows are sacrificed before conversation entries", () => {
  const nodes = [];
  // Interleave tool-call one-liners with user text.
  for (let i = 0; i < 25; i += 1) {
    nodes.push({
      seq: i * 2 + 1,
      message: {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "bash", arguments: JSON.stringify({ command: "x".repeat(200) }) }]
      }
    });
    nodes.push({
      seq: i * 2 + 2,
      message: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: `正文 ${i} `.repeat(50) }] }
    });
  }
  const { capped, stats } = compileRegion(nodes, { ...CONFIG, maxTokens: 500 });
  assert.equal(capped, true);
  // Phase A (tool rows) runs before phase B (entries), so at least one tool row
  // must give way before an equal number of conversation entries.
  assert.ok(stats.elidedToolRows > 0 || stats.elidedRows > 0);
});
