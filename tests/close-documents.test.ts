import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DocumentStore } from '../src/main/store';
import { closeDocumentGroup } from '../src/main/close-documents';

let root: string;
let store: DocumentStore;
beforeEach(async () => {
  await mkdir('.runtime', { recursive: true });
  root = await mkdtemp(path.resolve('.runtime/group-'));
  store = new DocumentStore(path.join(root, 'data'));
  await store.initialize();
});
afterEach(async () => {
  await store.clearRecovery();
  if (path.dirname(root) !== path.resolve('.runtime')) throw new Error('测试目录越界');
  await rm(root, { recursive: true, force: true });
});
function dirty(content: string) {
  const document = store.newDocument();
  store.update(document.id, content, 1);
  return document;
}

describe('标签批量关闭', () => {
  it('无修改的标签全部静默关闭', async () => {
    const a = store.newDocument();
    const b = store.newDocument();
    const confirm = vi.fn(async (id: string) => id);
    const result = await closeDocumentGroup(store, a.id, 'all', confirm);
    expect(confirm).not.toHaveBeenCalled();
    expect(result).toEqual({ closedIds: [a.id, b.id], activeId: null });
    expect(store.documents).toEqual([]);
  });
  it('关闭其他标签保留右键目标及其草稿，只确认实际修改的其他文件', async () => {
    const keep = dirty('保留的草稿');
    const other = dirty('可关闭的草稿');
    store.newDocument();
    await store.flushRecovery();
    const confirm = vi.fn(async (id: string) => id);
    await closeDocumentGroup(store, keep.id, 'others', confirm);
    expect(confirm.mock.calls.map(([id]) => id)).toEqual([other.id]);
    expect(store.documents.map((d) => d.id)).toEqual([keep.id]);
    expect(store.activeId).toBe(keep.id);
    expect((await store.readRecovery()).map((r) => r.document.content)).toEqual(['保留的草稿']);
  });
  it('后续标签取消时，不提前关闭已同意放弃的标签或删除草稿', async () => {
    const a = dirty('草稿甲');
    const b = dirty('草稿乙');
    const c = dirty('草稿丙');
    await store.flushRecovery();
    const confirm = vi.fn(async (id: string) => (id === b.id ? null : id));
    expect(await closeDocumentGroup(store, a.id, 'all', confirm)).toBeNull();
    expect(confirm.mock.calls.map(([id]) => id)).toEqual([a.id, b.id]);
    expect(store.documents.map((d) => d.id)).toEqual([a.id, b.id, c.id]);
    expect((await store.readRecovery()).map((r) => r.document.content)).toEqual([
      '草稿甲',
      '草稿乙',
      '草稿丙',
    ]);
  });
  it('后续保存失败时保留所有标签，已完成的保存仍然有效', async () => {
    const a = dirty('要保存的甲');
    const b = dirty('不能丢失的乙');
    const target = path.join(root, '甲.md');
    const confirm = async (id: string) => {
      await store.save(id === a.id ? target : path.join(root, '不存在', '乙.md'), id);
      return id;
    };
    await expect(closeDocumentGroup(store, a.id, 'all', confirm)).rejects.toThrow();
    expect(store.documents).toHaveLength(2);
    expect(await readFile(target, 'utf8')).toBe('要保存的甲');
    expect(store.isDirty(a.id)).toBe(false);
    expect(store.isDirty(b.id)).toBe(true);
    expect((await store.readRecovery())[0]?.document.content).toBe('不能丢失的乙');
  });
  it('确认期间重新载入导致文档标识改变时，关闭正确的新标识', async () => {
    const target = path.join(root, '原文.md');
    await writeFile(target, '原文');
    const a = await store.load(target);
    store.update(a.id, '内部修改', 1);
    const b = dirty('另一草稿');
    await writeFile(target, '外部更新');
    let reloadedId = '';
    const result = await closeDocumentGroup(store, a.id, 'all', async (id) => {
      if (id !== a.id) return id;
      reloadedId = (await store.reload(id)).id;
      return reloadedId;
    });
    expect(result?.closedIds).toEqual([reloadedId, b.id]);
    expect(store.documents).toEqual([]);
    expect(await readFile(target, 'utf8')).toBe('外部更新');
  });
  it('先前已确认的文档再次发生变化时需要重新确认，取消仍保留整个组', async () => {
    const a = dirty('甲');
    const b = dirty('乙');
    let first = true;
    const confirm = vi.fn(async (id: string) => {
      if (id === a.id && !first) return null;
      if (id === a.id) first = false;
      if (id === b.id) store.update(a.id, '确认后继续修改的甲', 2);
      return id;
    });
    expect(await closeDocumentGroup(store, a.id, 'all', confirm)).toBeNull();
    expect(confirm.mock.calls.map(([id]) => id)).toEqual([a.id, b.id, a.id]);
    expect(store.documents).toHaveLength(2);
    expect(store.get(a.id)?.document.content).toBe('确认后继续修改的甲');
  });
});
