// 自定义 Agent(lib/agents.js)。
//
// 背景:2026-11-17 加「Agents」页。Agent 的提示词要原样交给 claude --append-system-prompt,
// 而终端是 powershell.exe -Command "<一行命令>"。提示词里有中文引号、英文双引号、换行、路径反斜杠,
// 直接拼进命令行必坏 —— Windows PowerShell 5.1 把参数交给外部程序时不转义里面的双引号,
// 对方收到的是被截断、被拆开的几段。
//
// 钉住的几件事:
//   · 参数经过真实的 powershell.exe 之后,另一头收到的必须和原文一字不差(最要紧的一条,Windows 上真跑)
//   · 清单「没有」和「读坏了」分开:读坏的不能被悄悄覆盖,要先挪成备份
//   · 进来的数据当不可信:不认识的工具名、怪模型名、超长字段都要被挡掉
//   · 不填模型 = 不传 --model(跟随 Claude Code 自己的 /model 设置)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ag = require('../lib/agents');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-agents-'));

test('buildArgs:提示词、模型、工具按官方参数排好;没填的不出现', () => {
  assert.deepEqual(ag.buildArgs({ name: 'x' }), []);
  assert.deepEqual(ag.buildArgs({ prompt: '只读审查', model: 'opus', tools: ['read', 'gitread'] }), [
    '--append-system-prompt', '只读审查',
    '--model', 'opus',
    '--allowedTools', 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git status:*),Bash(git show:*)'
  ]);
  // 只有空白的提示词等于没有
  assert.deepEqual(ag.buildArgs({ prompt: ' \n\t ' }), []);
  // 结尾的空白和反斜杠去掉
  assert.deepEqual(ag.buildArgs({ prompt: '看 D:\\x\\ \n' }), ['--append-system-prompt', '看 D:\\x']);
});

test('normalize:不认识的工具、怪模型名、坏 id 都被挡掉', () => {
  const a = ag.normalize({ id: '../../etc', name: '', model: 'opus"; rm -rf /', tools: ['read', 'sudo', 'bash'], runs: [{ at: 1, proj: 'p' }, 'x', { at: 'no' }] });
  assert.match(a.id, /^[\w-]+$/);
  assert.notEqual(a.id, '../../etc');
  assert.equal(a.name, '未命名 Agent');
  assert.equal(a.model, 'opusrm-rf');
  assert.deepEqual(a.tools, ['read', 'bash']);
  assert.deepEqual(a.runs, [{ at: 1, proj: 'p' }]);
  assert.equal(ag.normalize({ model: 'claude-opus-5-5[1m]' }).model, 'claude-opus-5-5[1m]');
});

test('escapeForPs51:双引号、引号前的反斜杠、包引号时结尾的反斜杠', () => {
  assert.equal(ag.escapeForPs51('a"b'), 'a\\"b');
  assert.equal(ag.escapeForPs51('a\\"b'), 'a\\\\\\"b');
  assert.equal(ag.escapeForPs51('a b\\'), 'a b\\\\');      // 含空白会被包引号:结尾反斜杠翻倍
  assert.equal(ag.escapeForPs51('ab\\'), 'ab\\');          // 不含空白不包引号:原样
  assert.equal(ag.escapeForPs51('C:\\x\\y'), 'C:\\x\\y');  // 中间的反斜杠不动
});

test('load / save:没有文件是空清单;读坏的先备份再写,不悄悄覆盖', async () => {
  const d = tmp(), f = path.join(d, 'agents.json');
  assert.deepEqual(await ag.load(f), { ok: true, list: [] });

  fs.writeFileSync(f, '{ 坏了');
  const r = await ag.load(f);
  assert.equal(r.broken, true);
  assert.equal(r.ok, false);

  await ag.save(f, [{ id: 'a1', name: '审查' }]);
  const backups = fs.readdirSync(d).filter(n => n.startsWith('agents.json.broken-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(d, backups[0]), 'utf8'), '{ 坏了');
  const ok = await ag.load(f);
  assert.equal(ok.ok, true);
  assert.equal(ok.list[0].name, '审查');

  // 带 BOM 的也读得懂(记事本另存会加)
  fs.writeFileSync(f, '\uFEFF[{"id":"b","name":"带BOM"}]');
  assert.equal((await ag.load(f)).list[0].name, '带BOM');
});

test('recordRun:最新的在前,最多 20 条;读坏时不写', async () => {
  const d = tmp(), f = path.join(d, 'agents.json');
  await ag.save(f, [{ id: 'a1', name: 'x' }]);
  for (let i = 0; i < 25; i++) await ag.recordRun(f, 'a1', 'P' + i, 1000 + i);
  const a = (await ag.load(f)).list[0];
  assert.equal(a.runs.length, 20);
  assert.deepEqual(a.runs[0], { at: 1024, proj: 'P24' });
  assert.equal((await ag.recordRun(f, 'nope', 'P')).ok, false);
  fs.writeFileSync(f, 'bad');
  assert.equal((await ag.recordRun(f, 'a1', 'P')).ok, false);
  assert.equal(fs.readFileSync(f, 'utf8'), 'bad');
});

test('psQuote:单引号翻倍', () => {
  assert.equal(ag.psQuote("C:\\Users\\o'neil\\a.json"), "'C:\\Users\\o''neil\\a.json'");
});

// 最要紧的一条:真的经过 powershell.exe,另一头收到的参数和原文一字不差。
// 用一个打印 argv 的 node 小脚本顶替 claude(命令里把 claude 换成 node <脚本>)。
test('真跑 PowerShell:引号、换行、反斜杠、中文都原样送到', { skip: process.platform !== 'win32' }, () => {
  const d = tmp();
  const echo = path.join(d, 'echo.js');
  const out = path.join(d, 'out.json');
  fs.writeFileSync(echo, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)), 'utf8');`);
  const agent = {
    id: 'echo',
    prompt: '你是"严格"的审查员。\n路径 D:\\a b\\ 和 C:\\x\\"y\\" 都别动。\n它说:「别改」 \'单引号\' $env:PATH `反引号` 100%',
    model: 'opus',
    tools: ['read', 'gitread']
  };
  const cmd = ag.writeLaunch(path.join(d, 'runs'), agent);
  assert.match(cmd, / claude @a$/);
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    cmd.replace(/ claude @a$/, ' node ' + ag.psQuote(echo) + ' @a')], { encoding: 'utf8', timeout: 60000 });
  assert.equal(ps.status, 0, ps.stderr);
  // 提示词走文件(--append-system-prompt-file),其余参数原样
  const got = JSON.parse(fs.readFileSync(out, 'utf8'));
  const want = ag.buildArgs(agent);
  const i = want.indexOf('--append-system-prompt');
  assert.equal(got[i], '--append-system-prompt-file');
  assert.equal(fs.readFileSync(got[i + 1], 'utf8'), want[i + 1]);
  got.splice(i, 2); want.splice(i, 2);
  assert.deepEqual(got, want);
});

// 2026-11-17 做 MCP 页时发现:PowerShell 5.1 只在「引号外面有空白」时才给参数包引号,而且把 \" 也当引号数。
// 提示词 "只读 审查"(空白全在引号里)不会被包,claude 收到的是被空格劈开的两段。所以提示词改走文件。
test('真跑 PowerShell:空白全在引号里的提示词也完整送到', { skip: process.platform !== 'win32' }, () => {
  const d = tmp();
  const echo = path.join(d, 'echo.js');
  const out = path.join(d, 'out.json');
  fs.writeFileSync(echo, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)), 'utf8');`);
  for (const prompt of ['"只读 审查"', 'x"a b"', '"a b" "c d"']) {
    const cmd = ag.writeLaunch(path.join(d, 'runs'), { id: 'q', prompt, model: 'opus' });
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd.replace(/ claude @a$/, ' node ' + ag.psQuote(echo) + ' @a')], { encoding: 'utf8', timeout: 60000 });
    assert.equal(ps.status, 0, ps.stderr);
    const got = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(got.length, 4, JSON.stringify(got));
    assert.equal(fs.readFileSync(got[1], 'utf8'), prompt);
    assert.deepEqual(got.slice(2), ['--model', 'opus']);
  }
});

test('真跑 PowerShell:什么都没填时 claude 不带参数', { skip: process.platform !== 'win32' }, () => {
  const d = tmp();
  const echo = path.join(d, 'echo.js');
  const out = path.join(d, 'out.json');
  fs.writeFileSync(echo, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)), 'utf8');`);
  const cmd = ag.writeLaunch(path.join(d, 'runs'), { id: 'empty' });
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd.replace(/ claude @a$/, ' node ' + ag.psQuote(echo) + ' @a')], { encoding: 'utf8', timeout: 60000 });
  assert.equal(ps.status, 0, ps.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), []);
});
