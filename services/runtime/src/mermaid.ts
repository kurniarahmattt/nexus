/**
 * Mermaid post-processor.
 *
 * Finds fenced ```mermaid blocks in bot output and appends a kroki.io URL
 * reference (markdown image) so Rocket.Chat can preview the rendered
 * diagram inline. Source block is preserved so users still see the code.
 *
 * Kroki encoding: the diagram source is deflated (zlib, level 9) and
 * base64url encoded. URL = https://kroki.io/mermaid/svg/<encoded>.
 */

import { deflateSync } from "node:zlib";

const MERMAID_FENCE =
  /```mermaid\s*\n([\s\S]+?)\n```/g;

const KROKI_BASE = process.env.KROKI_BASE ?? "https://kroki.io";

function encodeForKroki(src: string): string {
  return deflateSync(Buffer.from(src, "utf8"), { level: 9 }).toString("base64url");
}

function krokiUrl(src: string, format: "svg" | "png" = "svg"): string {
  return `${KROKI_BASE}/mermaid/${format}/${encodeForKroki(src)}`;
}

/**
 * Walk `text` and inject a markdown image after every mermaid fence so
 * the reader sees both source + rendered diagram. Returns unchanged if
 * no mermaid block present.
 */
export function renderMermaidLinks(text: string): string {
  if (!text.includes("```mermaid")) return text;
  let out = "";
  let lastIndex = 0;
  let counter = 0;
  MERMAID_FENCE.lastIndex = 0;
  for (const match of text.matchAll(MERMAID_FENCE)) {
    const src = match[1]?.trim();
    if (!src) continue;
    counter++;
    const url = krokiUrl(src, "svg");
    const start = match.index!;
    const end = start + match[0].length;
    out += text.slice(lastIndex, end);
    out += `\n\n![diagram ${counter}](${url})\n`;
    lastIndex = end;
  }
  out += text.slice(lastIndex);
  return out;
}
