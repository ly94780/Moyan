export type Mode = 'read' | 'edit' | 'split';
export interface Preferences {
  version: 1;
  theme: 'light' | 'dark' | 'system';
  readSize: number;
  editSize: number;
  remoteImages: boolean;
  mode?: Mode;
}
export const defaultPreferences: Preferences = {
  version: 1,
  theme: 'system',
  readSize: 16,
  editSize: 14,
  remoteImages: false,
};
export interface DocumentData {
  id: string;
  name: string;
  path: string | null;
  content: string;
  savedContent: string | null;
  version: number;
  savedVersion: number;
  bom: boolean;
  eol: 'LF' | 'CRLF';
  mixed: boolean;
  large: boolean;
}
export interface SaveResult {
  kind: 'saved' | 'loaded';
  document: DocumentData;
  replacedId?: string;
}
export const isDocumentDirty = (document: DocumentData): boolean =>
  document.content !== document.savedContent;
export interface WorkspaceData {
  documents: DocumentData[];
  activeId: string | null;
}
export interface OpenResult extends WorkspaceData {
  issues: string[];
}
export interface CloseResult {
  closedId: string;
  activeId: string | null;
}
export type CloseScope = 'others' | 'all';
export interface TabsClosedResult {
  closedIds: string[];
  activeId: string | null;
}
export interface TabMenuAction {
  id: string;
  action: 'reveal' | 'closeOthers' | 'closeAll';
}
export interface Bootstrap {
  preferences: Preferences;
  workspace: WorkspaceData;
  recovery: { names: string[] } | null;
}
export type Result<T> = { ok: true; data: T } | { ok: false; error: string };
export interface DesktopAPI {
  bootstrap(): Promise<Result<Bootstrap>>;
  restoreRecovery(restore: boolean): Promise<Result<WorkspaceData>>;
  newDocument(): Promise<Result<DocumentData | null>>;
  openDocument(): Promise<Result<OpenResult>>;
  openDroppedFiles(files: File[]): Promise<Result<OpenResult>>;
  openPendingDocuments(): Promise<Result<OpenResult>>;
  activateDocument(id: string): void;
  closeDocument(id: string): Promise<Result<CloseResult | null>>;
  showTabContextMenu(id: string): Promise<Result<void>>;
  revealDocument(id: string): Promise<Result<void>>;
  closeDocuments(id: string, scope: CloseScope): Promise<Result<TabsClosedResult | null>>;
  saveDocument(id: string, saveAs?: boolean): Promise<Result<SaveResult | null>>;
  updateDocument(id: string, content: string, version: number): void;
  preferences(value: Preferences): Promise<Result<void>>;
  external(url: string): Promise<Result<void>>;
  onSaved(callback: (result: SaveResult) => void): () => void;
  onTabMenuAction(callback: (action: TabMenuAction) => void): () => void;
  onExternalOpen(callback: () => void): () => void;
}
