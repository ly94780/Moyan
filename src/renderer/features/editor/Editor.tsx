import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  indentOnInput,
} from '@codemirror/language';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import type { DocumentData } from '../../../shared/types';

export interface EditorHandle {
  capture(): void;
  search(): void;
  insert(before: string, after?: string): void;
  focus(): void;
}
interface Props {
  document: DocumentData;
  documentIds: string[];
  dark: boolean;
  size: number;
  onChange(id: string, content: string): void;
  onCursor(id: string, line: number, column: number): void;
}
export const Editor = forwardRef<EditorHandle, Props>(function Editor(
  { document, documentIds, dark, size, onChange, onCursor },
  ref,
) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onCursor });
  callbacks.current = { onChange, onCursor };
  const theme = useRef(new Compartment());
  const sessions = useRef(
    new Map<string, { state: EditorState; scroll: ReturnType<EditorView['scrollSnapshot']> }>(),
  );
  const capture = useRef<() => void>(() => undefined);
  const appearance = (isDark: boolean, fontSize: number) => [
    isDark ? oneDark : [],
    EditorView.theme({
      '&': { height: '100%', fontSize: `${fontSize}px` },
      '.cm-scroller': { fontFamily: 'Consolas, "Cascadia Code", monospace', lineHeight: '1.8' },
      '.cm-content': { padding: '16px 0' },
      '.cm-line': { padding: '0 20px 0 16px' },
      '.cm-gutters': { border: 'none', background: 'transparent', color: '#9298a5' },
      '&.cm-focused': { outline: 'none' },
    }),
  ];
  useEffect(() => {
    if (!container.current) return;
    const cache = sessions.current;
    const cached = cache.get(document.id);
    const editor = new EditorView({
      parent: container.current,
      scrollTo: cached?.scroll,
      state:
        cached?.state ??
        EditorState.create({
          doc: document.content,
          extensions: [
            lineNumbers(),
            highlightActiveLine(),
            drawSelection(),
            history(),
            markdown(),
            bracketMatching(),
            indentOnInput(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            EditorView.lineWrapping,
            search({ top: true }),
            keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
            EditorState.phrases.of({
              Find: '查找',
              Replace: '替换',
              next: '下一个',
              previous: '上一个',
              all: '全选匹配',
              'match case': '区分大小写',
              'by word': '全词匹配',
              regexp: '正则表达式',
              replace: '替换',
              'replace all': '全部替换',
              close: '关闭',
              'No matches': '没有匹配结果',
            }),
            EditorView.contentAttributes.of({
              'aria-label': 'Markdown 源码编辑器',
              spellcheck: 'false',
            }),
            theme.current.of(appearance(dark, size)),
            EditorView.updateListener.of((update) => {
              if (update.docChanged)
                callbacks.current.onChange(document.id, update.state.doc.toString());
              if (update.docChanged || update.selectionSet) {
                const position = update.state.selection.main.head;
                const line = update.state.doc.lineAt(position);
                callbacks.current.onCursor(document.id, line.number, position - line.from + 1);
              }
            }),
          ],
        }),
    });
    view.current = editor;
    const head = editor.state.selection.main.head;
    const line = editor.state.doc.lineAt(head);
    callbacks.current.onCursor(document.id, line.number, head - line.from + 1);
    const remember = () => {
      if (editor.dom.getClientRects().length)
        cache.set(document.id, { state: editor.state, scroll: editor.scrollSnapshot() });
    };
    capture.current = remember;
    editor.scrollDOM.addEventListener('scroll', remember);
    return () => {
      remember();
      cache.set(document.id, {
        state: editor.state,
        scroll: cache.get(document.id)?.scroll ?? editor.scrollSnapshot(),
      });
      editor.scrollDOM.removeEventListener('scroll', remember);
      editor.destroy();
      view.current = null;
    };
    // Keep one view mounted; inactive tabs retain immutable state and history, not a DOM tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id]);
  useEffect(() => {
    const open = new Set(documentIds);
    for (const id of sessions.current.keys()) if (!open.has(id)) sessions.current.delete(id);
  }, [documentIds]);
  useEffect(() => {
    view.current?.dispatch({ effects: theme.current.reconfigure(appearance(dark, size)) });
  }, [dark, size, document.id]);
  useImperativeHandle(
    ref,
    () => ({
      capture() {
        capture.current();
      },
      search() {
        if (view.current) openSearchPanel(view.current);
      },
      focus() {
        view.current?.focus();
      },
      insert(before, after = '') {
        const editor = view.current;
        if (!editor || editor.composing) return;
        const { from, to } = editor.state.selection.main;
        const selected = editor.state.sliceDoc(from, to);
        editor.dispatch({
          changes: { from, to, insert: before + selected + after },
          selection: { anchor: from + before.length, head: to + before.length },
        });
        editor.focus();
      },
    }),
    [],
  );
  return <div ref={container} style={{ height: '100%', overflow: 'hidden' }} />;
});
