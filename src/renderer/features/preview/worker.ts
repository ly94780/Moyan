import { renderMarkdown, type Rendered } from './markdown';
export interface RenderRequest {
  content: string;
  documentId: string;
  remoteImages: boolean;
}
export type RenderResponse = { ok: true; rendered: Rendered } | { ok: false };
self.onmessage = (event: MessageEvent<RenderRequest>) => {
  try {
    const { content, documentId, remoteImages } = event.data;
    self.postMessage({
      ok: true,
      rendered: renderMarkdown(content, documentId, remoteImages),
    } satisfies RenderResponse);
  } catch {
    self.postMessage({ ok: false } satisfies RenderResponse);
  }
};
