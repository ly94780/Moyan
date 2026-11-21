import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import { toString } from 'mdast-util-to-string';
import type { Root, RootContent } from 'mdast';

export interface Heading {
  id: string;
  text: string;
  depth: number;
}
export interface Rendered {
  html: string;
  headings: Heading[];
  words: number;
}
function countWords(node: Root | RootContent): number {
  if (
    ['root', 'blockquote', 'list', 'listItem', 'table', 'tableRow'].includes(node.type) &&
    'children' in node
  ) {
    return node.children.reduce((sum, child) => sum + countWords(child as RootContent), 0);
  }
  return (toString(node).match(/\p{Script=Han}|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu) ?? [])
    .length;
}
export function imageSource(url: string, documentId: string, remote: boolean): string | null {
  if (/^https?:\/\//i.test(url)) return remote ? url : null;
  if (!url || /^[a-z][a-z\d+.-]*:|^[/\\]|\0/i.test(url)) return null;
  try {
    return `moyan-image://${documentId}/${encodeURIComponent(decodeURIComponent(url))}`;
  } catch {
    return null;
  }
}

export function renderMarkdown(content: string, documentId = '', remote = false): Rendered {
  const headings: Heading[] = [];
  let words = 0;
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(() => (tree: Root) => {
      const slugs = new Map<string, number>();
      visit(tree, 'heading', (node) => {
        const text = toString(node);
        const slug = `h-${
          text
            .toLowerCase()
            .replace(/[^\p{L}\p{N}_-]+/gu, '-')
            .slice(0, 100) || 'section'
        }`;
        const count = slugs.get(slug) ?? 0;
        slugs.set(slug, count + 1);
        const id = count ? `${slug}-${count}` : slug;
        headings.push({ id, text, depth: node.depth });
        node.data = { ...node.data, hProperties: { id } };
      });
      visit(tree, 'html', (node, index, parent) => {
        if (parent && index !== undefined)
          parent.children[index] = { type: 'text', value: node.value };
      });
      visit(tree, 'image', (node, index, parent) => {
        const source = imageSource(node.url, documentId, remote);
        if (source) node.url = source;
        else if (parent && index !== undefined)
          parent.children[index] = { type: 'text', value: `[图片未加载：${node.alt || '图片'}]` };
      });
      words = countWords(tree);
    })
    .use(remarkRehype)
    .use(rehypeSanitize, {
      ...defaultSchema,
      clobberPrefix: '',
      protocols: { ...defaultSchema.protocols, src: ['http', 'https', 'moyan-image'] },
    })
    .use(rehypeHighlight, { detect: false, ignoreMissing: true })
    .use(rehypeStringify);
  return { html: String(processor.processSync(content)), headings, words };
}
