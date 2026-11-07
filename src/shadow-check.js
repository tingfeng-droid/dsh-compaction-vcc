/**
 * Duplicate-install self-check.
 *
 * Why this exists (2026-11-07, real incident): the engine can be installed under
 * two different package names on the same machine —
 *
 *   - `dsh-compaction-vcc`                    (bundle install)
 *   - `@deepseek-ai/dsh-compaction-basic`      (alias install)
 *
 * Upgrading overwrites only the name the upgrade targeted. The other directory
 * keeps the version it was first installed with, and because the host resolves
 * `- id: compaction-vcc` by package name, it may load that stale copy. The
 * symptom is the worst kind: the version on disk reads new, every static check
 * passes, and the engine behaves like the old build with no error and no warning.
 *
 * In the incident the profile held `dsh-compaction-vcc@0.7.0` next to
 * `@deepseek-ai/dsh-compaction-basic@0.4.0`; the host loaded 0.4.0 and its
 * output matched a 0.4.0 offline compile exactly.
 *
 * This module finds sibling installs of the same package so the engine can say
 * so once at startup instead of letting the user debug by inference.
 *
 * @module shadow-check
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Package names this engine may be installed under. */
const KNOWN_NAMES = ["dsh-compaction-vcc", "@deepseek-ai/dsh-compaction-basic"];

/**
 * Walk up from `startDir`, yielding every `node_modules` directory found.
 * @param startDir - absolute directory to start from.
 * @param limit - maximum parent hops (guards against pathological trees).
 * @returns absolute `node_modules` paths, nearest first.
 */
function nodeModulesAncestors(startDir, limit = 8) {
  const found = [];
  let dir = resolve(startDir);
  for (let hop = 0; hop < limit; hop += 1) {
    const candidate = join(dir, "node_modules");
    if (existsSync(candidate)) found.push(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/**
 * Read the name/version of a package directory without throwing.
 * @param packageDir - candidate package root.
 * @returns the manifest fields, or undefined when unreadable.
 */
function readManifest(packageDir) {
  try {
    const raw = readFileSync(join(packageDir, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version !== "string") return undefined;
    return { name: typeof parsed.name === "string" ? parsed.name : "", version: parsed.version };
  } catch {
    return undefined;
  }
}

/**
 * Find every installed copy of this engine reachable from the running module.
 *
 * Deliberately read-only and best-effort: a filesystem surprise must never stop
 * the host from booting. The caller decides whether to warn.
 *
 * @param moduleUrl - `import.meta.url` of the running copy.
 * @returns every copy found, including the running one (`current: true`).
 */
export function findInstalledCopies(moduleUrl) {
  let selfDir;
  try {
    selfDir = dirname(dirname(new URL(moduleUrl).pathname));
  } catch {
    return [];
  }
  const copies = [];
  const seen = new Set();
  for (const modulesDir of nodeModulesAncestors(dirname(selfDir))) {
    for (const name of KNOWN_NAMES) {
      const dir = join(modulesDir, name);
      if (seen.has(dir) || !existsSync(dir)) continue;
      seen.add(dir);
      const manifest = readManifest(dir);
      if (manifest === undefined) continue;
      // Only count directories that really hold this engine; a profile may
      // legitimately have the official basic package under the same name.
      const isThisEngine = manifest.name === "dsh-compaction-vcc";
      if (!isThisEngine) continue;
      copies.push({
        dir,
        version: manifest.version,
        current: resolve(dir) === resolve(selfDir)
      });
    }
  }
  return copies;
}

/**
 * Build the warning line for stale sibling installs.
 *
 * Returns undefined when there is nothing worth saying: a single copy, or
 * multiple copies that all report the same version (harmless duplication).
 *
 * @param moduleUrl - `import.meta.url` of the running copy.
 * @returns a one-line warning, or undefined.
 */
export function describeShadowInstalls(moduleUrl) {
  const copies = findInstalledCopies(moduleUrl);
  const current = copies.find((copy) => copy.current);
  if (current === undefined) return undefined;
  const stale = copies.filter((copy) => !copy.current && copy.version !== current.version);
  if (stale.length === 0) return undefined;
  const detail = copies
    .map((copy) => `${copy.current ? "[running] " : "[shadow]  "}${copy.dir.replace(/\/node_modules\//, "/node_modules/")}=${copy.version}`)
    .join("; ");
  return (
    `another copy of this engine is installed at a different version (${detail}). ` +
    `The host may load the shadow copy, so an upgrade can look applied while the old build runs. ` +
    `Remove the extra directory AND its dependency entry from the profile package.json, then restart.`
  );
}
