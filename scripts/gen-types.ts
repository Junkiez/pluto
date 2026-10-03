// Build step: collect the .d.ts files the in-browser TypeScript service needs into dist/types.json
// (virtual path -> source): TS's lib files (ES + DOM) and nodejs-polars' declarations.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";

const out: Record<string, string> = {};
const tsLib = "node_modules/typescript/lib";
for (const f of readdirSync(tsLib))
  if (/^lib\.(es\d{4}|es5|esnext|dom|decorators|webworker\.importscripts|scripthost).*\.d\.ts$/.test(f) || f === "lib.d.ts")
    out["/lib/" + f] = readFileSync(join(tsLib, f), "utf8");

const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const polars = "node_modules/nodejs-polars";
for (const f of walk(join(polars, "bin")).filter(f => f.endsWith(".d.ts")))
  out["/node_modules/nodejs-polars/" + relative(polars, f)] = readFileSync(f, "utf8");

mkdirSync("dist", { recursive: true });
writeFileSync("dist/types.json", JSON.stringify(out));
console.log(`types.json: ${Object.keys(out).length} files, ${(JSON.stringify(out).length / 1e6).toFixed(1)} MB`);
