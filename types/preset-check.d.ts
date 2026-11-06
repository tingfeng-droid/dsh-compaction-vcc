/**
 * Preset-takeover self-check types.
 *
 * A host that mounts agent presets gives each one its own isolated compaction
 * realm, so the host-plane engine row this package inserts cannot replace a
 * preset's summarizer row. These helpers classify every preset's compaction
 * engine row and build the operator warning for the ones still on the
 * summarizer.
 *
 * @module dsh-compaction-vcc/preset-check
 */

/** Package name this engine ships under. */
export declare const ENGINE_PACKAGE: "dsh-compaction-vcc";
/** Bare name bundled presets declare for the official summarizer row. */
export declare const BASIC_PACKAGE: "@deepseek-ai/dsh-compaction-basic";
/** Cordis service name both engines publish. */
export declare const COMPACTION_SERVICE: "compaction";

/** A composition row normalized from any of the shapes the host produces. */
export interface NormalizedRow {
  id: string;
  name: string;
  active: boolean;
}

/** One compaction engine row found inside a preset. */
export interface EngineRow extends NormalizedRow {
  isVcc: boolean;
}

/** One preset's compaction engine verdict. */
export interface PresetAudit {
  presetId: string;
  isDefault: boolean;
  broken?: string;
  engines: EngineRow[];
}

/** One record from `agentPresets.compositionInventory()`. */
export interface InventoryPreset {
  id?: string;
  isDefault?: boolean;
  broken?: string;
  rows?: unknown[];
}

/**
 * Read a composition row's fields regardless of which shape produced it.
 * Accepts `{ entryId, moduleName, enabled }` (the composition shape the host
 * reports) and a raw Cordis entry `{ id, name, disabled }`.
 */
export declare function readRow(row: unknown): NormalizedRow;

/** Whether a preset row loads this engine. */
export declare function isVccRow(row: unknown, baseUrl?: string): boolean;

/** Whether a preset row is a compaction engine row of any implementation. */
export declare function isCompactionEngineRow(row: unknown): boolean;

/** Flatten a preset's nested row list, descending into group configs. */
export declare function flattenRows(rows: unknown[] | undefined): unknown[];

/** Classify every preset's compaction engine row. */
export declare function auditPresets(inventory: InventoryPreset[] | undefined, baseUrl?: string): PresetAudit[];

/** Presets whose active compaction engine is NOT this package, default first. */
export declare function presetsWithoutVcc(audit: PresetAudit[]): PresetAudit[];

/** Operator-facing warning, or `null` when every preset uses this engine. */
export declare function formatTakeoverWarning(audit: PresetAudit[]): string | null;

/** Read the preset inventory without assuming the service exists. */
export declare function readInventory(ctx: unknown): Promise<InventoryPreset[] | undefined>;

/**
 * Run the takeover check and report through the harness logger.
 * Fenced: returns `[]` rather than throwing when the host shape is unexpected.
 */
export declare function checkPresetTakeover(
  ctx: unknown,
  logger: { warn?: (message: string) => void } | undefined,
  enabled: boolean | undefined
): Promise<PresetAudit[]>;
