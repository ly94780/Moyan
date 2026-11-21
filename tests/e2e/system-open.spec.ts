import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DocumentStore } from '../../src/main/store';

let application: ElectronApplication | undefined;
let page: Page;
let root: string;
let env: Record<string, string>;
let appExecutable: string;
const appEntry = path.resolve('.');
const executablePath = process.env.MOYAN_EXECUTABLE;
const appArguments = (files: string[]) => [...(executablePath ? [] : [appEntry]), ...files];

async function launch(files: string[] = []) {
  application = await electron.launch({
    executablePath,
    args: appArguments(files),
    cwd: root,
    env,
  });
  page = await application.firstWindow();
  await expect(page.locator('footer')).toContainText('墨页');
  appExecutable = await application.evaluate(() => process.execPath);
}

async function sendFiles(files: string[], cwd = root) {
  // Start a real second process with the same isolated userData. No app-event mocking.
  const child = spawn(appExecutable, appArguments(files), {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 15000,
  });
  let error = '';
  child.stderr.on('data', (value: Buffer) => (error += value.toString()));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  expect(code, error.slice(-2000)).toBe(0);
}

async function expectSingleWindow() {
  expect(
    await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
  ).toBe(1);
  expect(application!.process().exitCode).toBeNull();
}

test.beforeEach(async () => {
  application = undefined;
  await mkdir('.runtime', { recursive: true });
  root = await mkdtemp(path.resolve('.runtime/system-open-'));
  env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.MOYAN_TEST_DATA = path.join(root, 'data');
});

test.afterEach(async () => {
  if (application && application.process().exitCode === null) {
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await application.close();
  }
  if (path.dirname(root) !== path.resolve('.runtime')) throw new Error('测试目录越界');
  await rm(root, { recursive: true, force: true });
});

test('系统打开：首次启动读取中文空格路径及多个 Markdown 文件', async () => {
  const a = path.join(root, '中文 空格 #1.md');
  const b = path.join(root, '第二份.MARKDOWN');
  await writeFile(a, '# 中文文件\n\n正文甲');
  await writeFile(b, '# 第二份\n\n正文乙');
  await launch([path.basename(a), b]);
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('article h1')).toHaveText('第二份');
  await page.getByRole('tab', { name: path.basename(a), exact: true }).click();
  await expect(page.locator('article')).toContainText('正文甲');
  await expect(page.locator('footer')).toContainText('已保存');
  await expectSingleWindow();
});

test('系统打开：已启动时复用进程、恢复最小化，重复打开保留修改和撤销', async () => {
  const a = path.join(root, '原文.md');
  const b = path.join(root, '新文档.markdown');
  await writeFile(a, '# 原文');
  await writeFile(b, '# 新文档');
  await launch([a]);
  await expect(page.getByRole('tab')).toHaveCount(1);
  const pid = await application!.evaluate(() => process.pid);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Markdown 源码编辑器' });
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('，保留修改');
  await expect(page.locator('footer')).toContainText('未保存');
  await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await sendFiles([b]);
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab', { name: path.basename(b), exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect
    .poll(() =>
      application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
    )
    .toBe(false);
  await sendFiles([a.toUpperCase()]);
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(editor).toContainText('保留修改');
  await expect(page.locator('footer')).toContainText('未保存');
  await editor.click();
  await page.keyboard.press('Control+z');
  await expect(editor).not.toContainText('保留修改');
  await expect(page.locator('footer')).toContainText('已保存');
  expect(await readFile(a, 'utf8')).toBe('# 原文');
  expect(await application!.evaluate(() => process.pid)).toBe(pid);
  await expectSingleWindow();
});

test('系统打开：连续第二进程按各自工作目录转交文件，无文件仅激活窗口', async () => {
  await launch();
  const directories = ['目录甲', '目录乙'];
  for (const directory of directories) {
    await mkdir(path.join(root, directory));
    await writeFile(path.join(root, directory, '同名.md'), `# ${directory}`);
  }
  await Promise.all(
    directories.map((directory) => sendFiles(['同名.md'], path.join(root, directory))),
  );
  await expect(page.getByRole('tab')).toHaveCount(2);
  await sendFiles([]);
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('tab').first().click();
  const first = await page.locator('article h1').textContent();
  await page.getByRole('tab').last().click();
  await expect(page.locator('article h1')).not.toHaveText(first!);
  await expectSingleWindow();
});

test('系统打开：等待草稿恢复，首启与第二进程请求均保留且不覆盖恢复内容', async () => {
  const a = path.join(root, '待恢复.md');
  const b = path.join(root, '外部打开.md');
  await writeFile(a, '# 磁盘原文');
  await writeFile(b, '# 外部打开');
  const store = new DocumentStore(env.MOYAN_TEST_DATA);
  await store.initialize();
  const draft = await store.load(a);
  store.update(draft.id, '# 草稿修改', 1);
  await store.flushRecovery();
  await launch([a]);
  await expect(page.getByRole('button', { name: '恢复草稿', exact: true })).toBeVisible();
  await sendFiles([b]);
  await expect(page.getByRole('tab')).toHaveCount(0);
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('tab', { name: path.basename(a), exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown 源码编辑器' })).toContainText(
    '草稿修改',
  );
  await expect(page.locator('footer')).toContainText('未保存');
  expect(await readFile(a, 'utf8')).toBe('# 磁盘原文');
  await expectSingleWindow();
});

test('系统打开：设置期间排队，失败路径提示并保留当前内容，后续请求仍可打开', async () => {
  const a = path.join(root, '原文.md');
  const b = path.join(root, '之后打开.md');
  const missing = path.join(root, '不存在.md');
  await writeFile(a, '# 原文');
  await writeFile(b, '# 之后打开');
  await launch([a]);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: '阅读与外观设置' }).click();
  await sendFiles([missing, b]);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: '关闭设置' }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('status').filter({ hasText: '不存在.md' })).toContainText('已不存在');
  await sendFiles([a]);
  await expect(page.getByRole('tab', { name: path.basename(a), exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('article h1')).toHaveText('原文');
  expect(await readFile(a, 'utf8')).toBe('# 原文');
  await expectSingleWindow();
});
