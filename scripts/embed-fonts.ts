import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const FONTS_DIR = join(root, "fonts");
const HTML_PATH = join(root, "src", "ui", "index.html");
const START_MARKER = "/* __MATCHDAY_FONTS_START__ */";
const END_MARKER = "/* __MATCHDAY_FONTS_END__ */";

const WEIGHTS: Record<string, number> = {
  thin: 100,
  extralight: 200,
  light: 300,
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
};

function fontMetaOf(file: string): { family: string; style: string; weight: number } {
  const lower = file.toLowerCase().replace(/\.[a-z0-9]+$/, "");
  if (lower.includes("albireo")) {
    return {
      family: "Albireo",
      style: lower.includes("italic") ? "italic" : "normal",
      weight: WEIGHTS.bold,
    };
  }
  let weight = WEIGHTS.regular;
  for (const [key, value] of Object.entries(WEIGHTS)) {
    if (lower.includes(`poppins-${key}`) || lower.includes(`poppins_${key}`)) {
      weight = value;
      break;
    }
  }
  return { family: "Poppins", style: lower.includes("italic") ? "italic" : "normal", weight };
}

function mimeOf(ext: string): string {
  if (ext === ".woff2") return "font/woff2";
  if (ext === ".woff") return "font/woff";
  if (ext === ".otf") return "font/otf";
  return "font/ttf";
}

function formatOf(ext: string): string {
  if (ext === ".woff2") return "woff2";
  if (ext === ".woff") return "woff";
  if (ext === ".otf") return "opentype";
  return "truetype";
}

/**
 * Embeds fonts from `fonts/` as data URIs in the UI HTML
 * (keeps the executable self-contained with no runtime external files).
 */
export function embedFonts(): string {
  const files = readdirSync(FONTS_DIR)
    .filter((file) => /\.(ttf|otf|woff|woff2)$/i.test(file))
    .sort();
  if (files.length === 0) {
    throw new Error(`No fonts found in ${FONTS_DIR} (expected Poppins and Albireo).`);
  }
  const faces = files
    .map((file) => {
      const { family, style, weight } = fontMetaOf(file);
      const ext = extname(file).toLowerCase();
      const base64 = readFileSync(join(FONTS_DIR, file)).toString("base64");
      return (
        `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};` +
        `font-display:swap;src:url(data:${mimeOf(ext)};base64,${base64}) format('${formatOf(ext)}');}`
      );
    })
    .join("");

  let html = readFileSync(HTML_PATH, "utf8");
  const block = `${START_MARKER}\n${faces}\n${END_MARKER}`;
  if (html.includes(START_MARKER) && html.includes(END_MARKER)) {
    const start = html.indexOf(START_MARKER);
    const end = html.indexOf(END_MARKER) + END_MARKER.length;
    html = html.slice(0, start) + block + html.slice(end);
  } else {
    throw new Error(
      `Markers ${START_MARKER} / ${END_MARKER} not found in ${HTML_PATH}.`,
    );
  }
  writeFileSync(HTML_PATH, html, "utf8");
  return faces;
}

if (import.meta.main) {
  const css = embedFonts();
  console.log(`[fonts] embedded ${css.length} bytes of @font-face data in src/ui/index.html`);
}
