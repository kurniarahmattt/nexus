import type { Adapter } from "./types.ts";
import { claudeAdapter } from "./claude.ts";
import { hermesAdapter } from "./hermes.ts";
import { cursorAdapter } from "./cursor.ts";
import { geminiAdapter } from "./gemini.ts";
import { makeRemoteAdapter } from "./remote.ts";

const shared = new Map<string, Adapter>([
  [claudeAdapter.slug, claudeAdapter],
  [hermesAdapter.slug, hermesAdapter],
  [cursorAdapter.slug, cursorAdapter],
  [geminiAdapter.slug, geminiAdapter],
]);

/**
 * Returns an adapter for the given slug+kind. Shared agents look up the
 * static registry. Remote agents get a fresh RemoteAdapter that dispatches
 * via gateway.
 */
export function getAdapter(
  slug: string,
  kind: "shared" | "remote" = "shared",
): Adapter | undefined {
  if (kind === "remote") return makeRemoteAdapter(slug);
  return shared.get(slug);
}

export function knownSlugs(): string[] {
  return [...shared.keys()];
}
