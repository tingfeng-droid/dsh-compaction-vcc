/**
 * Duplicate-install regression tests.
 *
 * These pin the 2026-11-07 incident: a profile held `dsh-compaction-vcc@0.7.0`
 * next to a stale `@deepseek-ai/dsh-compaction-basic@0.4.0`, the host loaded the
 * stale copy, and an upgrade appeared to do nothing with no error anywhere.
 *
 * The check is filesystem-driven, so each case builds a throwaway tree instead
 * of mocking `fs`. That keeps the assertion honest: it exercises the same
 * ancestor walk the running engine performs.
 *
 * @module dsh-compaction-vcc/test/shadow-check
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeShadowInstalls, findInstalledCopies } from "../src/shadow-check.js";

/**
 * Create a fake installed package inside `nodeModules`.
 * @param nodeModules - absolute `node_modules` directory.
 * @param name - install directory name (may be a scoped path).
 * @param declaredName - `name` field written into the manifest.
 * @param version - `version` field written into the manifest.
 */
function plantPackage(nodeModules, name, declaredName, version) {
  const dir = join(nodeModules, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: declaredName, version }), "utf8");
}

/**
 * Build a temporary profile tree and return its relevant paths.
 * @param copies - packages to plant: directory name plus manifest fields.
 * @returns the running module URL and a cleanup function.
 */
function buildTree(copies) {
  const root = mkdtempSync(join(tmpdir(), "vcc-shadow-"));
  const nodeModules = join(root, "profiles", "web", "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  for (const copy of copies) plantPackage(nodeModules, copy.dir, copy.name, copy.version);
  const runDir = join(nodeModules, copies[0].dir, "src");
  mkdirSync(runDir, { recursive: true });
  return {
    nodeModules,
    url: `file://${join(runDir, "index.js")}`,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

test("a single install reports no shadow warning", () => {
  const tree = buildTree([{ dir: "dsh-compaction-vcc", name: "dsh-compaction-vcc", version: "0.7.0" }]);
  try {
    assert.equal(describeShadowInstalls(tree.url), undefined);
    const copies = findInstalledCopies(tree.url);
    assert.equal(copies.length, 1);
    assert.equal(copies[0].current, true);
  } finally {
    tree.cleanup();
  }
});

test("a stale alias copy at an older version is reported as shadow", () => {
  const tree = buildTree([
    { dir: "dsh-compaction-vcc", name: "dsh-compaction-vcc", version: "0.7.0" },
    { dir: join("@deepseek-ai", "dsh-compaction-basic"), name: "dsh-compaction-vcc", version: "0.4.0" }
  ]);
  try {
    const warning = describeShadowInstalls(tree.url);
    assert.ok(warning, "expected a warning when a stale sibling exists");
    assert.match(warning, /0\.7\.0/);
    assert.match(warning, /0\.4\.0/);
    assert.match(warning, /dsh-compaction-basic/);
    assert.match(warning, /\[running\]/);
    assert.match(warning, /\[shadow\]/);
  } finally {
    tree.cleanup();
  }
});

test("duplicate copies at the same version stay quiet", () => {
  const tree = buildTree([
    { dir: "dsh-compaction-vcc", name: "dsh-compaction-vcc", version: "0.7.0" },
    { dir: join("@deepseek-ai", "dsh-compaction-basic"), name: "dsh-compaction-vcc", version: "0.7.0" }
  ]);
  try {
    assert.equal(describeShadowInstalls(tree.url), undefined);
    assert.equal(findInstalledCopies(tree.url).length, 2);
  } finally {
    tree.cleanup();
  }
});

test("the genuine official basic package is not counted", () => {
  // The alias install name is shared with the real upstream package. A profile
  // may hold the official engine under it; that must not be flagged as a copy
  // of this fork.
  const tree = buildTree([
    { dir: "dsh-compaction-vcc", name: "dsh-compaction-vcc", version: "0.7.0" },
    {
      dir: join("@deepseek-ai", "dsh-compaction-basic"),
      name: "@deepseek-ai/dsh-compaction-basic",
      version: "0.2.2-rc.1"
    }
  ]);
  try {
    assert.equal(describeShadowInstalls(tree.url), undefined);
    assert.equal(findInstalledCopies(tree.url).length, 1);
  } finally {
    tree.cleanup();
  }
});

test("an unreadable sibling manifest is skipped instead of throwing", () => {
  const tree = buildTree([{ dir: "dsh-compaction-vcc", name: "dsh-compaction-vcc", version: "0.7.0" }]);
  try {
    const broken = join(tree.nodeModules, "@deepseek-ai", "dsh-compaction-basic");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "package.json"), "{not json", "utf8");
    assert.equal(describeShadowInstalls(tree.url), undefined);
  } finally {
    tree.cleanup();
  }
});
