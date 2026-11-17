// MCP 页(lib/mcp.js)。
//
// 背景:2026-11-17 把原来「项目 ⋯ → MCP 服务器」那个只读弹窗做成整页,能看状态、加、删、从 Claude Desktop 导入。
// 增删不自己改配置文件,一律走官方 claude mcp add-json / remove。
//
// 踩过的坑:
//   1. 旧弹窗按「D:\x\y」去 ~/.claude.json 的 projects 里找,可那里的 key 是「D:/x/y」—— 仅本项目(local)的服务器
//      从来没显示过。现在统一斜杠、不分大小写比较。
//   2. add-json 的 JSON 经 PowerShell 5.1 交给 claude:{"args":["a b"]} 这种空白全在引号里的参数,PS 不包引号,
//      claude 收到半截,报 "Invalid configuration: not a JSON object"。现在把 JSON 里的空白写成 \u0020。
//      (实测:真 claude 加一个带空格/引号/反斜杠/中文的配置,写进 .mcp.json 的和原样一字不差。)
// 测试不碰真实的 ~/.claude.json,只用临时目录。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const m = require('../lib/mcp');
const ag = require('../lib/agents');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mcp-'));

test('readConfig:全局 / 仅本项目(key 是正斜杠)/ 项目共享 三处都读到;密钥只给名字', async () => {
  const d = tmp();
  const proj = path.join(d, 'My Proj');
  fs.mkdirSync(proj);
  const cj = path.join(d, '.claude.json');
  fs.writeFileSync(cj, '\uFEFF' + JSON.stringify({
    mcpServers: { gh: { type: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: 'secret-123' } } },
    projects: {
      [proj.replace(/\\/g, '/').toUpperCase()]: { mcpServers: { db: { url: 'https://x/mcp', headers: { Authorization: 'Bearer zzz' } } }, enabledMcpjsonServers: ['shared'] },
      'D:/other': { mcpServers: { nope: { command: 'x' } } }
    }
  }));
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'node', args: ['s.js'] }, fresh: { command: 'node' } } }));
  const r = await m.readConfig(cj, proj);
  assert.deepEqual(r.broken, {});
  assert.deepEqual(r.servers.map(s => [s.name, s.scope, s.type]), [['gh', 'user', 'stdio'], ['db', 'local', 'http'], ['shared', 'project', 'stdio'], ['fresh', 'project', 'stdio']]);
  assert.deepEqual(r.servers.map(s => s.approval), [undefined, undefined, 'approved', 'pending']);
  assert.deepEqual(r.servers[0].envKeys, ['GITHUB_TOKEN']);
  assert.deepEqual(r.servers[1].headerKeys, ['Authorization']);
  assert.ok(!JSON.stringify(r).includes('secret-123') && !JSON.stringify(r).includes('zzz'), '密钥的值不能出现在给界面的数据里');
});

test('readConfig:没有文件 = 没配;文件坏了要说出来', async () => {
  const d = tmp();
  assert.deepEqual(await m.readConfig(path.join(d, 'none.json'), d), { servers: [], broken: {}, mcpJsonPath: path.join(d, '.mcp.json') });
  fs.writeFileSync(path.join(d, 'bad.json'), '{ "mcpServers": ');
  fs.writeFileSync(path.join(d, '.mcp.json'), 'nope');
  const r = await m.readConfig(path.join(d, 'bad.json'), d);
  assert.match(r.broken.claudeJson, /不是合法的 JSON/);
  assert.match(r.broken.mcpJson, /不是合法的 JSON/);
});

test('parseList:认得出连上 / 失败 / 待批准 / 要登录;看不懂的行跳过', () => {
  const out = [
    'Checking MCP server health…', '',
    'claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected',
    'fs: npx -y @x/fs C:\\a b - ✗ Failed to connect',
    'shared: node s.js - ⏸ Pending approval (run `claude` to approve)',
    'linear: https://mcp.linear.app/sse (SSE) - ! Needs authentication',
    '乱七八糟的一行'
  ].join('\r\n');
  assert.deepEqual(m.parseList(out).map(x => [x.name, x.status]), [['claude.ai Claude Docs', 'ok'], ['fs', 'fail'], ['shared', 'pending'], ['linear', 'auth']]);
  assert.equal(m.parseList(out)[1].target, 'npx -y @x/fs C:\\a b');
});

test('buildConfig:表单 → 配置;填错给中文提示', () => {
  assert.deepEqual(m.buildConfig({ type: 'stdio', command: ' npx ', args: '-y\n\n @x/fs \nC:\\a b', env: 'K=v=1\n\nT = x' }),
    { type: 'stdio', command: 'npx', args: ['-y', '@x/fs', 'C:\\a b'], env: { K: 'v=1', T: 'x' } });
  assert.deepEqual(m.buildConfig({ type: 'http', url: 'https://a/mcp', headers: 'Authorization: Bearer a:b' }),
    { type: 'http', url: 'https://a/mcp', headers: { Authorization: 'Bearer a:b' } });
  assert.throws(() => m.buildConfig({ type: 'stdio' }), /启动命令/);
  assert.throws(() => m.buildConfig({ type: 'sse', url: 'ftp://x' }), /http/);
  assert.throws(() => m.buildConfig({ type: 'stdio', command: 'x', env: 'NOEQ' }), /名字=值/);
});

test('parsePasted:三种常见粘法都认', () => {
  assert.deepEqual(m.parsePasted('{"mcpServers":{"a":{"command":"x"},"b":{"url":"https://b"}}}').map(x => x.name), ['a', 'b']);
  assert.deepEqual(m.parsePasted('{"a":{"command":"x"}}').map(x => x.name), ['a']);
  assert.deepEqual(m.parsePasted('{"command":"npx","args":["y"]}', 'mine'), [{ name: 'mine', cfg: { command: 'npx', args: ['y'] } }]);
  assert.throws(() => m.parsePasted('{"command":"npx"}'), /填个名字/);
  assert.throws(() => m.parsePasted('{"a":{"foo":1}}'), /不像 MCP 配置/);
  assert.throws(() => m.parsePasted('[1]'), /JSON 对象/);
  assert.throws(() => m.parsePasted('{oops'), /不是合法的 JSON/);
});

test('addArgs / removeArgs:名字和范围先校验;JSON 里没有空白但意思不变', () => {
  const cfg = { type: 'stdio', command: 'npx', args: ['C:\\带 空格\\"引号"\\', '全角\u3000空格', 'tab\there'] };
  const a = m.addArgs('fs-1', 'project', cfg);
  assert.deepEqual(a.slice(0, 5), ['mcp', 'add-json', '-s', 'project', 'fs-1']);
  assert.ok(!/\s/.test(a[5]));
  assert.deepEqual(JSON.parse(a[5]), cfg);
  assert.deepEqual(m.removeArgs('x.y_z', 'user'), ['mcp', 'remove', '-s', 'user', 'x.y_z']);
  assert.throws(() => m.addArgs('a b', 'user', cfg), /名称/);
  assert.throws(() => m.addArgs('-rf', 'user', cfg), /名称/);
  assert.throws(() => m.removeArgs('ok', 'global'), /范围/);
});

// 真的过一遍 powershell.exe(和 runClaude 同一行命令,只把 claude 换成打印 argv 的 node 脚本)
test('真跑 PowerShell:add-json 的 JSON 一字不差送到', { skip: process.platform !== 'win32' }, () => {
  const d = tmp();
  const echo = path.join(d, 'echo.js');
  const out = path.join(d, 'out.json');
  fs.writeFileSync(echo, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)), 'utf8');`);
  const cfg = { type: 'stdio', command: 'npx', args: ['a b', 'C:\\带 空格\\"引号"\\'], env: { K: 'a b"c' } };
  const args = m.addArgs('fs', 'local', cfg);
  const f = path.join(d, 'a.json');
  fs.writeFileSync(f, JSON.stringify(args.map(ag.escapeForPs51)));
  const line = `$a = Get-Content -Raw -Encoding UTF8 -LiteralPath ${ag.psQuote(f)} | ConvertFrom-Json; node ${ag.psQuote(echo)} @a`;
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', line], { encoding: 'utf8', timeout: 60000 });
  assert.equal(ps.status, 0, ps.stderr);
  const got = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(got, args);
  assert.deepEqual(JSON.parse(got[5]), cfg);
});

test('readDesktop:没装 Claude Desktop 就是空;值留在主进程,摘要不带密钥', async () => {
  const d = tmp();
  assert.deepEqual(await m.readDesktop(path.join(d, 'none.json')), { ok: true, servers: [] });
  const f = path.join(d, 'c.json');
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { a: { command: 'npx', env: { KEY: 'v' } }, bad: 3 } }));
  const r = await m.readDesktop(f);
  assert.deepEqual(r.servers.map(s => s.name), ['a']);
  assert.deepEqual(r.servers[0].sum.envKeys, ['KEY']);
  assert.ok(!JSON.stringify(r.servers[0].sum).includes('"v"'));
});
