/**
 * Preset-takeover self-check for `dsh-compaction-vcc`.
 *
 * The harness mounts each agent preset as an independent Cordis tree with its
 * own `isolate` realm, so a `compaction` row declared inside a preset
 * (`preset-standard` and friends) instantiates ITS OWN engine in that realm.
 * The engine row this bundle inserts lives on the host plane and can never
 * reach into a preset realm — see `leakedServices` in
 * `@deepseek-ai/dsh-agent-preset-registry`.
 *
 * The consequence is the failure this module exists to catch: the plugin is
 * installed, the `recall`/`search` tools work (they register globally), and
 * compaction still runs on the summarizer preset row. Nothing errors. Without
 * a check the first symptom is a `compaction/summary` event whose `provider`
 * is a chat model instead of `dsh-compaction-vcc`.
 *
 * Two takeover routes are supported and both are detected here:
 *
 *   1. **Alias install** (README method 1, the documented default): the profile
 *      installs this package under the name `@deepseek-ai/dsh-compaction-basic`.
 *      Preset rows resolve that bare name from the profile's `node_modules`
 *      first, so every bundled preset loads this engine with no preset edits.
 *   2. **Preset row rewrite**: a profile patch (or a copied preset) replaces the
 *      row's `name` with this package. Presets resolve it directly.
 *
 * Anything else — plain `dsh plugin add dsh-compaction-vcc` with untouched
 * bundled presets — leaves every preset on the summarizer. The check reports
 * that loudly once per mount instead of failing silently.
 *
 * @module dsh-compaction-vcc/preset-check
 */
import { createRequire } from "node:module";

/** Package name this engine ships under. */
export const ENGINE_PACKAGE = "dsh-compaction-vcc";/** Bare name bundled presets declare for the official summarizer row. */
export const BASIC_PACKAGE = "@deepseek-ai/dsh-compaction-basic";
/** Cordis service name both engines publish. */
export const COMPACTION_SERVICE = "compaction";

/** Row names that identify a compaction engine inside a preset tree. */
const SUMMARY_ENGINE_HINTS = ["compaction-basic", "compaction-vcc", "compaction-instant"];

/**
 * Resolve a row's package name the way the preset loader will, so a row that
 * merely *reads* `@deepseek-ai/dsh-compaction-basic` can be classified by where
 * that bare name actually lands.
 *
 * This distinction is the whole point of the check: the alias install leaves
 * the row name untouched, so name text alone cannot tell a healthy alias
 * deployment from an untouched one that still loads the summarizer.
 *
 * @param name - the row's `name` field.
 * @param baseUrl - resolution base (the preset's `baseUrl`).
 * @returns the resolved file path, or undefined when it does not resolve.
 */
function resolveRowPackage(name, baseUrl) {
  if (typeof name !== "string" || name.length === 0) return undefined;
  if (name.startsWith("cordis:") || name.startsWith("#")) return undefined;
  try {
    const anchor = typeof baseUrl === "string" && baseUrl.length > 0
      ? baseUrl
      : `file://${process.cwd()}/`;
    return createRequire(anchor).resolve(name);
  } catch {
    return undefined;
  }
}

/**
 * Whether a resolved path belongs to this engine's package.
 * The package's own sources live in `<pkg>/src/`, so a path segment test is
 * enough and stays correct for both the real name and the alias.
 * @param resolved - absolute path from `require.resolve`, if any.
 * @returns true when the path is inside this package.
 */
function isEnginePath(resolved) {
  if (typeof resolved !== "string") return false;
  return resolved.includes(`/${ENGINE_PACKAGE}/`) || resolved.includes(`\\${ENGINE_PACKAGE}\\`);
}

/**
 * Whether one preset row belongs to this engine.
 *
 * A row counts as this engine when either:
 *   - its `name` literal is this package (row rewritten, or inserted by id), or
 *   - its `name` is the official summarizer name BUT that bare name resolves
 *     into this package's directory (the documented alias install).
 *
 * Without a resolution base the second case stays "unknown" and is treated as
 * NOT this engine: reporting a false alarm on an untouched install is worse
 * than staying quiet, because an untouched install is the dangerous state.
 *
 * @param row - a preset composition row (`{ id, name, ... }`).
 * @param baseUrl - optional resolution base for the alias check.
 * @returns true when the row loads this engine.
 */
export function isVccRow(row, baseUrl) {
  if (row === null || typeof row !== "object") return false;
  const name = typeof row.name === "string" ? row.name : "";
  if (name === ENGINE_PACKAGE || name.startsWith(`${ENGINE_PACKAGE}/`)) return true;
  const id = typeof row.id === "string" ? row.id : "";
  if (id === "compaction-vcc" || id === "compaction-instant") return true;
  if (name === BASIC_PACKAGE || name.startsWith(`${BASIC_PACKAGE}/`)) {
    return isEnginePath(resolveRowPackage(name, baseUrl));
  }
  return false;
}

/**
 * Whether one preset row is a compaction engine row of any implementation.
 * @param row - a preset composition row.
 * @returns true for a row that occupies the compaction seam.
 */
export function isCompactionEngineRow(row) {
  if (row === null || typeof row !== "object") return false;
  const id = typeof row.id === "string" ? row.id : "";
  const name = typeof row.name === "string" ? row.name : "";
  if (SUMMARY_ENGINE_HINTS.includes(id)) return true;
  return SUMMARY_ENGINE_HINTS.some((hint) => name === hint || name.startsWith(`${hint}/`)) || name === ENGINE_PACKAGE || name === BASIC_PACKAGE;
}

/**
 * Flatten a preset's nested row list, descending into `cordis:group` configs.
 * @param rows - top-level preset rows.
 * @returns every row in declaration order.
 */
export function flattenRows(rows) {
  const flat = [];
  const walk = (list) => {
    if (!Array.isArray(list)) return;
    for (const row of list) {
      if (row === null || typeof row !== "object") continue;
      flat.push(row);
      if (Array.isArray(row.config)) walk(row.config);
    }
  };
  walk(rows);
  return flat;
}

/**
 * Classify every preset's compaction engine row.
 * @param inventory - `agentPresets.compositionInventory()` output.
 * @param baseUrl - optional resolution base for the alias-install check.
 * @returns one record per preset that declares a compaction engine row.
 */
export function auditPresets(inventory, baseUrl) {
  if (!Array.isArray(inventory)) return [];
  const audited = [];
  for (const preset of inventory) {
    if (preset === null || typeof preset !== "object") continue;
    const rows = flattenRows(preset.rows);
    const engineRows = rows.filter(isCompactionEngineRow);
    if (engineRows.length === 0) continue;
    audited.push({
      presetId: typeof preset.id === "string" ? preset.id : "?",
      isDefault: preset.isDefault === true,
      broken: preset.broken,
      engines: engineRows.map((row) => ({
        id: typeof row.id === "string" ? row.id : "",
        name: typeof row.name === "string" ? row.name : "",
        active: row.disabled !== true,
        isVcc: isVccRow(row, baseUrl)
      }))
    });
  }
  return audited;
}

/**
 * Presets whose active compaction engine is NOT this package.
 * @param audit - `auditPresets()` output.
 * @returns the offender records, default preset first.
 */
export function presetsWithoutVcc(audit) {
  const offenders = audit.filter((preset) => {
    const activeEngines = preset.engines.filter((engine) => engine.active);
    if (activeEngines.length === 0) return false;
    return !activeEngines.some((engine) => engine.isVcc);
  });
  return offenders.sort((left, right) => Number(right.isDefault) - Number(left.isDefault));
}

/**
 * Build the operator-facing warning for presets that kept the summarizer.
 * Returns `null` when every preset uses this engine, so the caller can log
 * unconditionally and stay quiet on a healthy install.
 * @param audit - `auditPresets()` output.
 * @returns the warning text, or null when nothing is wrong.
 */
export function formatTakeoverWarning(audit) {
  const offenders = presetsWithoutVcc(audit);
  if (offenders.length === 0) return null;
  const detail = offenders.map((preset) => {
    const summarizers = preset.engines
      .filter((engine) => engine.active && !engine.isVcc)
      .map((engine) => engine.name || engine.id)
      .join(", ");
    return `  - preset "${preset.presetId}"${preset.isDefault ? " (default)" : ""}: ${summarizers || "unknown engine"}`;
  }).join("\n");
  return [
    "dsh-compaction-vcc: this engine did NOT take over compaction for " + `${offenders.length} preset(s).`,
    detail,
    "",
    "Each preset mounts its own isolated compaction realm, so the host-plane",
    "engine row cannot replace a preset's summarizer row. Compaction therefore",
    "still runs the built-in summarizer (a model call), while the recall/search",
    "tools keep working — which is why this fails silently.",
    "",
    "Fix it with ONE of:",
    `  1. Alias install (recommended, no preset edits):`,
    `       dsh plugin --profile <name> add "${BASIC_PACKAGE}@npm:${ENGINE_PACKAGE}"`,
    `  2. Rewrite these presets' compaction row \`name\` to "${ENGINE_PACKAGE}"`,
    "     (copy the preset, or patch its config.plugins — keep the isolate realm).",
    "",
    "Verify with the provider field of the next compaction/summary event:",
    `  it must read "${ENGINE_PACKAGE}", not a chat model.`
  ].join("\n");
}

/**
 * Read the preset inventory without assuming the service exists.
 * @param ctx - any context carrying the `agentPresets` service.
 * @returns the inventory, or `undefined` when no preset registry is mounted.
 */
export async function readInventory(ctx) {
  const registry = ctx.get("agentPresets");
  if (registry === undefined || registry === null) return undefined;
  if (typeof registry.compositionInventory !== "function") return undefined;
  try {
    return await registry.compositionInventory();
  } catch {
    return undefined;
  }
}

/**
 * Run the takeover check and report through the harness logger.
 * A missing preset registry means no preset overrides compaction, so the
 * host-plane engine is authoritative and nothing is reported.
 * @param ctx - engine context.
 * @param logger - logger with `warn`.
 * @param enabled - whether the check is turned on by configuration.
 * @returns the offending presets, or an empty list when healthy/skipped.
 */
export async function checkPresetTakeover(ctx, logger, enabled) {
  if (enabled !== true) return [];
  const inventory = await readInventory(ctx);
  if (inventory === undefined) return [];
  const baseUrl = readBaseUrl(ctx);
  const audit = auditPresets(inventory, baseUrl);
  const warning = formatTakeoverWarning(audit);
  if (warning !== null) {
    try {
      logger.warn(warning);
    } catch {
      /* a failing logger must never break the engine */
    }
  }
  return presetsWithoutVcc(audit);
}

/**
 * Resolution base a preset's rows resolve their package names from.
 * Presets inherit the profile's `baseUrl`, so the alias install is detected
 * against exactly the directory the loader will use.
 * @param ctx - any context of the runtime.
 * @returns the base URL string, or undefined when unavailable.
 */
function readBaseUrl(ctx) {
  try {
    const base = ctx?.baseUrl;
    if (typeof base === "string" && base.length > 0) return base;
    if (base !== null && typeof base === "object" && typeof base.href === "string") return base.href;
  } catch {
    /* a context without a baseUrl simply cannot confirm the alias */
  }
  return undefined;
}
