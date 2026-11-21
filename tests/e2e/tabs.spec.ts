import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
  type Locator,
} from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

let application: ElectronApplication;
let page: Page;
let root: string;
async function launch() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.MOYAN_TEST_DATA = path.join(root, 'data');
  const executablePath = process.env.MOYAN_EXECUTABLE;
  application = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
  page = await application.firstWindow();
  await expect(page.getByRole('button', { name: '新建文档', exact: true })).toBeEnabled();
}
test.beforeEach(async () => {
  await mkdir('.runtime', { recursive: true });
  root = await mkdtemp(path.resolve('.runtime/tabs-'));
  await launch();
  await messageResponse(2);
});
test.afterEach(async () => {
  if (application && !page.isClosed()) {
    await messageResponse(1);
    await application.close();
  }
  if (path.dirname(root) !== path.resolve('.runtime')) throw new Error('测试目录越界');
  await rm(root, { recursive: true, force: true });
});
async function messageResponse(response: number) {
  await application.evaluate(({ dialog }, value) => {
    process.env.MOYAN_PROMPTS = '0';
    dialog.showMessageBox = async () => {
      process.env.MOYAN_PROMPTS = String(Number(process.env.MOYAN_PROMPTS) + 1);
      return { response: value, checkboxChecked: false };
    };
  }, response);
}
async function promptCount() {
  return application.evaluate(() => Number(process.env.MOYAN_PROMPTS ?? 0));
}
async function openFiles(files: string[]) {
  await application.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
  }, files);
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
}
const editor = () => page.getByRole('textbox', { name: 'Markdown 源码编辑器' });
async function edit() {
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await editor().click();
}
async function dropFiles(files: string[]) {
  const session = await page.context().newCDPSession(page);
  const data = { items: [], files, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const)
    await session.send('Input.dispatchDragEvent', { type, x: 450, y: 320, data });
  await session.detach();
}

type MenuTestState = typeof globalThis & {
  __moyanMenu?: Electron.Menu;
  __moyanMenuCount?: number;
  __moyanRevealedPath?: string;
};
async function stubNativeMenu() {
  await application.evaluate(({ Menu, shell }) => {
    Menu.prototype.popup = function (this: Electron.Menu) {
      const state = globalThis as MenuTestState;
      state.__moyanMenu = this;
      state.__moyanMenuCount = (state.__moyanMenuCount ?? 0) + 1;
    };
    shell.showItemInFolder = (target) => {
      (globalThis as MenuTestState).__moyanRevealedPath = target;
    };
  });
}
async function tabMenu(tab: Locator, keyboard = false) {
  const before = await application.evaluate(
    () => (globalThis as MenuTestState).__moyanMenuCount ?? 0,
  );
  if (keyboard) {
    await tab.focus();
    await page.keyboard.press('Shift+F10');
  } else await tab.click({ button: 'right' });
  await expect
    .poll(() => application.evaluate(() => (globalThis as MenuTestState).__moyanMenuCount ?? 0))
    .toBe(before + 1);
  return application.evaluate(() =>
    (globalThis as MenuTestState)
      .__moyanMenu!.items.filter((item) => item.type !== 'separator')
      .map((item) => ({ id: item.id, label: item.label, enabled: item.enabled })),
  );
}
async function chooseTabMenu(id: string) {
  await application.evaluate((_electron, target) => {
    const item = (globalThis as MenuTestState).__moyanMenu?.getMenuItemById(target);
    if (!item?.enabled) throw new Error('菜单项不存在或已禁用');
    item.click();
  }, id);
}

test('多选打开、标签独立内容与保存、切换后保留撤销和显示模式', async () => {
  const a = path.join(root, '甲.md');
  const b = path.join(root, '乙.markdown');
  await writeFile(a, '# 甲\n\n原文甲');
  await writeFile(b, '# 乙\n\n原文乙');
  await openFiles([a, b]);
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab', { name: '乙.markdown', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: '甲.md', exact: true }).click();
  await edit();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('，甲的修改');
  await expect(page.locator('footer')).toContainText('未保存');
  await page.getByRole('tab', { name: '乙.markdown', exact: true }).click();
  await expect(page.locator('footer')).toContainText('已保存');
  await edit();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('，乙的修改');
  await page.keyboard.press('Control+s');
  await expect(page.locator('footer')).toContainText('已保存');
  expect(await readFile(b, 'utf8')).toBe('# 乙\n\n原文乙，乙的修改');
  expect(await readFile(a, 'utf8')).toBe('# 甲\n\n原文甲');
  await page.getByRole('tab', { name: '甲.md', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(editor()).toContainText('甲的修改');
  await editor().click();
  await page.keyboard.press('Control+z');
  await expect(editor()).not.toContainText('甲的修改');
  await expect(page.locator('footer')).toContainText('已保存');
  await page.keyboard.press('Control+y');
  await expect(page.locator('footer')).toContainText('未保存');
  await page.keyboard.press('Control+s');
  await expect(page.locator('footer')).toContainText('已保存');
  expect(await readFile(a, 'utf8')).toContain('甲的修改');
  await openFiles([a]);
  await expect(page.getByRole('tab')).toHaveCount(2);
  expect(await promptCount()).toBe(0);
  await page.screenshot({ path: '.runtime/multi-tabs.png' });
});

test('无实际变化、撤销与手动还原后关闭标签及退出均不询问', async () => {
  const target = path.join(root, '不应询问.md');
  await writeFile(target, '\ufeff# 原文\r\n\r\n正文\r\n');
  await openFiles([target]);
  await edit();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+f');
  await page.keyboard.press('Escape');
  await expect(page.locator('footer')).toContainText('已保存');
  await page.keyboard.press('Control+w');
  await expect(page.getByRole('tab')).toHaveCount(0);
  expect(await promptCount()).toBe(0);
  await openFiles([target]);
  await edit();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('改变');
  await expect(page.locator('footer')).toContainText('未保存');
  await page.keyboard.press('Control+z');
  await expect(page.locator('footer')).toContainText('已保存');
  await page.keyboard.press('Control+w');
  await expect(page.getByRole('tab')).toHaveCount(0);
  expect(await promptCount()).toBe(0);
  await openFiles([target]);
  await edit();
  await editor().fill('# 原文\n\n正文\n额外内容');
  await expect(page.locator('footer')).toContainText('未保存');
  await editor().fill('# 原文\n\n正文\n');
  await expect(page.locator('footer')).toContainText('已保存');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: '新建', exact: true })).toBeEnabled();
  await expect(page.locator('footer')).not.toContainText('未保存');
  await page.keyboard.press('Control+w');
  await expect(page.getByRole('tab')).toHaveCount(1);
  expect(await promptCount()).toBe(0);
  const child = application.process();
  await application
    .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    .catch(() => undefined);
  await expect.poll(() => child.exitCode).not.toBeNull();
  expect((await readFile(target)).equals(Buffer.from('\ufeff# 原文\r\n\r\n正文\r\n'))).toBe(true);
});

test('关闭后台脏标签只处理该文件；取消退出保留全部标签', async () => {
  const a = path.join(root, '后台.md');
  const b = path.join(root, '当前.md');
  await writeFile(a, 'A');
  await writeFile(b, 'B');
  await openFiles([a, b]);
  await page.getByRole('tab', { name: '后台.md', exact: true }).click();
  await edit();
  await editor().fill('A 修改');
  await page.getByRole('tab', { name: '当前.md', exact: true }).click();
  await page.getByRole('button', { name: '关闭 后台.md', exact: true }).click();
  await expect(page.getByRole('button', { name: '关闭 后台.md', exact: true })).toBeEnabled();
  await expect(page.getByRole('tab')).toHaveCount(2);
  expect(await promptCount()).toBe(1);
  await messageResponse(0);
  await page.getByRole('button', { name: '关闭 后台.md', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  expect(await readFile(a, 'utf8')).toBe('A 修改');
  expect(await readFile(b, 'utf8')).toBe('B');
  await edit();
  await editor().fill('B 修改');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
  await editor().fill('新文档修改');
  await application.evaluate(({ BrowserWindow, dialog }) => {
    let calls = 0;
    dialog.showMessageBox = async () => ({
      response: ++calls === 1 ? 1 : 2,
      checkboxChecked: false,
    });
    BrowserWindow.getAllWindows()[0].close();
  });
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('tab', { name: '当前.md', exact: true }).click();
  await expect(editor()).toContainText('B 修改');
  expect(await readFile(b, 'utf8')).toBe('B');
});

test('真实文件拖入、混合格式、重复与同名不同目录，以及在编辑区拖入', async () => {
  await mkdir(path.join(root, 'one'));
  await mkdir(path.join(root, 'two'));
  const a = path.join(root, 'one', '同名.md');
  const b = path.join(root, 'two', '同名.md');
  const bad = path.join(root, '忽略.txt');
  await writeFile(a, '# 文件一');
  await writeFile(b, '# 文件二');
  await writeFile(bad, '不要作为 Markdown 打开');
  await dropFiles([a, b, bad]);
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('article h1')).toHaveText('文件二');
  await expect(page.getByRole('status').filter({ hasText: '仅支持' })).toBeVisible();
  const tabs = page.getByRole('tab', { name: '同名.md', exact: true });
  expect(await tabs.nth(0).getAttribute('title')).toContain('one');
  expect(await tabs.nth(1).getAttribute('title')).toContain('two');
  await edit();
  await editor().fill('# 保留编辑');
  await dropFiles([b]);
  await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(editor()).toContainText('保留编辑');
  const c = path.join(root, '拖进编辑区.MD');
  await writeFile(c, '# 文件三');
  await dropFiles([c]);
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(editor()).toContainText('文件三');
  await tabs.nth(1).click();
  await expect(editor()).toContainText('保留编辑');
  expect(await promptCount()).toBe(0);
  await page.screenshot({ path: '.runtime/drag-tabs.png' });
});

test('多个未保存文件重启后一起恢复，保存一个仍保留其他草稿', async () => {
  await page.getByRole('button', { name: '新建文档', exact: true }).click();
  await editor().fill('草稿甲');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
  await editor().fill('草稿乙');
  await expect
    .poll(
      async () => {
        try {
          return JSON.parse(await readFile(path.join(root, 'data/recovery.json'), 'utf8')).records
            .length;
        } catch {
          return 0;
        }
      },
      { timeout: 7000 },
    )
    .toBe(2);
  await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await launch();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(editor()).toContainText('草稿乙');
  await page.getByRole('tab').first().click();
  await expect(editor()).toContainText('草稿甲');
  const target = path.join(root, '保存甲.md');
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
  await page.keyboard.press('Control+s');
  await expect(page.locator('footer')).toContainText('已保存');
  const remaining = JSON.parse(
    await readFile(path.join(root, 'data/recovery.json'), 'utf8'),
  ).records;
  expect(remaining).toHaveLength(1);
  expect(remaining[0].document.content).toBe('草稿乙');
  await page.getByRole('tab').last().click();
  await expect(page.locator('footer')).toContainText('未保存');
});

test('重新载入外部内容不重复标签，另存为不能覆盖另一已打开文件', async () => {
  const a = path.join(root, '刷新.md');
  const b = path.join(root, '另一份.md');
  await writeFile(a, '原文 A');
  await writeFile(b, '原文 B');
  await openFiles([a, b]);
  await page.getByRole('tab', { name: '刷新.md', exact: true }).click();
  await edit();
  await editor().fill('内部改动');
  await writeFile(a, '外部新内容');
  await messageResponse(2);
  await page.keyboard.press('Control+s');
  await expect(editor()).toContainText('外部新内容');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('footer')).toContainText('已保存');
  await page.getByRole('tab', { name: '另一份.md', exact: true }).click();
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, a);
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '另一个标签' })).toBeVisible();
  expect(await readFile(a, 'utf8')).toBe('外部新内容');
  expect(await readFile(b, 'utf8')).toBe('原文 B');
  await expect(page.getByRole('tab')).toHaveCount(2);
});

test('切换标签保留光标、编辑器滚动位置，并可用键盘切换', async () => {
  const a = path.join(root, '长文.md');
  const b = path.join(root, '短文.md');
  await writeFile(a, Array.from({ length: 400 }, (_, i) => `第 ${i + 1} 行内容`).join('\n'));
  await writeFile(b, '短文');
  await openFiles([a, b]);
  await page.getByRole('tab', { name: '长文.md', exact: true }).click();
  await edit();
  await page.keyboard.press('Control+End');
  await expect(page.locator('footer')).toContainText('行 400');
  await expect
    .poll(() => page.locator('.cm-scroller').evaluate((node) => node.scrollTop))
    .toBeGreaterThan(300);
  await page.keyboard.press('Control+Tab');
  await expect(page.getByRole('tab', { name: '短文.md', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Control+Shift+Tab');
  await expect(page.getByRole('tab', { name: '长文.md', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('footer')).toContainText('行 400');
  await expect
    .poll(() => page.locator('.cm-scroller').evaluate((node) => node.scrollTop))
    .toBeGreaterThan(300);
  await page.keyboard.insertText('继续写作');
  await expect(editor()).toContainText('继续写作');
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(page.locator('article')).toContainText('继续写作');
  const preview = page.locator('article').locator('..');
  await preview.evaluate((node) => {
    node.scrollTop = 600;
  });
  await expect.poll(() => preview.evaluate((node) => node.scrollTop)).toBeGreaterThan(200);
  await page.getByRole('tab', { name: '短文.md', exact: true }).click();
  await page.getByRole('tab', { name: '长文.md', exact: true }).click();
  await expect.poll(() => preview.evaluate((node) => node.scrollTop)).toBeGreaterThan(200);
  expect(await promptCount()).toBe(0);
});

test('标签右键菜单包含三个操作，未命名与单标签正确禁用，并支持键盘菜单', async () => {
  await stubNativeMenu();
  await page.getByRole('button', { name: '新建文档', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  expect(await tabMenu(page.getByRole('tab').first())).toEqual([
    { id: 'tab-reveal', label: '打开所在文件夹', enabled: false },
    { id: 'tab-close-others', label: '关闭其他标签', enabled: false },
    { id: 'tab-close-all', label: '关闭所有标签', enabled: true },
  ]);
  const a = path.join(root, '后台文件.md');
  const b = path.join(root, '当前文件.md');
  await writeFile(a, 'A');
  await writeFile(b, 'B');
  await openFiles([a, b]);
  await tabMenu(page.getByRole('tab', { name: '后台文件.md', exact: true }));
  await expect(page.getByRole('tab', { name: '当前文件.md', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await chooseTabMenu('tab-reveal');
  await expect
    .poll(() => application.evaluate(() => (globalThis as MenuTestState).__moyanRevealedPath))
    .toBe(a);
  const keyboardItems = await tabMenu(
    page.getByRole('tab', { name: '后台文件.md', exact: true }),
    true,
  );
  expect(keyboardItems.every((item) => item.enabled)).toBe(true);
  expect(await promptCount()).toBe(0);
});

test('标签右键关闭其他保留点中的后台标签，关闭所有后回到欢迎页', async () => {
  await stubNativeMenu();
  const files = ['甲.md', '乙.md', '丙.md'].map((name) => path.join(root, name));
  for (const target of files) await writeFile(target, path.basename(target));
  await openFiles(files);
  await tabMenu(page.getByRole('tab', { name: '乙.md', exact: true }));
  await chooseTabMenu('tab-close-others');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: '乙.md', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(await promptCount()).toBe(0);
  const items = await tabMenu(page.getByRole('tab').first());
  expect(items.find((item) => item.id === 'tab-close-others')?.enabled).toBe(false);
  await chooseTabMenu('tab-close-all');
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新建文档', exact: true })).toBeVisible();
  expect(await promptCount()).toBe(0);
});

test('标签右键批量关闭中途取消保留所有正文和恢复草稿', async () => {
  await stubNativeMenu();
  const a = path.join(root, '甲.md');
  const b = path.join(root, '乙.md');
  await writeFile(a, '原文甲');
  await writeFile(b, '原文乙');
  await openFiles([a, b]);
  await page.getByRole('tab', { name: '甲.md', exact: true }).click();
  await edit();
  await editor().fill('修改甲');
  await page.getByRole('tab', { name: '乙.md', exact: true }).click();
  await edit();
  await editor().fill('修改乙');
  await application.evaluate(({ dialog }) => {
    process.env.MOYAN_PROMPTS = '0';
    dialog.showMessageBox = async () => {
      const count = Number(process.env.MOYAN_PROMPTS) + 1;
      process.env.MOYAN_PROMPTS = String(count);
      return { response: count === 1 ? 1 : 2, checkboxChecked: false };
    };
  });
  await tabMenu(page.getByRole('tab').first());
  await chooseTabMenu('tab-close-all');
  await expect.poll(promptCount).toBe(2);
  await expect(page.getByRole('button', { name: '新建', exact: true })).toBeEnabled();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('tab', { name: '甲.md', exact: true }).click();
  await expect(editor()).toHaveText('修改甲');
  await page.getByRole('tab', { name: '乙.md', exact: true }).click();
  await expect(editor()).toHaveText('修改乙');
  expect(await readFile(a, 'utf8')).toBe('原文甲');
  expect(await readFile(b, 'utf8')).toBe('原文乙');
  await expect
    .poll(
      async () => {
        try {
          return JSON.parse(await readFile(path.join(root, 'data/recovery.json'), 'utf8')).records
            .length;
        } catch {
          return 0;
        }
      },
      { timeout: 7000 },
    )
    .toBe(2);
});

test('标签右键批量关闭保存失败或另存为取消时不移除目标标签', async () => {
  await stubNativeMenu();
  await page.getByRole('button', { name: '新建文档', exact: true }).click();
  await editor().fill('草稿甲');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
  await editor().fill('草稿乙');
  await messageResponse(0);
  const good = path.join(root, '已保存甲.md');
  const bad = path.join(root, '不存在', '乙.md');
  await application.evaluate(
    ({ dialog }, paths) => {
      let count = 0;
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: count++ === 0 ? paths.good : paths.bad,
      });
    },
    { good, bad },
  );
  await tabMenu(page.getByRole('tab').first());
  await chooseTabMenu('tab-close-all');
  await expect(page.getByRole('status').filter({ hasText: '文件或目录已不存在' })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(2);
  expect(await readFile(good, 'utf8')).toBe('草稿甲');
  await expect(editor()).toHaveText('草稿乙');
  await messageResponse(0);
  await application.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
  });
  await tabMenu(page.getByRole('tab').first());
  await chooseTabMenu('tab-close-all');
  await expect.poll(promptCount).toBe(1);
  await expect(page.getByRole('button', { name: '新建', exact: true })).toBeEnabled();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(editor()).toHaveText('草稿乙');
});
