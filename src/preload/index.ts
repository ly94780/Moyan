import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopAPI } from '../shared/types';

const api: DesktopAPI = {
  bootstrap: () => ipcRenderer.invoke('document:bootstrap'),
  restoreRecovery: (restore) => ipcRenderer.invoke('document:recovery', restore),
  newDocument: () => ipcRenderer.invoke('document:new'),
  openDocument: () => ipcRenderer.invoke('document:open'),
  openPendingDocuments: () => ipcRenderer.invoke('document:open-pending'),
  openDroppedFiles: (files) => {
    const paths = files.flatMap((file) => {
      try {
        const value = webUtils.getPathForFile(file);
        return value ? [value] : [];
      } catch {
        return [];
      }
    });
    return ipcRenderer.invoke('document:drop', paths);
  },
  activateDocument: (id) => ipcRenderer.send('document:activate', id),
  closeDocument: (id) => ipcRenderer.invoke('document:close', id),
  showTabContextMenu: (id) => ipcRenderer.invoke('document:menu', id),
  revealDocument: (id) => ipcRenderer.invoke('document:reveal', id),
  closeDocuments: (id, scope) => ipcRenderer.invoke('document:close-group', id, scope),
  saveDocument: (id, saveAs = false) => ipcRenderer.invoke('document:save', id, saveAs),
  updateDocument: (id, content, version) =>
    ipcRenderer.send('document:update', id, content, version),
  preferences: (value) => ipcRenderer.invoke('preferences:write', value),
  external: (url) => ipcRenderer.invoke('link:external', url),
  onSaved: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, result: Parameters<typeof callback>[0]) =>
      callback(result);
    ipcRenderer.on('document:saved', listener);
    return () => ipcRenderer.removeListener('document:saved', listener);
  },
  onTabMenuAction: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, action: Parameters<typeof callback>[0]) =>
      callback(action);
    ipcRenderer.on('document:menu-action', listener);
    return () => ipcRenderer.removeListener('document:menu-action', listener);
  },
  onExternalOpen: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('document:external-open', listener);
    return () => ipcRenderer.removeListener('document:external-open', listener);
  },
};
contextBridge.exposeInMainWorld('desktop', Object.freeze(api));
