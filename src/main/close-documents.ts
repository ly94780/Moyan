import type { CloseScope, TabsClosedResult } from '../shared/types';
import type { DocumentStore } from './store';

/** Confirm the whole group before discarding anything, including each tab's recovery data. */
export async function closeDocumentGroup(
  store: DocumentStore,
  id: string,
  scope: CloseScope,
  confirm: (documentId: string) => Promise<string | null>,
): Promise<TabsClosedResult | null> {
  if (!store.get(id)) return null;
  const targets = new Map(
    store.documents.filter((d) => scope === 'all' || d.id !== id).map((d) => [d.id, d.id]),
  );
  const approved = new Map<string, number>();
  for (;;) {
    const pending = [...targets].find(([, currentId]) => {
      const document = store.get(currentId)?.document;
      return document && store.isDirty(currentId) && approved.get(currentId) !== document.version;
    });
    if (!pending) break;
    const [originalId, currentId] = pending;
    const resolved = await confirm(currentId);
    if (!resolved) return null;
    // External reload can replace a tab's identifier while keeping its position.
    targets.set(originalId, resolved);
    const document = store.get(resolved)?.document;
    if (document) approved.set(resolved, document.version);
  }
  const closedIds = [...targets.values()].filter((target) => store.get(target));
  for (const target of closedIds) store.remove(target);
  if (scope === 'others') store.activate(id);
  await store.flushRecovery().catch(store.onRecoveryError);
  return { closedIds, activeId: store.activeId };
}
