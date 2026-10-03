// Web worker: TypeScript language service over the notebook. All JS/TS cells are concatenated into one virtual
// module (/nb.ts) so a binding from cell 1 has its type in cell 5; requests carry (cell index, offset in cell).
import ts from "typescript";
import types from "../../dist/types.json";

// kernel globals (server.ts injects these into every JS/TS cell)
const GLOBALS = `
type Rows = Record<string, any>[];
/** Query the notebook's Postgres (PGlite). Tagged template interpolations become $n parameters. */
declare function sql(q: TemplateStringsArray | string, ...values: any[]): Promise<Rows>;
/** Query the notebook's DuckDB. Interpolations are inlined as-is. */
declare function duck(q: TemplateStringsArray | string, ...values: any[]): Promise<Rows>;
/** Polars (native, embedded). */
declare const pl: typeof import("nodejs-polars").default;
/** Notebook filesystem: <notebook>.files/ (sandbox) or the real fs with --unsafe. */
declare const fs: {
  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, encoding: "utf8" | "utf-8" | { encoding: string }): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdir(path: string, options: { withFileTypes: true }): Promise<{ name: string; isFile(): boolean; isDirectory(): boolean }[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<{ size: number; mtime: Date; isFile(): boolean; isDirectory(): boolean }>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
};
`;

const files = new Map<string, string>(Object.entries(types as Record<string, string>));
files.set("/globals.d.ts", GLOBALS);
const versions = new Map<string, number>();
const NB = "/nb.ts";

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"], allowJs: true, strict: false, noEmit: true,
  skipLibCheck: true, baseUrl: "/", paths: { polars: ["/node_modules/nodejs-polars/bin/index.d.ts"], "nodejs-polars": ["/node_modules/nodejs-polars/bin/index.d.ts"] },
};
const host: ts.LanguageServiceHost = {
  getCompilationSettings: () => options,
  getScriptFileNames: () => [NB, "/globals.d.ts"],
  getScriptVersion: f => String(versions.get(f) ?? 0),
  getScriptSnapshot: f => (files.has(f) ? ts.ScriptSnapshot.fromString(files.get(f)!) : undefined),
  getCurrentDirectory: () => "/",
  getDefaultLibFileName: () => "/lib/lib.d.ts",
  fileExists: f => files.has(f),
  readFile: f => files.get(f),
  directoryExists: d => [...files.keys()].some(f => f.startsWith(d.endsWith("/") ? d : d + "/")),
  getDirectories: () => [],
};
const ls = ts.createLanguageService(host, ts.createDocumentRegistry());

// rebuild /nb.ts from the cells; returns the offset where `cell` starts
function sync(cells: { lang: string; code: string }[], cell: number) {
  let text = "", start = 0;
  cells.forEach((c, i) => {
    if (c.lang !== "ts" && c.lang !== "js") return;
    if (i === cell) start = text.length;
    text += c.code + "\n;\n";
  });
  if (files.get(NB) !== text) { files.set(NB, text); versions.set(NB, (versions.get(NB) ?? 0) + 1); }
  return start;
}
const text = (parts?: ts.SymbolDisplayPart[]) => ts.displayPartsToString(parts ?? []);

self.onmessage = ({ data: m }: MessageEvent) => {
  let result: any = null;
  try {
    const base = sync(m.cells, m.cell), pos = base + m.pos;
    if (m.kind === "complete") {
      const r = ls.getCompletionsAtPosition(NB, pos, { includeCompletionsWithInsertText: true, includeCompletionsForModuleExports: false });
      if (r) result = {
        from: (r.optionalReplacementSpan?.start ?? pos) - base,
        // filter by what's typed before capping: in scope there are thousands of globals
        options: r.entries.filter(e => !m.prefix || e.name.toLowerCase().includes(m.prefix.toLowerCase())).slice(0, 300).map(e => ({ label: e.name, type: e.kind, sortText: e.sortText, deprecated: !!e.kindModifiers?.includes("deprecated") })),
      };
    } else if (m.kind === "details") {
      const d = ls.getCompletionEntryDetails(NB, pos, m.name, undefined, undefined, undefined, undefined);
      if (d) result = { signature: text(d.displayParts), doc: text(d.documentation) };
    } else if (m.kind === "hover") {
      const q = ls.getQuickInfoAtPosition(NB, pos);
      if (q) result = { from: q.textSpan.start - base, to: q.textSpan.start + q.textSpan.length - base, signature: text(q.displayParts), doc: text(q.documentation) };
    }
  } catch (e) {
    result = null; // a broken cell mid-edit shouldn't kill the worker
  }
  (self as any).postMessage({ id: m.id, result });
};
