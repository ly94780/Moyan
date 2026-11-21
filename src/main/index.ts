import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DocumentStore, canonicalTarget } from './store';
import { resolveImage } from './files';
import { closeDocumentGroup } from './close-documents';
import { filesFromCommandLine, isMarkdownPath } from './open-arguments';
import type { Bootstrap, OpenResult, Result, SaveResult, TabMenuAction } from '../shared/types';

protocol.registerSchemesAsPrivileged([
  { scheme: 'moyan-image', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
// Isolate automated tests without touching the user's real recovery data.
if (process.env.MOYAN_TEST_DATA) app.setPath('userData', process.env.MOYAN_TEST_DATA);
const directory = __dirname;
let window: BrowserWindow;
let store: DocumentStore;
let closing = false;
let closePending = false;
let operations: Promise<unknown> = Promise.resolve();
const pendingOpenPaths = filesFromCommandLine(process.argv, process.cwd(), !!process.defaultApp);

function focusWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

function queueExternalFiles(files: string[]) {
  pendingOpenPaths.push(...files);
  if (window && !window.isDestroyed()) {
    if (files.length) window.webContents.send('document:external-open');
    focusWindow();
  }
}

function errorMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY')
    return '无法访问文件，可能被占用或没有写入权限。请关闭占用程序，或另存到其他位置。';
  if (code === 'ENOSPC') return '磁盘空间不足。内容仍保留在编辑器中，请释放空间后重试。';
  if (code === 'ENOENT') return '文件或目录已不存在，请重新选择文件或另存为。';
  if (error instanceof Error && error.message.startsWith('无法读取：')) return error.message;
  if (error instanceof Error && error.message.startsWith('目标文件已在')) return error.message;
  if (error instanceof Error && error.message.startsWith('请先保存文件')) return error.message;
  return '操作未完成，内容仍保留在编辑器中。请重试或另存为。';
}
function trusted(event: {
  sender: Electron.WebContents;
  senderFrame: Electron.WebFrameMain | null;
}) {
  return event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
}
function handle<T>(channel: string, operation: (...args: unknown[]) => Promise<T> | T) {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<Result<T>> => {
    if (!trusted(event)) return Promise.resolve({ ok: false, error: '请求来源无效' });
    const work = operations
      .catch(() => undefined)
      .then(async (): Promise<Result<T>> => {
        try {
          return { ok: true, data: await operation(...args) };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      });
    operations = work;
    return work;
  });
}
async function save(id: string, saveAs = false): Promise<SaveResult | null> {
  const record = store.get(id);
  if (!record) return null;
  let target = record.document.path;
  if (!saveAs && target && !store.isDirty(id)) return null;
  if (!saveAs && target && (await store.conflict(id))) {
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      title: '文件已在外部修改',
      message: '磁盘上的文件与打开时不同。',
      detail: '重新载入将放弃编辑器中的修改；另存为可以保留两份内容。',
      buttons: ['取消', '另存为', '重新载入', '覆盖磁盘文件'],
      defaultId: 1,
      cancelId: 0,
    });
    if (response === 0) return null;
    if (response === 1) saveAs = true;
    if (response === 2) {
      const loaded = await store.reload(id);
      const result: SaveResult = { kind: 'loaded', document: loaded, replacedId: id };
      window.webContents.send('document:saved', result);
      return result;
    }
  }
  if (saveAs || !target) {
    const result = await dialog.showSaveDialog(window, {
      title: '保存 Markdown',
      defaultPath: target ?? record.document.name,
      filters: [{ name: 'Markdown 文档', extensions: ['md', 'markdown'] }],
    });
    if (result.canceled || !result.filePath) return null;
    target = result.filePath;
  }
  const result: SaveResult = { kind: 'saved', document: await store.save(target, id) };
  window.webContents.send('document:saved', result);
  return result;
}
async function canLeave(id: string): Promise<string | null> {
  if (!store.isDirty(id)) return id;
  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    title: '保留修改',
    message: `要保存“${store.get(id)?.document.name}”的修改吗？`,
    detail: '选择“不保存”将放弃本次修改及其恢复草稿。',
    buttons: ['保存', '不保存', '取消'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 2) return null;
  if (response === 0) {
    const result = await save(id);
    if (!result || store.isDirty(result.document.id)) return null;
    return result.document.id;
  }
  return id;
}

async function canExit(): Promise<boolean> {
  const approved = new Map<string, number>();
  for (;;) {
    const next = store.documents.find(
      (d) => store.isDirty(d.id) && approved.get(d.id) !== d.version,
    );
    if (!next) return true;
    const resolvedId = await canLeave(next.id);
    if (!resolvedId) return false;
    const current = store.get(resolvedId)?.document;
    if (current) approved.set(resolvedId, current.version);
  }
}

async function createWindow() {
  store = new DocumentStore(app.getPath('userData'));
  await store.initialize();
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: '墨页 · Markdown',
    backgroundColor: '#f7f8fa',
    icon: path.join(directory, '../../resources/moyan.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(directory, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  store.onRecoveryError = () => {
    void dialog.showMessageBox(window, {
      type: 'error',
      message: '恢复草稿写入失败',
      detail: '请使用 Ctrl+S 保存文档，避免退出后丢失未保存内容。',
    });
  };
  let recovery = await store.readRecovery();
  handle('document:bootstrap', async (): Promise<Bootstrap> => ({
    preferences: await store.readPreferences(),
    workspace: store.workspace,
    recovery: recovery.length ? { names: recovery.map((r) => r.document.name) } : null,
  }));
  handle('document:recovery', async (restore) => {
    if (typeof restore !== 'boolean' || !recovery.length) return store.workspace;
    if (restore) recovery.forEach((record) => store.add(record));
    else await store.clearRecovery();
    recovery = [];
    return store.workspace;
  });
  handle('document:new', () => (!recovery.length ? store.newDocument() : null));
  const openPaths = async (paths: unknown): Promise<OpenResult> => {
    const opened = new Map<string, import('../shared/types').DocumentData>();
    const issues: string[] = [];
    if (recovery.length) return { documents: [], activeId: store.activeId, issues };
    if (!Array.isArray(paths) || !paths.length)
      return {
        documents: [],
        activeId: store.activeId,
        issues: ['请拖入本地 .md 或 .markdown 文件。'],
      };
    for (const entry of paths) {
      if (typeof entry !== 'string' || !path.isAbsolute(entry) || !isMarkdownPath(entry)) {
        issues.push('已忽略非 Markdown 文件，仅支持 .md 和 .markdown。');
        continue;
      }
      try {
        const target = await canonicalTarget(entry);
        const existing = store.findByPath(target);
        if (existing) {
          store.activate(existing.id);
          opened.set(existing.id, existing);
          continue;
        }
        const info = await stat(target);
        if (!info.isFile()) {
          issues.push(`${path.basename(entry)}：不是普通文件。`);
          continue;
        }
        if (info.size > 5 * 1024 * 1024) {
          const { response } = await dialog.showMessageBox(window, {
            type: 'question',
            message: `“${path.basename(entry)}”是一个较大的文档`,
            detail: '将先进入编辑模式，预览可按需开启。',
            buttons: ['继续打开', '取消'],
            cancelId: 1,
          });
          if (response === 1) continue;
        }
        const record = await store.prepare(target);
        store.add(record);
        opened.set(record.document.id, record.document);
      } catch (error) {
        issues.push(`${path.basename(entry)}：${errorMessage(error)}`);
      }
    }
    return {
      documents: [...opened.values()],
      activeId: store.activeId,
      issues: [...new Set(issues)],
    };
  };
  handle('document:open', async () => {
    if (recovery.length) return { documents: [], activeId: store.activeId, issues: [] };
    // Choose first: cancelling the dialog must not discard current edits.
    const selected = await dialog.showOpenDialog(window, {
      filters: [{ name: 'Markdown 文档', extensions: ['md', 'markdown'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (selected.canceled || !selected.filePaths.length)
      return { documents: [], activeId: store.activeId, issues: [] };
    return openPaths(selected.filePaths);
  });
  handle('document:drop', openPaths);
  handle('document:open-pending', () => {
    if (recovery.length || !pendingOpenPaths.length)
      return { documents: [], activeId: store.activeId, issues: [] };
    return openPaths(pendingOpenPaths.splice(0));
  });
  handle('document:save', (id, saveAs) =>
    typeof id === 'string' ? save(id, saveAs === true) : null,
  );
  handle('document:close', async (id) => {
    if (typeof id !== 'string' || !store.get(id)) return null;
    const resolved = await canLeave(id);
    if (!resolved) return null;
    const result = store.remove(resolved);
    await store.flushRecovery().catch(store.onRecoveryError);
    return result;
  });
  handle('document:close-group', (id, scope) => {
    if (typeof id !== 'string' || (scope !== 'all' && scope !== 'others')) return null;
    return closeDocumentGroup(store, id, scope, canLeave);
  });
  handle('document:reveal', async (id) => {
    const document = typeof id === 'string' ? store.get(id)?.document : undefined;
    if (!document) return;
    if (!document.path) throw new Error('请先保存文件，再打开所在文件夹。');
    await stat(document.path);
    shell.showItemInFolder(document.path);
  });
  handle('document:menu', (id) => {
    const document = typeof id === 'string' ? store.get(id)?.document : undefined;
    if (!document) return;
    const dispatch = (action: TabMenuAction['action']) => () => {
      if (!window.isDestroyed() && store.get(document.id))
        window.webContents.send('document:menu-action', {
          id: document.id,
          action,
        } satisfies TabMenuAction);
    };
    Menu.buildFromTemplate([
      {
        id: 'tab-reveal',
        label: '打开所在文件夹',
        enabled: !!document.path,
        click: dispatch('reveal'),
      },
      { type: 'separator' },
      {
        id: 'tab-close-others',
        label: '关闭其他标签',
        enabled: store.documents.length > 1,
        click: dispatch('closeOthers'),
      },
      { id: 'tab-close-all', label: '关闭所有标签', click: dispatch('closeAll') },
    ]).popup({ window });
  });
  ipcMain.on('document:activate', (event, id: unknown) => {
    if (trusted(event) && typeof id === 'string') store.activate(id);
  });
  handle('preferences:write', (value) => store.writePreferences(value));
  handle('link:external', async (value) => {
    if (typeof value !== 'string') return;
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol)) await shell.openExternal(url.href);
  });
  ipcMain.on('document:update', (event, id: unknown, content: unknown, version: unknown) => {
    if (
      trusted(event) &&
      typeof id === 'string' &&
      typeof content === 'string' &&
      typeof version === 'number'
    )
      store.update(id, content, version);
  });
  protocol.handle('moyan-image', async (request) => {
    try {
      const url = new URL(request.url);
      const d = store.get(url.hostname)?.document;
      if (!d?.path) return new Response(null, { status: 403 });
      const target = await resolveImage(d.path, decodeURIComponent(url.pathname.slice(1)));
      const types: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
      };
      return new Response(await readFile(target), {
        headers: {
          'Content-Type': types[path.extname(target).toLowerCase()],
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  window.on('close', (event) => {
    if (closing) return;
    event.preventDefault();
    if (closePending) return;
    closePending = true;
    operations = operations
      .catch(() => undefined)
      .then(async () => {
        try {
          if (await canExit()) {
            // Keep all drafts until every tab's close decision has been accepted.
            if (!recovery.length) await store.clearRecovery();
            closing = true;
            window.close();
          }
        } catch (error) {
          await dialog.showMessageBox(window, { type: 'error', message: errorMessage(error) });
        } finally {
          closePending = false;
        }
      });
  });
  window.once('ready-to-show', () => window.show());
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(path.join(directory, '../renderer/index.html'));
}
// Acquire before any data I/O or BrowserWindow creation. The secondary process only forwards files.
if (!app.requestSingleInstanceLock({ files: pendingOpenPaths })) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory, additionalData: unknown) => {
    const data = additionalData as { files?: unknown } | null;
    // Preserve paths resolved against the sender's cwd; Chromium can change argv order.
    const files =
      data && Array.isArray(data.files)
        ? data.files.filter(
            (value): value is string =>
              typeof value === 'string' && path.isAbsolute(value) && isMarkdownPath(value),
          )
        : filesFromCommandLine(argv, workingDirectory, !!process.defaultApp);
    queueExternalFiles(files);
  });
  app
    .whenReady()
    .then(createWindow)
    .catch(() => {
      dialog.showErrorBox('启动失败', '无法初始化应用数据，请检查存储目录的访问权限。');
      app.quit();
    });
}
app.on('window-all-closed', () => app.quit());
