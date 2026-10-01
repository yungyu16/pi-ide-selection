import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("包：Pi loader 加载独立 IDE 包入口", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-ide-selection-loader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { pi: { extensions: string[] } };
  const loaded = await discoverAndLoadExtensions(manifest.pi.extensions.map((path) => resolve(path)), root, join(root, "agent"));
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0]!.path.endsWith("/src/index.ts"));
});
