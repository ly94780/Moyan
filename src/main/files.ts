import { createHash, randomUUID } from 'node:crypto';
import { open, rename, unlink, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const digest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export function decodeMarkdown(bytes: Uint8Array) {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  const lf = (raw.match(/(?<!\r)\n/g) ?? []).length;
  if (raw.includes('\u0000') || /\r(?!\n)/.test(raw)) {
    throw new Error('暂不支持此文件的编码或换行格式，请先转换为 UTF-8。');
  }
  return {
    content: raw.replace(/\r\n/g, '\n'),
    bom,
    eol: crlf > lf ? ('CRLF' as const) : ('LF' as const),
    mixed: crlf > 0 && lf > 0,
  };
}

export function encodeMarkdown(content: string, bom: boolean, eol: 'LF' | 'CRLF'): Buffer {
  return Buffer.from(
    (bom ? '\ufeff' : '') +
      content.replace(/\r\n/g, '\n').replace(/\n/g, eol === 'CRLF' ? '\r\n' : '\n'),
    'utf8',
  );
}

// A failed replacement must leave the original in place. Never unlink the destination first.
export async function atomicWrite(target: string, bytes: Uint8Array): Promise<void> {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, target);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

export async function fileDigest(target: string): Promise<string | null> {
  try {
    return digest(await readFile(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function resolveImage(documentPath: string, relativePath: string): Promise<string> {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0'))
    throw new Error('无效图片路径');
  const root = await realpath(path.dirname(documentPath));
  const target = await realpath(path.resolve(root, relativePath));
  const relative = path.relative(root, target);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    !/\.(png|jpe?g|gif|webp)$/i.test(target)
  ) {
    throw new Error('图片超出文档目录或格式不受支持');
  }
  return target;
}
