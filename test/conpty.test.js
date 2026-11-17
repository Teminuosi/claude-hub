// 内嵌终端用 node-pty 自带的新版 ConPTY,不用 Windows 自带的(main.js spawnTermWith)。
//
// 背景:2026-11-17 用户反馈内嵌终端里「滚轮翻不到上面的对话」「输入行有字不显示、光标往前移就不见了」。
// 先怀疑 xterm 字宽表,换成 Unicode 11 后没好。拿同一套 xterm 配置对照实测(Electron + node-pty + 真的 claude,
// 让它从 1 数到 120,再往输入框里打「参考其他claudia，增加中文输入测试」并左移 6 格):
//
//                         系统自带 ConPTY(Win10 19045)          node-pty 自带 conpty.dll
//   120 行输出之后       只剩最后 23 行,1–97 行直接丢了,        23 行在屏上,其余由 Claude 自己保管
//                        xterm 滚动历史 = 0,滚轮无物可滚          (备用屏 + 鼠标跟踪),滚轮真的往上翻
//   输入行               「❯参考…」吞了一个空格,光标与文字错一格   「❯ 参考…」一字不差,光标位置正确
//
// 根因:Win10 自带的 ConPTY 太老,它在 Claude Code 和 xterm 中间自己重画一遍屏幕,
// 滚出屏幕的行被它吞掉、中文宽度和 Claude 算的不一样。新版 conpty.dll 没这些毛病。
//
// 钉住的几件事:
//   · spawnTermWith 要带 useConptyDll: true,新版起不来时退回系统自带的(拿不准就放行)
//   · spawnTermWith 仍然是同步的(见 main.js 里的 ⚠️ 注释)
//   · 打包时 conpty.dll / OpenConsole.exe 必须在 asarUnpack 里(在 asar 包里的 exe 起不来)
//   · 这台机器上新版 ConPTY 真的能起、中文能原样回来(装了依赖的 Windows 上才跑)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, '找不到 ' + name);
  let depth = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  throw new Error('括号不配对');
}

test('spawnTermWith:先用新版 ConPTY,起不来退回系统自带的;仍然同步', () => {
  const body = fnBody(MAIN, 'spawnTermWith');
  assert.match(body, /pty\.spawn\('powershell\.exe',[\s\S]*?useConptyDll: dll/);
  // 新版那次在 try 里,catch 里退回系统自带的那次
  assert.match(body, /try\s*\{\s*p\s*=\s*spawnPs\(true\);\s*\}\s*catch\s*\{\s*p\s*=\s*spawnPs\(false\);\s*\}/);
  assert.equal(/\bawait\b/.test(body), false, 'spawnTermWith 里不许有 await');
  assert.equal(/^\s*async\s+function\s+spawnTermWith/m.test(MAIN), false);
});

test('打包:node-pty 解出 asar(conpty.dll / OpenConsole.exe 在 asar 里起不来;平台包 electron-builder 会自动解出)', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  assert.match(yml, /asarUnpack:[\s\S]*"node_modules\/@lydell\/node-pty\/\*\*"/);
});

// 装了依赖的 Windows 上:真的用新版 ConPTY 起一个进程,中文和空格原样回来。
// 放在子进程里跑、跑完 process.exit:node-pty 在 Windows 上会留句柄,不这样整个 npm test 就挂着不退。
let hasPty = false;
try { require.resolve('@lydell/node-pty'); hasPty = true; } catch {}
test('真跑:新版 ConPTY 起得来,中文、空格原样回来', { skip: process.platform !== 'win32' || !hasPty }, () => {
  const text = '❯ 参考其他claudia，增加';
  const script = `
    const pty = require('@lydell/node-pty');
    const p = pty.spawn('powershell.exe', ['-NoProfile', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output '${text}'"],
      { name: 'xterm-256color', cols: 100, rows: 10, cwd: process.cwd(), env: process.env, useConptyDll: true });
    let out = '';
    p.onData(d => { out += d; });
    const done = () => { process.stdout.write(JSON.stringify(out)); process.exit(0); };
    p.onExit(() => setTimeout(done, 300));
    setTimeout(done, 20000);`;
  const r = require('node:child_process').spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', timeout: 40000 });
  assert.equal(r.status, 0, r.stderr);
  const plain = JSON.parse(r.stdout).replace(/\x1b\[[\d;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
  assert.ok(plain.includes(text), '收到的是:' + JSON.stringify(plain.slice(0, 300)));
});
