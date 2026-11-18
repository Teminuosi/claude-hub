// 2026-11-17 自查(代码审查第 4~8 条)里界面这一侧的几处修正,截 index.html 的真源码测。
//
//   4. onclick="f('${...}')" 里只用 escAttr 不够:它把 ' 转成 &#39;,浏览器解析属性时又还原成 ',
//      照样把 JS 字符串截断。要先 escJs 再 escAttr。
//   5. MCP 页按行号记「选中的服务器」,重新读配置后行序一变,「移除」就删到别的服务器。改成按 范围+名称 记。
//   8. 「在会话里用 /rewind」原来固定等 2.5 秒就往终端里填字:Claude 起得慢就被启动画面吞掉,
//      停在「信任这个文件夹吗」时还会落进对话框。改成看屏幕判断(ckPromptState)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const between = (a, b) => { const i = SRC.indexOf(a), j = SRC.indexOf(b); assert.ok(i >= 0 && j > i, '找不到标记 ' + a); return SRC.slice(i, j); };

// ---------- 4 ----------
const escAttr = new Function(between('// <esc-attr>', '// </esc-attr>') + '\nreturn escAttr;')();
const escJsLine = SRC.match(/^const escJs = .*$/m)[0];
const escJs = new Function(escJsLine + '\nreturn escJs;')();
// 模拟浏览器:先按 HTML 解出属性值,再把它当 JS 执行,看 f 收到的是不是原样
const htmlDecode = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const runOnclick = (attr) => { let got; new Function('f', htmlDecode(attr))((x) => { got = x; }); return got; };

test('4. onclick 里的参数:escJs 再 escAttr 能原样送到;只用 escAttr 会截断', () => {
  for (const v of ["it's", 'a\\b', `x'); alert(1); ('`, '"<&>"', '中文 id']) {
    assert.equal(runOnclick(`f('${escAttr(escJs(v))}')`), v, JSON.stringify(v));
  }
  assert.throws(() => runOnclick(`f('${escAttr("it's")}')`));   // 修之前的写法:JS 语法错
});

test('4. 新加的几页里,onclick 拼字符串参数一律 escAttr(escJs(…))', () => {
  const pages = between('// ===== Agents 页 =====', '// <osc52>');
  const bad = pages.match(/onclick="[a-zA-Z]+\('\$\{escAttr\((?!escJs\()/g);
  assert.equal(bad, null, '还有只用 escAttr 的:' + JSON.stringify(bad));
});

// ---------- 5 ----------
test('5. MCP 选中的服务器按「范围 + 名称」认,行序变了也还是它', () => {
  const env = { mcSel: null, mcRows: [] };
  const f = new Function('env', `with (env) { ${between('// <mc-sel>', '// </mc-sel>')}; return { mcKey, mcSelRow }; }`)(env);
  env.mcRows = [{ scope: 'user', name: 'a' }, { scope: 'local', name: 'b' }, { scope: 'project', name: 'b' }];
  env.mcSel = f.mcKey(env.mcRows[1]);
  env.mcRows = [{ scope: 'project', name: 'b' }, { scope: 'user', name: 'new' }, { scope: 'local', name: 'b' }, { scope: 'user', name: 'a' }];
  assert.deepEqual(f.mcSelRow(), { scope: 'local', name: 'b' });   // 同名不同范围不会认错
  env.mcRows = env.mcRows.filter(r => r.scope !== 'local');
  assert.equal(f.mcSelRow(), null);                                  // 被删了就是没选中,不会落到别的行上
  const body = between('async function mcRemove()', 'async function mcImport()');
  assert.match(body, /const s = mcSelRow\(\);/);
  assert.doesNotMatch(SRC, /mcRows\[mcSel\]/);
});

// ---------- 8 ----------
const ckPromptState = new Function(between('// <ck-prompt>', '// </ck-prompt>') + '\nreturn ckPromptState;')();
test('8. 看屏幕判断 Claude Code 能不能接输入', () => {
  // 真实画面片段(实测)
  assert.equal(ckPromptState([' ▐▛███▜▌   Claude Code v2.1.326', '', '❯ 从1数到80,每行一个数字', '']), 'ready');
  assert.equal(ckPromptState(['──────', '> ', '──────', '  ? for shortcuts']), 'ready');
  assert.equal(ckPromptState(['│ > Try "fix lint errors"', '']), 'ready');
  assert.equal(ckPromptState(['Do you trust the files in this folder?', '', '❯ 1. Yes, proceed', '  2. No, exit']), 'trust');
  assert.equal(ckPromptState(['Is this a project you created or one you trust? (Quick safety check) trust this folder', '❯ 1. Yes, I trust this folder']), 'trust');
  assert.equal(ckPromptState(['❯ 1. Yes', '  2. No']), 'wait');      // 选项菜单不是输入行
  assert.equal(ckPromptState(['', 'Resuming conversation…', '']), 'wait');
  assert.equal(ckPromptState([]), 'wait');
  const body = between('async function ckRewindInSession()', 'async function ckFork()');
  assert.doesNotMatch(body, /setTimeout\(r, 2500\)/);
  assert.match(body, /ckPromptState\(/);
});
