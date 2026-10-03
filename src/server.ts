// Pluto: notebook server. JS/TS cells run in an edge-runtime VM (TS stripped by swc), SQL cells hit PGlite.
import { PGlite } from "@electric-sql/pglite";
import { Database } from "bun:sqlite";
import { EdgeRuntime } from "edge-runtime";
import { inspect } from "node:util";
import { timingSafeEqual, randomBytes } from "node:crypto";
import realFs from "node:fs/promises";
import { createLoopback } from "mountx";
import { createNodeFsDriver } from "mountx/drivers/node-fs";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath, sep } from "node:path";
// embedded into the binary by `bun build --compile`
import indexHtml from "./web/index.html" with { type: "file" };
import editorJs from "../dist/editor.js" with { type: "file" };
import tsWorkerJs from "../dist/ts-worker.js" with { type: "file" };
import geistSans from "../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2" with { type: "file" };
import geistMono from "../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2" with { type: "file" };
import logoPng from "../assets/logo.png" with { type: "file" };
import vueJs from "../node_modules/vue/dist/vue.global.prod.js" with { type: "file" };
import swcGlue from "../node_modules/@swc/wasm/wasm.js" with { type: "text" };
import swcWasm from "../node_modules/@swc/wasm/wasm_bg.wasm" with { type: "file" };
import pgWasm from "../node_modules/@electric-sql/pglite/dist/pglite.wasm" with { type: "file" };
import initdbWasm from "../node_modules/@electric-sql/pglite/dist/initdb.wasm" with { type: "file" };
import pgData from "../node_modules/@electric-sql/pglite/dist/pglite.data" with { type: "file" };

const swc = await loadSwc();
// named args: --name value / --name=value (single dash works too)
function flag(name: string) {
  const args = process.argv.slice(2);
  const eq = args.find(a => /^--?[\w-]+=/.test(a) && a.replace(/^--?/, "").startsWith(name + "="));
  if (eq) return eq.slice(eq.indexOf("=") + 1);
  const i = args.findIndex(a => a === "--" + name || a === "-" + name);
  if (i < 0) return undefined;
  if (args[i + 1] === undefined || args[i + 1].startsWith("-")) throw new Error(`--${name} needs a value`);
  return args[i + 1];
}
// --pass (or PLUTO_PASS, which stays out of `ps`): require a password
const pass = flag("pass") ?? process.env.PLUTO_PASS;
let file = resolvePath(flag("file") ?? "notebook.json"); // absolute: sandbox mode chdirs (see duckConn)
const port = Number(process.env.PORT ?? 9999);
// deno-style: --allow-import=host1,host2 limits URL imports; bare --allow-import allows any host
const allowArg = process.argv.find(a => a.startsWith("--allow-import"));
const allowHosts = allowArg === "--allow-import" ? null : (allowArg?.split("=")[1] ?? "esm.sh,cdn.jsdelivr.net,unpkg.com,jsr.io").split(",");

const pgliteWasmModule = new WebAssembly.Module(await Bun.file(pgWasm).arrayBuffer());
const initdbWasmModule = new WebAssembly.Module(await Bun.file(initdbWasm).arrayBuffer());
const openDb = () => PGlite.create({ dataDir: file + ".pgdata", pgliteWasmModule, initdbWasmModule, fsBundle: Bun.file(pgData) });
let db = await openDb();

// fs for cells: by default a mountx loopback jailed to <notebook>.files/ (`..` is clamped at its root);
// --unsafe hands cells the real node:fs/promises.
const unsafe = process.argv.includes("--unsafe");
let fs = unsafe ? realFs : sandboxFs(file + ".files");
function sandboxFs(root: string) {
  mkdirSync(root, { recursive: true });
  const loop = createLoopback(createNodeFsDriver(root)) as any;
  const abs = (p: any) => (String(p).startsWith("/") ? String(p) : "/" + p);
  return new Proxy(loop, {
    get(t, k) {
      // node-style readFile(path, "utf8") -> string; mountx returns bytes
      if (k === "readFile") return async (p: any, o?: any) => {
        const b = await t.readFile(abs(p));
        const enc = typeof o === "string" ? o : o?.encoding;
        return enc ? new TextDecoder().decode(b) : b;
      };
      // node-style readdir -> names unless { withFileTypes: true }
      if (k === "readdir") return async (p: any, o?: any) => {
        const ents = await t.readdir(abs(p), { withFileTypes: true });
        return o?.withFileTypes ? ents : ents.map((e: any) => e.name);
      };
      const f = t[k];
      return typeof f === "function" ? (p: any, ...a: any[]) => f.call(t, abs(p), ...a.map(x => (typeof x === "string" && k === "rename" ? abs(x) : x))) : f;
    },
  });
}

let vm = newVm();

// switch notebooks: each one has its own db (<name>.pgdata), sandbox fs (<name>.files) and a fresh kernel
const dir = dirname(resolvePath(file));
// DuckDB: opened on first use (first load extracts the ~110MB engine to ~/.cache/pluto), one file per notebook.
// Without --unsafe it can only touch <notebook>.files/ and the config is locked so cells can't SET their way out.
let duck: Promise<any> | undefined;
const duckConn = () => (duck ??= (async () => {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const inst = await DuckDBInstance.create(file + ".duckdb");
  const conn = await inst.connect();
  if (!unsafe) {
    // DuckDB checks relative paths against the allow-list before resolving them, so make cwd the sandbox.
    // ponytail: process-wide cwd; fine since everything else uses absolute paths in sandbox mode
    process.chdir(file + ".files");
    const root = (resolvePath(file + ".files") + sep).replaceAll("'", "''");
    // order matters: allow-list and search path first, then cut external access, then lock it all
    await conn.run(`SET allowed_directories = ['${root}']; SET enable_external_access = false; SET lock_configuration = true;`);
  }
  return { inst, conn };
})().catch(e => { duck = undefined; throw e; }));
// Polars: native, embedded (polars-binding.ts), loaded on first use. Frames render as tables; "polars" cells run SQL over
// every DataFrame bound in the JS kernel, by variable name.
let polars: any;
const pl = () => (polars ??= require("nodejs-polars"));
const isFrame = (x: any) => typeof x?.toRecords === "function" && typeof x?.height === "number";
const isLazy = (x: any) => typeof x?.collectSync === "function";
const isSeries = (x: any) => typeof x?.toArray === "function" && typeof x?.dtype === "object" && !isFrame(x);
const plain = (v: any): any => (typeof v === "bigint" ? (Number.isSafeInteger(Number(v)) ? Number(v) : String(v)) : v);
function frameResult(df: any, out: string[]) {
  const max = 500; // ponytail: fixed cap so huge frames don't blow up the page; paginate if needed
  if (df.height > max) out.push(`showing ${max} of ${df.height} rows`);
  const rows = df.head(max).toRecords().map((r: any) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)])));
  return { out, tables: [{ fields: df.columns, rows }] };
}
function polarsSql(code: string) {
  const frames: Record<string, any> = {};
  for (const k of Object.keys(vm.context)) {
    try { const x = vm.context[k]; if (isFrame(x) || isLazy(x)) frames[k] = x; } catch {}
  }
  return pl().SQLContext(frames).execute(code, { eager: true });
}

// SQLite (bun:sqlite, built into the binary): <notebook>.sqlite. Without --unsafe, statements that reach other files
// (ATTACH, VACUUM INTO) are refused. ponytail: keyword regex, so a string literal containing "attach" is refused too.
let lite: Database | undefined;
const liteDb = () => (lite ??= new Database(file + ".sqlite", { create: true }));
function sqliteRun(code: string) {
  if (!unsafe && /\b(attach|vacuum\s+into)\b/i.test(code)) throw new Error("ATTACH / VACUUM INTO are disabled in the sandbox (run with --unsafe)");
  // bun's query() runs one statement: run everything before the last one, return the last one's rows
  let q: string | null = null, last = 0;
  const body = code.replace(/[\s;]+$/, "");
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { if (c === q) q = null; }
    else if (c === "'" || c === '"' || c === "`") q = c;
    else if (c === "-" && body[i + 1] === "-") i = body.indexOf("\n", i) < 0 ? body.length : body.indexOf("\n", i);
    else if (c === ";") last = i + 1;
  }
  if (last) liteDb().run(body.slice(0, last));
  const stmt = liteDb().query(body.slice(last));
  const rows = stmt.all() as any[];
  return { fields: stmt.columnNames, rows: rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? `<${v.length} bytes>` : plain(v)]))) };
}

async function duckQuery(q: string) {
  const r = await (await duckConn()).conn.runAndReadAll(q);
  // BIGINT -> number when it fits, else string (JSON can't carry bigint); other types via duckdb's JSON conversion
  const big = (v: any) => (typeof v === "bigint" ? (Number.isSafeInteger(Number(v)) ? Number(v) : String(v)) : v);
  const js = r.getRowObjectsJS(), json = r.getRowObjectsJson();
  return { fields: r.columnNames(), rows: json.map((row: any, i: number) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof js[i][k] === "bigint" ? big(js[i][k]) : v]))) };
}

async function openNotebook(name: string) {
  await db.close();
  lite?.close(); lite = undefined;
  if (duck) { const d = await duck.catch(() => null); d?.conn.closeSync(); d?.inst.closeSync(); duck = undefined; }
  file = join(dir, name);
  db = await openDb();
  if (!unsafe) fs = sandboxFs(file + ".files");
  vm = newVm();
}
const listNotebooks = () =>
  readdirSync(dir).filter(f => {
    if (!f.endsWith(".json")) return false;
    try { return Array.isArray(JSON.parse(readFileSync(join(dir, f), "utf8")).cells); } catch { return false; }
  });
function newVm() {
  // allow eval/new Function + wasm: libraries (arquero, compilers) need them, and cells already run arbitrary code
  const v = new EdgeRuntime({ codeGeneration: { strings: true, wasm: true } });
  // edge-runtime swaps Object for a Proxy (cross-realm instanceof), which breaks the common `x.constructor === Object`
  // plain-object check (typed-function/mathjs inside danfojs, among others). Put the realm's real Object back.
  v.evaluate("globalThis.Object = ({}).constructor");
  // cross-language: await sql`select ...` or await sql("select $1", [x]) from JS cells
  v.context.sql = async (q: any, ...vals: any[]) => {
    const text = Array.isArray(q) && "raw" in q ? q.reduce((a: string, s: string, i: number) => a + "$" + i + s) : q;
    const params = Array.isArray(q) && "raw" in q ? vals : vals[0];
    return (await db.query(text, params)).rows;
  };
  // URL imports: fetch ESM, convert to CJS with swc, preload deps in parallel, evaluate inside the VM. Cache dies with the kernel.
  const mods = new Map<string, { module: { exports: any }; ready: Promise<void> }>();
  const load = (url: string, chain: string[] = []): Promise<void> => {
    if (chain.includes(url)) return Promise.resolve(); // import cycle: hand back partially-initialised exports, like node
    if (!mods.has(url)) {
      const module = { exports: {} as any };
      mods.set(url, { module, ready: (async () => {
        const host = new URL(url).hostname;
        if (allowHosts && !allowHosts.includes(host)) throw new Error(`import of ${url} denied; run with --allow-import=${host}`);
        // esm.sh picks its build from the user-agent; ask for the browser one (edge-runtime has no `process`)
        const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 Chrome/130" } });
        if (!res.ok) throw new Error(`import ${url}: HTTP ${res.status}`);
        const text = await res.text();
        // no import/export => browser script / UMD bundle: run it like a <script> tag and export the globals it defines.
        // (handing UMD a `module` makes it take its Node path, which browser bundles like danfojs break on)
        const body = swc.parseSync(text, { syntax: "ecmascript" }).body;
        if (!body.some((n: any) => /^(Import|Export)/.test(n.type))) {
          const before = new Set(Object.getOwnPropertyNames(v.context));
          v.evaluate(text);
          const added = Object.getOwnPropertyNames(v.context).filter(k => !before.has(k));
          // the library's own global: one the script declares at top level (webpack's `var dfd = ...`), else whatever
          // isn't an obvious helper/polyfill (`_tfGlobals`, `regeneratorRuntime`)
          const declared = new Set(body.flatMap((n: any) => (n.type === "VariableDeclaration" ? n.declarations.map((d: any) => d.id?.value) : [])));
          const top = added.filter(k => declared.has(k));
          const own = top.length ? top : added.filter(k => !k.startsWith("_") && k !== "regeneratorRuntime");
          const only = own.length === 1 ? v.context[own[0]] : undefined;
          Object.assign(module.exports, Object.fromEntries(added.map(k => [k, v.context[k]])), only && typeof only === "object" ? only : {});
          module.exports.default = only ?? module.exports;
          return;
        }
        const cjs = swc.transformSync(text, { jsc: { parser: { syntax: "ecmascript" }, target: "es2022" }, module: { type: "commonjs" } }).code;
        const specs = [...new Set([...cjs.matchAll(/require\("([^"]+)"\)/g)].map(m => m[1]))];
        // a dep that fails to load only throws when actually required: packages often try/catch optional or per-platform requires
        const failed = new Map<string, unknown>();
        await Promise.all(specs.map(s => load(resolve(s, url), [...chain, url]).catch(e => failed.set(s, e))));
        v.evaluate(`(function (module, exports, require) {${cjs}\n})`)(module, module.exports, (s: string) => {
          if (failed.has(s)) throw failed.get(s);
          return mods.get(resolve(s, url))!.module.exports;
        });
      })() });
    }
    return mods.get(url)!.ready;
  };
  v.context.fs = fs;
  // await duck`select ...` from JS cells (no params; interpolations are inlined as-is)
  v.context.duck = async (q: any, ...vals: any[]) =>
    (await duckQuery(Array.isArray(q) && "raw" in q ? String.raw(q, ...vals) : q)).rows;
  v.context.__import = async (spec: string) => {
    if (spec === "nodejs-polars" || spec === "polars") return Object.assign(Object.create(pl()), { default: pl() });
    if (/^(node:)?fs(\/promises)?$/.test(spec)) return new Proxy(fs, { get: (t: any, k) => (k === "default" || k === "promises" ? fs : t[k]) });
    const url = resolve(spec); await load(url); return mods.get(url)!.module.exports; };
  return v;
}

async function loadSwc() {
  // @swc/wasm reads wasm_bg.wasm via __dirname, which doesn't exist in a compiled binary; feed it the embedded bytes instead.
  const mod: any = { exports: {} };
  const src = swcGlue.replace(/const path = require\('path'\).*\n.*\n/, "const bytes = __bytes;\n");
  new Function("module", "exports", "require", "__bytes", src)(mod, mod.exports, require, new Uint8Array(await Bun.file(swcWasm).arrayBuffer()));
  return mod.exports;
}

// bare specifiers go to esm.sh, like `npm:` in deno
const resolve = (spec: string, base?: string) => /^(https?:|\.{0,2}\/)/.test(spec) ? new URL(spec, base).href : "https://esm.sh/" + spec;

// `import a, { b as c } from "u"` / `import * as m from "u"` -> `var a = (await __import("u")).default` ...
// ponytail: regex, single-line imports only; swc AST if multi-line imports are needed
function rewriteImports(code: string) {
  return code.replace(/^import\s+(?!type\b)(.+?)\s+from\s+["']([^"']+)["'];?[ \t]*$/gm, (_, clause: string, spec: string) => {
    const m = `(await __import(${JSON.stringify(spec)}))`;
    const out: string[] = [];
    const ns = clause.match(/\*\s+as\s+([\w$]+)/);
    if (ns) out.push(`var ${ns[1]} = ${m};`);
    const def = clause.match(/^([\w$]+)/);
    if (def) out.push(`var ${def[1]} = ${m}.default;`);
    for (const n of clause.match(/\{([^}]*)\}/)?.[1].split(",").map(x => x.trim()).filter(Boolean) ?? []) {
      const [name, alias = name] = n.split(/\s+as\s+/);
      out.push(`var ${alias} = ${m}[${JSON.stringify(name)}];`);
    }
    return out.join("\n");
  }).replace(/^import\s+["']([^"']+)["'];?$/gm, (_, spec) => `await __import(${JSON.stringify(spec)});`);
}

// async cells run inside an IIFE, so turn a trailing expression statement into `return (...)` to keep the cell's value
function returnLast(code: string, lang: string) {
  try {
    // leading ";" pins the program span to offset 0 (swc spans are global and accumulate across parses)
    const src = ";" + code;
    const ast = swc.parseSync(src, { syntax: lang === "ts" ? "typescript" : "ecmascript" });
    const last = ast.body.at(-1);
    if (last?.type !== "ExpressionStatement") return code;
    const b = Buffer.from(src), base = ast.span.start;
    const [s, e] = [last.span.start - base, last.span.end - base];
    const expr = b.subarray(s, e).toString().replace(/;\s*$/, "");
    return b.subarray(1, s).toString() + `return (${expr});` + b.subarray(e).toString();
  } catch {
    return code; // let the real compile report syntax errors
  }
}

function toJs(code: string, lang: string) {
  code = rewriteImports(code);
  // ponytail: column-0 regex makes top-level bindings persist across cells; swc AST rewrite if nested edge cases bite
  code = code.replace(/^(?:const|let)\s+/gm, "var ");
  if (/\bawait\b/.test(code)) {
    // async cells lose `var` scope inside the IIFE, so hoist simple top-level bindings onto globalThis
    code = code.replace(/^var\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/gm, "globalThis.$1 =");
    code = `(async () => {\n${returnLast(code, lang)}\n})()`;
  }
  if (lang === "ts")
    code = swc.transformSync(code, { jsc: { parser: { syntax: "typescript" }, target: "es2022" }, isModule: false }).code;
  return code;
}

async function run(code: string, lang: string) {
  const out: string[] = [];
  if (lang === "sql") {
    const res = await db.exec(code);
    return { out, tables: res.filter(r => r.fields.length).map(r => ({ fields: r.fields.map(f => f.name), rows: r.rows })) };
  }
  if (lang === "sqlite") { const t = sqliteRun(code); return { out, tables: t.fields.length ? [t] : [] }; }
  if (lang === "polars") return frameResult(polarsSql(code), out);
  if (lang === "duckdb") {
    const t = await duckQuery(code);
    return { out, tables: t.fields.length ? [t] : [] };
  }
  const fmt = (a: any[]) => a.map(x => (typeof x === "string" ? x : inspect(x, { depth: 4 }))).join(" ");
  const tables: any[] = [];
  vm.context.console = {
    table: (data: any) => {
      if (isFrame(data)) return void tables.push(frameResult(data, out).tables[0]);
      const rows = Array.isArray(data) ? data.map(r => (r !== null && typeof r === "object" ? r : { value: r })) : Object.entries(data ?? {}).map(([k, v]) => ({ "(index)": k, ...(v !== null && typeof v === "object" ? v : { value: v }) }));
      tables.push({ fields: [...new Set(rows.flatMap(r => Object.keys(r)))], rows: rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)]))) });
    }, log: (...a: any[]) => out.push(fmt(a)), info: (...a: any[]) => out.push(fmt(a)), warn: (...a: any[]) => out.push(fmt(a)), error: (...a: any[]) => out.push(fmt(a)) };
  // lazy `pl` global: getters don't survive into the vm context, so bind it the first time a cell mentions it
  if (/\bpl\b/.test(code) && vm.context.pl === undefined) vm.context.pl = pl();
  let value = vm.evaluate(toJs(code, lang));
  if (typeof value?.then === "function") value = await value;
  if (isLazy(value) && !isFrame(value)) value = value.collectSync();
  if (isSeries(value)) value = pl().DataFrame([value]);
  // danfo.js DataFrames (2D `values` + `columns`, plus its own index)
  if (typeof value?.print === "function" && Array.isArray(value?.columns) && Array.isArray(value?.values?.[0]) && Array.isArray(value?.index)) {
    const n = value.values.length, max = 500;
    if (n > max) out.push(`showing ${max} of ${n} rows`);
    const rows = value.values.slice(0, max).map((r: any[], i: number) => Object.fromEntries([["", value.index[i]], ...value.columns.map((c: string, j: number) => [c, plain(r[j])])]));
    return { out, tables: [...tables, { fields: ["", ...value.columns], rows }] };
  }
  // arquero tables
  if (typeof value?.objects === "function" && typeof value?.numRows === "function" && typeof value?.columnNames === "function") {
    const rows = value.objects({ limit: 500 }).map((r: any) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)])));
    if (value.numRows() > 500) out.push(`showing 500 of ${value.numRows()} rows`);
    return { out, tables: [...tables, { fields: value.columnNames(), rows }] };
  }
  if (isFrame(value)) return { out, tables: [...tables, ...frameResult(value, out).tables] };
  // HTML results: a string that starts with a tag, or a Response with an html content-type
  if (value instanceof vm.context.Response && value.headers.get("content-type")?.includes("html")) return { out, tables, html: await value.text() };
  if (typeof value === "string" && /^\s*<(!doctype|[a-z][\w-]*)[\s>/]/i.test(value)) return { out, tables, html: value };
  return { out, tables, value: value === undefined ? undefined : inspect(value, { depth: 4 }) };
}

// random per-process session token: restarting the binary logs everyone out
const session = randomBytes(32).toString("hex");
const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
// basic auth (any username, constant-time password check) or the session cookie from ?password=
function authorized(req: Request) {
  const cookie = req.headers.get("cookie")?.match(/(?:^|;\s*)pluto=([0-9a-f]+)/)?.[1];
  if (cookie && safeEq(cookie, session)) return true;
  const [scheme, cred] = req.headers.get("authorization")?.split(" ") ?? [];
  if (scheme === "Bearer" && cred) return safeEq(cred, pass!); // MCP clients
  if (scheme !== "Basic" || !cred) return false;
  try { return safeEq(atob(cred).split(":").slice(1).join(":"), pass!); } catch { return false; }
}

const json = (x: any, status = 200) => Response.json(x, { status });

// ---- MCP (Streamable HTTP, JSON responses only; stateless) at /mcp ----
// ponytail: hand-rolled JSON-RPC instead of the SDK: 3 methods, no sessions/SSE needed for request/response tools
const readNb = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { cells: [] });
const writeNb = (nb: any) => writeFileSync(file, JSON.stringify(nb, null, 2));
const langs = ["ts", "js", "sql", "sqlite", "duckdb", "polars"];
const langDoc = "ts|js (shared JS kernel; `sql`, `duck`, `pl`, `fs` globals; URL/esm.sh imports), sql (PGlite Postgres), sqlite, duckdb, polars (SQL over DataFrames in the JS kernel)";
const mcpTools = [
  { name: "run_code", description: `Run code in the notebook kernel without adding a cell. lang: ${langDoc}.`,
    inputSchema: { type: "object", properties: { lang: { type: "string", enum: langs }, code: { type: "string" } }, required: ["lang", "code"] } },
  { name: "get_notebook", description: "Current notebook: name and cells (lang, code, last result).",
    inputSchema: { type: "object", properties: {} } },
  { name: "add_cell", description: "Append (or insert at index) a cell to the current notebook and save it; runs it unless run=false.",
    inputSchema: { type: "object", properties: { lang: { type: "string", enum: langs }, code: { type: "string" }, name: { type: "string", description: "optional cell title" }, index: { type: "integer" }, run: { type: "boolean" } }, required: ["lang", "code"] } },
  { name: "update_cell", description: "Replace a cell's code (and optionally lang) by index, save, and run it unless run=false.",
    inputSchema: { type: "object", properties: { index: { type: "integer" }, code: { type: "string" }, name: { type: "string", description: "optional cell title" }, lang: { type: "string", enum: langs }, run: { type: "boolean" } }, required: ["index", "code"] } },
  { name: "delete_cell", description: "Delete a cell by index and save.",
    inputSchema: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] } },
  { name: "list_notebooks", description: "Notebooks available next to the current one.",
    inputSchema: { type: "object", properties: {} } },
  { name: "open_notebook", description: "Switch to (or create) a notebook by file name. Restarts the kernel.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
];
const runSafe = (code: string, lang: string) => run(code, lang).catch((e: any) => ({ error: String(e?.stack ?? e) }));
async function mcpCall(name: string, a: any) {
  if (a.lang !== undefined && !langs.includes(a.lang)) throw new Error(`lang must be one of ${langs.join(", ")}`);
  switch (name) {
    case "run_code": return runSafe(a.code, a.lang);
    case "get_notebook": return { name: basename(file), cells: readNb().cells };
    case "add_cell": {
      const nb = readNb(), cell: any = { ...(a.name ? { name: a.name } : {}), lang: a.lang, code: a.code };
      if (a.run !== false) cell.result = await runSafe(a.code, a.lang);
      const i = Number.isInteger(a.index) ? Math.max(0, Math.min(a.index, nb.cells.length)) : nb.cells.length;
      nb.cells.splice(i, 0, cell); writeNb(nb);
      return { index: i, result: cell.result };
    }
    case "update_cell": {
      const nb = readNb(), cell = nb.cells[a.index];
      if (!cell) throw new Error(`no cell at index ${a.index}`);
      Object.assign(cell, { code: a.code }, a.lang ? { lang: a.lang } : {}, a.name !== undefined ? { name: a.name } : {});
      if (a.run !== false) cell.result = await runSafe(cell.code, cell.lang);
      writeNb(nb);
      return { index: a.index, result: cell.result };
    }
    case "delete_cell": {
      const nb = readNb();
      if (!nb.cells[a.index]) throw new Error(`no cell at index ${a.index}`);
      nb.cells.splice(a.index, 1); writeNb(nb);
      return { ok: true };
    }
    case "list_notebooks": return { current: basename(file), files: listNotebooks() };
    case "open_notebook": {
      let n = basename(String(a.name));
      if (!n.endsWith(".json")) n += ".json";
      if (!existsSync(join(dir, n))) writeFileSync(join(dir, n), JSON.stringify({ cells: [] }, null, 2));
      await openNotebook(n);
      return { current: n };
    }
  }
  throw new Error(`unknown tool ${name}`);
}
async function mcp(req: Request) {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } }); // no server-initiated SSE
  const msg = await req.json().catch(() => null);
  if (!msg || typeof msg !== "object") return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  const reply = async (m: any) => {
    if (m.id === undefined) return undefined; // notification (e.g. notifications/initialized)
    const ok = (result: any) => ({ jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "initialize":
        return ok({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} },
          serverInfo: { name: "pluto", version: "0.1.0" },
          instructions: `Pluto notebook (current: ${basename(file)}). Cells share one JS kernel; SQL cells hit Postgres (PGlite), duckdb cells DuckDB, polars cells run SQL over JS DataFrames.` });
      case "ping": return ok({});
      case "tools/list": return ok({ tools: mcpTools });
      case "tools/call":
        try {
          const r = await mcpCall(m.params?.name, m.params?.arguments ?? {});
          const isError = !!(r as any)?.error || !!(r as any)?.result?.error;
          return ok({ content: [{ type: "text", text: JSON.stringify(r, null, 1).slice(0, 100_000) }], isError });
        } catch (e: any) {
          return ok({ content: [{ type: "text", text: String(e?.message ?? e) }], isError: true });
        }
      default: return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } };
    }
  };
  const out = Array.isArray(msg) ? (await Promise.all(msg.map(reply))).filter(Boolean) : await reply(msg);
  return out === undefined || (Array.isArray(out) && !out.length) ? new Response(null, { status: 202 }) : json(out);
}

Bun.serve({
  port,
  async fetch(req) {
    // browsers send Origin on cross-site POSTs; refuse those so other websites can't drive the kernel via localhost
    // (MCP clients and curl send no Origin). Also blocks DNS-rebinding, per the MCP transport spec.
    const origin = req.headers.get("origin");
    if (req.method !== "GET" && origin && new URL(origin).host !== new URL(req.url).host)
      return new Response("cross-origin request refused", { status: 403 });
    // ?password=… logs in once: set a session cookie, then redirect so the password leaves the URL/history
    const qp = new URL(req.url).searchParams.get("password");
    if (pass && qp !== null && safeEq(qp, pass)) {
      const u = new URL(req.url);
      u.searchParams.delete("password");
      return new Response(null, { status: 302, headers: { location: u.pathname + u.search, "set-cookie": `pluto=${session}; Path=/; HttpOnly; SameSite=Lax` } });
    }
    if (pass && !authorized(req))
      return new Response("password required", { status: 401, headers: { "www-authenticate": new URL(req.url).pathname === "/mcp" ? 'Bearer realm="Pluto"' : 'Basic realm="Pluto", charset="UTF-8"' } });
    const { pathname } = new URL(req.url);
    if (pathname === "/") return new Response(Bun.file(indexHtml), { headers: { "content-type": "text/html" } });
    if (pathname === "/editor.js" || pathname === "/ts-worker.js")
      return new Response(Bun.file(pathname === "/editor.js" ? editorJs : tsWorkerJs), { headers: { "content-type": "text/javascript", "cache-control": "no-cache" } });
    if (pathname === "/geist.woff2" || pathname === "/geist-mono.woff2")
      return new Response(Bun.file(pathname === "/geist.woff2" ? geistSans : geistMono), { headers: { "content-type": "font/woff2", "cache-control": "max-age=86400" } });
    if (pathname === "/logo.png") return new Response(Bun.file(logoPng), { headers: { "content-type": "image/png", "cache-control": "max-age=86400" } });
    if (pathname === "/vue.js") return new Response(Bun.file(vueJs), { headers: { "content-type": "text/javascript" } });
    if (pathname === "/api/notebook" && req.method === "GET")
      return json(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { cells: [{ lang: "ts", code: "const x: number = 41\nx + 1" }] });
    if (pathname === "/api/notebook" && req.method === "PUT") {
      writeFileSync(file, JSON.stringify(await req.json(), null, 2));
      return json({ ok: true });
    }
    if (pathname === "/api/run" && req.method === "POST") {
      const { code, lang } = await req.json();
      try { return json(await run(code, lang)); }
      catch (e: any) { return json({ error: String(e?.stack ?? e) }); }
    }
    if (pathname === "/mcp") return mcp(req);
    if (pathname === "/api/files") {
      const files = listNotebooks();
      if (!files.includes(basename(file))) files.push(basename(file)); // unsaved current one
      return json({ current: basename(file), files: files.sort() });
    }
    if (pathname === "/api/open" && req.method === "POST") {
      let { name } = await req.json();
      name = basename(String(name)); // no path tricks: notebooks live next to the first one
      if (!name.endsWith(".json")) name += ".json";
      if (!existsSync(join(dir, name))) writeFileSync(join(dir, name), JSON.stringify({ cells: [{ lang: "ts", code: "" }] }, null, 2));
      await openNotebook(name);
      return json({ ok: true, current: name });
    }
    if (pathname === "/api/restart" && req.method === "POST") { vm = newVm(); return json({ ok: true }); }
    return new Response("not found", { status: 404 });
  },
});
console.log(`pluto: http://localhost:${port}  (notebook: ${basename(file)}, fs: ${unsafe ? "REAL (--unsafe)" : basename(file) + ".files/"}${pass ? ", password protected" : ""})`);
console.log(`mcp:   http://localhost:${port}/mcp${pass ? "  (Authorization: Bearer <password>)" : ""}`);
