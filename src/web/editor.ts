// Browser bundle: CodeMirror 6 cell editor. Colors still come from Shiki (same themes/colors as before, via the
// --shiki-light/--shiki-dark vars); TypeScript completions + hover come from ts-worker.js.
import { EditorView, keymap, lineNumbers, drawSelection, Decoration, ViewPlugin, hoverTooltip, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { EditorState, Compartment, StateEffect, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { sql, PostgreSQL, SQLite } from "@codemirror/lang-sql";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, type Completion } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { hl, themeOf } from "./hl";

// ---- shiki highlighting as decorations ----
const shikiLang = (l: string) => (l === "ts" ? "typescript" : l === "js" ? "javascript" : "sql");
const retheme = StateEffect.define<null>();
let currentTheme = "catppuccin";

function decorate(view: EditorView, lang: string): DecorationSet {
  const p = themeOf(currentTheme);
  const doc = view.state.doc.toString();
  const marks: any[] = [];
  // ponytail: re-tokenizes the whole cell per change; fine for notebook-sized cells
  const lines = hl.codeToTokens(doc, { lang: shikiLang(lang), themes: { light: p.light.name, dark: p.dark.name }, defaultColor: false }).tokens;
  for (const line of lines)
    for (const t of line) {
      const style = Object.entries(t.htmlStyle ?? {}).map(([k, v]) => `${k}:${v}`).join(";");
      // t.offset is absolute in the cell
      if (style && t.content.length) marks.push(Decoration.mark({ attributes: { style, class: "tk" } }).range(t.offset, t.offset + t.content.length));
    }
  return Decoration.set(marks, true);
}
const shiki = (lang: () => string) => ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = decorate(view, lang()); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.transactions.some(t => t.effects.some(e => e.is(retheme)))) this.decorations = decorate(u.view, lang());
  }
}, { decorations: v => v.decorations });

// ---- TypeScript worker ----
let worker: Worker | undefined, seq = 0;
const pending = new Map<number, (r: any) => void>();
function ask(msg: any): Promise<any> {
  worker ??= Object.assign(new Worker("/ts-worker.js"), { onmessage: (e: MessageEvent) => { pending.get(e.data.id)?.(e.data.result); pending.delete(e.data.id); } });
  const id = ++seq;
  return new Promise(res => { pending.set(id, res); worker!.postMessage({ ...msg, id }); });
}
const kindType: Record<string, string> = { method: "method", function: "function", property: "property", var: "variable", let: "variable", const: "constant", class: "class", interface: "interface", type: "type", keyword: "keyword", enum: "enum", module: "namespace", alias: "variable", parameter: "variable", "local var": "variable", "local function": "function" };

type Ctx = () => { cells: { lang: string; code: string }[]; index: number };
function tsCompletions(ctx: Ctx) {
  return async (c: CompletionContext) => {
    const word = c.matchBefore(/[\w$]*/);
    const trigger = /[.\w$]$/.test(c.state.sliceDoc(Math.max(0, c.pos - 1), c.pos));
    if (!c.explicit && !trigger) return null;
    const { cells, index } = ctx();
    const live = cells.map((x, i) => (i === index ? { ...x, code: c.state.doc.toString() } : x));
    const r = await ask({ kind: "complete", cells: live, cell: index, pos: c.pos, prefix: word?.text ?? "" });
    if (!r || c.aborted) return null;
    return {
      from: word ? word.from : c.pos,
      validFor: /^[\w$]*$/,
      options: r.options.map((o: any): Completion => ({
        label: o.label, type: kindType[o.type] ?? o.type, boost: -Number.parseInt(o.sortText, 10) || 0,
        class: o.deprecated ? "cm-deprecated" : undefined,
        info: async () => {
          const d = await ask({ kind: "details", cells: live, cell: index, pos: c.pos, name: o.label });
          if (!d) return null;
          const el = document.createElement("div");
          el.className = "cm-ts-info";
          el.innerHTML = `<code></code><p></p>`;
          el.querySelector("code")!.textContent = d.signature;
          el.querySelector("p")!.textContent = d.doc;
          return el;
        },
      })),
    };
  };
}
function tsHover(ctx: Ctx) {
  return hoverTooltip(async (view, pos) => {
    const { cells, index } = ctx();
    const r = await ask({ kind: "hover", cells, cell: index, pos });
    if (!r?.signature) return null;
    return {
      pos: r.from, end: r.to, above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-ts-info";
        dom.innerHTML = `<code></code>${r.doc ? "<p></p>" : ""}`;
        dom.querySelector("code")!.textContent = r.signature;
        if (r.doc) dom.querySelector("p")!.textContent = r.doc;
        return { dom };
      },
    };
  }, { hoverTime: 400 });
}

// ---- look: transparent, Geist Mono, faint gutter; colors come from the page's CSS vars ----
const look = EditorView.theme({
  "&": { fontSize: "13px", background: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: '"Geist Mono", ui-monospace, monospace', lineHeight: "1.5", overflow: "visible" },
  ".cm-content": { padding: "10px 0", caretColor: "var(--fg)" },
  ".cm-line": { padding: "0 10px 0 6px" },
  ".cm-gutters": { background: "transparent", border: "none", color: "var(--fg)", opacity: ".35" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "28px", padding: "0 0 0 8px", textAlign: "right" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { background: "color-mix(in srgb, var(--accent) 25%, transparent) !important" },
  ".cm-matchingBracket": { background: "color-mix(in srgb, var(--accent) 20%, transparent)", outline: "none" },
  ".cm-tooltip": { background: "var(--cell)", border: "1px solid var(--line)", borderRadius: "6px", color: "var(--fg)", fontFamily: "Geist, system-ui, sans-serif" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: '"Geist Mono", ui-monospace, monospace', maxHeight: "16em" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { background: "var(--accent)", color: "#fff" },
  ".cm-completionInfo": { maxWidth: "420px" },
});

export interface CellEditor { view: EditorView; setLang(l: string): void; focus(): void; destroy(): void }

/** Mount a cell editor. ctx() gives all cells + this cell's index (for cross-cell types). */
export function createEditor(el: HTMLElement, o: { doc: string; lang: string; onChange(code: string): void; onRun(): void; onRunNext(): void; ctx: Ctx }): CellEditor {
  let lang = o.lang;
  const langConf = new Compartment(), complete = new Compartment();
  const langExt = (l: string) => (l === "ts" || l === "js" ? javascript({ typescript: l === "ts" }) : sql({ dialect: l === "sqlite" ? SQLite : PostgreSQL }));
  // TS cells get TS completions; SQL cells get lang-sql's keyword completions
  const completeExt = (l: string) => (l === "ts" || l === "js" ? [autocompletion({ override: [tsCompletions(o.ctx)] }), tsHover(o.ctx)] : autocompletion());
  const view = new EditorView({
    parent: el,
    state: EditorState.create({
      doc: o.doc,
      extensions: [
        Prec.highest(keymap.of([
          { key: "Shift-Enter", run: () => (o.onRunNext(), true) },
          { key: "Mod-Enter", run: () => (o.onRun(), true) },
        ])),
        lineNumbers(), history(), drawSelection(), indentOnInput(), bracketMatching(), closeBrackets(), highlightSelectionMatches(),
        EditorView.lineWrapping, look,
        langConf.of(langExt(lang)), complete.of(completeExt(lang)),
        shiki(() => lang),
        keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
        EditorView.updateListener.of(u => { if (u.docChanged) o.onChange(u.state.doc.toString()); }),
      ],
    }),
  });
  return {
    view,
    setLang(l) { lang = l; view.dispatch({ effects: [langConf.reconfigure(langExt(l)), complete.reconfigure(completeExt(l)), retheme.of(null)] }); },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

const w = window as any;
w.createEditor = createEditor;
w.setEditorTheme = (t: string) => {
  currentTheme = t;
  for (const v of document.querySelectorAll(".cm-editor")) EditorView.findFromDOM(v as HTMLElement)?.dispatch({ effects: retheme.of(null) });
};
