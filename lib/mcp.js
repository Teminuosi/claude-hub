// MCP 页:看、加、删 Claude Code 的 MCP 服务器。
//
// 读:直接读配置文件(快,不用起 claude):
//   ~/.claude.json  mcpServers                     → 全局(user,所有项目可用)
//                   projects["D:/x/y"].mcpServers  → 仅本机本项目(local)。注意 key 是正斜杠的路径
//   <项目>/.mcp.json mcpServers                    → 项目共享(project,跟着仓库走)
// 「连得上吗」:跑官方 claude mcp list(它会挨个连一遍,慢,单独异步拿;超时/看不懂就显示「未检测」)。
// 写:不自己改这些文件 —— 一律走官方 claude mcp add-json / remove,和用户在终端里敲是一回事。
//   参数用 agents.js 那套「写进 JSON 文件,PowerShell 读出来 claude @a 展开」传,JSON 里的引号不会被吃掉。
// 密钥:env / headers 的值不传给界面,只给名字。
const fs = require('fs');
const path = require('path');
const { runKillable } = require('./killtree');
const { writeJsonAtomic } = require('./atomic-json');
const { escapeForPs51, psQuote } = require('./agents');

const SCOPES = ['user', 'local', 'project'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// ~/.claude.json 里 projects 的 key 是「D:/claude-project/x」这种,比较时统一斜杠、不分大小写
const projKey = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function summarize(name, cfg, scope, extra) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const type = c.type || (c.url ? 'http' : 'stdio');
  return Object.assign({
    name, scope, type,
    command: typeof c.command === 'string' ? c.command : '',
    args: Array.isArray(c.args) ? c.args.map(String) : [],
    url: typeof c.url === 'string' ? c.url : '',
    envKeys: c.env && typeof c.env === 'object' ? Object.keys(c.env) : [],
    headerKeys: c.headers && typeof c.headers === 'object' ? Object.keys(c.headers) : []
  }, extra || {});
}

async function readJson(file) {
  let text;
  try { text = await fs.promises.readFile(file, 'utf8'); }
  catch (e) { return e && e.code === 'ENOENT' ? { missing: true } : { broken: '读不了:' + (e && e.message || e) }; }
  try { return { data: JSON.parse(text.replace(/^\uFEFF/, '')) }; }
  catch (e) { return { broken: '不是合法的 JSON:' + (e && e.message || e) }; }
}

// 返回 { servers, broken: { claudeJson?, mcpJson? }, mcpJsonPath }
// 「没有这个文件」和「文件坏了」分开:前者就是没配,后者要告诉用户
async function readConfig(claudeJsonPath, projPath) {
  const servers = [];
  const broken = {};
  const home = await readJson(claudeJsonPath);
  let approved = null, rejected = null, allApproved = false;
  if (home.broken) broken.claudeJson = home.broken;
  else if (home.data) {
    const d = home.data;
    for (const [n, c] of Object.entries(d.mcpServers || {})) servers.push(summarize(n, c, 'user'));
    if (projPath && d.projects && typeof d.projects === 'object') {
      const want = projKey(projPath);
      const k = Object.keys(d.projects).find(x => projKey(x) === want);
      const pj = k ? d.projects[k] : null;
      if (pj) {
        for (const [n, c] of Object.entries(pj.mcpServers || {})) servers.push(summarize(n, c, 'local'));
        approved = Array.isArray(pj.enabledMcpjsonServers) ? pj.enabledMcpjsonServers : null;
        rejected = Array.isArray(pj.disabledMcpjsonServers) ? pj.disabledMcpjsonServers : null;
        allApproved = pj.enableAllProjectMcpServers === true;
      }
    }
  }
  const mcpJsonPath = projPath ? path.join(projPath, '.mcp.json') : '';
  if (projPath) {
    const pj = await readJson(mcpJsonPath);
    if (pj.broken) broken.mcpJson = pj.broken;
    else if (pj.data) {
      for (const [n, c] of Object.entries(pj.data.mcpServers || {})) {
        // .mcp.json 里的服务器要用户在 Claude Code 里批准过才会连
        const approval = allApproved || (approved && approved.includes(n)) ? 'approved' : (rejected && rejected.includes(n) ? 'rejected' : 'pending');
        servers.push(summarize(n, c, 'project', { approval }));
      }
    }
  }
  return { servers, broken, mcpJsonPath };
}

// 解析 claude mcp list 的输出:「名字: 目标 - ✔ Connected」。看不懂的行跳过(拿不准 = 不下结论)
function parseList(out) {
  const res = [];
  for (const raw of String(out || '').split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^(.+?):\s+(.*)\s+-\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const word = m[4].toLowerCase();
    let status = 'unknown';
    if (/connected/.test(word) && !/fail|not/.test(word)) status = 'ok';
    else if (/fail|error/.test(word)) status = 'fail';
    else if (/pending|approval/.test(word)) status = 'pending';
    else if (/auth/.test(word)) status = 'auth';
    else if (/disabled/.test(word)) status = 'disabled';
    res.push({ name: m[1].trim(), target: m[2].trim(), status, text: m[4].trim() });
  }
  return res;
}

// 把用户填的表单 / 粘贴的 JSON 变成 claude mcp add-json 要的那份配置。出错抛中文消息
function buildConfig(f) {
  const type = ['stdio', 'http', 'sse'].includes(f.type) ? f.type : 'stdio';
  const cfg = { type };
  const kv = (text, what) => {
    const o = {};
    for (const line of String(text || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const i = line.indexOf(what === 'headers' ? ':' : '=');
      if (i <= 0) throw new Error(what === 'headers' ? `请求头要写成「名字: 值」:${line.trim()}` : `环境变量要写成「名字=值」:${line.trim()}`);
      o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return o;
  };
  if (type === 'stdio') {
    const command = String(f.command || '').trim();
    if (!command) throw new Error('要填启动命令(比如 npx)');
    cfg.command = command;
    const args = String(f.args || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (args.length) cfg.args = args;
    const env = kv(f.env, 'env');
    if (Object.keys(env).length) cfg.env = env;
  } else {
    const url = String(f.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('地址要以 http:// 或 https:// 开头');
    cfg.url = url;
    const h = kv(f.headers, 'headers');
    if (Object.keys(h).length) cfg.headers = h;
  }
  return cfg;
}

// 粘贴的 JSON:{ mcpServers: {名字: 配置} } / {名字: 配置} / 单个配置(要另给名字)
function parsePasted(text, fallbackName) {
  let j;
  try { j = JSON.parse(String(text || '').trim()); } catch (e) { throw new Error('不是合法的 JSON:' + e.message); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('要粘一个 JSON 对象');
  const isCfg = (o) => o && typeof o === 'object' && (typeof o.command === 'string' || typeof o.url === 'string');
  let map;
  if (j.mcpServers && typeof j.mcpServers === 'object') map = j.mcpServers;
  else if (isCfg(j)) {
    if (!fallbackName) throw new Error('这段是单个服务器的配置,请在「名称」里填个名字');
    map = { [fallbackName]: j };
  } else map = j;
  const out = [];
  for (const [n, c] of Object.entries(map)) {
    if (!isCfg(c)) throw new Error(`「${n}」不像 MCP 配置(没有 command 也没有 url)`);
    out.push({ name: n, cfg: c });
  }
  if (!out.length) throw new Error('里面没有服务器');
  return out;
}

function checkName(n) { if (!NAME.test(String(n || ''))) throw new Error('名称只能用字母、数字、- _ .,最长 64 个字'); }
function checkScope(s) { if (!SCOPES.includes(s)) throw new Error('范围不对'); }

// JSON 里的空白全写成 \uXXXX:JSON.stringify 的输出里,空白只会出现在字符串值里面,换成转义意思不变。
// 这样整个参数没有空白,PowerShell 5.1 就不会去判断要不要包引号 —— 它把 \" 也当引号数,
// 遇到 {"args":["a b"]} 这种「空白都在引号里」的,不包引号,到 claude 那边就从空格处断开(实测)。
const jsonArg = (cfg) => JSON.stringify(cfg).replace(/\s/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
function addArgs(name, scope, cfg) { checkName(name); checkScope(scope); return ['mcp', 'add-json', '-s', scope, name, jsonArg(cfg)]; }
function removeArgs(name, scope) { checkName(name); checkScope(scope); return ['mcp', 'remove', '-s', scope, name]; }

// 跑 claude <args>:参数写进文件再由 PowerShell 展开(和 Agent 运行同一套,引号安全)
// env 由调用方给(补好 PATH、去掉 CLAUDE_CODE 标记、带上代理)
function runClaude(args, { cwd, env, runDir, timeout = 60000 }) {
  fs.mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, 'mcp-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.json');
  writeJsonAtomic(file, args.map(escapeForPs51));
  const line = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
    + `$a = Get-Content -Raw -Encoding UTF8 -LiteralPath ${psQuote(file)} | ConvertFrom-Json; claude @a; exit $LASTEXITCODE`;
  // 超时连 claude.exe 一起杀(只杀 powershell 的话,检测卡住时每点一次就多留一个 claude 在后台)
  return runKillable('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', line],
    { cwd: cwd || undefined, env }, timeout).then(r => {
    fs.promises.unlink(file).catch(() => {});
    const out = (r.stdout + '\n' + r.stderr).trim();
    return { ok: !r.err, out, timedOut: r.timedOut };
  });
}

// Claude Desktop(Windows 版)的配置,用来一键导入。没装就是空
async function readDesktop(file) {
  const r = await readJson(file);
  if (r.missing) return { ok: true, servers: [] };
  if (r.broken) return { ok: false, msg: r.broken };
  const map = (r.data && r.data.mcpServers) || {};
  return { ok: true, servers: Object.entries(map).filter(([, c]) => c && typeof c === 'object').map(([n, c]) => ({ name: n, cfg: c, sum: summarize(n, c, 'desktop') })) };
}

// 删掉 dir 里超过 maxAgeMs 的参数文件。正常情况下 runClaude 用完就删;这是给「进程中途被杀」留下的兜底。
// 只删老的:刚启动时如果正好有一次添加在进行,它的文件不能被删。
async function cleanRuns(dir, maxAgeMs = 10 * 60 * 1000, now = Date.now()) {
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!/^mcp-[\d-]+\.json$/.test(name)) continue;
    const p = path.join(dir, name);
    try { const st = await fs.promises.stat(p); if (now - st.mtimeMs > maxAgeMs) { await fs.promises.unlink(p); n++; } } catch {}
  }
  return n;
}

module.exports = { cleanRuns, SCOPES, projKey, summarize, readConfig, parseList, buildConfig, parsePasted, addArgs, removeArgs, runClaude, readDesktop, checkName };
