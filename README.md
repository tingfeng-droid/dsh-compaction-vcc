# dsh-compaction-vcc

> **Maintained by [tingfeng-droid](https://github.com/tingfeng-droid).** Based on [TsFreddie/dsh-compaction-instant](https://github.com/TsFreddie/dsh-compaction-instant) (MIT) — full credit to the original author for the conversation-compiler design this project builds on.
> Main changes: fixed host 0.2.2 compatibility where `toolCallId` moved from `content[0]` to the message, which silently dropped every `-> result N` pointer (see `src/compiler.js` / `src/session-compat.js`), plus a 100-test suite.

[English](README.md) | [简体中文](README.zh-CN.md)

Instant, near-lossless context compaction for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — a **drop-in replacement for `@deepseek-ai/dsh-compaction-basic`** that replaces LLM summarization with the deterministic conversation-compiler principle of [lllyasviel/VCC](https://github.com/lllyasviel/VCC).

A compaction compresses a shadowed history span in **milliseconds, with zero model calls**, keeping **original tokens only** — no paraphrase, no hallucination, no summarizer cost. Everything that is cut is still recoverable through `(seq N)` pointers into the durable session log.

## Why keeping original tokens prevents hallucination

This is the most important design trade-off in the project, so it deserves its own section.

**LLM-summarization compaction manufactures hallucination.** Ask a model to summarize history and it will fill in the details it cannot quite recall with plausible-sounding wording — **and that filled-in material is invented, not factual**. Worse, it is hard to detect: the summary reads fluently and looks reasonable, and the model then treats **its own summary as a factual premise** for further reasoning. A paraphrased number, a reworded caveat, or a dropped precondition is enough to put an entire downstream chain of reasoning on a false footing.

**Keeping original tokens cuts that path off at the root.** This engine **only moves original text, never rewriting a single character**:

- Every elision carries a `(seq N)` pointer back to the original event in the durable log;
- The model can call `recall` at any time to pull the full original text back **verbatim**;
- So the model ever sees only two things: **original tokens**, or **an explicitly marked pointer saying "content elided here — retrieve it at seq N"**. There is no third kind.

Put differently: **summarizing compression lets a model rewrite the original; this engine archives the original verbatim and merely typesets it more tightly.** The former quietly produces fabrication; the latter has no structural room for it.

This matters most in long sessions: the longer the context, the more a summary has to cover, and the more chances there are to rewrite and lose information — whereas pointer-based archiving costs **a few bytes per elision**, essentially independent of history length.

## Key features

- **LLM-free** — compaction never invokes a model. No summarizer prompt, no inference latency, no token spend; the compile is deterministic text processing, so a million-token history compresses in milliseconds.
- **Near-lossless** — output contains only original tokens; every cut is marked and points at its durable `seq`, and prior checkpoints are copied verbatim.
- **Instant** — a single deterministic pass over the shadowed nodes; no network, no model, no KV-cache concerns.
- **Contract-exact drop-in** — same seam, events, provenance and failure vocabulary as `compaction-basic`; every built-in preset loads it unchanged (alias install).

## Example

A region containing a user request, an assistant text + tool call, and its result compiles to:

```
[user]
please fix the bug
[assistant]
on it
* read "a.js" (seq 2 -> result 3)
[user]
next question
```

Every tool call is ONE line: the key argument for whitelisted tools (`toolArgTools`), name-only for the rest (`* job_kill (seq 9 -> result 10)`), nothing at all for `hideTools` rows. Tool results never occupy entries — the `-> result N` pointer keeps them one `recall(type:"result")` away. Long user/assistant text is truncated to its budget with `...(truncated from seq N)`; every elision names the durable event that still holds the full content.

## Recall: the lossless read-back layer

The package also ships the counterparts that close the near-lossless loop — **same-session recall** for the agent and the human. Because the session log is append-only, every token the compiler ever elided is still recoverable:

| Entry point | Module | What it does |
|---|---|---|
| `recall` **tool** (model-facing) | `dsh-compaction-vcc/tool` | Typed restore: `type:"seq"` with `(seq N)`/`(seqs A-B)` markers, `type:"result"` with the `result N` pointer, `type:"checkpoint"` with a `[checkpoint N]` ordinal — restores exact original content into the current tool result |
| `search` **tool** (model-facing, grep) | `dsh-compaction-vcc/tool` | Keyword/regex search over the whole durable log — including content elided by compaction — returning matching events with their `(seq N)` pointers, ready for `recall` |
| `/recall` **command** (human, grep) | `dsh-compaction-vcc/command` | `/recall <keyword|regex>` appends a durable `form: "recall"` user message with the matching events and their seq pointers, so the next model turn sees them |
| Shared cores | `dsh-compaction-vcc/recall` + `dsh-compaction-vcc/search` | Seq parsing (`12`, `3-7`, `seq 12` / `seqs 3-7`), log expansion, budgets, projection; regex compilation and hit rendering |

Recall keeps **everything**: text, reasoning, raw tool-call arguments, nested tool-result content; log-only events render as labeled data dumps; missing seqs are reported; a `maxRecallTokens` budget (default **16000**) cuts with a provenance marker and counts the skipped remainder; searches cap shown hits (`maxSearchHits`, default **50**). Both plugins are separate rows, so they can be mounted next to **any** compaction backend — they only read the durable log.

Every checkpoint also frames a short **RECALL guide** at its head, telling the model exactly how to use `recall` / `search` to recover elided content. When a prior checkpoint is elided under cap pressure it never vanishes silently: it leaves a single `[checkpoint N]` line (N = compaction ordinal, 1 = oldest), which `recall(type:"checkpoint", id:"N")` restores in full.

## Configuration

All fields optional; defaults shown.

| Key | Default | Meaning |
|---|---|---|
| `thresholdRatio` | `0.5` | Fraction of the routed model's context window that triggers automatic compaction |
| `retainTurns` | `1` | Preferred complete recent turns kept verbatim (automatic and manual `/compact`); never overrides the ceiling |
| `retainTokens` | `5120` | **Hard** retained-region token ceiling: older whole turns are added only while the total fits, and when the latest turn alone exceeds it, only the fitting suffix of that turn is kept |
| `auto` | `true` | Register `agent/pre-step` pressure and `agent/request-error` overflow recovery |
| `checkpointCap` | `65536` | Total budget for one compiled checkpoint (compiler tokens): a checkpoint compiled from a smaller span stays near-lossless, a larger one elides down to this cap |
| `maxTokens` / `checkpointScale` | `8192` / `0.1` | **Deprecated** — accepted for drop-in compatibility but **ignored**: the budget is the cap alone (no floor, no proportional scaling) |
| `textTokens` | `512` | Budget per assistant text block |
| `userTextTokens` | `1024` | Budget per user text block |
| `toolCallTokens` | `128` | Budget per tool-call one-liner (never rescaled — see the elision rules) |
| `toolResultExcerptTokens` | `256` | Accepted for compatibility; **inert** — tool results no longer occupy entries |
| `includeReasoning` | `false` | Keep reasoning blocks in the checkpoint |
| `stripNoiseXml` | `true` | Strip configured noise wrappers from user text |
| `noisePatterns` | see compiler | Noise XML regex sources, applied with the `s` flag |
| `toolKeyFields` | built-ins | Extra tool-name → argument-field map for one-liners |
| `toolArgTools` | see compiler | Whitelist whose key argument renders in the one-liner (`read`/`write`/`edit`/`glob`/`grep`/`bash`/`shell`/`web_search`/`skill`/`subagent`/…); every other tool is name-only |
| `hideTools` | — | Bookkeeping tools dropped from the checkpoint entirely |
| `modelPolicies` | — | Per provider/model overrides of `thresholdRatio`/`retainTurns`/`retainTokens` |
| `compactionRetries` / `maxOverflowRetries` | `1` / `1` | Retry budgets, same semantics as basic |
| `summarizationProvider` / `summarizationModel` | — | Accepted for config drop-in compatibility; **inert** — this backend never routes a model |

The tool and command plugins each take their own `{ maxRecallTokens?: 16000, maxSearchHits?: 50 }` config.

> **Cordis config gotcha:** the plugin row's config passes through the schemastery schema, whose `~standard` adapter injects **`[]` for every absent array key** (`toolArgTools`, `hideTools`, `noisePatterns`, `toolKeyFields`, `modelPolicies`). The resolver treats an empty list as *unset* and falls back to the defaults — so a missing `toolArgTools` keeps the built-in whitelist (never disable it by writing `toolArgTools: []`; empty means default). `debug: true` writes per-compile diagnostics to the configured `debugLogPath` (default `$DSH_HOME/compaction-debug.log`).

Budgets are enforced twice — by token count and by a `budget × 4` character ceiling — so pathological unbroken runs (base64 blobs, minified files) cannot bypass them. Tool calls are **always one line**: they are never rescaled, and the cap loop shrinks only the conversation-text budgets (floor **32 tokens** each). If the compiled region still exceeds the cap, the oldest **tool rows** are removed first (`[N tool/result entries elided: seqs a-b]`), and only then the oldest remaining entries (`[N earlier entries elided: seqs a-b]`) — tool calls can never squeeze the dialogue out. The newest content always survives.

### Settings namespace (no UI)

The engine exposes a **user-owned settings namespace** (`compaction-vcc`) on every deployment that composes the settings domain (the standard web/desktop profiles do). The editable subset, persisted to `settings.yaml` and layered **over** the plugin row's cordis config:

| Field | Meaning |
|---|---|
| `checkpointCap` | Total compiler-token budget for one checkpoint (default 65536) |
| `auto` | Register automatic between-step compaction |
| `thresholdRatio` | Context-window fraction that triggers automatic compaction (default `0.5`) |
| `retainTurns` | Preferred complete recent turns kept verbatim (default `1`) |
| `retainTokens` | **Hard** retained-token ceiling: whole turns (or, when the latest turn is larger, a fitting suffix of it) never exceed it (default `5120`) |

Everything else (`modelPolicies`, `toolArgTools`, `debug`, `debugLogPath`, the deprecated `maxTokens`/`checkpointScale`, …) stays cordis-config-only. The settings layer never breaks the engine: every settings write is re-validated by the full config resolver before it is persisted, and non-exposed entry fields keep their composed values. Without a settings service the engine behaves exactly as before (composition entry only).

> **⚠️ There is no graphical settings card.** The `dsh.client` declaration was removed outright in 0.2.0 (see the version table below). The namespace above still exists and is still readable/writable through the settings API, but it is **not rendered as UI controls** — edit `cordis.patch.yml` → `compaction-vcc.config` instead.

### Tokenizer and multilingual behavior

The tokenizer is a character-class heuristic: ASCII letter runs and digit runs count as one token each, punctuation is per-character, whitespace is free, and every other code unit is its own token. Concretely:

| Content | Tokens |
|---|---|
| CJK (`你好，世界！`) | 1 per code point (6) |
| Cyrillic / Arabic | 1 per code unit |
| Accented Latin (`café`) | ASCII runs stay grouped (`caf` + `é`) |
| Emoji (`😀`) | 2 (surrogate pair) |

Every truncation, excerpt, and cap cut is taken at a **code-point boundary** — a slice never leaves a lone surrogate half, so emoji and other astral characters always reach the model intact (pinned by `test/multilang.test.js`). The character-density ceiling follows the DeepSeek docs conversion (quick_start/token_usage): about 0.3 tokens per non-CJK character and 0.6 per CJK character.

The harness token meter (used for the shrink guarantee and `/compact` reporting) is a separate `chars / 4 + block overhead` estimator; the two deliberately coexist — see the top-level design notes.

## Guarantees

- **Instant** — the compile is a single deterministic pass over the shadowed nodes; no network, no model, no KV-cache concerns.
- **Near-lossless** — output contains only original tokens; every cut is marked and points at its durable `seq`; prior checkpoints are copied verbatim.
- **Contract-exact drop-in** — identical seam, events, provenance, pricing (via the singleton `ctx.tokenMeter`), and failure vocabulary as `compaction-basic`, including the shrink guarantee (a checkpoint that would not reduce the surface is rejected).
- **Optional pruner compatible** — consumes the optional `toolResultPruner` service exactly like basic (it helps the *retained tail*; the compiler collapses the *shadowed* region).

## Measured compression (real sessions, no drops)

Rates measured on real session logs (this project's own development sessions), compiled **without dropping a single entry** — every row survives, only per-entry truncation and one-line tool rows apply. Percentages are of the original token count.

| Load | Raw tokens | Compiled | Retained | Compressed |
|---|---|---|---|---|
| Tool-dense session, full (3,181 nodes: 1,438 tool calls + 1,540 results) | 2,523,012 | 226,205 | **9.0%** | 91.0% |
| Another session, full (864 nodes) | 685,088 | 62,705 | **9.2%** | 90.8% |
| Same tool-dense session, recent 800 messages | 625,927 | 45,031 | **7.2%** | 92.8% |
| Pure text only (same session minus all tool rows) | 160,963 | 109,945 | **68.3%** | 31.7% |

Where the ratio comes from (no drops):

- **Tool results cost nothing** — results never produce entries; the `-> result N` pointer keeps each one one `recall` away. That is the biggest win.
- **Tool calls are one line** — each call collapses to a single row (≤ 128 tokens; ~100 on average).
- **Reasoning text is not retained** — reasoning deltas are elided entirely (marked, never silent).
- **Conversation text is nearly lossless** — the pure-text control retained 68.3%; the ~1.5x on text is mostly JSON wrapper stripping plus truncation of only the longest blocks.

Budget scan (same 2.5M-token tool-dense session): with the 64K default cap, the compiled view lands at ~56K tokens (2.2% of the raw size). Dropping starts only as the cap shrinks below the no-drop threshold of ~226K tokens — a lower cap costs a cliff, not a slope:

| Cap | Compiled | Retained | Entries | Dropped |
|---|---|---|---|---|
| 8,192 | 8,243 | 0.33% | 111 | 2,090 |
| 32,768 | 22,263 | 0.88% | 232 | 1,969 |
| 65,536 (deployment default) | 55,737 | 2.2% | 325 | 1,876 |
| 65,536 | 55,737 | 2.2% | 325 | 1,876 |
| 131,072 | 131,047 | 5.2% | 1,142 | 1,058 |
| 226,205 (no-drop threshold) | 226,205 | 9.0% | 2,199 | 0 |

## Installation

All three methods below install the package (published to npm as `dsh-compaction-vcc`) with the harness's own plugin manager (which runs pnpm inside the profile directory, making the package resolvable to both the host composition and every agent preset):

```bash
dsh plugin --profile web add <spec>
```

`dsh-command-compact` (`/compact`) is backend-independent, so it keeps working unchanged in every method.

### ⚠️ Read this first: the wrong install fails silently

**If the host mounts any agent preset (`standard` / `ptc` / `minimal` / `cordis`),
a plain `dsh plugin add dsh-compaction-vcc` is NOT enough.**

Each preset is mounted in its own `isolate` realm, so the `compaction-basic` row
inside a preset instantiates **its own** engine in that realm. The engine row this
package inserts lives on the host plane and **cannot reach into a preset realm** —
upstream `leakedServices` requires compaction services to stay inside the isolate
realm and throws if one leaks out.

The result is a silent half-install:

| | State |
|---|---|
| `recall` / `search` tools | ✅ work (tool registration is global) |
| `/recall` command | ✅ works |
| **actual compaction** | ❌ **still the official basic (model call, summary)** |

**There is exactly one way to tell** — the `provider` field on `compaction/summary`:

```bash
zstd -dc <session>.jsonl.zstd | python3 -c "
import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    o=json.loads(line)
    if o.get('type')=='compaction/summary':
        d=o['data']
        print(o['seq'], d.get('provider'), d.get('model'), 'llm=',d.get('llmStreamCall'))
"
```

- `provider = dsh-compaction-vcc` / `model = vcc-compiler` → ✅ correct
- `provider` is a chat model (e.g. `zlwb-pool-vision`), `llmStreamCall: true` → ❌ **still basic**

**Since 0.3.0 the engine runs this check itself after mount and logs an explicit
`warn` when a preset kept the summarizer**, instead of leaving you to guess. The
switch is `warnOnPresetTakeover` (default `true`).

On a host that mounts presets use **Method 1** (recommended), or Method 2 / 3
(which edit presets). A host without presets can install directly.

> Not sure whether you mount presets? Check whether the profile's
> `dsh.profile.bundles` includes `@deepseek-ai/dsh-web-app` (it inserts
> `agent-preset-registry` with `config.default: standard`), or run
> `dsh --profile <name> --dump-config | grep -c "preset-"`.

### Method 1 — Drop-in replace the built-in engine (alias)

```bash
dsh plugin --profile web add "@deepseek-ai/dsh-compaction-basic@npm:dsh-compaction-vcc"
```

**dsh currently has no way to choose the compaction engine**, and the built-in agent presets (`standard`, `code`, `cordis`) pin the package name `@deepseek-ai/dsh-compaction-basic` in their compositions. To use this engine inside those built-in presets you therefore **masquerade as the built-in plugin**: preset rows resolve bare package names from the profile's `node_modules` (which outranks the harness installation), so installing our package under the built-in name makes every built-in preset load this engine automatically — no preset files are touched, and preset upgrades keep working.

The masquerade is safe by construction: this engine is a contract-exact drop-in — the same `ctx.compaction` seam, the **identical inject list** (`llm`, `tokenMeter`, `sessions`), the same event protocol and error vocabulary, and its `Config` accepts every key of basic's configuration surface. Removing the alias dependency restores the real basic.

This install is **not** recognized as a bundle (the harness resolves the name `@deepseek-ai/dsh-compaction-basic` from its own installation, which declares no `dsh.bundle`), so nothing is automatic — add the recall tools and `/recall` command to the profile's `cordis.patch.yml` yourself (new rows ride an `insert` list; the file hot-reloads, no restart needed). Row names must use the **alias package name**, the only one resolvable in this install; the engine row is optional, needed only as a host fallback for presets without compaction (e.g. `minimal`):

```yaml
- id: compaction-basic
  disabled: true                     # host-level swap (optional fallback)
- insert:
    - id: compaction-instant
      name: '@deepseek-ai/dsh-compaction-basic'   # host fallback for presets without compaction
    - id: tool-recall
      name: '@deepseek-ai/dsh-compaction-basic/tool'
    - id: command-recall
      name: '@deepseek-ai/dsh-compaction-basic/command'
```

### Method 2 — Direct install + AI-authored preset copy (dsh authoring mode)

```bash
dsh plugin --profile web add dsh-compaction-vcc
```

Then open a session with the preset-authoring preset (the shipped `cordis` preset, "creation mode") and ask the AI to:

> Copy the `standard` preset and swap its compaction engine row to `dsh-compaction-vcc`.

The AI uses `agentPresets.copy('standard', '<id>')` to create a locally authored preset, swaps the compaction row's `name` in the copy, mount-validates it with `standingKeyFor('<id>')`, and can set it as the default by patching the `agent-presets` row (`config.default: <id>`). The new preset appears in the UI picker; the built-in presets stay untouched.

The package declares `dsh.bundle`, so the direct install registers itself as a **profile layer automatically**: the built-in summarizer row is disabled and the instant engine + recall tools are inserted host-side (see `cordis.patch.yml` in the package). No manual patch rows needed for the host; only the preset copy above.

### Method 3 — Direct install + manual preset configuration

```bash
dsh plugin --profile web add dsh-compaction-vcc
mkdir -p "$DSH_HOME/.agent-presets/<id>"
# copy composition + metadata from the built-in preset you want as a base
# (the preset roster lists every preset's real path):
cp <built-in-preset>/agent.cordis.yml "$DSH_HOME/.agent-presets/<id>/agent.cordis.yml"
# write preset.yml beside it with name + description
```

Then hand-edit the copy's compaction group — one row name change, inside the same isolate realm:

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true      # the pruner must share this realm
  config:
    - id: compaction-instant
      name: dsh-compaction-vcc   # was '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    # ... keep the pruner row
```

Rules: never edit the shipped preset install; keep the isolate realm; a successful `standingKeyFor` mount (or simply starting a session on the preset) is the real validation — the roster's `broken` flag only catches parse errors.

No host-level rows are needed for Methods 2 and 3: the `dsh.bundle` mentioned above registers everything automatically.

| Method | Engine in built-in presets | Touches preset files | Extra preset in picker | Setup effort |
|---|---|---|---|---|
| **1. Alias replace** | ✅ automatic (standard/code/cordis) | no | no | one command + patch rows |
| **2. AI-authored copy** | only the new preset | the copy | yes | one prompt |
| **3. Manual preset** | only the new preset | the copy | yes | manual edit |

> Only one `ctx.compaction` implementation may be mounted per context (the seam documents "load one implementation per context"); preset mounts keep their own isolate realm, so host and preset instances never collide.

## Development

```bash
npm test        # node --test (compiler units, config validation, session integration, engine)
npm run check   # node --check over all sources
```

The package is dependency-light: `@deepseek-ai/schemastery` for the Config schema; everything else is a peer (the harness provides it). `src/compiler.js` is deliberately dependency-free so it is unit-testable without a running harness.

## Differences from compaction-basic

- No summarizer call → compaction latency goes from seconds to milliseconds; no summarizer token spend.
- No rephrasing → facts, file paths, commands, and identifiers survive byte-exact; the model continues on its own words.
- Deterministic → the same region always compiles to the same checkpoint.
- Prior checkpoints are copied verbatim instead of being re-summarized (cheap and lossless).
- Manual `/compact` and automatic pressure compaction both keep a verbatim recent tail capped by `retainTokens` (whole turns first; a latest turn larger than the ceiling keeps only its fitting suffix) instead of compiling the whole history, so the active conversation is never compacted away; the compiled checkpoint only covers the older span.
- The `compaction/summary` event carries the **compiled entries themselves** — the UI's expandable checkpoint row shows exactly the body the model sees, wrapped in an **adaptive Markdown code fence** (the fence grows longer than any ``` inside, so messages containing markdown render as one tidy code block), and the checkpoint heads with a short RECALL guide telling the model how to recover elided content via `recall` / `search`.
- Trade-off: the checkpoint can be less *dense* than an LLM summary for prose-heavy history (facts are truncated, not merged). The verbatim tail (`retainTurns`/`retainTokens`) is where active work lives, and everything else stays recoverable through `(seq N)` pointers + recall.

MIT licensed.

## Version history

| Version | Status | Notes |
|---|---|---|
| **0.7.0** | ✅ current | **Post-audit cleanup.** Removes `src/client.js` (621 lines / 28.4 kB of dead code — the `dsh.client` declaration was deleted in 0.2.0, so this browser half has had no entry point since), shrinking the package from 83.5 to 79.0 kB. The README section claiming a "browser settings card" contradicted the 0.2.0 removal note; it now reads "Settings namespace (no UI)". Version table backfilled for 0.4.0–0.6.1, which were missing entirely. `exports["./client"]` and the `check` script entry are gone too. |
| 0.6.1 | ✅ usable | **Two fixes, both of which silently broke the host or froze it.** (1) `isCheckpointSource` matched the wrong source shape: host 0.2.x emits `{kind:"compact-checkpoint"}`, but the code tested the legacy `{kind:"plugin", plugin:"compact"}` — a condition that can **never** be true, so the checkpoint branch never ran and `recall(type:"checkpoint")` could not find a single checkpoint (0 before, 5 after). (2) `parseSeqSpec` had no `Number.isSafeInteger` upper bound: `recall(type:"seq", id:"9007199254740992")` **spun forever, synchronously**, inside `expandSelections`'s `seq += 1` loop (at 2^53, `+1` does not change the value) — the tool never returns, no timer can fire, and the host must be restarted. Both the parser and the expander are guarded now, and `seq 0` is rejected. Also fixes three cases where one malformed node aborted an entire compile (`content` null, an array holding a null block, a non-array `content`) — each threw a `TypeError` and cost the whole compaction, which the host swallows as a warning (the symptom is "compaction simply does not happen"). Tests 137 → 149. |
| 0.6.0 | ✅ usable | Elides injected bodies inside prior checkpoints (`elideCheckpointInjectedBodies`, default off). A checkpoint carries the memory snapshot and rules blocks that were live when it was compiled, and every compaction re-injects them — that copy is pure duplication. Enabling this replaces it with a one-line pointer; the originals stay in the append-only log and remain recallable. Measured 90,877 → 46,290 chars (−44,737). Adds `elideSourceKinds` (drop injected rows by source.kind). |
| 0.5.0 | ✅ usable | Completes the 0.2.2 compatibility surface: after tool-result `toolCallId` moved from `content[0]` to the message level, the pre-pass that maps call ids to result seqs stopped matching — **silently** losing every `-> result N` pointer, which is what `recall(type:"result")` relies on. Also consolidates `session-compat` so both session shapes go through one accessor pair. |
| 0.4.0 | ✅ usable | **Defaults switched to "keep the original text".** `userTextTokens` 1024→**16384**, `textTokens` 512→**8192**, `checkpointCap` 65536→**393216**, `retainTokens` 5120→**20480**. Measured on a real 3,524-node / 2.69M-token session: at a 500k shadowed span, conversation retention went **22.0% → 98.4%**; 98.6% at 800k. This also fixes the preset-isolation case for free, because a preset's `compaction-basic` row writes no `config` and therefore inherits the new defaults. Per-entry budgets leave 3.4x / 2x headroom over the longest measured entries (user 4745 / assistant 4043 tokens). Keep `checkpointCap` under ~40% of the model window (393216 ≈ 39% of 1M). |
| 0.3.0 | ✅ usable | **Fixes the silent preset failure.** When the host mounts agent presets, each preset owns an engine instance inside its own `isolate` realm, so the host-plane row this package inserts can never reach it — compaction **silently falls back to the official basic** while the recall tools keep working. This release self-checks preset takeover after mount and logs a `warn` when a preset kept the summarizer; switch is `warnOnPresetTakeover`. Adds 19 preset-scenario tests. **Engine behavior is unchanged — it just stops being silent.** |
| 0.2.1 | ⚠️ deprecated | First attempt at the self-check, but it **read the wrong field names**: `compositionInventory()` reports `{entryId, moduleName, enabled}`, and reading `{id, name, disabled}` made the audit report "healthy" every time — worse than no check, because it looked like one. Also threw `TypeError` on four malformed-context paths. Use 0.3.0. |
| 0.2.0 | ✅ usable | **Removes the `dsh.client` declaration entirely.** The optional settings card made the host create a web-boot entry that could never activate, and an entry that fails to activate aborts the whole web boot. This engine does not need any frontend, so the frontend is gone. |
| 0.1.9 | ⚠️ deprecated | Tried to fix the activation failure by correcting `dsh.client.inject`. Import succeeded, the entry still never activated. **Fails to start on bundle installs.** |
| 0.1.8 | ⚠️ deprecated | Dropped a `require` of a package that does not exist in the host. Still broken. |
| 0.1.7 | ⚠️ deprecated | First version with a correct manifest, but its `client.js` requires `@deepseek-ai/dsh-client-runtime`, which the host does not ship. **Fails to start on bundle installs.** |
| 0.1.6 | ⚠️ deprecated | Real release, but with the old manifest: no `engines.dsh` and `^0.1.0-rc.6` peers, so hosts skip it silently. |
| 0.1.5 | ⚠️ deprecated | Same manifest problem as 0.1.6. |
| 0.0.0-stage | scratch | Placeholder created while debugging the publish pipeline. Contains no code; nothing installs it. |

Two different failure modes are recorded above, and they behave nothing alike:

- **A wrong manifest is silent.** The host drops the bundle into `skippedBundles` and keeps going, so it looks exactly like a working install until you check that compaction actually ran.
- **A broken `dsh.client` is loud but fatal.** If `package.json` declares `dsh.client` with `platform: "web"`, the host is obliged to create a web-boot entry for it and to activate that entry. There is no fallback path: when activation fails, the entire web boot aborts and the app does not start:

  ```
  web boot: 1 entry did not activate
  dsh-compaction-vcc: import failed | loading | pending (waiting for services: ...)
  ```

  Note that this only happens on **bundle installs** (`dsh plugin add`). A package-alias install never loads `dsh.client`, so the fault is invisible on a machine configured that way — which is exactly how 0.1.7 through 0.1.9 shipped broken.

**If you are on anything below 0.2.0, upgrade.** The three broken releases are deprecated on npm.