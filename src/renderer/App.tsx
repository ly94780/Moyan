import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  BookOpen,
  Braces,
  Columns2,
  FilePlus2,
  FolderOpen,
  Save,
  SaveAll,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  Search,
  Feather,
  ChevronRight,
  FileText,
  Circle,
  Bold,
  Italic,
  Heading1,
  Link,
  Code2,
  Quote,
  X,
  ArrowUpRight,
  Check,
  WifiOff,
  ListTree,
} from 'lucide-react';
import {
  defaultPreferences,
  isDocumentDirty,
  type DocumentData,
  type Mode,
  type Preferences,
  type Result,
  type SaveResult,
  type OpenResult,
  type TabsClosedResult,
  type TabMenuAction,
} from '../shared/types';
import { Editor, type EditorHandle } from './features/editor/Editor';
import { Preview } from './features/preview/Preview';
import { renderMarkdown, type Rendered } from './features/preview/markdown';
import type { RenderResponse } from './features/preview/worker';
import styles from './styles/App.module.css';

const sample = `# 让文字，回归专注\n\n欢迎来到 **墨页**。这是一个安静、轻巧的 Markdown 写作空间。\n\n## 从一段文字开始\n\nMarkdown 用简单的符号，记录清晰的想法。你可以专注阅读，也可以切换到分屏模式，边写边看。\n\n> 好的工具，让你忘记工具的存在。\n\n## 你的写作清单\n\n- [x] 打开一个新的写作空间\n- [x] 体验舒适的阅读排版\n- [ ] 写下今天的第一个想法\n\n## 用代码表达\n\n\`\`\`javascript\nconst idea = '让灵感自然发生';\nconsole.log(idea);\n\`\`\`\n\n## 把信息整理清楚\n\n| 模式 | 适合的时刻 |\n| --- | --- |\n| 阅读 | 沉浸于一篇好文章 |\n| 编辑 | 专注写下你的想法 |\n| 分屏 | 让文字和排版同时发生 |\n\n了解更多：[Markdown 指南](https://www.markdownguide.org/)\n\n---\n\n一切保存在本地。你的文字，始终属于你。\n`;
const emptyRender: Rendered = { html: '', headings: [], words: 0 };
const modeNames: Record<Mode, string> = { read: '阅读', edit: '编辑', split: '分屏' };

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

export function App() {
  const [documents, setDocuments] = useState<DocumentData[]>([]);
  const documentsRef = useRef<DocumentData[]>([]);
  const [document, setDocument] = useState<DocumentData | null>(null);
  const documentRef = useRef<DocumentData | null>(null);
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>('read');
  const [sidebar, setSidebar] = useState(true);
  const [settings, setSettings] = useState(false);
  const [recovery, setRecovery] = useState<{ names: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [externalOpenPending, setExternalOpenPending] = useState(true);
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [message, setMessage] = useState('');
  const [rendered, setRendered] = useState<Rendered>(emptyRender);
  const [rendering, setRendering] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [split, setSplit] = useState(50);
  const [systemDark, setSystemDark] = useState(matchMedia('(prefers-color-scheme: dark)').matches);
  const editor = useRef<EditorHandle>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const recoveryDialog = useRef<HTMLDialogElement>(null);
  const previewScroll = useRef<HTMLDivElement>(null);
  const restoringPreview = useRef(false);
  const tabViews = useRef(
    new Map<string, { mode: Mode; cursor: { line: number; column: number }; scroll: number }>(),
  );
  const previewCache = useRef(
    new Map<string, { content: string; remote: boolean; rendered: Rendered }>(),
  );
  const modeRef = useRef(mode);
  const cursorRef = useRef(cursor);
  const preferencesRef = useRef(preferences);
  modeRef.current = mode;
  cursorRef.current = cursor;
  preferencesRef.current = preferences;
  const dirty = !!document && isDocumentDirty(document);
  const failed = !!document && failedIds.has(document.id);
  const dark = preferences.theme === 'dark' || (preferences.theme === 'system' && systemDark);
  const content = document?.content;
  const documentId = document?.id;
  const skipPreview = document?.large && mode === 'edit';
  const notify = useCallback((value: string) => setMessage(value), []);
  const setFailed = useCallback((value: boolean, id = documentRef.current?.id) => {
    if (!id) return;
    setFailedIds((previous) => {
      const next = new Set(previous);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const putDocument = useCallback((value: DocumentData, replacedId?: string) => {
    const existing = documentsRef.current.find((d) => d.id === (replacedId ?? value.id));
    const next =
      existing && !replacedId && existing.version > value.version
        ? { ...value, content: existing.content, version: existing.version }
        : value;
    const list = existing
      ? documentsRef.current.map((d) => (d.id === existing.id ? next : d))
      : [...documentsRef.current, next];
    documentsRef.current = list;
    setDocuments(list);
    if (documentRef.current?.id === (replacedId ?? value.id)) {
      documentRef.current = next;
      setDocument(next);
    }
    return next;
  }, []);
  const replaceDocument = useCallback((value: DocumentData | null, force = false) => {
    const previous = documentRef.current;
    if (!force && previous && previous.id === value?.id) {
      documentRef.current = value;
      setDocument(value);
      window.desktop.activateDocument(value.id);
      return;
    }
    if (previous?.id !== value?.id) {
      editor.current?.capture();
      restoringPreview.current = true;
    }
    if (previous && previous.id !== value?.id)
      tabViews.current.set(previous.id, {
        mode: modeRef.current,
        cursor: cursorRef.current,
        scroll:
          modeRef.current === 'edit'
            ? (tabViews.current.get(previous.id)?.scroll ?? 0)
            : (previewScroll.current?.scrollTop ?? 0),
      });
    documentRef.current = value;
    setDocument(value);
    const view = value ? tabViews.current.get(value.id) : undefined;
    setMode(
      view?.mode ??
        (value?.large ? 'edit' : (preferencesRef.current.mode ?? (value?.path ? 'read' : 'edit'))),
    );
    setCursor(view?.cursor ?? { line: 1, column: 1 });
    const cached = value ? previewCache.current.get(value.id) : undefined;
    setRendered(
      value &&
        cached?.content === value.content &&
        cached.remote === preferencesRef.current.remoteImages
        ? cached.rendered
        : emptyRender,
    );
    if (value) window.desktop.activateDocument(value.id);
  }, []);
  const applySave = useCallback(
    (result: SaveResult) => {
      const current = documentsRef.current.find(
        (d) => d.id === (result.replacedId ?? result.document.id),
      );
      if (result.kind === 'loaded') {
        if (!current && documentsRef.current.some((d) => d.id === result.document.id)) return;
        const active = documentRef.current?.id === result.replacedId;
        putDocument(result.document, result.replacedId);
        if (active) replaceDocument(result.document, true);
        return;
      }
      if (!current || current.savedVersion > result.document.savedVersion) return;
      const next = {
        ...current,
        path: result.document.path,
        name: result.document.name,
        mixed: false,
        savedVersion: result.document.savedVersion,
        savedContent: result.document.savedContent,
      };
      putDocument(next);
      setFailed(false, next.id);
    },
    [replaceDocument, putDocument, setFailed],
  );

  useEffect(() => {
    let mounted = true;
    const unsubscribe = window.desktop.onSaved(applySave);
    void window.desktop
      .bootstrap()
      .then(unwrap)
      .then((data) => {
        if (!mounted) return;
        setPreferences(data.preferences);
        preferencesRef.current = data.preferences;
        data.workspace.documents.forEach((d) => putDocument(d));
        replaceDocument(documentsRef.current.find((d) => d.id === data.workspace.activeId) ?? null);
        setRecovery(data.recovery);
        setReady(true);
      })
      .catch((error: Error) => notify(error.message));
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [applySave, notify, replaceDocument, putDocument]);

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    window.document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  useEffect(() => {
    if (!ready) return;
    void window.desktop.preferences(preferences).then((result) => {
      if (!result.ok) notify('偏好保存失败，本次设置仍然有效。');
    });
  }, [preferences, ready, notify]);
  useEffect(() => {
    window.document.title = `${dirty ? '● ' : ''}${document?.name ?? '欢迎'} · 墨页`;
  }, [document?.name, dirty]);
  useEffect(() => {
    if (documentId)
      window.document
        .getElementById(`tab-${documentId}`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [documentId]);
  useEffect(() => {
    const ids = new Set(documents.map((d) => d.id));
    for (const id of previewCache.current.keys()) if (!ids.has(id)) previewCache.current.delete(id);
    for (const id of tabViews.current.keys()) if (!ids.has(id)) tabViews.current.delete(id);
  }, [documents]);
  useLayoutEffect(() => {
    restoringPreview.current = true;
    if (previewScroll.current)
      previewScroll.current.scrollTop = documentId
        ? (tabViews.current.get(documentId)?.scroll ?? 0)
        : 0;
    const frame = requestAnimationFrame(() => {
      if (previewScroll.current)
        previewScroll.current.scrollTop = documentId
          ? (tabViews.current.get(documentId)?.scroll ?? 0)
          : 0;
      restoringPreview.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [documentId, rendered.html, mode]);
  useEffect(() => {
    if (content === undefined || !documentId || skipPreview) {
      setRendered(emptyRender);
      setRendering(false);
      return;
    }
    const cached = previewCache.current.get(documentId);
    if (cached?.content === content && cached.remote === preferences.remoteImages) {
      setRendered(cached.rendered);
      setRendering(false);
      return;
    }
    setRendering(true);
    const publish = (value: Rendered) => {
      if (documentsRef.current.find((d) => d.id === documentId)?.content !== content) return;
      previewCache.current.set(documentId, {
        content,
        remote: preferences.remoteImages,
        rendered: value,
      });
      if (documentRef.current?.id !== documentId) return;
      setRendered(value);
      setRendering(false);
    };
    let worker: Worker | undefined;
    const failed = () => {
      if (documentRef.current?.id !== documentId || documentRef.current.content !== content) return;
      setRendering(false);
      notify('预览未能完成，文档仍可编辑和保存。');
    };
    const timer = setTimeout(() => {
      try {
        if (content.length > 150_000) {
          worker = new Worker(new URL('./features/preview/worker.ts', import.meta.url), {
            type: 'module',
          });
          worker.onmessage = (event: MessageEvent<RenderResponse>) => {
            if (event.data.ok) {
              publish(event.data.rendered);
            } else failed();
            worker?.terminate();
          };
          worker.onerror = () => {
            failed();
            worker?.terminate();
          };
          worker.postMessage({ content, documentId, remoteImages: preferences.remoteImages });
        } else {
          try {
            publish(renderMarkdown(content, documentId, preferences.remoteImages));
          } catch {
            failed();
          }
        }
      } catch {
        failed();
        worker?.terminate();
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      worker?.terminate();
    };
  }, [content, documentId, preferences.remoteImages, skipPreview, notify]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 6500);
    return () => clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    if (settings) settingsDialog.current?.showModal();
    else settingsDialog.current?.close();
  }, [settings]);
  useEffect(() => {
    if (recovery) recoveryDialog.current?.showModal();
    else recoveryDialog.current?.close();
  }, [recovery]);

  const changeContent = useCallback(
    (content: string, id = documentRef.current?.id) => {
      const current = documentsRef.current.find((d) => d.id === id);
      if (!current) return;
      if (current.content === content) return;
      const next = { ...current, content, version: current.version + 1 };
      putDocument(next);
      setFailed(false, next.id);
      window.desktop.updateDocument(next.id, content, next.version);
    },
    [putDocument, setFailed],
  );
  const selectMode = useCallback((next: Mode) => {
    const current = documentRef.current;
    if (current && modeRef.current !== 'edit')
      tabViews.current.set(current.id, {
        mode: next,
        cursor: cursorRef.current,
        scroll: previewScroll.current?.scrollTop ?? 0,
      });
    setMode(next);
    setPreferences((p) => ({ ...p, mode: next }));
    if (next !== 'read') setTimeout(() => editor.current?.focus(), 0);
  }, []);
  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      try {
        await action();
      } catch (error) {
        notify(error instanceof Error ? error.message : '操作未完成，请重试。');
      } finally {
        setBusy(false);
      }
    },
    [notify],
  );
  const create = useCallback(
    (example = false) =>
      run(async () => {
        const value = unwrap(await window.desktop.newDocument());
        if (!value) return;
        putDocument(value);
        replaceDocument(value);
        setMode(example ? 'split' : (preferences.mode ?? 'edit'));
        if (example) changeContent(sample);
        else setTimeout(() => editor.current?.focus(), 0);
      }),
    [run, replaceDocument, preferences.mode, changeContent, putDocument],
  );
  const acceptOpened = useCallback(
    (value: OpenResult) => {
      value.documents.forEach((d) => putDocument(d));
      if (value.documents.length)
        replaceDocument(documentsRef.current.find((d) => d.id === value.activeId) ?? null);
      const issues = [...value.issues];
      if (value.documents.some((d) => d.mixed))
        issues.push('文件包含混合换行，保存时将统一为主要换行格式。');
      if (issues.length) notify(issues.slice(0, 3).join(' '));
    },
    [putDocument, replaceDocument, notify],
  );
  useEffect(() => window.desktop.onExternalOpen(() => setExternalOpenPending(true)), []);
  useEffect(() => {
    if (!ready || busy || recovery || settings || !externalOpenPending) return;
    setExternalOpenPending(false);
    void run(async () => acceptOpened(unwrap(await window.desktop.openPendingDocuments())));
  }, [ready, busy, recovery, settings, externalOpenPending, run, acceptOpened]);
  const open = useCallback(
    () =>
      run(async () => {
        acceptOpened(unwrap(await window.desktop.openDocument()));
      }),
    [run, acceptOpened],
  );
  const save = useCallback(
    (saveAs = false) =>
      run(async () => {
        const id = documentRef.current?.id;
        if (!id) return;
        const result = await window.desktop.saveDocument(id, saveAs);
        if (!result.ok) {
          setFailed(true, id);
          throw new Error(result.error);
        }
        if (result.data) {
          applySave(result.data);
          notify(result.data.kind === 'loaded' ? '已重新载入磁盘文件。' : '文档已保存。');
        }
      }),
    [run, applySave, notify, setFailed],
  );
  const applyClosedTabs = useCallback(
    (result: TabsClosedResult) => {
      const closed = new Set(result.closedIds);
      const remaining = documentsRef.current.filter((d) => !closed.has(d.id));
      documentsRef.current = remaining;
      setDocuments(remaining);
      for (const id of closed) setFailed(false, id);
      if (
        documentRef.current?.id !== result.activeId ||
        (documentRef.current && closed.has(documentRef.current.id))
      )
        replaceDocument(remaining.find((d) => d.id === result.activeId) ?? null);
    },
    [replaceDocument, setFailed],
  );
  const closeTab = useCallback(
    (id: string) =>
      run(async () => {
        const result = unwrap(await window.desktop.closeDocument(id));
        if (!result) return;
        applyClosedTabs({ closedIds: [result.closedId], activeId: result.activeId });
      }),
    [run, applyClosedTabs],
  );
  const handleTabMenuAction = useCallback(
    ({ id, action }: TabMenuAction) => {
      void run(async () => {
        if (action === 'reveal') {
          unwrap(await window.desktop.revealDocument(id));
          return;
        }
        const result = unwrap(
          await window.desktop.closeDocuments(id, action === 'closeOthers' ? 'others' : 'all'),
        );
        if (result) applyClosedTabs(result);
      });
    },
    [run, applyClosedTabs],
  );
  useEffect(() => window.desktop.onTabMenuAction(handleTabMenuAction), [handleTabMenuAction]);
  const showTabMenu = (id: string) => {
    if (busy || !ready || settings || recovery) return;
    void window.desktop
      .showTabContextMenu(id)
      .then(unwrap)
      .catch((error: Error) => notify(error.message));
  };
  const find = useCallback(() => {
    if (!documentRef.current) return;
    if (mode === 'read') setMode('edit');
    setTimeout(() => editor.current?.search(), 0);
  }, [mode]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        settings ||
        recovery ||
        busy ||
        !ready ||
        !event.ctrlKey ||
        event.altKey
      )
        return;
      const key = event.key.toLowerCase();
      if (
        !['n', 'o', 's', 'f', 'h', 'p', 'w', 'tab'].includes(key) ||
        (key === 'p' && !event.shiftKey)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (key === 'n') void create();
      if (key === 'o') void open();
      if (key === 'w' && documentRef.current) void closeTab(documentRef.current.id);
      if (key === 'tab' && documentsRef.current.length) {
        const index = documentsRef.current.findIndex((d) => d.id === documentRef.current?.id);
        const next =
          (index + (event.shiftKey ? -1 : 1) + documentsRef.current.length) %
          documentsRef.current.length;
        replaceDocument(documentsRef.current[next]);
        setTimeout(() => {
          if (modeRef.current !== 'read') editor.current?.focus();
        }, 0);
      }
      if (key === 's' && documentRef.current) void save(event.shiftKey);
      if (key === 'f' || key === 'h') find();
      if (key === 'p' && documentRef.current)
        selectMode(({ read: 'edit', edit: 'split', split: 'read' } as const)[mode]);
    };
    window.addEventListener('keydown', keyboard, true);
    return () => window.removeEventListener('keydown', keyboard, true);
  }, [
    create,
    open,
    save,
    find,
    selectMode,
    mode,
    settings,
    recovery,
    busy,
    ready,
    closeTab,
    replaceDocument,
  ]);

  const isFileDrag = (event: React.DragEvent) => event.dataTransfer.types.includes('Files');
  const dropFiles = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragging(false);
    if (busy || !ready || recovery || settings) return;
    const files = Array.from(event.dataTransfer.files);
    void run(async () => acceptOpened(unwrap(await window.desktop.openDroppedFiles(files))));
  };

  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = workspace.current?.getBoundingClientRect();
    if (!bounds) return;
    const target = event.currentTarget;
    const move = (e: PointerEvent) =>
      setSplit(Math.max(35, Math.min(65, ((e.clientX - bounds.left) / bounds.width) * 100)));
    const stop = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
      target.removeEventListener('pointercancel', stop);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
    target.addEventListener('pointercancel', stop);
  };
  const insert = (before: string, after = '') => {
    if (mode === 'read') setMode('edit');
    setTimeout(() => editor.current?.insert(before, after), 0);
  };

  return (
    <div
      className={styles.app}
      onDragEnter={(event) => {
        if (isFileDrag(event)) {
          event.preventDefault();
          dragDepth.current++;
          if (!busy && ready && !recovery && !settings) setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (isFileDrag(event)) {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }
      }}
      onDragOver={(event) => {
        if (isFileDrag(event)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = busy || !ready || recovery || settings ? 'none' : 'copy';
        }
      }}
      onDropCapture={dropFiles}
    >
      {dragging && (
        <div className={styles.dropOverlay} role="status">
          <FolderOpen size={40} />
          <strong>松开以打开 Markdown 文件</strong>
          <span>支持同时拖入多个 .md / .markdown 文件</span>
        </div>
      )}

      <header className={styles.toolbar} aria-label="文档工具栏">
        <div className={styles.brand}>
          <span className={styles.brandIcon}>
            <Feather size={13} />
          </span>
          <strong>墨页</strong>
        </div>
        <div className={styles.actions}>
          <button
            disabled={busy || !ready}
            onClick={() => void create()}
            title="新建文档 Ctrl+N"
            aria-label="新建"
          >
            <FilePlus2 size={15} />
          </button>
          <button
            disabled={busy || !ready}
            onClick={() => void open()}
            title="打开文件 Ctrl+O"
            aria-label="打开"
          >
            <FolderOpen size={15} />
          </button>
          <button
            disabled={!document || busy}
            onClick={() => void save()}
            title="保存 Ctrl+S"
            aria-label="保存"
          >
            <Save size={15} />
          </button>
          <button
            disabled={!document || busy}
            onClick={() => void save(true)}
            title="另存为 Ctrl+Shift+S"
            aria-label="另存为"
          >
            <SaveAll size={15} />
          </button>
        </div>
        <span className={styles.divider} />
        <div className={styles.modes} aria-label="显示模式">
          {(['read', 'edit', 'split'] as const).map((value, index) => {
            const Icon = [BookOpen, Braces, Columns2][index];
            return (
              <button
                key={value}
                aria-pressed={mode === value}
                disabled={!document}
                className={mode === value ? styles.activeMode : ''}
                onClick={() => selectMode(value)}
              >
                <Icon size={13} />
                {modeNames[value]}
              </button>
            );
          })}
        </div>
        {document && mode !== 'read' && (
          <div className={styles.formatTools} role="group" aria-label="文本格式">
            <button aria-label="加粗" title="加粗" onClick={() => insert('**', '**')}>
              <Bold size={14} />
            </button>
            <button aria-label="斜体" title="斜体" onClick={() => insert('*', '*')}>
              <Italic size={14} />
            </button>
            <button aria-label="插入标题" title="插入标题" onClick={() => insert('# ')}>
              <Heading1 size={15} />
            </button>
            <button
              aria-label="插入链接"
              title="插入链接"
              onClick={() => insert('[', '](https://)')}
            >
              <Link size={14} />
            </button>
            <button aria-label="插入代码" title="插入代码" onClick={() => insert('`', '`')}>
              <Code2 size={15} />
            </button>
            <button aria-label="插入引用" title="插入引用" onClick={() => insert('> ')}>
              <Quote size={14} />
            </button>
          </div>
        )}
        <div className={styles.toolbarRight}>
          <button disabled={!document} onClick={find} title="查找 Ctrl+F" aria-label="查找">
            <Search size={15} />
          </button>
          <button
            onClick={() => setSidebar(!sidebar)}
            title={sidebar ? '收起目录' : '展开目录'}
            aria-label={sidebar ? '收起目录' : '展开目录'}
          >
            {sidebar ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </button>
          <button
            aria-label="阅读与外观设置"
            title="阅读与外观设置"
            onClick={() => setSettings(true)}
          >
            <Settings2 size={15} />
          </button>
        </div>
      </header>

      {!!documents.length && (
        <div className={styles.tabBar} role="tablist" aria-label="打开的文件">
          {documents.map((item) => (
            <div
              key={item.id}
              className={`${styles.fileTab} ${document?.id === item.id ? styles.selectedTab : ''}`}
              onContextMenu={(event) => {
                event.preventDefault();
                showTabMenu(item.id);
              }}
            >
              <button
                id={`tab-${item.id}`}
                role="tab"
                aria-selected={document?.id === item.id}
                aria-label={item.name}
                title={item.path ?? item.name}
                tabIndex={document?.id === item.id ? 0 : -1}
                disabled={busy}
                onClick={() => replaceDocument(item)}
                onKeyDown={(event) => {
                  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                    event.preventDefault();
                    showTabMenu(item.id);
                    return;
                  }
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const index = documents.findIndex((d) => d.id === item.id);
                  const next =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? documents.length - 1
                        : (index + (event.key === 'ArrowRight' ? 1 : -1) + documents.length) %
                          documents.length;
                  replaceDocument(documents[next]);
                  window.document.getElementById(`tab-${documents[next].id}`)?.focus();
                }}
              >
                <FileText size={12} />
                <span>{item.name}</span>
                {isDocumentDirty(item) && <i aria-label="未保存" title="未保存" />}
              </button>
              <button
                className={styles.closeTab}
                aria-label={`关闭 ${item.name}`}
                title="关闭标签 Ctrl+W"
                disabled={busy}
                onClick={() => void closeTab(item.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button
            className={styles.newTab}
            aria-label="新建标签"
            title="新建标签 Ctrl+N"
            disabled={busy || !ready}
            onClick={() => void create()}
          >
            <FilePlus2 size={14} />
          </button>
        </div>
      )}
      <div className={styles.body}>
        {sidebar && (
          <aside className={styles.sidebar}>
            <div className={styles.sidebarLabel}>
              <ListTree size={14} />
              文章目录
              <span>
                {rendered.headings.length ? String(rendered.headings.length).padStart(2, '0') : ''}
              </span>
            </div>
            {document ? (
              <nav aria-label="文章目录">
                {rendered.headings.length ? (
                  rendered.headings.map((heading) => (
                    <button
                      key={heading.id}
                      style={{ paddingLeft: 14 + (heading.depth - 1) * 12 }}
                      onClick={() => {
                        if (mode === 'edit') setMode('read');
                        setTimeout(
                          () =>
                            window.document
                              .getElementById(heading.id)
                              ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
                          180,
                        );
                      }}
                    >
                      {heading.text || '无标题'}
                    </button>
                  ))
                ) : (
                  <p className={styles.outlineEmpty}>
                    使用 # 创建标题
                    <br />
                    让思路井然有序
                  </p>
                )}
              </nav>
            ) : (
              <div className={styles.startNav}>
                <div>
                  <span />
                  开始使用
                </div>
                <p>给想法一个安静的地方。</p>
              </div>
            )}
          </aside>
        )}

        <main className={styles.main}>
          {!document ? (
            <div className={styles.welcome}>
              <div className={styles.welcomeTag}>
                <span /> YOUR QUIET WRITING SPACE
              </div>
              <h1>
                让文字，
                <br />
                <em>回归专注。</em>
              </h1>
              <p className={styles.welcomeDescription}>
                阅读一篇好文章，或写下一个新想法。
                <br />
                在墨页，留一点空间给自己。
              </p>
              <div className={styles.welcomeActions}>
                <button
                  className={styles.primary}
                  disabled={!ready || busy}
                  onClick={() => void open()}
                >
                  <FolderOpen size={18} />
                  打开 Markdown 文件
                  <ArrowUpRight size={16} />
                </button>
                <button
                  className={styles.secondary}
                  disabled={!ready || busy}
                  onClick={() => void create()}
                >
                  <FilePlus2 size={17} />
                  新建文档
                </button>
              </div>
              <button
                className={styles.sampleLink}
                disabled={!ready || busy}
                onClick={() => void create(true)}
              >
                初次见面，打开一份示例 <ChevronRight size={14} />
              </button>
              <div className={styles.featureCards}>
                <div>
                  <BookOpen size={21} />
                  <h3>舒适阅读</h3>
                  <p>恰好的留白，清晰的层次</p>
                </div>
                <div>
                  <Columns2 size={21} />
                  <h3>边写边看</h3>
                  <p>轻松在文字与预览间切换</p>
                </div>
                <div>
                  <WifiOff size={21} />
                  <h3>本地优先</h3>
                  <p>无需联网，安心保存每一笔</p>
                </div>
              </div>
              <span className={styles.welcomeFootnote}>一个文件，一段思考，无限可能。</span>
            </div>
          ) : (
            <>
              <div
                ref={workspace}
                className={`${styles.workspace} ${styles[mode]}`}
                style={{ '--split': `${split}%` } as CSSProperties}
              >
                <section
                  className={styles.editorPane}
                  aria-label="Markdown 编辑区"
                  hidden={mode === 'read'}
                >
                  <div className={styles.editorMount}>
                    <Editor
                      ref={editor}
                      document={document}
                      documentIds={documents.map((d) => d.id)}
                      dark={dark}
                      size={preferences.editSize}
                      onChange={(id, content) => changeContent(content, id)}
                      onCursor={(id, line, column) => {
                        if (documentRef.current?.id === id) setCursor({ line, column });
                      }}
                    />
                  </div>
                </section>
                {mode === 'split' && (
                  <div
                    className={styles.resizer}
                    role="separator"
                    tabIndex={0}
                    aria-label="调整分屏宽度"
                    aria-orientation="vertical"
                    aria-valuemin={35}
                    aria-valuemax={65}
                    aria-valuenow={Math.round(split)}
                    onPointerDown={resize}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                        event.preventDefault();
                        setSplit((s) =>
                          Math.max(35, Math.min(65, s + (event.key === 'ArrowRight' ? 2 : -2))),
                        );
                      }
                    }}
                  />
                )}
                <section
                  className={styles.previewPane}
                  aria-label="Markdown 预览"
                  hidden={mode === 'edit'}
                >
                  {rendering && (
                    <div className={styles.renderStatus} role="status">
                      正在排版…
                    </div>
                  )}
                  <div
                    ref={previewScroll}
                    className={styles.previewScroll}
                    onScroll={(event) => {
                      if (
                        documentRef.current &&
                        !restoringPreview.current &&
                        modeRef.current !== 'edit'
                      )
                        tabViews.current.set(documentRef.current.id, {
                          mode: modeRef.current,
                          cursor: cursorRef.current,
                          scroll: event.currentTarget.scrollTop,
                        });
                    }}
                  >
                    {document.content ? (
                      <Preview html={rendered.html} size={preferences.readSize} onError={notify} />
                    ) : (
                      <div className={styles.emptyPreview}>
                        <Feather size={28} />
                        <h3>从第一个字开始</h3>
                        <p>切换到编辑模式，写下你的想法。</p>
                        <button onClick={() => selectMode('edit')}>
                          开始写作 <ChevronRight size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                </section>
              </div>
            </>
          )}
        </main>
      </div>
      <footer className={styles.statusbar}>
        <div>
          {failed ? (
            <>
              <Circle size={10} className={styles.failure} />
              保存失败
            </>
          ) : dirty ? (
            <>
              <Circle size={9} className={styles.unsaved} />
              未保存
            </>
          ) : (
            <>
              <Check size={12} />
              {document?.path ? '已保存' : document ? '无修改' : '准备就绪'}
            </>
          )}
          <span className={styles.statusDivider} />
          <span>本地文件 · 离线可用</span>
        </div>
        <div>
          {document && (
            <>
              <span>
                {skipPreview
                  ? '按需统计'
                  : rendering && !rendered.html
                    ? '统计中'
                    : `${rendered.words.toLocaleString()} 字`}
              </span>
              <span>
                行 {cursor.line}，列 {cursor.column}
              </span>
              <span>{document.bom ? 'UTF-8 BOM' : 'UTF-8'}</span>
              <span>{document.eol}</span>
            </>
          )}
          <span className={styles.version}>墨页 0.2.4</span>
        </div>
      </footer>
      {message && (
        <div className={styles.toast} role="status">
          <span>{message}</span>
          <button aria-label="关闭提示" onClick={() => setMessage('')}>
            <X size={15} />
          </button>
        </div>
      )}
      <dialog
        ref={recoveryDialog}
        className={styles.settings}
        onCancel={(event) => event.preventDefault()}
        aria-label="草稿恢复"
      >
        <div className={styles.settingsTitle}>
          <div>
            <h2>接着上次的想法</h2>
            <p>发现 {recovery?.names.length ?? 0} 份未保存的草稿</p>
          </div>
          <Feather size={24} />
        </div>
        <p className={styles.recoveryDescription}>
          {recovery?.names.length === 1
            ? `“${recovery.names[0]}”`
            : `${recovery?.names.length ?? 0} 个文件`}
          的内容已经为你保留。恢复后可以继续编辑，磁盘原文件不会被改写。
        </p>
        <div className={styles.welcomeActions}>
          <button
            className={styles.primary}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const value = unwrap(await window.desktop.restoreRecovery(true));
                value.documents.forEach((d) => putDocument(d));
                replaceDocument(documentsRef.current.find((d) => d.id === value.activeId) ?? null);
                setRecovery(null);
                setMode('edit');
                notify('已恢复上次草稿。请确认后保存。');
              })
            }
          >
            恢复草稿
          </button>
          <button
            className={styles.secondary}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                unwrap(await window.desktop.restoreRecovery(false));
                setRecovery(null);
              })
            }
          >
            放弃草稿
          </button>
        </div>
      </dialog>
      <dialog
        ref={settingsDialog}
        className={styles.settings}
        onClose={() => setSettings(false)}
        onCancel={() => setSettings(false)}
      >
        <div className={styles.settingsTitle}>
          <div>
            <h2>让阅读更合心意</h2>
            <p>你的习惯，会在下次打开时保留。</p>
          </div>
          <button aria-label="关闭设置" onClick={() => setSettings(false)}>
            <X size={19} />
          </button>
        </div>
        <label>
          外观主题
          <select
            value={preferences.theme}
            onChange={(e) =>
              setPreferences((p) => ({ ...p, theme: e.target.value as Preferences['theme'] }))
            }
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <label>
          阅读字号 <span>{preferences.readSize}px</span>
          <input
            aria-label="阅读字号"
            type="range"
            min="14"
            max="24"
            value={preferences.readSize}
            onChange={(e) => setPreferences((p) => ({ ...p, readSize: +e.target.value }))}
          />
        </label>
        <label>
          编辑字号 <span>{preferences.editSize}px</span>
          <input
            aria-label="编辑字号"
            type="range"
            min="12"
            max="24"
            value={preferences.editSize}
            onChange={(e) => setPreferences((p) => ({ ...p, editSize: +e.target.value }))}
          />
        </label>
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            checked={preferences.remoteImages}
            onChange={(e) => setPreferences((p) => ({ ...p, remoteImages: e.target.checked }))}
          />
          <div>
            加载网络图片<small>开启后，文章中的图片会向对应网站发起请求。</small>
          </div>
        </label>
        <div className={styles.settingsHint}>
          快捷键：Ctrl+S 保存 · Ctrl+F 查找 · Ctrl+Shift+P 切换模式
        </div>
      </dialog>
    </div>
  );
}
