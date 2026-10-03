// Native addons embedded in the binary get extracted once into ~/.cache/pluto/<name>, then dlopen'd from there
// (Bun would otherwise re-extract them to a temp dir on every start; DuckDB also needs its dylib beside it).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** files: [name on disk, embedded path]; the last one is the .node to load (written last = extraction complete) */
export function loadNative(name: string, files: [string, string][]) {
  const dir = join(homedir(), ".cache", "pluto", name);
  const addon = join(dir, files.at(-1)![0]);
  if (!existsSync(addon)) {
    mkdirSync(dir, { recursive: true });
    for (const [f, src] of files) writeFileSync(join(dir, f), readFileSync(src));
  }
  const m = { exports: {} as any };
  process.dlopen(m, addon);
  return m.exports;
}
