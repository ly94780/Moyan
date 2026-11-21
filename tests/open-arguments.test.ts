import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { filesFromCommandLine } from '../src/main/open-arguments';

describe('系统文件打开参数', () => {
  const cwd = path.resolve('.runtime/中文 目录');
  it('打包程序跳过 exe，保留中文、空格、特殊字符和多个文件', () => {
    const a = path.join(cwd, '中文 空格 #1.md');
    const b = path.join(cwd, '第二份.MARKDOWN');
    expect(filesFromCommandLine(['墨页.exe', a, b], cwd, false)).toEqual([a, b]);
  });

  it('开发模式跳过 Electron 入口参数', () => {
    expect(filesFromCommandLine(['electron.exe', 'app.md', '正文.md'], cwd, true)).toEqual([
      path.join(cwd, '正文.md'),
    ]);
  });

  it('相对路径基于发送方目录解析，忽略开关、网址和不支持的文件', () => {
    expect(
      filesFromCommandLine(
        [
          '墨页.exe',
          '--inspect=0',
          '--user-data-dir=data.md',
          '--original-process-start-time=123',
          'https://example.com/page.md',
          '文档.txt',
          '',
          '../另一目录/文件.md',
        ],
        cwd,
        false,
      ),
    ).toEqual([path.resolve(cwd, '../另一目录/文件.md')]);
  });

  it('去重规范化路径，Windows 忽略大小写，空参数没有文档', () => {
    const file = path.join(cwd, 'README.md');
    expect(filesFromCommandLine(['墨页.exe', file, './README.md'], cwd, false)).toEqual([file]);
    if (process.platform === 'win32')
      expect(filesFromCommandLine(['墨页.exe', file, file.toUpperCase()], cwd, false)).toEqual([
        file,
      ]);
    expect(filesFromCommandLine(['墨页.exe'], cwd, false)).toEqual([]);
  });
});
