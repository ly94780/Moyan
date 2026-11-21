import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

let application: ElectronApplication;
let page: Page;
let root: string;
let bootMs: number;
async function launchApplication() {
  const started = performance.now();
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  env.MOYAN_TEST_DATA = path.join(root, 'data');
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.MOYAN_EXECUTABLE;
  application = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
  page = await application.firstWindow();
  await expect(page.getByRole('button', { name: '新建文档', exact: true })).toBeEnabled();
  bootMs = performance.now() - started;
}
test.beforeEach(async () => {
  root = await mkdtemp(path.resolve('.runtime/e2e-'));
  await launchApplication();
});
test.afterEach(async () => {
  if (application && !page.isClosed()) {
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await application.close();
  }
  if (path.dirname(root) !== path.resolve('.runtime')) throw new Error('测试目录越界');
  await rm(root, { recursive: true, force: true });
});
test.beforeAll(async () => {
  await mkdir('.runtime', { recursive: true });
});

async function chooseSave(target: string) {
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
}
async function chooseOpen(target: string) {
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, target);
}

test('示例阅读、编辑、模式切换、撤销历史和实际保存', async () => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.screenshot({ path: '.runtime/welcome.png' });
  await page.getByRole('button', { name: /打开一份示例/ }).click();
  await expect(page.locator('article h1')).toHaveText('让文字，回归专注');
  await expect(page.locator('article table')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '文章目录' }).getByRole('button')).toHaveCount(
    5,
  );
  const editor = page.getByRole('textbox', { name: 'Markdown 源码编辑器' });
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n\n## 新的中文标题\n\n测试保存。');
  await expect(page.locator('article h2').last()).toHaveText('新的中文标题');
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(editor).toBeHidden();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await editor.click();
  await page.keyboard.press('Control+z');
  await expect(editor).not.toContainText('新的中文标题');
  await page.keyboard.press('Control+y');
  const target = path.join(root, '中文 保存 #1.md');
  await chooseSave(target);
  await page.keyboard.press('Control+s');
  await expect(page.locator('footer')).toContainText('已保存');
  expect(await readFile(target, 'utf8')).toContain('新的中文标题');
  await page.getByRole('button', { name: '分屏', exact: true }).click();
  await page.screenshot({ path: '.runtime/split.png' });
  await page.getByRole('button', { name: '阅读与外观设置' }).click();
  await page.getByLabel('外观主题').selectOption('dark');
  await page.getByRole('button', { name: '关闭设置' }).click();
  await page.screenshot({ path: '.runtime/dark.png' });
  expect(errors).toEqual([]);
});

test('未保存取消、外部冲突取消与另存为', async () => {
  const target = path.join(root, 'existing.md');
  await writeFile(target, '\ufeff# 原文\r\n\r\n正文\r\n');
  await chooseOpen(target);
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await expect(page.locator('article h1')).toHaveText('原文');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Markdown 源码编辑器' });
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('内部修改');
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
  });
  await page.keyboard.press('Control+n');
  await expect(page.getByRole('button', { name: '新建', exact: true })).toBeEnabled();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('tab', { name: 'existing.md', exact: true }).click();
  await expect(editor).toContainText('内部修改');
  await application.evaluate(
    ({ BrowserWindow, dialog }) =>
      new Promise<void>((resolve) => {
        dialog.showMessageBox = async () => {
          resolve();
          return { response: 2, checkboxChecked: false };
        };
        BrowserWindow.getAllWindows()[0].close();
      }),
  );
  await expect(editor).toBeVisible();
  await writeFile(target, '# 外部修改\n');
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await expect(editor).toContainText('内部修改');
  expect(await readFile(target, 'utf8')).toBe('# 外部修改\n');
  const other = path.join(root, '另存.md');
  await chooseSave(other);
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('footer')).toContainText('已保存');
  const saved = await readFile(other, 'utf8');
  expect(saved.startsWith('\ufeff')).toBe(true);
  expect(saved).toContain('\r\n');
  expect(saved).toContain('内部修改');
  expect(await readFile(target, 'utf8')).toBe('# 外部修改\n');
});

test('查找替换、保存失败、恢复草稿与进程隔离', async () => {
  await page.getByRole('button', { name: '新建文档', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Markdown 源码编辑器' });
  await editor.fill('# 测试\n\nhello hello');
  await page.keyboard.press('Control+h');
  const search = page.locator('.cm-search');
  await expect(search).toBeVisible();
  await search.locator('input[name="search"]').fill('hello');
  await search.locator('input[name="replace"]').fill('世界');
  await search.getByRole('button', { name: '全部替换', exact: true }).click();
  await expect(editor).toContainText('世界 世界');
  await editor.click();
  await page.keyboard.press('Control+z');
  await expect(editor).toContainText('hello hello');
  await chooseSave(path.join(root, 'missing', 'fail.md'));
  await page.keyboard.press('Control+s');
  await expect(page.locator('footer')).toContainText('保存失败');
  await expect(editor).toContainText('hello hello');
  await expect
    .poll(
      async () => {
        try {
          return JSON.parse(await readFile(path.join(root, 'data/recovery.json'), 'utf8'))
            .records[0].document.content;
        } catch {
          return '';
        }
      },
      { timeout: 7000 },
    )
    .toContain('hello hello');
  expect(
    await page.evaluate(() => ({
      node: typeof (window as unknown as Record<string, unknown>).require,
      process: typeof (window as unknown as Record<string, unknown>).process,
    })),
  ).toEqual({ node: 'undefined', process: 'undefined' });
  await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await launchApplication();
  await expect(page.getByRole('dialog', { name: '草稿恢复' })).toBeVisible();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown 源码编辑器' })).toContainText(
    'hello hello',
  );
  await expect(page.locator('footer')).toContainText('未保存');
});

test('图片加载、锚点跳转、最小窗口与文档性能记录', async () => {
  test.setTimeout(90_000);
  await page.bringToFront();
  await page.context().setOffline(true);
  const screenshot = await readFile('resources/moyan.png');
  await writeFile(path.join(root, '图 #1.png'), screenshot);
  const imageDocument = path.join(root, '图片.md');
  await writeFile(
    imageDocument,
    '# 中文标题\n\n![本地图](图%20%231.png)\n\n![拒绝的图片](../outside.png)\n\n[跳转](#中文标题)',
  );
  await chooseOpen(imageDocument);
  await page.getByRole('button', { name: '打开', exact: true }).click();
  const image = page.getByRole('img', { name: '本地图', exact: true });
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(256);
  await expect(page.locator('article')).toContainText('图片无法加载');
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(900, 600),
  );
  await page.screenshot({ path: '.runtime/compact.png' });
  const stats: Record<string, unknown> = { startupMs: Math.round(bootMs), offline: true };
  for (const lines of [2000, 20000]) {
    const text =
      '# 性能样例\n\n' +
      Array.from(
        { length: lines },
        (_, i) => `第${i}行，记录想法与文字。Markdown editor sample.\n`,
      ).join('');
    const target = path.join(root, `perf-${lines}.md`);
    await writeFile(target, text);
    const elapsed: number[] = [];
    const interactive: number[] = [];
    for (let iteration = 0; iteration < 3; iteration++) {
      await chooseOpen(target);
      const started = performance.now();
      await page.getByRole('button', { name: '打开', exact: true }).click();
      await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
      interactive.push(Math.round(performance.now() - started));
      await expect(page.locator('article h1')).toHaveText('性能样例', { timeout: 20000 });
      await expect
        .poll(
          () =>
            page
              .locator('article')
              .evaluate((node, ending) => node.textContent?.includes(ending), `第${lines - 1}行`),
          { timeout: 20_000 },
        )
        .toBe(true);
      elapsed.push(Math.round(performance.now() - started));
      console.log(JSON.stringify({ lines, iteration, ms: elapsed.at(-1) }));
    }
    stats[String(lines)] = {
      bytes: Buffer.byteLength(text),
      milliseconds: elapsed,
      interactiveMs: interactive,
      medianMs: [...elapsed].sort((a, b) => a - b)[1],
      worstMs: Math.max(...elapsed),
    };
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Markdown 源码编辑器' });
    await editor.click();
    await page.keyboard.press('Control+End');
    const started = performance.now();
    await page.keyboard.insertText('中文输入检查');
    await expect(editor).toContainText('中文输入检查');
    stats[`input-${lines}`] = Math.round(performance.now() - started);
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    // Return to read mode so the next file is measured through its completed preview.
    await page.getByRole('button', { name: '阅读', exact: true }).click();
  }
  await writeFile('.runtime/performance.json', JSON.stringify(stats, null, 2));
});
