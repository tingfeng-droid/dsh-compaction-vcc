import test from "node:test";
import assert from "node:assert/strict";
import { elideCheckpointInjectedBodies, compileNodes, DEFAULT_NOISE_PATTERNS, compileNoisePatterns } from "../src/compiler.js";

const SNAPSHOT = [
  "[MNEMON] Search Documents for substantial project records.",
  "",
  "MNEMON RUNTIME MEMORY SNAPSHOT",
  "",
  'USER.md (user profile)',
  '<runtime-memory-file name="USER.md">',
  "用户偏好正文",
  "</runtime-memory-file>",
  "",
  "MEMORY.md (working reference)",
  '<runtime-memory-file name="MEMORY.md">',
  "工作事实正文",
  "</runtime-memory-file>"
].join("\n");

const RULES = [
  "<system-reminder>",
  "The following workspace instructions may be relevant to the current workspace.",
  "",
  "Instructions from: ~/.dsh/AGENTS.md",
  "",
  "# 用户全局工作指令",
  "正文",
  "</system-reminder>"
].join("\n");

test("memory snapshot inside a prior checkpoint collapses to a pointer", () => {
  const body = `[user]\n真实对话内容\n\n${SNAPSHOT}\n\n[assistant]\n回复正文`;
  const result = elideCheckpointInjectedBodies(body);
  assert.equal(result.spans, 1);
  assert.ok(result.chars > 100);
  assert.equal(result.text.includes("<runtime-memory-file"), false);
  assert.equal(result.text.includes("MNEMON RUNTIME MEMORY SNAPSHOT"), false);
  assert.ok(result.text.includes("真实对话内容"));
  assert.ok(result.text.includes("回复正文"));
  assert.ok(result.text.includes("注入内容已压缩为指针"));
});

test("a rules wrapper inside a prior checkpoint collapses to a pointer", () => {
  const body = `[user]\n真实对话内容\n\n${RULES}\n\n[assistant]\n回复正文`;
  const result = elideCheckpointInjectedBodies(body);
  assert.equal(result.spans, 1);
  assert.equal(result.text.includes("<system-reminder>"), false);
  assert.ok(result.text.includes("真实对话内容"));
  assert.ok(result.text.includes("回复正文"));
});

test("prose that merely mentions the tags is left alone", () => {
  // This is the regression that matters: our own conversation talks about these
  // tags constantly, and none of those sentences may be treated as real blocks.
  const prose = [
    "[assistant]",
    "规则外面套着 `<system-reminder>` 标签，被噪声模式剥掉了。",
    "",
    "我上面看到的那份 `MNEMON RUNTIME MEMORY SNAPSHOT` 就是它。",
    "",
    "看这个 `<runtime-memory-file name=\"USER.md\">` 写法。"
  ].join("\n");
  const result = elideCheckpointInjectedBodies(prose);
  assert.equal(result.spans, 0);
  assert.equal(result.text, prose);
});

test("a mention followed much later by a real block does not swallow the prose", () => {
  const body = [
    "[assistant]",
    "我说过 `<system-reminder>` 这个标签。",
    "这里还有一大段真实的对话正文，不能被吃掉。".repeat(60),
    "",
    RULES
  ].join("\n");
  const result = elideCheckpointInjectedBodies(body);
  assert.equal(result.spans, 1);
  assert.ok(result.text.includes("这里还有一大段真实的对话正文"));
  // The prose mention survives verbatim; only the real wrapped block is gone.
  assert.ok(result.text.includes("我说过 `<system-reminder>` 这个标签"));
  assert.equal(result.text.includes("Instructions from: ~/.dsh/AGENTS.md"), false);
  assert.equal(result.text.includes("用户全局工作指令"), false);
});

test("two memory snapshots in one body are both collapsed", () => {
  const body = `${SNAPSHOT}\n\n中间对话\n\n${SNAPSHOT}`;
  const result = elideCheckpointInjectedBodies(body);
  assert.equal(result.spans, 2);
  assert.equal(result.text.includes("<runtime-memory-file"), false);
  assert.ok(result.text.includes("中间对话"));
});

test("a body with nothing injected is returned unchanged", () => {
  const body = "[user]\n只有对话\n\n[assistant]\n只有回复";
  const result = elideCheckpointInjectedBodies(body);
  assert.equal(result.spans, 0);
  assert.equal(result.text, body);
});

const CONFIG = (overrides = {}) => ({
  textTokens: 8192,
  userTextTokens: 16384,
  toolCallTokens: 128,
  toolResultExcerptTokens: 256,
  includeReasoning: false,
  stripNoiseXml: true,
  noisePatterns: compileNoisePatterns(DEFAULT_NOISE_PATTERNS),
  elideSourceKinds: [],
  elideCheckpointInjectedBodies: false,
  toolKeyFields: {},
  toolArgTools: [],
  hideTools: [],
  maxTokens: 393216,
  ...overrides
});

const checkpointNode = (text) => ({
  seq: 10,
  message: {
    role: "user",
    source: { kind: "plugin", plugin: "compact" },
    content: [{ type: "text", text }]
  }
});

test("checkpoint bodies are untouched while the switch is off (stock default)", () => {
  const text = `真实对话\n\n${SNAPSHOT}`;
  const { stats, entries } = compileNodes([checkpointNode(text)], CONFIG());
  assert.equal(stats.elidedCheckpointSpans, 0);
  assert.equal(stats.elidedCheckpointChars, 0);
  assert.equal(entries[0].text.includes("<runtime-memory-file"), true);
});

test("checkpoint bodies collapse when the switch is on", () => {
  const text = `真实对话\n\n${SNAPSHOT}`;
  const { stats, entries } = compileNodes(
    [checkpointNode(text)],
    CONFIG({ elideCheckpointInjectedBodies: true })
  );
  assert.equal(stats.elidedCheckpointSpans, 1);
  assert.ok(stats.elidedCheckpointChars > 100);
  assert.equal(entries[0].text.includes("<runtime-memory-file"), false);
  assert.ok(entries[0].text.includes("真实对话"));
  assert.ok(entries[0].text.includes("注入内容已压缩为指针"));
});

test("live user turns keep their full text even with the switch on", () => {
  // Only prior-checkpoint prose is rewritten. A live message that happens to
  // quote a snapshot must survive verbatim.
  const node = {
    seq: 11,
    message: {
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: SNAPSHOT }]
    }
  };
  const { stats, entries } = compileNodes([node], CONFIG({ elideCheckpointInjectedBodies: true }));
  assert.equal(stats.elidedCheckpointSpans, 0);
  assert.ok(entries[0].text.includes("用户偏好正文"));
});
