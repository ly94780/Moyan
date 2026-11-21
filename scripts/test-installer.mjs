import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { log } from 'node:console';

if (process.platform !== 'win32') throw new Error('安装关联验证需要 Windows。');
const require = createRequire(import.meta.url);
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows.js');
const execute = promisify(execFile);
const runtime = path.resolve('.runtime');
await mkdir(runtime, { recursive: true });
const root = await mkdtemp(path.join(runtime, 'installer-probe-'));
if (path.dirname(root) !== runtime) throw new Error('测试目录越界');
try {
  const compiler = await getMakeNsisPath(undefined);
  const output = path.join(root, 'probe.exe');
  await execute(
    compiler.path,
    [
      `/DAPP_EXECUTABLE_FILENAME=MoyanAssociationProbe-${randomUUID()}.exe`,
      `/DPROBE_OUTFILE=${output}`,
      `/DPROBE_DIRECTORY=${path.join(root, '中文 空格')}`,
      `/DPROBE_INSTALLER_INCLUDE=${path.resolve('build/installer.nsh')}`,
      path.resolve('tests/fixtures/installer-associations.nsi'),
    ],
    { env: { ...process.env, ...compiler.env }, windowsHide: true, timeout: 30000 },
  );
  await execute(output, ['/S'], { windowsHide: true, timeout: 15000 });
  log('安装关联验证通过：旧路径升级、中文空格及引号、两种扩展名、卸载所有权保护。');
} finally {
  await rm(root, { recursive: true, force: true });
}
