// Syntax colours for the preview panel, with VS Code's grammars (Shiki). Nothing here loads until
// the first file is opened, and each language loads the first time it is needed.
import type { HighlighterCore, ThemedToken } from "shiki/core";

type Loader = () => Promise<unknown>;
const LANGS: Record<string, [string, Loader]> = {};
const add = (name: string, load: Loader, exts: string[]) => { for (const e of exts) LANGS[e] = [name, load]; };
add("typescript", () => import("shiki/langs/typescript.mjs"), ["ts", "mts", "cts"]);
add("tsx", () => import("shiki/langs/tsx.mjs"), ["tsx"]);
add("javascript", () => import("shiki/langs/javascript.mjs"), ["js", "mjs", "cjs"]);
add("jsx", () => import("shiki/langs/jsx.mjs"), ["jsx"]);
add("json", () => import("shiki/langs/json.mjs"), ["json", "jsonc", "json5"]);
add("python", () => import("shiki/langs/python.mjs"), ["py", "pyw"]);
add("shellscript", () => import("shiki/langs/shellscript.mjs"), ["sh", "bash", "zsh"]);
add("powershell", () => import("shiki/langs/powershell.mjs"), ["ps1", "psm1"]);
add("bat", () => import("shiki/langs/bat.mjs"), ["bat", "cmd"]);
add("css", () => import("shiki/langs/css.mjs"), ["css"]);
add("scss", () => import("shiki/langs/scss.mjs"), ["scss"]);
add("html", () => import("shiki/langs/html.mjs"), ["html", "htm"]);
add("markdown", () => import("shiki/langs/markdown.mjs"), ["md", "markdown", "mdx"]);
add("yaml", () => import("shiki/langs/yaml.mjs"), ["yml", "yaml"]);
add("toml", () => import("shiki/langs/toml.mjs"), ["toml"]);
add("ini", () => import("shiki/langs/ini.mjs"), ["ini", "cfg", "conf", "properties"]);
add("xml", () => import("shiki/langs/xml.mjs"), ["xml", "svg", "csproj", "plist"]);
add("rust", () => import("shiki/langs/rust.mjs"), ["rs"]);
add("go", () => import("shiki/langs/go.mjs"), ["go"]);
add("java", () => import("shiki/langs/java.mjs"), ["java"]);
add("kotlin", () => import("shiki/langs/kotlin.mjs"), ["kt", "kts"]);
add("c", () => import("shiki/langs/c.mjs"), ["c", "h"]);
add("cpp", () => import("shiki/langs/cpp.mjs"), ["cpp", "cc", "cxx", "hpp", "hh"]);
add("csharp", () => import("shiki/langs/csharp.mjs"), ["cs"]);
add("swift", () => import("shiki/langs/swift.mjs"), ["swift"]);
add("php", () => import("shiki/langs/php.mjs"), ["php"]);
add("ruby", () => import("shiki/langs/ruby.mjs"), ["rb"]);
add("lua", () => import("shiki/langs/lua.mjs"), ["lua"]);
add("sql", () => import("shiki/langs/sql.mjs"), ["sql"]);
add("vue", () => import("shiki/langs/vue.mjs"), ["vue"]);
add("svelte", () => import("shiki/langs/svelte.mjs"), ["svelte"]);
add("dockerfile", () => import("shiki/langs/dockerfile.mjs"), ["dockerfile"]);
add("diff", () => import("shiki/langs/diff.mjs"), ["diff", "patch"]);

/** Past this, colouring would hold up the page more than it helps. */
const MAX_CHARS = 300_000;

export function languageOf(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return "dockerfile";
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  return LANGS[ext]?.[0] ?? null;
}

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

function getHighlighter() {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([import("shiki/core"), import("shiki/engine/javascript")]);
    return createHighlighterCore({
      themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return highlighter;
}

/** Each line's coloured pieces, or null when the file has no known language or is too long. */
export async function highlightLines(text: string, name: string): Promise<ThemedToken[][] | null> {
  const lang = languageOf(name);
  if (!lang || text.length > MAX_CHARS) return null;
  const h = await getHighlighter();
  if (!loaded.has(lang)) {
    const entry = Object.values(LANGS).find(([n]) => n === lang)!;
    await h.loadLanguage((await entry[1]() as { default: Parameters<HighlighterCore["loadLanguage"]>[0] }).default);
    loaded.add(lang);
  }
  return h.codeToTokens(text, { lang, themes: { light: "github-light", dark: "github-dark" } }).tokens;
}
