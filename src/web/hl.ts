// Browser bundle: fine-grained shiki (3 langs, a few themes, JS regex engine — no oniguruma wasm).
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import ts from "@shikijs/langs/typescript";
import js from "@shikijs/langs/javascript";
import sql from "@shikijs/langs/sql";
import latte from "@shikijs/themes/catppuccin-latte";
import mocha from "@shikijs/themes/catppuccin-mocha";
import githubLight from "@shikijs/themes/github-light";
import githubDark from "@shikijs/themes/github-dark";
import tokyoNight from "@shikijs/themes/tokyo-night";
import houston from "@shikijs/themes/houston";

// Tokyo Night and Houston only ship dark: derive a light variant by keeping each token's hue and darkening it
// until it reads on a light background. ponytail: HSL lightness clamp; hand-tune palettes if a color looks off.
function toLight(t: any) {
  const fix = (c?: string) => {
    if (!c || !/^#[0-9a-f]{6}/i.test(c)) return c;
    const [r, g, b] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    const L = Math.min(l, 0.4), S = Math.min(1, sat * 1.1); // cap lightness at 40%
    const C = (1 - Math.abs(2 * L - 1)) * S, X = C * (1 - Math.abs((h % 2) - 1)), m = L - C / 2;
    const [r1, g1, b1] = h < 1 ? [C, X, 0] : h < 2 ? [X, C, 0] : h < 3 ? [0, C, X] : h < 4 ? [0, X, C] : h < 5 ? [X, 0, C] : [C, 0, X];
    return "#" + [r1, g1, b1].map(v => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("") + c.slice(7);
  };
  return {
    ...t, name: t.name + "-light", type: "light",
    colors: { ...t.colors, "editor.background": "#ffffff", "editor.foreground": fix(t.colors["editor.foreground"]) },
    tokenColors: t.tokenColors.map((r: any) => ({ ...r, settings: { ...r.settings, foreground: fix(r.settings?.foreground) } })),
  };
}
const tokyoLight = toLight(tokyoNight), houstonLight = toLight(houston);

// editor themes: light/dark pair, picked by the UI theme
const all = [latte, mocha, githubLight, githubDark, tokyoNight, tokyoLight, houston, houstonLight];
export const pairs: Record<string, { label: string; light: any; dark: any }> = {
  catppuccin: { label: "Catppuccin", light: latte, dark: mocha },
  "tokyo-night": { label: "Tokyo Night", light: tokyoLight, dark: tokyoNight },
  houston: { label: "Houston", light: houstonLight, dark: houston },
  github: { label: "GitHub", light: githubLight, dark: githubDark },
};

export const hl = createHighlighterCoreSync({ themes: all, langs: [ts, js, sql], engine: createJavaScriptRegexEngine() });

export const themeOf = (theme: string) => pairs[theme] ?? pairs.catppuccin;
const w = window as any;
w.editorThemes = Object.fromEntries(Object.entries(pairs).map(([k, p]) => [k, { label: p.label }]));
w.highlight = (code: string, lang: string, theme = "catppuccin") => {
  const p = pairs[theme] ?? pairs.catppuccin;
  return hl.codeToHtml(code, { lang, themes: { light: p.light.name, dark: p.dark.name }, defaultColor: false });
};
