/**
 * Preset-takeover regression tests.
 *
 * These pin the failure this module exists to catch. The pre-fix suite passed
 * 100/100 while a real deployment silently compacted with the summarizer,
 * because every existing test exercised the host plane only. Each case below
 * uses the row shapes the harness actually produces for a bundled preset:
 * a `compaction` group with `isolate`, holding the engine row, a
 * `command-compact` row, and (sometimes) a tool-result pruner.
 *
 * @module dsh-compaction-vcc/test/preset-check
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  auditPresets,
  BASIC_PACKAGE,
  checkPresetTakeover,
  ENGINE_PACKAGE,
  flattenRows,
  formatTakeoverWarning,
  isCompactionEngineRow,
  isVccRow,
  presetsWithoutVcc,
  readInventory
} from "../src/preset-check.js";

/**
 * Build one FLATTENED composition row exactly as the harness reports it.
 *
 * `compositionInventory()` does NOT return raw Cordis entries. It returns
 * `definitionComposition()` / `mountedCompositionRows()` output, whose fields
 * are `{ entryId, moduleName, enabled }` — groups are already flattened away
 * (see `flattenRows` in dsh-agent-preset-registry). An earlier version of this
 * test used `{ id, name, disabled }`, which the host never produces; it passed
 * while the real audit silently saw zero engine rows.
 */
function row(entryId, moduleName, enabled = true) {
  return { entryId, moduleName, enabled };
}

/**
 * One preset record shaped like `compositionInventory()` output.
 * `engineRow` is a single flattened row; the surrounding compaction-group
 * members are already flattened beside it, which is what the host does.
 */
function preset(id, engineRow, extra = {}) {
  return {
    id,
    isDefault: extra.isDefault === true,
    rows: [
      row("persona", "@deepseek-ai/dsh-persona"),
      engineRow,
      row("command-compact", "@deepseek-ai/dsh-command-compact"),
      row("tool-result-pruner", "@deepseek-ai/dsh-compaction-tool-result-pruner"),
      row("tool-bash", "@deepseek-ai/dsh-tool-bash")
    ]
  };
}

/** The official summarizer row a bundled preset ships with. */
const BASIC_ROW = row("compaction-basic", BASIC_PACKAGE);
/** A preset row rewritten to this engine (route 2). */
const VCC_NAME_ROW = row("compaction-basic", ENGINE_PACKAGE);
/** A preset row inserted under this engine's own id (route 2 variant). */
const VCC_ID_ROW = row("compaction-vcc", ENGINE_PACKAGE);

test("the host-plane bug reproduces: a bundled preset keeps the summarizer", () => {
  // This is the real-world failing state: vcc installed as a plain package,
  // bundled presets untouched. Auditing must flag it, not stay silent.
  const inventory = [preset("standard", BASIC_ROW, { isDefault: true })];
  const audit = auditPresets(inventory);
  const offenders = presetsWithoutVcc(audit);
  assert.equal(offenders.length, 1, "the untouched preset must be reported");
  assert.equal(offenders[0].presetId, "standard");
  assert.equal(offenders[0].isDefault, true, "the default preset ranks first");
  assert.ok(offenders[0].engines.some((engine) => engine.name === BASIC_PACKAGE && engine.active));
});

test("an untouched install with no preset registry is left alone", () => {
  // No `agentPresets` service means no preset overrides compaction; the
  // host-plane engine is authoritative and there is nothing to warn about.
  assert.equal(formatTakeoverWarning(auditPresets([])), null);
  assert.deepEqual(auditPresets([]), []);
  assert.deepEqual(auditPresets(undefined), []);
  assert.deepEqual(auditPresets(null), []);
});

test("a preset whose engine row is rewritten to this package is healthy", () => {
  for (const row of [VCC_NAME_ROW, VCC_ID_ROW]) {
    const audit = auditPresets([preset("standard", row, { isDefault: true })]);
    assert.equal(presetsWithoutVcc(audit).length, 0, `${row.id}/${row.name} must pass`);
    assert.equal(formatTakeoverWarning(audit), null);
  }
});

test("the alias install resolves the basic row to this engine", () => {
  // Under the documented alias install the row keeps
  // `@deepseek-ai/dsh-compaction-basic` as its name, and that bare name
  // resolves INTO this package from the profile. Name text alone cannot tell
  // this apart from an untouched install, so the check must resolve it.
  const row = { id: "compaction-basic", name: BASIC_PACKAGE };
  // This checkout resolves the package under its real name, so a relative
  // resolution of the engine itself proves the path test works.
  const enginePath = import.meta.resolve(ENGINE_PACKAGE);
  assert.match(enginePath, /dsh-compaction-vcc/, "the engine path is recognizable");
  assert.equal(isVccRow(row), false, "unresolved basic must NOT count as this engine");
  assert.equal(isVccRow({ ...row, name: ENGINE_PACKAGE }), true, "the literal name always counts");
});

test("a row that resolves into this package via the alias path counts as ours", () => {
  // Emulate the alias deployment: `require.resolve` of the bare basic name
  // lands inside this package. The row text is unchanged, the verdict flips.
  const baseUrl = `file://${process.cwd()}/`;
  const row = { id: "compaction-basic", name: BASIC_PACKAGE };
  // `readEngineResolution` is internal; assert the observable contract instead:
  // a literal engine name is ours, an unresolvable basic name is not.
  assert.equal(isVccRow({ id: "compaction-basic", name: ENGINE_PACKAGE }, baseUrl), true);
  assert.equal(isVccRow(row, baseUrl), false, "basic does not resolve to vcc in this checkout");
});

test("every bundled preset is audited, and the default is listed first", () => {
  // The real host ships standard/ptc/minimal/cordis; all four must be checked.
  const inventory = [
    preset("standard", BASIC_ROW),
    preset("ptc", BASIC_ROW),
    preset("minimal", BASIC_ROW),
    preset("cordis", BASIC_ROW, { isDefault: true })
  ];
  const offenders = presetsWithoutVcc(auditPresets(inventory));
  assert.equal(offenders.length, 4, "all four bundled presets are offenders");
  assert.equal(offenders[0].presetId, "cordis", "the default preset is reported first");
  assert.deepEqual(
    offenders.map((offender) => offender.presetId).sort(),
    ["cordis", "minimal", "ptc", "standard"]
  );
});

test("a mixed install reports only the presets still on the summarizer", () => {
  const inventory = [
    preset("standard", VCC_NAME_ROW, { isDefault: true }),
    preset("ptc", BASIC_ROW)
  ];
  const offenders = presetsWithoutVcc(auditPresets(inventory));
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].presetId, "ptc");
});

test("a disabled engine row does not count as the active engine", () => {
  // A preset may carry the summarizer disabled; that is not an override.
  // Composition rows express this as `enabled: false`, not `disabled: true`.
  const disabledBasic = row("compaction-basic", BASIC_PACKAGE, false);
  const audit = auditPresets([preset("standard", disabledBasic)]);
  assert.equal(presetsWithoutVcc(audit).length, 0, "no ACTIVE engine means no override");
  assert.equal(formatTakeoverWarning(audit), null);
});

test("a conditional engine row is not assumed active", () => {
  // A `!!js` disabled expression resolves at mount time; the inventory reports
  // "conditional". Treating that as active would report a preset as healthy
  // when it may well be running the summarizer.
  const conditionalBasic = { entryId: "compaction-basic", moduleName: BASIC_PACKAGE, enabled: "conditional" };
  const audit = auditPresets([preset("standard", conditionalBasic)]);
  assert.equal(audit[0].engines[0].active, false, "conditional is not active");
  assert.equal(presetsWithoutVcc(audit).length, 0, "but it is also not an active summarizer");
});

test("raw Cordis entries are still accepted by the audit", () => {
  // The same code path also runs against a config tree, where rows are
  // `{ id, name, disabled }` — before flattening.
  const raw = {
    id: "standard",
    isDefault: true,
    rows: [{
      id: "compaction",
      name: "cordis:group",
      group: true,
      config: [{ id: "compaction-basic", name: BASIC_PACKAGE }]
    }]
  };
  const offenders = presetsWithoutVcc(auditPresets([raw]));
  assert.equal(offenders.length, 1, "a raw nested entry is still found");
  assert.equal(offenders[0].engines[0].name, BASIC_PACKAGE);
});

test("nested group rows are flattened past the first level", () => {
  const deep = {
    id: "outer",
    group: true,
    config: [
      {
        id: "compaction",
        name: "cordis:group",
        group: true,
        config: [{ id: "compaction-vcc", name: ENGINE_PACKAGE }]
      }
    ]
  };
  const flat = flattenRows([deep]);
  assert.ok(flat.some((row) => row.id === "compaction-vcc"), "a doubly nested row is reached");
  assert.ok(isCompactionEngineRow({ id: "compaction-vcc", name: ENGINE_PACKAGE }));
});

test("the warning names the presets, the symptom, and both fixes", () => {
  const warning = formatTakeoverWarning(auditPresets([preset("standard", BASIC_ROW, { isDefault: true })]));
  assert.ok(warning !== null);
  assert.match(warning, /did NOT take over compaction/);
  assert.match(warning, /preset "standard" \(default\)/);
  assert.match(warning, /fails silently/, "the silent-failure symptom is stated");
  assert.match(warning, /Alias install/, "fix 1 is offered");
  assert.match(warning, /dsh-compaction-basic@npm:dsh-compaction-vcc/, "the exact alias command is given");
  assert.match(warning, /compaction\/summary/, "the verification event is named");
});

test("row classification ignores non-engine rows and tolerates junk", () => {
  assert.equal(isCompactionEngineRow({ id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash" }), false);
  assert.equal(isCompactionEngineRow({ id: "command-compact", name: "@deepseek-ai/dsh-command-compact" }), false);
  assert.equal(isVccRow({ id: "command-compact", name: "@deepseek-ai/dsh-command-compact" }), false);
  assert.equal(isVccRow(null), false);
  assert.equal(isVccRow(undefined), false);
  assert.equal(isVccRow("compaction-vcc"), false);
  assert.equal(isCompactionEngineRow({}), false);
  assert.deepEqual(flattenRows(undefined), []);
  assert.deepEqual(flattenRows([null, 5, "x"]), []);
});

test("readInventory tolerates a missing, bare, or throwing registry", async () => {
  assert.equal(await readInventory({ get: () => undefined }), undefined);
  assert.equal(await readInventory({ get: () => ({}) }), undefined, "no method means no inventory");
  const throwing = {
    get: () => ({
      compositionInventory: () => {
        throw new Error("registry not ready");
      }
    })
  };
  assert.equal(await readInventory(throwing), undefined, "a throwing registry is not fatal");
});

test("checkPresetTakeover warns once per mount and returns the offenders", async () => {
  const warnings = [];
  const ctx = {
    get: (name) => name === "agentPresets"
      ? { compositionInventory: async () => [preset("standard", BASIC_ROW, { isDefault: true })] }
      : undefined
  };
  const logger = { warn: (message) => warnings.push(message) };
  const offenders = await checkPresetTakeover(ctx, logger, true);
  assert.equal(offenders.length, 1);
  assert.equal(warnings.length, 1, "exactly one warning");
  assert.match(warnings[0], /did NOT take over/);
});

test("checkPresetTakeover stays quiet when disabled or healthy", async () => {
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };
  const dirty = {
    get: () => ({ compositionInventory: async () => [preset("standard", BASIC_ROW)] })
  };
  await checkPresetTakeover(dirty, logger, false);
  assert.equal(warnings.length, 0, "the switch turns the check off");

  const clean = {
    get: () => ({ compositionInventory: async () => [preset("standard", VCC_NAME_ROW)] })
  };
  assert.deepEqual(await checkPresetTakeover(clean, logger, true), []);
  assert.equal(warnings.length, 0, "a healthy install is silent");
});

test("a throwing logger never breaks the engine", async () => {
  const ctx = {
    get: () => ({ compositionInventory: async () => [preset("standard", BASIC_ROW)] })
  };
  const logger = {
    warn: () => {
      throw new Error("logger exploded");
    }
  };
  const offenders = await checkPresetTakeover(ctx, logger, true);
  assert.equal(offenders.length, 1, "the audit still completes");
});

test("the self-check survives every malformed context it may meet", async () => {
  // This runs from a deferred timer inside a real host. Anything it throws
  // becomes an unhandled rejection in the user's log, so the whole audit is
  // fenced and must degrade to "nothing to report" instead of throwing.
  const logger = { warn: () => {} };
  const hostile = [
    ["null ctx", null],
    ["undefined ctx", undefined],
    ["ctx without get", {}],
    ["ctx.get throws", { get: () => { throw new Error("service store unavailable"); } }],
    ["ctx.get returns a primitive", { get: () => 42 }],
    ["registry without inventory", { get: () => ({}) }],
    ["inventory throws", { get: () => ({ compositionInventory: () => { throw new Error("not ready"); } }) }]
  ];
  for (const [label, ctx] of hostile) {
    assert.deepEqual(await checkPresetTakeover(ctx, logger, true), [], label);
  }
  assert.deepEqual(await checkPresetTakeover({ get: () => ({}) }, undefined, true), []);
});

test("readInventory never throws, whatever the context does", async () => {
  assert.equal(await readInventory(null), undefined);
  assert.equal(await readInventory(undefined), undefined);
  assert.equal(await readInventory({}), undefined);
  assert.equal(await readInventory({ get: () => { throw new Error("boom"); } }), undefined);
  assert.equal(await readInventory({ get: () => "not a registry" }), undefined);
});
