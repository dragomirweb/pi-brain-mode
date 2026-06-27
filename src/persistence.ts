import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { type BrainPersisted, type BrainState, PERSIST_KEY } from "./state.ts";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

export function persist(pi: ExtensionAPI, state: BrainState): void {
  const data: BrainPersisted = { v: 1, enabled: state.enabled, config: state.config };
  pi.appendEntry(PERSIST_KEY, data);
}

export function loadLatest(sessionManager: ReadonlySessionManager): BrainPersisted | null {
  const entries = sessionManager.getEntries?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { customType?: unknown; data?: { v?: unknown } };
    if (entry?.customType === PERSIST_KEY && entry?.data?.v === 1) {
      return entry.data as BrainPersisted;
    }
  }
  return null;
}
