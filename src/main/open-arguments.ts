import path from 'node:path';

export const isMarkdownPath = (value: string): boolean => /\.(md|markdown)$/i.test(value);

export function filesFromCommandLine(
  argv: readonly string[],
  workingDirectory: string,
  defaultApp: boolean,
): string[] {
  // Electron's development entry is an extra argument; Windows already unquotes paths.
  const files = argv.slice(defaultApp ? 2 : 1).flatMap((value) => {
    if (!value || value.startsWith('-') || !isMarkdownPath(value) || value.includes('://'))
      return [];
    return [path.resolve(workingDirectory, value)];
  });
  const seen = new Set<string>();
  return files.filter((value) => {
    const key = process.platform === 'win32' ? value.toLowerCase() : value;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
