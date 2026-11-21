import { randomUUID } from 'node:crypto';
import { readFile, mkdir, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  defaultPreferences,
  isDocumentDirty,
  type CloseResult,
  type DocumentData,
  type Preferences,
  type WorkspaceData,
} from '../shared/types';
import { atomicWrite, decodeMarkdown, digest, encodeMarkdown, fileDigest } from './files';

export interface RecordData {
  document: DocumentData;
  baseline: string | null;
}
const pathKey = (value: string) =>
  process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
export async function canonicalTarget(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return path.join(await realpath(path.dirname(target)), path.basename(target));
  }
}

export function sanitizePreferences(value: unknown): Preferences {
  const p = (value && typeof value === 'object' ? value : {}) as Partial<Preferences>;
  return {
    version: 1,
    theme: ['light', 'dark', 'system'].includes(p.theme ?? '') ? p.theme! : 'system',
    readSize: Number.isFinite(p.readSize) ? Math.min(24, Math.max(14, p.readSize!)) : 16,
    editSize: Number.isFinite(p.editSize) ? Math.min(24, Math.max(12, p.editSize!)) : 14,
    remoteImages: p.remoteImages === true,
    mode: ['read', 'edit', 'split'].includes(p.mode ?? '') ? p.mode : undefined,
  };
}

export class DocumentStore {
  private records = new Map<string, RecordData>();
  activeId: string | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private recoveryQueue: Promise<void> = Promise.resolve();
  onRecoveryError: () => void = () => undefined;
  constructor(private directory: string) {}
  get current() {
    return this.activeId ? (this.records.get(this.activeId) ?? null) : null;
  }
  get documents(): DocumentData[] {
    return [...this.records.values()].map((record) => record.document);
  }
  get workspace(): WorkspaceData {
    return { documents: this.documents, activeId: this.activeId };
  }
  get dirty() {
    return !!this.current && isDocumentDirty(this.current.document);
  }
  get(id: string) {
    return this.records.get(id);
  }
  isDirty(id: string) {
    const record = this.get(id);
    return !!record && isDocumentDirty(record.document);
  }
  findByPath(target: string) {
    return this.documents.find(
      (document) => document.path && pathKey(document.path) === pathKey(target),
    );
  }
  activate(id: string) {
    if (this.records.has(id)) this.activeId = id;
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true });
  }
  newDocument(): DocumentData {
    let name = '未命名.md';
    let number = 2;
    while (this.documents.some((document) => document.name === name))
      name = `未命名 ${number++}.md`;
    const document: DocumentData = {
      id: randomUUID(),
      name,
      path: null,
      content: '',
      savedContent: '',
      version: 0,
      savedVersion: 0,
      bom: false,
      eol: 'LF',
      mixed: false,
      large: false,
    };
    this.add({ document, baseline: null });
    return document;
  }
  add(record: RecordData) {
    this.records.set(record.document.id, record);
    this.activeId = record.document.id;
  }
  async load(target: string): Promise<DocumentData> {
    const canonical = await canonicalTarget(target);
    const existing = this.findByPath(canonical);
    if (existing) {
      this.activate(existing.id);
      return existing;
    }
    const prepared = await this.prepare(canonical);
    this.add(prepared);
    return prepared.document;
  }
  async prepare(target: string): Promise<RecordData> {
    const canonical = await realpath(target);
    const bytes = await readFile(canonical);
    let decoded: ReturnType<typeof decodeMarkdown>;
    try {
      decoded = decodeMarkdown(bytes);
    } catch {
      throw new Error('无法读取：暂不支持此文件的编码或换行格式，请转换为 UTF-8。');
    }
    const document: DocumentData = {
      id: randomUUID(),
      name: path.basename(canonical),
      path: canonical,
      ...decoded,
      savedContent: decoded.content,
      version: 0,
      savedVersion: 0,
      large: bytes.length > 5 * 1024 * 1024,
    };
    return { document, baseline: digest(bytes) };
  }
  async reload(id: string): Promise<DocumentData> {
    const record = this.get(id);
    if (!record?.document.path) throw new Error('没有可重新载入的文件');
    const prepared = await this.prepare(record.document.path);
    this.records = new Map(
      [...this.records].map(([key, value]) =>
        key === id ? [prepared.document.id, prepared] : [key, value],
      ),
    );
    if (this.activeId === id) this.activeId = prepared.document.id;
    await this.flushRecovery().catch(this.onRecoveryError);
    return prepared.document;
  }
  remove(id: string): CloseResult {
    const ids = this.documents.map((document) => document.id);
    const index = ids.indexOf(id);
    this.records.delete(id);
    if (this.activeId === id) {
      const remaining = this.documents;
      this.activeId = remaining[Math.max(0, index - 1)]?.id ?? null;
    }
    return { closedId: id, activeId: this.activeId };
  }
  update(id: string, content: string, version: number) {
    const d = this.get(id)?.document;
    if (!d || !Number.isSafeInteger(version) || version <= d.version) return;
    d.content = content;
    d.version = version;
    if (!isDocumentDirty(d)) {
      // Remove a reverted tab's stale draft without removing other tabs' drafts.
      void this.flushRecovery().catch(this.onRecoveryError);
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flushRecovery().catch(this.onRecoveryError);
      }, 2000);
    }
  }
  async conflict(id = this.activeId): Promise<boolean> {
    const r = id ? this.get(id) : undefined;
    return !!r?.document.path && (await fileDigest(r.document.path)) !== r.baseline;
  }
  async save(target: string, id = this.activeId): Promise<DocumentData> {
    const record = id ? this.get(id) : undefined;
    if (!record) throw new Error('没有可保存的文档');
    const snapshot = { ...record.document };
    const canonical = await canonicalTarget(target);
    const other = this.findByPath(canonical);
    if (other && other.id !== id)
      throw new Error('目标文件已在另一个标签中打开，请选择其他文件名。');
    const bytes = encodeMarkdown(snapshot.content, snapshot.bom, snapshot.eol);
    await atomicWrite(canonical, bytes);
    record.baseline = digest(bytes);
    Object.assign(record.document, {
      path: canonical,
      name: path.basename(canonical),
      savedVersion: snapshot.version,
      savedContent: snapshot.content,
      mixed: false,
    });
    await this.flushRecovery().catch(this.onRecoveryError);
    return { ...record.document };
  }
  async flushRecovery() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const dirty = [...this.records.values()].filter((record) => isDocumentDirty(record.document));
    const snapshot = dirty.length ? JSON.stringify({ schema: 2, records: dirty }) : null;
    this.recoveryQueue = this.recoveryQueue
      .catch(() => undefined)
      .then(async () => {
        if (snapshot)
          await atomicWrite(path.join(this.directory, 'recovery.json'), Buffer.from(snapshot));
        else await this.deleteRecoveryFile();
      });
    await this.recoveryQueue;
  }
  private async deleteRecoveryFile() {
    await unlink(path.join(this.directory, 'recovery.json')).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
  }
  async clearRecovery() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.recoveryQueue = this.recoveryQueue
      .catch(() => undefined)
      .then(() => this.deleteRecoveryFile());
    await this.recoveryQueue;
  }
  async readRecovery(): Promise<RecordData[]> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(path.join(this.directory, 'recovery.json'), 'utf8'),
      );
      if (!parsed || typeof parsed !== 'object') return [];
      const recovery = parsed as Record<string, unknown>;
      const entries =
        recovery.schema === 1
          ? [recovery]
          : recovery.schema === 2 && Array.isArray(recovery.records)
            ? recovery.records
            : [];
      const records: RecordData[] = [];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const r = entry as Record<string, unknown>;
        if (!r.document || typeof r.document !== 'object') continue;
        const d = r.document as Record<string, unknown>;
        if (
          typeof d.content !== 'string' ||
          typeof d.name !== 'string' ||
          (d.path !== null && (typeof d.path !== 'string' || !path.isAbsolute(d.path))) ||
          typeof d.version !== 'number' ||
          !Number.isSafeInteger(d.version) ||
          d.version < 0 ||
          typeof d.savedVersion !== 'number' ||
          !Number.isSafeInteger(d.savedVersion) ||
          d.savedVersion < 0 ||
          d.savedVersion > d.version ||
          (d.eol !== 'LF' && d.eol !== 'CRLF') ||
          typeof d.bom !== 'boolean' ||
          (r.baseline !== null && typeof r.baseline !== 'string')
        )
          continue;
        let savedContent: string | null;
        if (recovery.schema === 2) {
          if (d.savedContent !== null && typeof d.savedContent !== 'string') continue;
          savedContent = d.savedContent;
        } else {
          savedContent = d.path === null ? '' : null;
          if (d.path) {
            try {
              const disk = await readFile(d.path);
              if (digest(disk) === r.baseline) savedContent = decodeMarkdown(disk).content;
            } catch {
              /* An unavailable legacy baseline must never mark a draft clean. */
            }
          }
        }
        const document: DocumentData = {
          id: randomUUID(),
          name: d.name,
          path: d.path,
          content: d.content,
          savedContent,
          version: d.version,
          savedVersion: d.savedVersion,
          eol: d.eol,
          bom: d.bom,
          mixed: d.mixed === true,
          large: d.large === true,
        };
        if (isDocumentDirty(document)) records.push({ document, baseline: r.baseline });
      }
      return records;
    } catch {
      return [];
    }
  }
  async readPreferences() {
    try {
      return sanitizePreferences(
        JSON.parse(await readFile(path.join(this.directory, 'preferences.json'), 'utf8')),
      );
    } catch {
      return { ...defaultPreferences };
    }
  }
  async writePreferences(value: unknown) {
    await atomicWrite(
      path.join(this.directory, 'preferences.json'),
      Buffer.from(JSON.stringify(sanitizePreferences(value))),
    );
  }
}
