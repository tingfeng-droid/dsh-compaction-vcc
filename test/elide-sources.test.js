/**
 * Tests for `elideSourceKinds` — collapsing harness-injected instruction
 * blocks (hot memory, workspace rules, skill catalog) to recall pointers
 * inside a checkpoint, plus the cap-hit notice appended to the footer.
 * @module dsh-compaction-vcc/test/elide-sources
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NOISE_PATTERNS,
  compileNoisePatterns,
  compileNodes,
  frameCheckpoint,
  isElidableSource
} from "../src/compiler.js";

const BASE_CONFIG = {
  maxTokens: 8192,
  textTokens: 512,
  userTextTokens: 16384,
  toolCallTokens: 128,
  toolResultExcerptTokens: 256,
  includeReasoning: false,
  stripNoiseXml: true,
  noisePatterns: compileNoisePatterns(DEFAULT_NOISE_PATTERNS),
  toolKeyFields: {},
  toolArgTools: [],
  hideTools: []
};

/** Minimal user node carrying a text block and a source descriptor. */
const userNode = (seq, text, source) => ({
  seq,
  message: { role: "user", source, content: [{ type: "text", text }] }
});

const MEMORY = "MNEMON RUNTIME MEMORY SNAPSHOT\n".repeat(40);
const RULES = "Instructions from: ~/.dsh/AGENTS.md\n".repeat(30);

test("isElidableSource matches on structured kind only", () => {
  assert.equal(isElidableSource({ kind: "dsh-mnemon" }, ["dsh-mnemon"]), true);
  assert.equal(isElidableSource({ kind: "user" }, ["dsh-mnemon"]), false);
  assert.equal(isElidableSource(undefined, ["dsh-mnemon"]), false);
  // Empty / absent list is the stock no-op.
  assert.equal(isElidableSource({ kind: "dsh-mnemon" }, []), false);
  assert.equal(isElidableSource({ kind: "dsh-mnemon" }, undefined), false);
});

test("empty elideSourceKinds keeps instruction bodies verbatim (stock behavior)", () => {
  const nodes = [userNode(1, MEMORY, { kind: "dsh-mnemon" })];
  const { entries, stats } = compileNodes(nodes, { ...BASE_CONFIG, elideSourceKinds: [] });
  assert.equal(stats.elidedSourceRows, 0);
  const joined = entries.map((e) => e.text).join("\n");
  assert.ok(joined.includes("MNEMON RUNTIME MEMORY SNAPSHOT"), "memory body must survive");
  assert.ok(!joined.includes("已压缩为指针"), "no pointer marker when disabled");
});

test("configured kinds collapse to a pointer carrying seq and size", () => {
  const nodes = [userNode(3595, MEMORY, { kind: "dsh-mnemon" })];
  const { entries, stats } = compileNodes(nodes, { ...BASE_CONFIG, elideSourceKinds: ["dsh-mnemon"] });
  assert.equal(stats.elidedSourceRows, 1);
  assert.equal(stats.elidedSourceChars, MEMORY.length);
  const joined = entries.map((e) => e.text).join("\n");
  assert.ok(joined.includes("记忆快照"), "pointer names the block");
  assert.ok(joined.includes("seq 3595"), "pointer carries the seq for recall");
  assert.ok(joined.includes(String(MEMORY.length)), "pointer states original size");
  assert.ok(!joined.includes("MNEMON RUNTIME MEMORY SNAPSHOT"), "body is gone");
});

test("rules and memory elide independently; unmatched sources stay", () => {
  const nodes = [
    userNode(1, RULES, { kind: "agent-instructions" }),
    userNode(2, MEMORY, { kind: "dsh-mnemon" }),
    userNode(3, "我打的字", { kind: "user" })
  ];
  const { entries, stats } = compileNodes(nodes, { ...BASE_CONFIG, elideSourceKinds: ["dsh-mnemon"] });
  assert.equal(stats.elidedSourceRows, 1, "only memory elided");
  const joined = entries.map((e) => e.text).join("\n");
  assert.ok(joined.includes("Instructions from:"), "rules untouched");
  assert.ok(joined.includes("我打的字"), "user text untouched");
  assert.ok(!joined.includes("MNEMON RUNTIME MEMORY SNAPSHOT"), "memory elided");
});

test("elision shrinks the compiled checkpoint substantially", () => {
  const nodes = [
    userNode(1, MEMORY, { kind: "dsh-mnemon" }),
    userNode(2, RULES, { kind: "agent-instructions" })
  ];
  const off = compileNodes(nodes, { ...BASE_CONFIG, elideSourceKinds: [] });
  const on = compileNodes(nodes, { ...BASE_CONFIG, elideSourceKinds: ["dsh-mnemon", "agent-instructions"] });
  assert.equal(on.stats.elidedSourceRows, 2);
  assert.ok(on.stats.tokens < off.stats.tokens / 2,
    `elided checkpoint should be far smaller (${on.stats.tokens} vs ${off.stats.tokens})`);
});

test("frameCheckpoint accepts multiple footer lines", () => {
  const entries = [{ seq: 1, text: "[user] hi", kind: "text" }];
  const one = frameCheckpoint(entries, undefined, undefined, "single footer");
  const many = frameCheckpoint(entries, undefined, undefined, ["first", "second"]);
  const textOf = (blocks) => blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  assert.ok(textOf(one).includes("single footer"));
  assert.ok(textOf(many).includes("first") && textOf(many).includes("second"));
  // Backwards compatible: undefined adds nothing.
  const none = frameCheckpoint(entries, undefined, undefined, undefined);
  assert.ok(!textOf(none).includes("footer"));
});
