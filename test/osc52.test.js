// 终端里的 OSC 52(程序让终端写剪贴板)—— index.html 里 // <osc52> 那段。
//
// 背景:2026-11-17 内嵌终端换成新版 ConPTY(见 test/conpty.test.js)之后,Claude Code 自动进入全屏模式、接管鼠标。
// 这时拖选文字是 Claude 自己做的,选完它发 ESC]52;c;<base64> 让终端写剪贴板(实测会提示 copied N chars)。
// xterm.js 默认不认 OSC 52 —— 不接的话,用户拖选完以为复制了,剪贴板里其实还是旧东西。
//
// 钉住的几件事:
//   · 标准写法 c;<base64>、省略目标的 ;<base64>、带换行的 base64 都能解出原文(含中文)
//   · 「读剪贴板」的查询 ? 一律不理(不能让终端里的程序借我们读走剪贴板)
//   · 坏数据(不是 base64、不是 UTF-8、没有分号、空)→ 什么都不写
//   · openTerm 里真的把它注册成 OSC 52 的处理函数
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const between = (a, b) => { const i = SRC.indexOf(a), j = SRC.indexOf(b); assert.ok(i >= 0 && j > i, '找不到标记 ' + a); return SRC.slice(i, j); };
const osc52Text = new Function(between('// <osc52>', '// </osc52>') + '\nreturn osc52Text;')();
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('标准写法、省略目标、带换行的 base64 都能解出原文', () => {
  assert.equal(osc52Text('c;' + b64('  Claude Code v2.1.32')), '  Claude Code v2.1.32');
  assert.equal(osc52Text(';' + b64('参考其他 claudia,增加')), '参考其他 claudia,增加');
  assert.equal(osc52Text('p;' + b64('多行\n第二行')), '多行\n第二行');
  const long = b64('x'.repeat(200));
  assert.equal(osc52Text('c;' + long.slice(0, 60) + '\n' + long.slice(60)), 'x'.repeat(200));
});

test('读剪贴板的查询不理;坏数据什么都不写', () => {
  for (const bad of ['c;?', 'c; ? ', '', 'c;', 'no-semicolon', 'c;不是base64!', 'c;' + Buffer.from([0xff, 0xfe, 0xfd]).toString('base64'), null, undefined]) {
    assert.equal(osc52Text(bad), '', JSON.stringify(bad));
  }
});

test('openTerm 里注册成 OSC 52 的处理函数,写剪贴板、也记成「刚选中的」给右键兜底用', () => {
  const body = SRC.slice(SRC.indexOf('async function openTerm('), SRC.indexOf('function activateTerm('));
  assert.match(body, /term\.parser\.registerOscHandler\(52,/);
  assert.match(body, /osc52Text\(data\)/);
  assert.match(body, /navigator\.clipboard\.writeText\(s\)/);
});

// 2026-11-17 自查:原来是无条件写剪贴板 —— 终端里任何输出(Claude 回显的恶意文件内容、cat 的日志)
// 只要带一段 ESC]52;c;<base64> 就能悄悄换掉剪贴板,用户下次粘贴的就是别人塞的命令。
// 现在只在「窗口在前台 + 2 秒内在这个终端里按下过鼠标(松开在哪都算)或按过键」时才写。
const osc52Allowed = new Function(between('// <osc52>', '// </osc52>') + '\nreturn osc52Allowed;')();

test('写剪贴板只认「人刚在这个终端里动过」', () => {
  const now = 1e12;
  assert.equal(osc52Allowed(now - 300, now, true), true);           // 刚松开鼠标(拖选复制)
  assert.equal(osc52Allowed(now - 2000, now, true), true);
  assert.equal(osc52Allowed(now - 2001, now, true), false);         // 太久以前
  assert.equal(osc52Allowed(0, now, true), false);                  // 从没碰过这个终端
  assert.equal(osc52Allowed(now - 100, now, false), false);         // 窗口不在前台
  assert.equal(osc52Allowed(now + 5000, now, true), false);         // 时间倒着走(改过系统时间)也不放
});

test('openTerm 里先过 osc52Allowed 再写;松开鼠标和按键都记成「人动过」', () => {
  const body = SRC.slice(SRC.indexOf('async function openTerm('), SRC.indexOf('function activateTerm('));
  const h = body.slice(body.indexOf('registerOscHandler(52,'));
  assert.ok(h.indexOf('osc52Allowed(') >= 0 && h.indexOf('osc52Allowed(') < h.indexOf('navigator.clipboard.writeText'), '要先判断再写剪贴板');
  // 按下在终端里、松开可能在终端外 —— mouseup 要挂在 window 上,不能只挂 pane
  assert.match(body, /pane\.addEventListener\('mousedown',/);
  assert.match(body, /window\.addEventListener\('mouseup', onUp, true\)/);
  assert.match(body, /pane\.addEventListener\('keydown', markUser, true\)/);
});
