// 自定义 Agent:一段提示词 + 模型 + 免确认的工具,存成一条,点「运行」就在内嵌终端里开一个带着这些设置的 claude 会话。
//
// 数据只放在客户端自己的 %APPDATA%\claude-hub\agents.json —— 不往 ~/.claude 或项目的 .claude/agents 里写任何东西
// (硬规矩 5:不替用户改 Claude Code 配置)。运行时靠的全是官方命令行参数:
//   --append-system-prompt  在默认系统提示词后面追加 Agent 的提示词
//   --model                 不填 = 跟随 Claude Code 自己的设置(/model)
//   --allowedTools          勾上的工具免确认;没勾的照样会问,不是禁用
//
// 参数怎么传到 claude 手里是这里最容易出事的地方:终端是 powershell.exe -Command "<一行命令>",
// 提示词里有引号、换行、反斜杠,直接拼进命令行必坏。所以参数先写成一个 JSON 数组文件,
// 命令行里只出现这个文件的路径,PowerShell 读文件、把数组展开(@a)传给 claude。
// Windows PowerShell 5.1 把数组元素交给外部程序时**不会**转义元素里的双引号(7.3 以后才会),
// 所以写文件前先按 Windows 命令行的规则把双引号和它前面的反斜杠转好(escapeForPs51)。
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-json');

// 界面上的四个勾 → 官方工具名。只读 git 用前缀规则,只放行这几条子命令。
const TOOL_SETS = {
  read: ['Read', 'Grep', 'Glob'],
  gitread: ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git status:*)', 'Bash(git show:*)'],
  write: ['Edit', 'Write'],
  bash: ['Bash']
};
const TOOL_KEYS = Object.keys(TOOL_SETS);
const MAX_RUNS = 20;

const str = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);

// 进来的东西一律当不可信:只留认识的字段,类型不对就丢掉
function normalize(a) {
  a = a && typeof a === 'object' ? a : {};
  const id = /^[\w-]{1,40}$/.test(a.id || '') ? a.id : 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return {
    id,
    name: str(a.name, 60).trim() || '未命名 Agent',
    desc: str(a.desc, 200).trim(),
    model: str(a.model, 80).trim().replace(/[^\w.\-\[\]]/g, ''),   // 模型名只会是字母数字和 . - [ ](如 opus、claude-opus-5-5[1m])
    prompt: str(a.prompt, 20000),
    tools: Array.isArray(a.tools) ? TOOL_KEYS.filter(k => a.tools.includes(k)) : [],
    runs: Array.isArray(a.runs)
      ? a.runs.filter(r => r && typeof r.at === 'number').slice(0, MAX_RUNS).map(r => ({ at: r.at, proj: str(r.proj, 260) }))
      : []
  };
}

// 读清单。「没有文件」和「文件读坏了」分开(硬规矩 7):
//   没有 → 空清单;读坏 → broken: true,界面要说出来,保存前先把坏文件挪到一边,不能悄悄盖掉
async function load(file) {
  let raw;
  try { raw = await fs.promises.readFile(file, 'utf8'); }
  catch (e) { return e && e.code === 'ENOENT' ? { ok: true, list: [] } : { ok: false, broken: true, list: [], msg: String(e) }; }
  try {
    const j = JSON.parse(raw.replace(/^﻿/, ''));
    if (!Array.isArray(j)) throw new Error('不是数组');
    return { ok: true, list: j.map(normalize) };
  } catch (e) {
    return { ok: false, broken: true, list: [], msg: 'agents.json 读不懂:' + e.message };
  }
}

async function save(file, list) {
  const cur = await load(file);
  if (cur.broken) {
    // 读坏的那份留个备份,再写新的
    try { await fs.promises.rename(file, file + '.broken-' + Date.now()); } catch {}
  }
  const clean = (Array.isArray(list) ? list : []).map(normalize);
  writeJsonAtomic(file, clean);
  return { ok: true, list: clean };
}

// 记一次运行(最新的在前,最多留 MAX_RUNS 条)
async function recordRun(file, id, proj, now = Date.now()) {
  const cur = await load(file);
  if (cur.broken) return { ok: false, msg: cur.msg };
  const a = cur.list.find(x => x.id === id);
  if (!a) return { ok: false, msg: '没有这个 Agent' };
  a.runs = [{ at: now, proj: String(proj || '') }, ...a.runs].slice(0, MAX_RUNS);
  writeJsonAtomic(file, cur.list);
  return { ok: true };
}

// 给 claude 的参数(原样,还没转义)
function buildArgs(agent) {
  const a = normalize(agent);
  const args = [];
  // 末尾的反斜杠在命令行里会把收尾的引号吃掉;提示词结尾的空白和反斜杠本来就没意义,直接去掉
  const prompt = a.prompt.replace(/[\s\\]+$/, '');
  if (prompt.trim()) args.push('--append-system-prompt', prompt);
  if (a.model) args.push('--model', a.model);
  const tools = a.tools.flatMap(k => TOOL_SETS[k]);
  if (tools.length) args.push('--allowedTools', tools.join(','));
  return args;
}

// Windows PowerShell 5.1 把参数交给外部程序时:含空白就整体包一层双引号,里面的双引号原样不动。
// 按 Windows 命令行的解析规则(CommandLineToArgvW / MSVC CRT),要让对方收到原字符串:
//   · 双引号前的 n 个反斜杠 → 2n 个,双引号本身 → \"
//   · 会被包引号时,结尾的 n 个反斜杠也要 → 2n 个(否则吃掉收尾引号)
function escapeForPs51(s) {
  s = String(s).replace(/(\\*)"/g, (m, bs) => bs + bs + '\\"');
  if (/\s/.test(s)) s = s.replace(/(\\+)$/, '$1$1');
  return s;
}

// PowerShell 单引号字符串:只有单引号要写成两个
const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// 把参数写进 runDir 下的文件,返回终端要执行的那一行命令
function writeLaunch(runDir, agent) {
  const a = normalize(agent);
  fs.mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, a.id + '.json');
  // 提示词不走命令行,写进文件用 --append-system-prompt-file 传:PowerShell 5.1 只在「引号外面有空白」时才给参数包引号,
  // 它把 \" 也当引号数 —— 像 "只读 审查" 这种空白全在引号里的提示词,不包引号,到 claude 那边就被空格劈开了(实测)。
  // 文件路径在 APPDATA 下,不会有双引号,怎么包都对。
  const args = buildArgs(a);
  const i = args.indexOf('--append-system-prompt');
  if (i >= 0) {
    const pf = path.join(runDir, a.id + '.prompt.txt');
    fs.writeFileSync(pf, args[i + 1], 'utf8');
    args.splice(i, 2, '--append-system-prompt-file', pf);
  }
  writeJsonAtomic(file, args.map(escapeForPs51));
  // -Raw 整个读成一个字符串再解析;解析出来是数组,@a 把它展开成一个个参数
  return `$a = Get-Content -Raw -Encoding UTF8 -LiteralPath ${psQuote(file)} | ConvertFrom-Json; claude @a`;
}

module.exports = { TOOL_SETS, TOOL_KEYS, normalize, load, save, recordRun, buildArgs, escapeForPs51, psQuote, writeLaunch };
