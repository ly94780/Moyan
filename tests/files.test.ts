import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, decodeMarkdown, encodeMarkdown, resolveImage } from '../src/main/files';
import { DocumentStore, sanitizePreferences } from '../src/main/store';

let root: string;
let store: DocumentStore;
beforeEach(async () => {
  await mkdir('.runtime', { recursive: true });
  root = await mkdtemp(path.resolve('.runtime/unit-'));
  store = new DocumentStore(path.join(root, 'data'));
  await store.initialize();
});
afterEach(async () => {
  await store.clearRecovery();
  if (path.dirname(root) !== path.resolve('.runtime')) throw new Error('测试目录越界');
  await rm(root, { recursive: true, force: true });
});

describe('文件往返与恢复', () => {
  it.each(['LF', 'CRLF'] as const)('保留 BOM、%s 与末尾换行', async (eol) => {
    for (const ending of ['', '\n']) {
      const bytes = encodeMarkdown('# 中文 Hello\n正文' + ending, true, eol);
      const d = decodeMarkdown(bytes);
      expect(d).toMatchObject({
        bom: true,
        eol,
        mixed: false,
        content: '# 中文 Hello\n正文' + ending,
      });
      expect(encodeMarkdown(d.content, d.bom, d.eol)).toEqual(bytes);
    }
  });
  it('拒绝非 UTF-8 和二进制，检测混合换行', () => {
    expect(() => decodeMarkdown(Uint8Array.of(0xff, 0xfe, 0x41))).toThrow();
    expect(() => decodeMarkdown(Buffer.from('abc\0def'))).toThrow();
    expect(decodeMarkdown(Buffer.from('a\r\nb\nc\r\n')).mixed).toBe(true);
  });
  it('中文空格路径可保存，外部同尺寸改动也会触发冲突', async () => {
    const target = path.join(root, '中文 文件 #1.md');
    await writeFile(target, 'abc');
    const d = await store.load(target);
    store.update(d.id, '新内容\n', 1);
    expect(store.dirty).toBe(true);
    await store.save(target);
    expect(await readFile(target, 'utf8')).toBe('新内容\n');
    expect(store.dirty).toBe(false);
    await writeFile(target, '外部改\n');
    expect(await store.conflict()).toBe(true);
  });
  it('写入失败保留原文件与未保存状态', async () => {
    const target = path.join(root, 'original.md');
    await writeFile(target, '原文');
    const d = await store.load(target);
    store.update(d.id, '修改', 1);
    await expect(store.save(path.join(root, '不存在', 'file.md'))).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('原文');
    expect(store.dirty).toBe(true);
  });
  it('保存过程中继续输入，新版本仍未保存且可恢复', async () => {
    const d = store.newDocument();
    store.update(d.id, '版本一', 1);
    const saving = store.save(path.join(root, 'draft.md'));
    store.update(d.id, '版本二', 2);
    const result = await saving;
    expect(await readFile(path.join(root, 'draft.md'), 'utf8')).toBe('版本一');
    expect(result.savedVersion).toBe(1);
    expect(store.dirty).toBe(true);
    expect((await store.readRecovery())[0]?.document.content).toBe('版本二');
  });
  it('草稿恢复不改写原文，旧文档或旧版本更新被忽略', async () => {
    const target = path.join(root, 'document.md');
    await writeFile(target, '原文');
    const d = await store.load(target);
    store.update('wrong-id', '不应写入', 10);
    store.update(d.id, '恢复的中文草稿', 1);
    store.update(d.id, '过期内容', 0);
    await store.flushRecovery();
    const recovered = await store.readRecovery();
    expect(recovered[0]?.document.content).toBe('恢复的中文草稿');
    expect(recovered[0]?.document.id).not.toBe(d.id);
    expect(await readFile(target, 'utf8')).toBe('原文');
    await store.clearRecovery();
    expect(await store.readRecovery()).toEqual([]);
  });
  it('原子替换已有文件，偏好损坏时回退默认值', async () => {
    const target = path.join(root, 'replace.md');
    await writeFile(target, 'old');
    await atomicWrite(target, Buffer.from('new'));
    expect(await readFile(target, 'utf8')).toBe('new');
    await writeFile(path.join(root, 'data', 'preferences.json'), '{broken');
    expect((await store.readPreferences()).theme).toBe('system');
    expect(
      sanitizePreferences({ readSize: 100, editSize: -10, theme: 'bad', remoteImages: 'true' }),
    ).toMatchObject({ readSize: 24, editSize: 12, theme: 'system', remoteImages: false });
  });
});

describe('多文件与实际内容变更', () => {
  it('仅进入编辑与重复写入相同文本不算修改，还原保存内容后恢复干净状态', async () => {
    const target = path.join(root, 'original.md');
    await writeFile(target, '# 原文\n');
    const d = await store.load(target);
    expect(store.isDirty(d.id)).toBe(false);
    store.update(d.id, '# 原文\n', 1);
    expect(store.isDirty(d.id)).toBe(false);
    store.update(d.id, '# 修改\n', 2);
    expect(store.isDirty(d.id)).toBe(true);
    store.update(d.id, '# 原文\n', 3);
    expect(store.isDirty(d.id)).toBe(false);
    await store.flushRecovery();
    expect(await store.readRecovery()).toEqual([]);
  });
  it('保存基准跟随实际落盘内容，保存期间还原旧基准仍有未落盘修改', async () => {
    const target = path.join(root, 'save.md');
    await writeFile(target, '原文');
    const d = await store.load(target);
    store.update(d.id, '新版', 1);
    const writing = store.save(target, d.id);
    store.update(d.id, '原文', 2);
    await writing;
    expect(await readFile(target, 'utf8')).toBe('新版');
    expect(store.isDirty(d.id)).toBe(true);
    store.update(d.id, '新版', 3);
    expect(store.isDirty(d.id)).toBe(false);
  });
  it('相同路径不重复打开，同名不同目录分别保留；切换后仍可保存指定文件', async () => {
    await mkdir(path.join(root, 'one'));
    await mkdir(path.join(root, 'two'));
    const first = path.join(root, 'one', 'same.md');
    const second = path.join(root, 'two', 'same.md');
    await writeFile(first, '一');
    await writeFile(second, '二');
    const a = await store.load(first);
    const b = await store.load(second);
    expect(store.documents).toHaveLength(2);
    store.update(a.id, '一的修改', 1);
    expect((await store.load(first)).id).toBe(a.id);
    expect(store.documents).toHaveLength(2);
    store.activate(b.id);
    await store.save(first, a.id);
    expect(store.activeId).toBe(b.id);
    expect(await readFile(first, 'utf8')).toBe('一的修改');
    expect(await readFile(second, 'utf8')).toBe('二');
    await expect(store.save(first, b.id)).rejects.toThrow('另一个标签');
  });
  it('保存、关闭或还原一个标签不清除其他标签草稿', async () => {
    const a = store.newDocument();
    const b = store.newDocument();
    store.update(a.id, '草稿甲', 1);
    store.update(b.id, '草稿乙', 1);
    await store.flushRecovery();
    expect((await store.readRecovery()).map((r) => r.document.content)).toEqual([
      '草稿甲',
      '草稿乙',
    ]);
    await store.save(path.join(root, 'a.md'), a.id);
    expect((await store.readRecovery()).map((r) => r.document.content)).toEqual(['草稿乙']);
    store.remove(a.id);
    await store.flushRecovery();
    expect((await store.readRecovery()).map((r) => r.document.content)).toEqual(['草稿乙']);
    store.update(b.id, '', 2);
    await store.flushRecovery();
    expect(await store.readRecovery()).toEqual([]);
  });
  it('兼容旧版单文档草稿，磁盘已变更时不能误判为干净', async () => {
    const target = path.join(root, 'legacy.md');
    await writeFile(target, '原文');
    const d = await store.load(target);
    const originalRecord = store.get(d.id)!;
    const { savedContent: _saved, ...legacyDocument } = { ...d, content: '旧版草稿', version: 1 };
    void _saved;
    await writeFile(
      path.join(root, 'data/recovery.json'),
      JSON.stringify({ schema: 1, document: legacyDocument, baseline: originalRecord.baseline }),
    );
    expect((await store.readRecovery())[0]?.document.savedContent).toBe('原文');
    await writeFile(target, '外部修改');
    expect((await store.readRecovery())[0]?.document.savedContent).toBeNull();
  });
});

describe('图片路径边界', () => {
  it('允许目录内中文图片，拒绝上级目录和错误格式', async () => {
    await mkdir(path.join(root, 'doc'));
    await mkdir(path.join(root, 'doc', '图片'));
    const document = path.join(root, 'doc', 'a.md');
    await writeFile(path.join(root, 'doc', '图片', '图 #1.png'), 'png');
    await writeFile(path.join(root, 'secret.png'), 'secret');
    await writeFile(path.join(root, 'doc', 'a.svg'), '<svg/>');
    expect(await resolveImage(document, '图片/图 #1.png')).toContain('图 #1.png');
    await expect(resolveImage(document, '../secret.png')).rejects.toThrow();
    await expect(resolveImage(document, 'a.svg')).rejects.toThrow();
  });
  it('符号链接不能绕过目录边界', async () => {
    await mkdir(path.join(root, 'doc'));
    await mkdir(path.join(root, 'outside'));
    await writeFile(path.join(root, 'outside', 'secret.png'), 'secret');
    await symlink(path.join(root, 'outside'), path.join(root, 'doc', 'link'), 'junction');
    await expect(resolveImage(path.join(root, 'doc', 'a.md'), 'link/secret.png')).rejects.toThrow();
  });
});
