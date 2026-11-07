/**
 * Deterministic VCC-style region compiler for `dsh-compaction-vcc`.
 *
 * Ports the "compiler" principle of https://github.com/lllyasviel/VCC
 * (`skills/conversation-compiler/scripts/VCC.py`) into the DSH vocabulary:
 *
 *   - the durable session event log is the lossless layer (VCC's `.txt`);
 *   - this module compiles one shadowed surface region into a compact,
 *     reference-linked view (VCC's `.min.txt`) using ONLY original tokens —
 *     no model call, no paraphrase — which is what makes it instant and
 *     near-lossless;
 *   - every truncation and elision keeps a `(seq N)` pointer back to the
 *     exact durable event, so nothing is unrecoverable;
 *   - noise handling mirrors VCC's brief-mode rules: sanitize control bytes,
 *     strip known noise XML wrappers, hide reasoning, collapse every tool
 *     call into ONE line (key argument for whitelisted tools, name-only for
 *     the rest, VCC-style `-> result N` pointer instead of the result entry),
 *     and render images/documents as labels.
 *
 * This module is dependency-free (no cordis, no dsh imports) so it can be
 * unit-tested and reused outside a running harness. Messages are read as
 * plain `{ role, content, source }` values — exactly what
 * `Session.deriveEventMessage` projects.
 *
 * @module dsh-compaction-vcc/compiler
 */

// ── tokenizer (VCC `_tokenize` / `_TOK_RE`) ────────────────────────────────

const TOKEN_RE = /[a-zA-Z]+|[0-9]+|[^\sa-zA-Z0-9]|\s+/g;

/** Whether a UTF-16 code unit can be an unpaired high surrogate. */
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Whether a UTF-16 code unit can be an unpaired low surrogate. */
function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Move the end of a slice to a code-point boundary: a cut must never leave a
 * high surrogate without its low half (a lone surrogate renders as garbage
 * for the model and every UI). Only ASCII-derived budgets slice, so the
 * adjustment costs at most one code unit.
 * @param text - sliced text.
 * @returns the text without a trailing unpaired high surrogate.
 */
function completeCodePointAtEnd(text) {
  return isHighSurrogate(text.charCodeAt(text.length - 1)) ? text.slice(0, -1) : text;
}

/**
 * Move the start of a slice to a code-point boundary (a tail excerpt must
 * never begin inside a surrogate pair).
 * @param text - sliced text.
 * @returns the text without a leading unpaired low surrogate.
 */
function completeCodePointAtStart(text) {
  return isLowSurrogate(text.charCodeAt(0)) ? text.slice(1) : text;
}
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Split text into fixed-density tokens under the same character-class
 * heuristic VCC uses: letter runs, digit runs, single punctuation chars, and
 * whitespace runs. Deterministic, offline, and consistent for every budget
 * decision in this module.
 *
 * The single-regex pass is deliberately kept: an `Intl.Segmenter`-driven
 * equivalent was implemented and benchmarked, and the regex won on every
 * workload (6–17× segmenter throughput; 486–13 500 ops/s on 64 KB inputs,
 * 1.7 M ops/s on short messages), so the segmenter version was dropped.
 * @param text - source text.
 * @returns the token list (whitespace tokens included, never counted).
 */
export function tokenize(text) {
  return text.match(TOKEN_RE) ?? [];
}

/**
 * DeepSeek's documented character→token conversion (quick_start/token_usage):
 * about 0.3 token per English character and 0.6 token per Chinese character.
 * The tokenizer still varies per model, so this is an estimate — the real
 * usage comes from the model's `usage` field.
 * @param char - one code point.
 * @returns true when the character carries the 0.6 CJK weight.
 */
export function isCjkChar(char) {
  const code = char.codePointAt(0);
  return (
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0x3000 && code <= 0x303f) || // CJK Symbols and Punctuation
    (code >= 0xff00 && code <= 0xffef) || // Fullwidth Forms
    // ⚠️ 2026-11-07 — the ranges below are NOT CJK ideographs, but they carry the
    // same 0.6-token character density as Chinese, so they belong in this
    // density class. Without them every kana, hangul syllable, Thai and
    // Devanagari character took the 0.3 English branch, and the DeepSeek
    // estimate undercounted those scripts by roughly 2x. `estimateEntryTokens`
    // takes max(countTokens, estimate), so budgets never actually overflowed —
    // but the estimate was systematically wrong for any non-Chinese CJK/Indic
    // session. The function name is kept for API stability; it means "CJK-density
    // character", not "ideograph".
    (code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
    (code >= 0x31f0 && code <= 0x31ff) || // Katakana Phonetic Extensions
    (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
    (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
    (code >= 0x0e00 && code <= 0x0e7f) || // Thai
    (code >= 0x0e80 && code <= 0x0eff) || // Lao
    (code >= 0x0900 && code <= 0x097f) || // Devanagari
    (code >= 0x0980 && code <= 0x09ff) || // Bengali
    (code >= 0x0a00 && code <= 0x0a7f) || // Gurmukhi
    (code >= 0x0a80 && code <= 0x0aff) || // Gujarati
    (code >= 0x0b00 && code <= 0x0b7f) || // Oriya
    (code >= 0x0b80 && code <= 0x0bff) || // Tamil
    (code >= 0x0c00 && code <= 0x0c7f) || // Telugu
    (code >= 0x0c80 && code <= 0x0cff) || // Kannada
    (code >= 0x0d00 && code <= 0x0d7f) || // Malayalam
    (code >= 0x0d80 && code <= 0x0dff) || // Sinhala
    (code >= 0x1000 && code <= 0x109f) || // Myanmar
    (code >= 0x1780 && code <= 0x17ff)    // Khmer
  );
}

/**
 * Estimate tokens of a text under the DeepSeek docs conversion (0.3 per
 * non-CJK character, 0.6 per CJK character). Counts accumulate as integer
 * tenths so long inputs stay exact under ceil.
 * @param text - arbitrary text.
 * @returns the estimated token count (may be fractional).
 */
export function estimateDeepSeekTokens(text) {
  let nonCjk = 0;
  let cjk = 0;
  for (const char of text) {
    if (isCjkChar(char)) cjk += 1;
    else nonCjk += 1;
  }
  return (nonCjk * 3 + cjk * 6) / 10;
}

/** Count the non-whitespace tokens of a text under {@link tokenize}. */
export function countTokens(text) {
  let count = 0;
  for (const token of tokenize(text)) if (token.trim().length > 0) count += 1;
  return count;
}

/**
 * Size one emitted entry the way every budget in this module is enforced:
 * the VCC word-class token count, floored at the DeepSeek-doc character
 * density equivalent (0.3 token per non-CJK char, 0.6 per CJK char) so the
 * total checkpoint cap also sees pathological long runs.
 * @param text - entry text.
 * @returns the budget-relevant size in tokens.
 */
export function estimateEntryTokens(text) {
  return Math.max(countTokens(text), Math.ceil(estimateDeepSeekTokens(text)));
}

/**
 * Strip carriage returns, ANSI escapes, and control bytes the way VCC's
 * `_sanitize` does — deterministic cleanup, never token-changing rewrites.
 * @param text - raw text.
 * @returns sanitized text.
 */
export function sanitize(text) {
  if (typeof text !== "string") return "";
  let out = text;
  if (out.includes("\r")) out = out.replaceAll("\r", "");
  if (out.includes("\x1b")) out = out.replace(ANSI_RE, "");
  return out.replace(CTRL_RE, "");
}

// ── truncation (VCC `_trunc`) ──────────────────────────────────────────────

/**
 * Truncate text to a non-whitespace-token budget, preserving exact original
 * tokens and appending a VCC-style provenance note when something was cut.
 *
 * The fixed tokenizer counts a whole unbroken run of letters or digits as one
 * token, so a pathological output (a 100 KB base64 blob, a minified file)
 * could otherwise pass any token budget; every budget is therefore enforced
 * twice — by token count AND by a `limit * 4` character ceiling (≈ the
 * tokenizer's real-density equivalent).
 * @param text - text to bound.
 * @param limit - non-whitespace token budget; `0` keeps nothing.
 * @param ref - provenance appended as `...(truncated from {ref})` on a cut.
 * @returns `{ text, truncated }` — `truncated` is true when anything was cut.
 */
export function truncateTokens(text, limit, ref) {
  const tokens = tokenize(text);
  let count = 0;
  let cut = tokens.length;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.trim().length === 0) continue;
    count += 1;
    if (count > limit) {
      cut = index;
      break;
    }
  }
  let out = cut >= tokens.length ? text : tokens.slice(0, cut).join("");
  let truncated = cut < tokens.length;
  const maxChars = Math.max(32, limit * 4);
  if (out.length > maxChars) {
    out = completeCodePointAtEnd(out.slice(0, maxChars));
    truncated = true;
  } else if (truncated) {
    out = completeCodePointAtEnd(out);
  }
  if (!truncated) return { text, truncated: false };
  out = out.replace(/\s+$/u, "");
  const note = ref === undefined ? "...(truncated)" : `...(truncated from ${ref})`;
  return { text: out + note, truncated: true };
}

/**
 * Keep the LAST `limit` non-whitespace tokens of a text, additionally capped
 * at `limit * 4` characters. The end of the text is always preserved.
 * @param text - text to bound.
 * @param limit - non-whitespace token budget.
 * @param ref - provenance prepended as `...(elided before {ref})`.
 * @returns `{ text, truncated }`.
 */
function tailTokens(text, limit, ref) {
  const tokens = tokenize(text);
  let count = 0;
  let startIdx = tokens.length;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index].trim().length > 0) {
      count += 1;
      if (count > limit) break;
    }
    startIdx = index;
  }
  let out = startIdx === 0 ? text : tokens.slice(startIdx).join("");
  let truncated = startIdx > 0;
  const maxChars = Math.max(32, limit * 4);
  if (out.length > maxChars) {
    out = completeCodePointAtStart(out.slice(out.length - maxChars));
    truncated = true;
  } else if (truncated) {
    out = completeCodePointAtStart(out);
  }
  if (!truncated) return { text, truncated: false };
  const note = ref === undefined ? "...(elided before)" : `...(elided before ${ref})`;
  return { text: note + out, truncated: true };
}

// ── noise stripping (VCC `_BRIEF_STRIP_RE` family) ─────────────────────────

const NOISE_UNWRAP_RE = /<\/?(?:command-name|command-args)>/g;

/**
 * The VCC brief-mode noise XML patterns, adapted to harness markup. Applied
 * with the `s` flag; the replacement set is configurable via
 * `InstantCompactionConfig.noisePatterns`.
 */
export const DEFAULT_NOISE_PATTERNS = [
  "<ide_opened_file>.*?</ide_opened_file>",
  "<ide_selection>.*?</ide_selection>",
  "<system-reminder>.*?</system-reminder>",
  "<command-message>.*?</command-message>",
  "<task-notification>.*?</task-notification>"
];

/** Compile untrusted noise-pattern sources, throwing on invalid regex. */
export function compileNoisePatterns(sources) {
  return sources.map((source, index) => {
    try {
      return new RegExp(source, "s");
    } catch (error) {
      throw new Error(`noisePatterns[${index}] (${JSON.stringify(source)}) is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/**
 * Strip configured noise XML blocks from user text and unwrap command-name /
 * command-args tags (VCC `_strip_noise_xml` + `_BRIEF_UNWRAP_RE`).
 * @param text - user text.
 * @param patterns - compiled noise regexes.
 * @returns the stripped text, trimmed.
 */
export function stripNoiseXml(text, patterns) {
  let out = text;
  for (const pattern of patterns) out = out.replace(pattern, "");
  out = out.replace(NOISE_UNWRAP_RE, "");
  return out.trim();
}

// ── tool-call one-liner (VCC `_tool_summary`) ──────────────────────────────

/** VCC's `_TOOL_SUMMARY_FIELDS`, extended for the DSH tool catalog. */
export const DEFAULT_TOOL_KEY_FIELDS = Object.freeze({
  read: "file_path",
  edit: "file_path",
  write: "file_path",
  glob: "pattern",
  grep: "pattern",
  bash: "command",
  web_search: "query",
  skill: "name",
  ralph: "objective",
  subagent: "description",
  subagent_fork: "description",
  create_goal: "objective",
  update_goal: "objective",
  workflow: "name",
  interrupt_agent: "agent_id",
  job_kill: "job_id",
  job_output: "job_id",
  send_message: "message"
});

/**
 * Tools whose key argument is kept in the one-liner. Everything else renders
 * name-only (`* tool (seq N)`) — bookkeeping tools carry no semantic payload
 * worth the tokens (VCC's brief mode keeps `Read`/`Edit`/… args and drops the
 * rest; `_BRIEF_HIDE_TOOLS` goes further and hides TodoWrite/ToolSearch
 * entirely, which `hideTools` config covers here).
 */
export const DEFAULT_ARG_TOOLS = Object.freeze([
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "bash",
  "shell",
  "web_search",
  "skill",
  "subagent",
  "subagent_fork",
  "ralph",
  "workflow"
]);

/**
 * First-line projection for a tool-call one-liner: multiline arguments
 * collapse to the first physical line plus a `[+ N lines]` marker, so
 * scripted commands (bash heredocs, multi-line pipelines) stay one compact
 * line instead of echoing the whole payload.
 * @param value - the key-argument string.
 * @returns the display value.
 */
export function oneLineArg(value) {
  const lines = value.split(/\r?\n/u);
  if (lines.length === 1) return value;
  const first = lines[0] !== "" || lines.every((line) => line.trim() === "")
    ? lines[0]
    : lines.find((line) => line.trim() !== "");
  return `${first} [+ ${lines.length - 1} lines]`;
}

/**
 * Pick the key argument for a tool-call one-liner: the tool-specific field
 * first, then the first string-valued argument, else nothing.
 * @param name - tool name.
 * @param input - parsed arguments object (or null when unparseable).
 * @param keyFields - merged tool-name → preferred-field map.
 * @returns the display value, or undefined.
 */
export function pickToolKeyArg(name, input, keyFields) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const preferred = keyFields[name];
  if (preferred !== undefined) {
    const value = input[preferred];
    if (typeof value === "string" && value.length > 0) return value;
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Safely parse a tool-call's raw JSON arguments string.
 * @param arguments_ - raw JSON as produced by the model.
 * @returns the parsed value, or null when it is not valid JSON.
 */
export function parseToolArguments(arguments_) {
  try {
    return JSON.parse(arguments_);
  } catch {
    return null;
  }
}

// ── content projection helpers ─────────────────────────────────────────────

/**
 * Project nested tool-result blocks into one plain-text string: text blocks
 * are joined, images and documents render as VCC-style labels.
 * @param blocks - nested result content.
 * @returns projected text.
 */
export function projectToolResultText(blocks) {
  const parts = [];
  // ⚠️ 2026-11-07 — tolerate a missing/non-array projection input and null
  // blocks inside it. Both used to throw (`block.type` on null), and this helper
  // sits on the tool-result, memory-recall and search paths alike.
  if (!Array.isArray(blocks)) return "";
  for (const block of blocks) {
    if (block === null || block === undefined) continue;
    if (block.type === "text") {
      const text = sanitize(block.text ?? "");
      if (text.length > 0) parts.push(text);
    } else if (block.type === "image") parts.push("[image]");
    else if (block.type === "document") parts.push("[document]");
    else parts.push(`[${String(block.type)}]`);
  }
  return parts.join("\n");
}

/** Whether a message source identifies a landed compaction checkpoint node. */
export function isCheckpointSource(source) {
  if (source === undefined || source === null) return false;
  // Host 0.2.x builds the marker with `compactCheckpointSource()`, which yields
  // `{ kind: "compact-checkpoint", compactionId, sourceCommandId? }`. The legacy
  // `{ kind: "plugin", plugin: "compact" }` shape from earlier hosts is still
  // accepted so checkpoints written by an older host stay recallable.
  if (source.kind === "compact-checkpoint") return true;
  return source.kind === "plugin" && source.plugin === "compact";
}

/**
 * Whether a message source is one of the harness-injected instruction blocks
 * the caller asked to elide (see `elideSourceKinds`). Matching is on the
 * structured `source.kind` field the harness records, never on message text:
 * a user quoting "Instructions from:" must not be mistaken for the real thing.
 *
 * The default (`undefined`/empty) matches nothing, so the open-source default
 * behavior is byte-identical to before this option existed.
 * @param source - message source descriptor, possibly absent.
 * @param kinds - configured exact `source.kind` values to elide.
 * @returns true when this node should collapse to a recall pointer.
 */
export function isElidableSource(source, kinds) {
  if (kinds === undefined || kinds.length === 0) return false;
  const kind = source?.kind;
  return typeof kind === "string" && kinds.includes(kind);
}

/**
 * Display labels for elidable instruction sources. Anything not listed falls
 * back to its raw `source.kind`, so a new host source still gets a readable
 * pointer without a code change.
 */
const ELIDABLE_SOURCE_LABELS = Object.freeze({
  "dsh-mnemon": "记忆快照",
  "agent-instructions": "规则与冷库索引",
  "skill-catalog": "技能清单",
  "runtime-context": "运行时上下文",
  "time-context": "时间上下文"
});

/**
 * Markers that open a hot-memory snapshot as our memory plugin renders it.
 * `[MNEMON]` is the routing hint, `MNEMON RUNTIME MEMORY SNAPSHOT` the payload.
 */
const MEMORY_SNAPSHOT_MARKERS = Object.freeze(["MNEMON RUNTIME MEMORY SNAPSHOT", "[MNEMON]"]);
/** Closing tag of one memory file block inside a snapshot. */
const MEMORY_FILE_CLOSE = "</runtime-memory-file>";
/**
 * Text that may separate two consecutive memory file blocks of ONE snapshot
 * (`USER.md` then `MEMORY.md`), so the two are treated as a single span.
 */
const MEMORY_BLOCK_JOINER = /^\s*(?:MEMORY\.md \(working reference\)|USER\.md \(user profile\)|<runtime-memory-file )/;
/**
 * One role header line of this compiler's own checkpoint format. Memory snapshots
 * never contain one, so finding it between a file block's opening and its close
 * means the close belongs to a LATER block and the span must stop before this.
 * Guards the truncation case: a block cut mid-way loses its closing tag, and
 * without this the span would swallow the conversation that follows.
 */
const MEMORY_ROLE_HEAD = /\n\[(?:user|assistant|tool)\]\s*\n/;

/**
 * Marker text the host puts inside a REAL rules/index wrapper. Prose that only
 * mentions `<system-reminder>` as a string must not qualify, so a candidate
 * span has to prove itself by carrying one of these phrases early on.
 */
const SYSTEM_REMINDER_BODY_MARKERS = Object.freeze([
  "The following workspace instructions may be relevant",
  "Instructions from:"
]);
/** How far into a candidate wrapper the proof phrase must appear. */
const SYSTEM_REMINDER_PROOF_WINDOW = 600;
/** How close a memory marker must sit to the first file block to count. */
const MEMORY_MARKER_WINDOW = 800;

/**
 * Locate injected memory snapshots embedded in a PRIOR checkpoint body.
 *
 * A snapshot is a run of consecutive `<runtime-memory-file …>…</…>` blocks.
 * The span starts at the nearest preceding snapshot marker so the routing hint
 * and the "Entry annotations default…" preamble go with it. The marker must sit
 * close to the first file block, so prose that merely quotes the marker text
 * (e.g. a discussion about this very feature) is not mistaken for a snapshot.
 * @param text - prior checkpoint body.
 * @returns `[start, end)` character spans, left to right.
 */
function findMemorySnapshotSpans(text) {
  const spans = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const markerAt = MEMORY_SNAPSHOT_MARKERS
      .map((marker) => text.indexOf(marker, searchFrom))
      .filter((index) => index !== -1)
      .reduce((lowest, index) => (lowest === undefined || index < lowest ? index : lowest), undefined);
    if (markerAt === undefined) break;
    const firstFile = text.indexOf("<runtime-memory-file ", markerAt);
    if (firstFile === -1) break;
    if (firstFile - markerAt > MEMORY_MARKER_WINDOW) {
      // Just prose quoting the marker — skip past it and keep looking.
      searchFrom = markerAt + 1;
      continue;
    }
    let end;
    let cursor = firstFile;
    for (;;) {
      const close = text.indexOf(MEMORY_FILE_CLOSE, cursor);
      if (close === -1) break;
      // A memory block whose closing tag was truncated away has no close of its
      // own, so the search below would run on to the NEXT block's close and
      // swallow every real turn in between. Role headers are this compiler's own
      // output and never appear inside a memory snapshot, so a role header before
      // the close proves the span has left the block: stop there and keep the
      // dialogue. Erring toward eliding less is safe; eliding a turn is not.
      const roleHead = MEMORY_ROLE_HEAD.exec(text.slice(cursor, close));
      if (roleHead !== null) {
        end = cursor + roleHead.index;
        break;
      }
      const after = close + MEMORY_FILE_CLOSE.length;
      end = after;
      cursor = after;
      if (!MEMORY_BLOCK_JOINER.test(text.slice(after, after + 240))) break;
    }
    if (end === undefined) break;
    spans.push([markerAt, end]);
    searchFrom = end;
  }
  return spans;
}

/**
 * Locate `<system-reminder>…</system-reminder>` wrappers that really frame
 * workspace rules, the cold-store index or runtime context.
 *
 * The wrapper must open at a line start, be followed by the block body marker
 * within a short window, and close before the body repeats — the host emits one
 * wrapper per injection, never nested. A sentence that merely mentions the tag
 * name fails all three checks, which is what keeps live prose intact.
 * @param text - prior checkpoint body.
 * @returns `[start, end)` character spans, left to right.
 */
function findSystemReminderSpans(text) {
  const spans = [];
  const pattern = /(?:^|\n)<system-reminder>\n/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const open = text.indexOf("<system-reminder>", match.index);
    const head = text.slice(open, open + SYSTEM_REMINDER_PROOF_WINDOW);
    if (!SYSTEM_REMINDER_BODY_MARKERS.some((marker) => head.includes(marker))) continue;
    const close = text.indexOf("</system-reminder>", open);
    if (close === -1) continue;
    spans.push([open, close + "</system-reminder>".length]);
  }
  return spans;
}

/**
 * Collapse harness-injected bodies embedded in a PRIOR checkpoint to one-line
 * pointers.
 *
 * Why this exists: those bodies are re-sent in full after every compaction, so
 * any copy kept inside a checkpoint body is a duplicate — the checkpoint grows
 * by one snapshot per compaction even though nothing new was said. The originals
 * stay in the append-only session log, so `recall` still restores them verbatim.
 *
 * Only checkpoint prose is touched; live conversation text is never scanned.
 * @param text - prior checkpoint body.
 * @returns the rewritten body plus how many spans and characters were removed.
 */
export function elideCheckpointInjectedBodies(text) {
  const spans = [...findMemorySnapshotSpans(text), ...findSystemReminderSpans(text)]
    .sort((left, right) => left[0] - right[0]);
  if (spans.length === 0) return { text, spans: 0, chars: 0 };
  let out = "";
  let cursor = 0;
  let chars = 0;
  let removed = 0;
  for (const [start, end] of spans) {
    // Overlapping spans would otherwise duplicate text; keep the outer one.
    if (start < cursor) continue;
    out += text.slice(cursor, start);
    const length = end - start;
    chars += length;
    removed += 1;
    out += `[注入内容已压缩为指针（原文 ${length} 字符）— 压缩后会重新注入，原文可用 recall 调回]`;
    cursor = end;
  }
  out += text.slice(cursor);
  return { text: out, spans: removed, chars };
}

/**
 * One-line pointer standing in for an elided instruction block. Carries the
 * seq so the agent can `recall` the original, plus what it was and how big it
 * was — a bare `(seq N)` would read as content loss rather than a substitution.
 * @param label - human name of the block ("记忆快照" / "规则与索引").
 * @param seq - source sequence of the elided message.
 * @param length - original character count.
 * @returns the marker line.
 */
function elidedSourceMarker(label, seq, length) {
  return `[${label} 已压缩为指针（${seqRef(seq)}，原文 ${length} 字符）— 原文可用 recall 调回，且下一次压缩后会重新注入]`;
}

/**
 * Head/tail excerpt of a tool result under one shared token budget. The tail
 * is anchored to the end of the text at character granularity, so a result
 * whose tail matters more than its head (file listings, logs) keeps its end.
 * @param text - projected result text.
 * @param budget - combined non-whitespace token budget for head + tail.
 * @param ref - provenance for the elision marker.
 * @returns the excerpt, or the full text when it already fits.
 */
export function excerptToolResult(text, budget, ref) {
  const overBudget = countTokens(text) > budget || text.length > budget * 4;
  if (budget <= 0 || !overBudget) return text;
  const half = Math.floor(budget / 2);
  const headLimit = Math.max(8, half);
  const tailLimit = Math.max(8, budget - headLimit);
  const head = truncateTokens(text, headLimit, ref);
  const tail = tailTokens(text, tailLimit, ref);
  return `${head.text}\n...(elided from ${ref})\n${tail.text}`;
}

// ── the region compiler ────────────────────────────────────────────────────

const CHECKPOINT_PREAMBLE = "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";
const CHECKPOINT_OPEN_TAG = "<compacted-checkpoint>";
const CHECKPOINT_CLOSE_TAG = "</compacted-checkpoint>";

/**
 * Model-facing guide framed into the head of every checkpoint: tells the
 * agent how to recover content the compiler elided or truncated, using the
 * two recall tools that read the append-only durable log.
 */
export const RECALL_GUIDE = "RECALL: append-only log — nothing is lost. `recall` restores original content: type \"seq\", id \"3-7\"; \"result\", id \"3\"; \"checkpoint\", id \"1\" (`[checkpoint N]` = dropped). `search` finds by keyword.";

/** Per-node reference marker: the durable seq is the lossless pointer. */
function seqRef(seq) {
  return `seq ${seq}`;
}

/**
 * Build marker for this compiler revision. Bumped whenever the compiled
 * output format changes, so debug logs can prove which code version ran.
 */
export const COMPILER_REV = "vcc-compiler-debug-2";

/**
 * Emit one debug line through the configured sink (and stderr). The sink is
 * installed by the engine (`config.debugSink`) when `debug` is enabled; the
 * compiler itself stays dependency-free.
 * @param config - resolved compiler configuration.
 * @param tag - short component tag for the line.
 * @param line - the diagnostic text.
 */
function debugLog(config, tag, line) {
  if (config.debug !== true) return;
  const text = `[dsh-compaction-vcc] ${tag}: ${line}`;
  try {
    if (typeof config.debugSink === "function") config.debugSink(text);
  } catch {
    /* a failing debug sink must never break a compaction */
  }
  try {
    console.error(text);
  } catch {
    /* stderr may be unavailable in embedded contexts */
  }
}

/**
 * Compile one ordered region into compact entries.
 * @param nodes - ordered `{ seq, message }` projections of the shadowed
 *   surface nodes; `message` may be null (non-projecting node).
 * @param config - resolved compiler-relevant configuration (see index.js).
 * @param budgets - optional per-block budgets; defaults to the config values
 *   (the budget-cap loop passes scaled budgets on retry).
 * @returns `{ entries, stats }` where each entry is one line-group string.
 */
export function compileNodes(nodes, config, budgets) {
  const effective = budgets ?? {
    textTokens: config.textTokens,
    userTextTokens: config.userTextTokens,
    toolCallTokens: config.toolCallTokens,
    toolResultExcerptTokens: config.toolResultExcerptTokens
  };
  const keyFields = { ...DEFAULT_TOOL_KEY_FIELDS, ...(config.toolKeyFields ?? {}) };
  const patterns = config.noisePatterns ?? [];
  // Empty lists mean "unset": the cordis config pipeline injects `[]` for
  // absent array keys, so fall back to the defaults instead of rendering
  // every tool call name-only.
  const argTools = config.toolArgTools?.length > 0 ? config.toolArgTools : DEFAULT_ARG_TOOLS;
  const hiddenTools = new Set(config.hideTools ?? []);
  debugLog(config, "compile", `rev=${COMPILER_REV} nodes=${nodes.length} argTools=[${argTools.join(",")}] hideTools=[${[...hiddenTools].join(",")}] budgets=${JSON.stringify(effective)}`);
  const entries = [];
  const stats = {
    nodes: nodes.length,
    entries: 0,
    toolCalls: 0,
    toolResults: 0,
    images: 0,
    documents: 0,
    reasoningElided: 0,
    noiseElided: 0,
    elidedSourceRows: 0,
    elidedSourceChars: 0,
    elidedCheckpointSpans: 0,
    elidedCheckpointChars: 0,
    checkpoints: 0,
    tokens: 0,
    elidedToolRows: 0,
    elidedRows: 0
  };
  // Pre-pass over the ordered nodes: map each tool-call id to the seq of its
  // result node, so every call one-liner can carry a VCC-style result pointer
  // (`(seq N -> result M)`) even though results no longer occupy entries.
  //
  // ⚠️ 2026-11-06 (this fork) — host 0.2.2 compatibility fix.
  // Up to host ~0.1.x a derived tool-result message exposed `toolCallId` on its
  // FIRST CONTENT BLOCK (`message.content[0].toolCallId`), and that is the only
  // shape this pre-pass used to look at. Host 0.2.2 derives a tool message the
  // way the model APIs do: `role: "tool"` with `toolCallId` on the MESSAGE
  // (`message.toolCallId`), while `content[0]` is a plain text block. The old
  // check therefore never matched, `resultSeqByCallId` stayed empty, and every
  // `* read "a.js" (seq 2)` one-liner silently lost its `-> result 3` pointer —
  // the hook `recall(type:"result")` relies on. Nothing threw; the checkpoint
  // just quietly stopped being lossless. Read the message-level field first and
  // keep the legacy `content[0]` shape as a fallback so one build serves both
  // host generations.
  const resultSeqByCallId = new Map();
  for (const node of nodes) {
    const message = node.message;
    if (message === null || message === undefined) continue;
    const first = message.content?.[0];
    // ⚠️ 2026-11-07 — `first !== undefined` misses null, which threw on
    // `first.type`. Guard the null block explicitly.
    const toolResultBlock = first !== undefined && first !== null && first.type === "tool-result" ? first : undefined;
    const callId = typeof message.toolCallId === "string"
      ? message.toolCallId
      : typeof toolResultBlock?.toolCallId === "string"
        ? toolResultBlock.toolCallId
        : undefined;
    if (callId !== undefined) resultSeqByCallId.set(callId, node.seq);
  }
  let lastRole;
  let open = false;

  /**
   * Append one compiled entry carrying a deletion-priority kind. Kinds order
   * the cap-elision passes in compileRegion: `result`/`tool`/`media`/`note`
   * rows are dropped before `text`/`reasoning`/`checkpoint` rows, so when a
   * checkpoint must shrink, the conversation's words survive its logs.
   * @param seq - durable seq the entry derives from.
   * @param text - rendered entry text.
   * @param kind - entry kind (see the kind list above).
   */
  const pushEntry = (seq, text, kind) => {
    entries.push({ seq, text, kind });
    stats.entries += 1;
    stats.tokens += estimateEntryTokens(text);
  };
  const roleHeader = (role, seq) => {
    if (!open || lastRole !== role) {
      open = true;
      lastRole = role;
      return `[${role}]\n`;
    }
    return "";
  };

  for (const node of nodes) {
    const message = node.message;
    // ⚠️ 2026-11-07 — `content` must be an iterable array here. A null/absent
    // `content` used to fall through to `message.content[0]` below and throw
    // `Cannot read properties of null (reading '0')`, which aborted the WHOLE
    // compile: one malformed node cost the entire compaction, silently (the
    // host's pre-step handler swallows the error as a warning). Skip the node
    // instead so the rest of the region still compiles.
    if (message === null || message === undefined) continue;
    if (!Array.isArray(message.content)) continue;
    if (message.role === "assistant") {
      let header = "";
      for (const block of message.content) {
        // ⚠️ 2026-11-07 — a null/undefined block in the array used to throw on
        // `block.type` and abort the whole compile. Skip it.
        if (block === null || block === undefined) continue;
        if (block.type === "text") {
          const text = sanitize(block.text ?? "");
          if (text.trim().length === 0) continue;
          header = roleHeader("assistant", node.seq);
          const kept = truncateTokens(text, effective.textTokens, seqRef(node.seq));
          pushEntry(node.seq, header + kept.text, "text");
          continue;
        }
        if (block.type === "reasoning") {
          if (config.includeReasoning !== true) {
            stats.reasoningElided += 1;
            continue;
          }
          const text = sanitize(block.text ?? "");
          if (text.trim().length === 0) continue;
          header = roleHeader("assistant", node.seq);
          const kept = truncateTokens(text, effective.textTokens, seqRef(node.seq));
          pushEntry(node.seq, header + kept.text, "reasoning");
          continue;
        }
        if (block.type === "tool-call") {
          const name = block.name ?? "unknown";
          stats.toolCalls += 1;
          if (hiddenTools.has(name)) {
            debugLog(config, "tool", `seq=${node.seq} name=${name} HIDDEN (hideTools)`);
            continue;
          }
          header = roleHeader("assistant", node.seq);
          // One line, always: key argument only for whitelisted tools, and a
          // VCC-style pointer to the result node (`* read "a.js" (seq 2 ->
          // result 3)`) so the dropped result stays one recall away.
          let oneLine;
          let diag;
          if (argTools.includes(name)) {
            const parsed = parseToolArguments(block.arguments);
            const arg = pickToolKeyArg(name, parsed, keyFields);
            oneLine = arg === undefined ? `* ${name}` : `* ${name} "${oneLineArg(arg)}"`;
            diag = `whitelist=yes argsType=${typeof block.arguments} argsLen=${block.arguments === null || block.arguments === undefined ? 0 : String(block.arguments).length} argsHead=${JSON.stringify(String(block.arguments).slice(0, 60))} parse=${parsed === null ? "FAIL" : "ok"} key=${keyFields[name] ?? "(fallback)"} arg=${arg === undefined ? "(none)" : JSON.stringify(String(arg).slice(0, 60))}`;
          } else {
            oneLine = `* ${name}`;
            diag = `whitelist=no argsType=${typeof block.arguments} argsLen=${block.arguments === null || block.arguments === undefined ? 0 : String(block.arguments).length} argsHead=${JSON.stringify(String(block.arguments).slice(0, 60))}`;
          }
          const resultSeq = resultSeqByCallId.get(block.id);
          const ref = resultSeq === undefined ? seqRef(node.seq) : `${seqRef(node.seq)} -> result ${resultSeq}`;
          const kept = truncateTokens(oneLine, effective.toolCallTokens, seqRef(node.seq));
          debugLog(config, "tool", `seq=${node.seq} name=${name} ${diag} line=${JSON.stringify(oneLine.slice(0, 80))} truncated=${kept.truncated} ref=${ref}`);
          pushEntry(node.seq, header + `${kept.text} (${ref})`, "tool");
          continue;
        }
        if (block.type === "image") {
          stats.images += 1;
          header = roleHeader("assistant", node.seq);
          pushEntry(node.seq, header + `[image] (${seqRef(node.seq)})`, "media");
          continue;
        }
        if (block.type === "document") {
          stats.documents += 1;
          header = roleHeader("assistant", node.seq);
          pushEntry(node.seq, header + `[document] (${seqRef(node.seq)})`, "media");
          continue;
        }
        /* unknown merge-extensible block types render as labels */
        {
          header = roleHeader("assistant", node.seq);
          pushEntry(node.seq, header + `[${String(block.type)}] (${seqRef(node.seq)})`, "media");

        }
      }
      /* reasoning-only and empty assistant messages produce no entry */
      continue;
    }
    // ⚠️ 2026-11-07 — host 0.2.x derives a tool result as `role: "tool"` with
    // `toolCallId` on the MESSAGE and a plain text block as `content[0]`. The
    // loop used to handle only `assistant` and `user`, so every real tool result
    // fell through and produced no entry: `stats.toolResults` stayed at 0, the
    // `toolResultExcerptTokens` budget was inert, and the tool output never
    // appeared in the checkpoint at all. Only the `-> result N` pointer survived
    // (that map is built by the separate pre-pass above), so `recall` could still
    // fetch the original — but the compiled view was misdescribed as "lossless"
    // while silently dropping this whole class of content.
    if (message.role === "tool") {
      stats.toolResults += 1;
      const body = projectToolResultText(message.content);
      if (body.length > 0) {
        const header = roleHeader("tool", node.seq);
        // Excerpt to the configured budget: tool output is the bulk of a long
        // session, and the full text stays one `recall(type:"result")` away via
        // the call line's `-> result N` pointer.
        const kept = excerptToolResult(body, effective.toolResultExcerptTokens, seqRef(node.seq));
        pushEntry(node.seq, header + kept, "result");
      }
      continue;
    }
    if (message.role === "user") {
      const first = message.content[0];
      if (first !== undefined && first !== null && first.type === "tool-result") {
        // Tool results never occupy an entry: the content is either absorbed
        // into the following assistant text or one recall away via the call
        // line's `-> result N` pointer (VCC drops results from brief mode too).
        stats.toolResults += 1;
        continue;
      }
      if (isCheckpointSource(message.source)) {
        stats.checkpoints += 1;
        let text = projectToolResultText(message.content);
        if (text.length > 0 && config.elideCheckpointInjectedBodies === true) {
          // A prior checkpoint body still carries every memory snapshot and
          // rules block that was live when it was compiled. Those are re-sent
          // in full after this compaction, so keeping them here is a duplicate.
          // Opt-in (default off) because it rewrites previously compiled prose.
          const collapsed = elideCheckpointInjectedBodies(text);
          if (collapsed.spans > 0) {
            text = collapsed.text;
            stats.elidedCheckpointSpans += collapsed.spans;
            stats.elidedCheckpointChars += collapsed.chars;
          }
        }
        if (text.length > 0) {
          // The checkpoint node is a user/message in the durable protocol
          // (surface replacement only allows message nodes), but it is
          // harness-generated framing — display it as [system].
          const header = roleHeader("system", node.seq);
          pushEntry(node.seq, header + text, "checkpoint");
        }
        continue;
      }
      if (isElidableSource(message.source, config.elideSourceKinds)) {
        // Harness-injected instruction blocks (hot memory, workspace rules,
        // skill catalog…) are re-injected in full after every compaction, so
        // keeping their body here duplicates them: one copy in the checkpoint,
        // one copy re-injected, every time. Collapse to a recall pointer.
        // `elideSourceKinds` is empty by default, so stock behavior is
        // unchanged; we enable it because our memory plugin re-injects.
        const text = projectToolResultText(message.content);
        if (text.length === 0) continue;
        const label = ELIDABLE_SOURCE_LABELS[message.source.kind] ?? message.source.kind;
        stats.elidedSourceRows += 1;
        stats.elidedSourceChars += text.length;
        pushEntry(node.seq, `${roleHeader("user", node.seq)}* ${elidedSourceMarker(label, node.seq, text.length)}`, "note");
        continue;
      }
      let surviving = 0;
      let header = "";
      for (const block of message.content) {
        // ⚠️ 2026-11-07 — a null/undefined block in the array used to throw on
        // `block.type` and abort the whole compile. Skip it.
        if (block === null || block === undefined) continue;
        if (block.type === "text") {
          let text = sanitize(block.text ?? "");
          if (config.stripNoiseXml !== false) text = stripNoiseXml(text, patterns);
          if (text.length === 0) continue;
          surviving += 1;
          header = roleHeader("user", node.seq);
          const kept = truncateTokens(text, effective.userTextTokens, seqRef(node.seq));
          pushEntry(node.seq, header + kept.text, "text");
        } else if (block.type === "image") {
          stats.images += 1;
          surviving += 1;
          header = roleHeader("user", node.seq);
          pushEntry(node.seq, header + `[image] (${seqRef(node.seq)})`, "media");
        } else if (block.type === "document") {
          stats.documents += 1;
          surviving += 1;
          header = roleHeader("user", node.seq);
          pushEntry(node.seq, header + `[document] (${seqRef(node.seq)})`, "media");
        } else {
          const text = sanitize(block.text ?? "");
          if (text.length === 0) continue;
          surviving += 1;
          header = roleHeader("user", node.seq);
          const kept = truncateTokens(text, effective.userTextTokens, seqRef(node.seq));
          pushEntry(node.seq, header + kept.text, "text");
        }
      }
      if (surviving === 0) {
        stats.noiseElided += 1;
        pushEntry(node.seq, `${roleHeader("user", node.seq)}* [user message elided: noise-only] (${seqRef(node.seq)})`, "note");
      }
    }
  }
  return { entries, stats };
}

/**
 * Per-budget elision floors: conversation text keeps a meaningful minimum
 * even when the total cap forces heavy rescaling, while tool one-liners and
 * result excerpts may collapse to near-nothing first.
 */
const BUDGET_FLOORS = Object.freeze({
  textTokens: 32,
  userTextTokens: 32,
  toolCallTokens: 8,
  toolResultExcerptTokens: 8
});

/** Entry kinds dropped by the first (low-value) elision pass. */
const LOW_VALUE_KINDS = new Set(["result", "tool", "media", "note"]);

/**
 * Scale ONLY the conversation-text budgets toward a total cap, never below
 * the per-key floor. Tool-call rows stay one-liners at their configured
 * budget: conversation shrinks first, tool rows are sacrificed whole by the
 * elision pass, so tool calls can never squeeze the dialogue out.
 * @param budgets - budget map to scale.
 * @param factor - uniform scale factor for text budgets.
 * @returns the scaled budget map (tool budgets untouched).
 */
function scaleBudgets(budgets, factor) {
  const scaled = { ...budgets };
  for (const key of ["textTokens", "userTextTokens"]) {
    scaled[key] = Math.max(BUDGET_FLOORS[key] ?? 8, Math.floor(budgets[key] * factor));
  }
  return scaled;
}

/** Render the provenance range of one dropped-entry list. */
function seqRangeOf(dropped) {
  const first = dropped[0].seq;
  const last = dropped[dropped.length - 1].seq;
  return first === last ? `seq ${first}` : `seqs ${first}-${last}`;
}

/**
 * Compile a region to completion under the total checkpoint cap: budgets are
 * rescaled toward `config.maxTokens` up to a fixed number of attempts, then
 * the oldest low-value rows (tool/result/media/note) are front-elided first,
 * and only then the oldest remaining entries — so the conversation's words
 * survive elision before its logs do. The newest entries always survive —
 * recency is the value ranking, as in VCC chunking.
 * @param nodes - ordered `{ seq, message }` projections.
 * @param config - resolved compiler configuration.
 * @returns `{ entries, stats, capped }` — `capped` records cap enforcement.
 */
export function compileRegion(nodes, config) {
  const baseBudgets = {
    textTokens: config.textTokens,
    userTextTokens: config.userTextTokens,
    toolCallTokens: config.toolCallTokens,
    toolResultExcerptTokens: config.toolResultExcerptTokens
  };
  let budgets = baseBudgets;
  let result = compileNodes(nodes, config, budgets);
  let attempts = 0;
  const maxAttempts = 4;
  while (result.stats.tokens > config.maxTokens && attempts < maxAttempts) {
    budgets = scaleBudgets(budgets, config.maxTokens / result.stats.tokens * 0.95);
    result = compileNodes(nodes, config, budgets);
    attempts += 1;
  }
  let capped = false;
  if (result.stats.tokens > config.maxTokens) {
    const entries = result.entries;
    // Phase A: drop the oldest low-value rows (tool/result/media/note)
    // anywhere in the list first, so conversation text and prior-checkpoint
    // knowledge survive elision before the logs do. The marker's seq range is
    // the dropped rows' span (approximate: surviving text may sit inside it).
    const toolRows = [];
    while (entries.length > 1 && result.stats.tokens > config.maxTokens) {
      const index = entries.findIndex((entry, position) => position < entries.length - 1 && LOW_VALUE_KINDS.has(entry.kind));
      if (index === -1) break;
      const dropped = entries.splice(index, 1)[0];
      result.stats.tokens -= estimateEntryTokens(dropped.text);
      toolRows.push(dropped);
    }
    if (toolRows.length > 0) {
      capped = true;
      result.stats.elidedToolRows += toolRows.length;
      entries.unshift({ seq: toolRows[0].seq, text: `[${toolRows.length} tool/result entries elided: ${seqRangeOf(toolRows)}]`, kind: "note" });
      result.stats.tokens += estimateEntryTokens(entries[0].text);
    }
    const elided = [];
    const droppedCheckpoints = [];
    while (entries.length > 1 && result.stats.tokens > config.maxTokens) {
      const dropped = entries.shift();
      result.stats.tokens -= estimateEntryTokens(dropped.text);
      elided.push(dropped);
      if (dropped.kind === "checkpoint") droppedCheckpoints.push(dropped);
    }
    if (elided.length > 0) {
      capped = true;
      result.stats.elidedRows += elided.length;
      // Dropped prior checkpoints never vanish silently: each leaves a
      // single `[checkpoint N]` line the agent can restore in full via
      // recall(type:"checkpoint", id:"N").
      const markerLines = [`[${elided.length} earlier entries elided: ${seqRangeOf(elided)}]`];
      for (const dropped of droppedCheckpoints) {
        const ordinal = config.checkpointOrdinals?.get(dropped.seq);
        const ref = ordinal === undefined ? `@ seq ${dropped.seq}` : String(ordinal);
        markerLines.push(`[checkpoint ${ref}]`);
      }
      entries.unshift({ seq: elided[0].seq, text: markerLines.join("\n"), kind: "note" });
      result.stats.tokens += estimateEntryTokens(entries[0].text);
    }
    if (result.stats.tokens > config.maxTokens && entries.length === 1) {
      capped = true;
      const hard = truncateTokens(entries[0].text, Math.max(8, config.maxTokens - 4), "total cap");
      entries[0] = { seq: entries[0].seq, text: hard.text, kind: entries[0].kind };
      result.stats.tokens = estimateEntryTokens(entries[0].text);
    }
  }
  return { ...result, capped };
}

/**
 * Normalize one compiled entry to its text: entries are `{ seq, text }`
 * pairs, but a custom compile hook may supply plain strings.
 * @param entry - entry value.
 * @returns the entry's text.
 */
export function entryText(entry) {
  return typeof entry === "string" ? entry : entry.text;
}

/**
 * Join compiled entries with separators that keep tool runs compact:
 * consecutive `tool` rows join with a single newline (no blank line), while
 * every other boundary keeps the blank line that separates entry groups.
 * Strings (guide, header, elision markers) behave like `text` entries.
 * @param entries - ordered entry texts (strings or `{ seq, text, kind }` pairs).
 * @returns the joined body text.
 */
export function joinCompiledEntries(entries) {
  let out = "";
  let previousKind;
  for (const entry of entries) {
    const kind = typeof entry === "string" ? "text" : entry.kind;
    if (out.length > 0) out += previousKind === "tool" && kind === "tool" ? "\n" : "\n\n";
    out += typeof entry === "string" ? entry : entry.text;
    previousKind = kind;
  }
  return out;
}

/**
 * Frame compiled entries as the durable replacement checkpoint content:
 * the shared preamble, the recall guide, then one tagged block (guide first,
 * then the optional intro line, the optional header line, the entries, and
 * the optional retention footer). Prior-checkpoint text copied verbatim
 * (with its own backend's tags) nests inside harmlessly.
 * @param entries - ordered entry texts (strings or `{ seq, text }` pairs).
 * @param headerLine - optional first line summarizing the compiled region.
 * @param introLine - optional first line summarizing the compaction itself.
 * @param footerLine - optional tail line reporting the verbatim retention.
 * @returns plain text content blocks.
 */
export function frameCheckpoint(entries, headerLine, introLine, footerLine) {
  const body = [RECALL_GUIDE];
  if (introLine !== undefined) body.push(introLine);
  if (headerLine !== undefined) body.push(headerLine);
  body.push(...entries);
  // `footerLine` accepts one line or an ordered list, so callers can append
  // several trailing notes (cap notice + verbatim retention) without
  // concatenating them into one unreadable paragraph.
  if (footerLine !== undefined) {
    if (Array.isArray(footerLine)) body.push(...footerLine.filter((line) => line !== undefined));
    else body.push(footerLine);
  }
  return [
    { type: "text", text: `${CHECKPOINT_PREAMBLE}\n\n${CHECKPOINT_OPEN_TAG}` },
    { type: "text", text: joinCompiledEntries(body) },
    { type: "text", text: CHECKPOINT_CLOSE_TAG }
  ];
}

export { CHECKPOINT_CLOSE_TAG, CHECKPOINT_OPEN_TAG, CHECKPOINT_PREAMBLE };
