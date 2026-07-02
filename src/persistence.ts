import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { type BrainPersisted, type BrainState, PERSIST_KEY } from "./state.ts";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

export function persist(pi: ExtensionAPI, state: BrainState): void {
  const data: BrainPersisted = {
    v: 2,
    enabled: state.enabled,
    config: state.config,
    journal: state.journal,
  };
  pi.appendEntry(PERSIST_KEY, data);
}

export function loadLatest(sessionManager: ReadonlySessionManager): BrainPersisted | null {
  const entries = sessionManager.getEntries?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { customType?: unknown; data?: { v?: unknown } };
    if (entry?.customType === PERSIST_KEY && (entry?.data?.v === 1 || entry?.data?.v === 2)) {
      const data = entry.data as Partial<BrainPersisted> & { enabled: boolean; config: never };
      return {
        v: 2,
        enabled: data.enabled,
        config: data.config as BrainPersisted["config"],
        journal: Array.isArray(data.journal) ? data.journal : [],
      };
    }
  }
  return null;
}
