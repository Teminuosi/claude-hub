// 数据层:读 projects.json / 会话 JSONL / 记忆文件 / 完成流。纯 node,无外部依赖。
const fs = require('fs');
const path = require('path');

const P = require('./paths');
const PROJECTS_JSON = P.PROJECTS_JSON;
const CLAUDE_PROJECTS = P.CLAUDE_PROJECTS;
const FEED = P.FEED;

function safeJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// 去掉命令包装/系统提示等噪音,提取真人指令文本
function cleanUserText(t) {
  if (!t) return '';
  t = t
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, ' ')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, ' ')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, ' ')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, ' ')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, ' ')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (t.startsWith('<')) return '';
  return t;
}

function textOfContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter(x => x && x.type === 'text').map(x => x.text).join(' ');
  }
  return '';
}

function getProjects() {
  const raw = fs.readFileSync(PROJECTS_JSON, 'utf8');
  const list = JSON.parse(raw);
  let totals = {};
  try { totals = require('./usage').totalsBySlug(); } catch {}
  // 排序:优先用 projects.json 里的 order(持久化,不怕浏览器缓存丢)
  list.sort((a, b) => ((typeof a.order === 'number') ? a.order : 9999) - ((typeof b.order === 'number') ? b.order : 9999));
  // 同一个 slug 被多个项目共用时(中文目录名会撞车),按会话真实 cwd 分账
  const slugCount = {};
  for (const p of list) { const s = p.sessSlug || ''; slugCount[s] = (slugCount[s] || 0) + 1; }
  // 他手动改过名的会话(左栏筛选框按会话名找项目用)。只认改过名的:
  // 自动标题要逐个读会话文件,几十个项目全读一遍会卡;改过名的查一张表就有。
  let custom = {};
  try { custom = loadTitles() || {}; } catch {}
  return list.map(p => {
    const sessDir = path.join(CLAUDE_PROJECTS, p.sessSlug || '');
    const shared = slugCount[p.sessSlug || ''] > 1;
    let sessCount = 0, lastActive = 0;
    const named = [];
    try {
      // 与 getSessions 用同一套归属判断,保证"左栏计数"和"中间列表"永远一致
      let files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
      files = files.filter(f => {
        const fp2 = path.join(sessDir, f);
        try { if (fs.statSync(fp2).size < 200) return false; } catch { return false; }
        return ownsSession(p.path, sessionCwd(fp2), shared);
      });
      sessCount = files.length;
      for (const f of files) {
        const m = fs.statSync(path.join(sessDir, f)).mtimeMs;
        if (m > lastActive) lastActive = m;
        const sid = f.slice(0, -6);   // 去掉 .jsonl
        const t = custom[sid];
        if (typeof t === 'string' && t.trim()) named.push({ sid, title: t.trim(), mtime: m });
      }
    } catch {}
    return {
      name: p.name, short: p.short || p.name, role: p.role || '', line: p.line || '',
      path: p.path, memSlug: p.memSlug || '', sessSlug: p.sessSlug || '',
      mainSession: p.mainSession || '', sessCount, lastActive,
      named: named.sort((a, b) => b.mtime - a.mtime).map(x => ({ sid: x.sid, title: x.title })),
      order: (typeof p.order === 'number') ? p.order : 9999,
      tok: totals[p.sessSlug || ''] || 0,
      stack: p.stack || [], deploy: p.deploy || '',
      highlights: p.highlights || [], pitfalls: p.pitfalls || []
    };
  });
}

// 会话标题:优先 summary 条目,否则第一条真人指令
function sessionTitle(fp) {
  let title = '', summary = '';
  try {
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const lines = buf.toString('utf8', 0, n).split('\n');
    for (const ln of lines) {
      const e = safeJson(ln);
      if (!e) continue;
      if (e.type === 'summary' && e.summary && !summary) { summary = e.summary; }
      if (e.type === 'user' && !e.isSidechain && !e.isMeta && !e.isCompactSummary && !title) {
        const t = cleanUserText(textOfContent(e.message && e.message.content));
        if (t) title = t;
      }
      if (summary && title) break;
    }
  } catch {}
  return summary || title || '(空会话)';
}

// 自定义会话标题(总控台备注名,按 sid 存)
const TITLES = P.TITLES;
function loadTitles() {
  // 读出来不是个对象(文件里是 null / 数组 / 一个字符串)也当空表,否则下游 custom[sid] 直接抛
  try {
    const t = JSON.parse(fs.readFileSync(TITLES, 'utf8'));
    return (t && typeof t === 'object' && !Array.isArray(t)) ? t : {};
  } catch { return {}; }
}
function setCustomTitle(sid, title) {
  if (!sid) return false;
  const t = loadTitles();
  if (title) t[sid] = title; else delete t[sid];
  fs.writeFileSync(TITLES, JSON.stringify(t, null, 2), 'utf8');
  return true;
}

// 读会话头部的 cwd(判断这条会话到底属于哪个项目)
const cwdCache = new Map();
function sessionCwd(fp) {
  let st; try { st = fs.statSync(fp); } catch { return ''; }
  const key = fp + '|' + st.size;
  if (cwdCache.has(key)) return cwdCache.get(key);
  let cwd = '';
  try {
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(Math.min(st.size, 32768));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.toString('utf8').match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) cwd = m[1].replace(/\\\\/g, '\\');
  } catch {}
  cwdCache.set(key, cwd);
  return cwd;
}

// 判断一条会话是否属于该项目
// 宽松:没读到 cwd、路径相同、或 cwd 在项目目录之下 → 都算自己的
// 严格只在"多个项目共用一个 slug 目录"时启用(中文目录名会撞车)
function ownsSession(projPath, cwd, strict) {
  if (!cwd || !projPath) return true;
  const a = String(cwd).replace(/[\\/]+$/, '').toLowerCase();
  const b = String(projPath).replace(/[\\/]+$/, '').toLowerCase();
  if (a === b || a.startsWith(b + '\\')) return true;
  return !strict;   // 不撞车时,cwd 对不上也保留(项目可能改过路径/移动过目录)
}

function getSessions(sessSlug, mainSession, projPath, strict) {
  const dir = path.join(CLAUDE_PROJECTS, sessSlug);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  } catch { return []; }
  const out = [];
  for (const f of files) {
    const fp = path.join(dir, f);
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    if (st.size < 200) continue; // 空壳会话不展示
    if (projPath && !ownsSession(projPath, sessionCwd(fp), strict)) continue;
    out.push({
      sid: f.replace('.jsonl', ''),
      title: '',
      mtime: st.mtimeMs,
      size: st.size,
      isMain: f.startsWith(String(mainSession || '~~').slice(0, 8))
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  const top = out.slice(0, 40);
  const custom = loadTitles();
  const usage = require('./usage');
  for (const s of top) {
    s.title = custom[s.sid] || sessionTitle(path.join(dir, s.sid + '.jsonl'));
    const u = usage.sessionUsage(dir, s.sid, true);
    s.tok = u ? (u.in + u.cw + u.out) : 0;
    s.tokOut = u ? u.out : 0;
  }
  return top;
}

// 新建项目:写入 projects.json
// slug 规则同 Claude Code:**所有非 [A-Za-z0-9-] 的字符都换成 '-'**(中文每个字换一个 '-')
// 例:F:\claude-project\老孙校招 → F--claude-project-----(早期只换 : 和 \,中文项目会话全找不到)
function slugOf(p) { return String(p).replace(/[^A-Za-z0-9-]/g, '-'); }
function addProject(info) {
  const raw = fs.readFileSync(PROJECTS_JSON, 'utf8');
  const list = JSON.parse(raw);
  const projPath = String(info.path || '').replace(/[\\/]+$/, '');
  if (!projPath) return { ok: false, msg: '没有给项目路径' };
  // 目录不存在就直接建(新建项目时按项目名在父目录下开子文件夹)
  if (!fs.existsSync(projPath)) {
    if (!info.createDir) return { ok: false, msg: '目录不存在:' + projPath };
    try { fs.mkdirSync(projPath, { recursive: true }); } catch (e) { return { ok: false, msg: '建目录失败:' + e.message }; }
  }
  if (list.some(p => String(p.path).toLowerCase() === projPath.toLowerCase())) return { ok: false, msg: '该目录已在项目列表里' };
  const slug = slugOf(projPath);
  const entry = {
    name: info.name || path.basename(projPath),
    short: info.name || path.basename(projPath),
    role: info.role || '', line: info.line || '未分组',
    path: projPath, memSlug: slug, sessSlug: slug, mainSession: '',
    stack: [], deploy: '', highlights: [], pitfalls: []
  };
  list.push(entry);
  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(list, null, 2), 'utf8');
  return { ok: true, path: projPath };
}

// 改项目信息(改名/分组/说明)
function updateProject(projPath, patch) {
  const list = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  const i = list.findIndex(p => String(p.path).toLowerCase() === String(projPath).toLowerCase());
  if (i < 0) return { ok: false, msg: '项目不存在' };
  if (patch.name) { list[i].name = patch.name; list[i].short = patch.name; }
  if (patch.line) list[i].line = patch.line;
  if (typeof patch.role === 'string') list[i].role = patch.role;
  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(list, null, 2), 'utf8');
  return { ok: true };
}

// 保存项目顺序(写进 projects.json 的 order 字段,持久化)
function saveOrder(paths) {
  const list = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  const idx = new Map((paths || []).map((p, i) => [String(p).toLowerCase(), i]));
  for (const p of list) {
    const k = String(p.path).toLowerCase();
    if (idx.has(k)) p.order = idx.get(k);
  }
  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(list, null, 2), 'utf8');
  return { ok: true };
}

// 从清单移除项目(只删清单条目,不碰磁盘文件/会话)
function removeProject(projPath) {
  const list = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  const next = list.filter(p => String(p.path).toLowerCase() !== String(projPath).toLowerCase());
  if (next.length === list.length) return { ok: false, msg: '项目不存在' };
  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(next, null, 2), 'utf8');
  return { ok: true };
}

// 会话移入回收站(.trash)
function trashSession(sessSlug, sid) {
  if (!/^[\w-]+$/.test(sid)) return false;
  const dir = path.join(CLAUDE_PROJECTS, sessSlug);
  const fp = path.join(dir, sid + '.jsonl');
  if (!fs.existsSync(fp)) return false;
  const tr = path.join(dir, '.trash');
  if (!fs.existsSync(tr)) fs.mkdirSync(tr);
  fs.renameSync(fp, path.join(tr, sid + '.jsonl'));
  return true;
}

function getMemory(memSlug) {
  const dir = path.join(CLAUDE_PROJECTS, memSlug, 'memory');
  const res = { index: '', files: [] };
  try {
    const idx = path.join(dir, 'MEMORY.md');
    if (fs.existsSync(idx)) res.index = fs.readFileSync(idx, 'utf8');
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.md') && f !== 'MEMORY.md') res.files.push(f);
    }
    res.files.sort();
  } catch {}
  return res;
}

function readMemoryFile(memSlug, file) {
  if (!/^[\w\-.\u4e00-\u9fff]+\.md$/.test(file)) return '';
  try {
    return fs.readFileSync(path.join(CLAUDE_PROJECTS, memSlug, 'memory', file), 'utf8');
  } catch { return ''; }
}

function getFeed(limit) {
  try {
    const lines = fs.readFileSync(FEED, 'utf8').trim().split('\n');
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < (limit || 30); i--) {
      const r = safeJson(lines[i]);
      if (r) out.push(r);
    }
    return out;
  } catch { return []; }
}

// 「修改记录」会被按时间切成多份(如 修改记录-归档_2026-07至09.md)。
// 用前缀匹配一次认全,以后再归档不用回来改白名单。
// 不许出现路径分隔符 —— 否则 rel 能拼出 ..\.. 跳出项目目录。
const CHANGELOG_RE = /^修改记录[^\\/]*\.md$/;
function changelogFiles(projPath) {
  try {
    return fs.readdirSync(projPath).filter(f => CHANGELOG_RE.test(f) && f !== '修改记录.md').sort();
  } catch { return []; }
}

// 项目资料:CLAUDE.md/修改记录/README/项目配置/技能
function getProjectDocs(projPath) {
  const res = { docs: [], skills: [], skillInfo: [] };
  try {
    for (const f of ['CLAUDE.md', '.claude\\CLAUDE.md', 'CLAUDE.local.md', '修改记录.md', 'README.md', '.claude\\settings.json', '.claude\\settings.local.json']) {
      if (fs.existsSync(path.join(projPath, f))) res.docs.push(f);
    }
    for (const f of changelogFiles(projPath)) res.docs.push(f);   // 归档出来的那几份
    // .claude/rules/*.md —— 带 paths 前置属性时，只在改到匹配文件时才加载
    try {
      const rd = path.join(projPath, '.claude', 'rules');
      for (const rf of fs.readdirSync(rd)) {
        if (rf.endsWith('.md')) res.docs.push('.claude\\rules\\' + rf);
      }
    } catch {}
    const sd = path.join(projPath, '.claude', 'skills');
    if (fs.existsSync(sd)) {
      for (const d of fs.readdirSync(sd)) {
        const sf = path.join(sd, d, 'SKILL.md');
        if (!fs.existsSync(sf)) continue;
        res.skills.push(d);
        let desc = '';
        try { desc = firstDesc(fs.readFileSync(sf, 'utf8')); } catch {}
        res.skillInfo.push({ name: d, desc: skillZh()[d] || desc });
      }
    }
  } catch {}
  return res;
}

function readProjectFile(projPath, rel) {
  const ok = ['CLAUDE.md', '修改记录.md', 'README.md', '.claude\\settings.json', '.claude\\settings.local.json'];
  const isSkill = /^\.claude\\skills\\[\w.\-一-鿿]+\\SKILL\.md$/.test(rel);
  if (!ok.includes(rel) && !isSkill && !CHANGELOG_RE.test(rel)) return '';
  try { return fs.readFileSync(path.join(projPath, rel), 'utf8'); } catch { return ''; }
}

// ===== 可写:记忆 / 项目文档 / 技能 =====
function writeMemoryFile(memSlug, file, content) {
  if (!/^[\w\-.\u4e00-\u9fff]+\.md$/.test(file)) return { ok: false, msg: '文件名不合法' };
  const dir = path.join(CLAUDE_PROJECTS, memSlug, 'memory');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, file);
    if (fs.existsSync(fp)) fs.copyFileSync(fp, fp + '.bak');   // 覆盖前留一份
    fs.writeFileSync(fp, content, 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, msg: String(e) }; }
}
function deleteMemoryFile(memSlug, file) {
  if (!/^[\w\-.\u4e00-\u9fff]+\.md$/.test(file) || file === 'MEMORY.md') return { ok: false, msg: '不允许删除' };
  try {
    const fp = path.join(CLAUDE_PROJECTS, memSlug, 'memory', file);
    const tr = path.join(CLAUDE_PROJECTS, memSlug, 'memory', '.trash');
    if (!fs.existsSync(tr)) fs.mkdirSync(tr, { recursive: true });
    fs.renameSync(fp, path.join(tr, file));
    return { ok: true };
  } catch (e) { return { ok: false, msg: String(e) }; }
}
function writeProjectFile(projPath, rel, content) {
  const ok = ['CLAUDE.md', '.claude\\CLAUDE.md', 'CLAUDE.local.md', '修改记录.md', 'README.md'];
  const isSkill = /^\.claude\\skills\\[\w.\-\u4e00-\u9fff]+\\SKILL\.md$/.test(rel);
  const isCmd = /^\.claude\commands\[\w.\-一-鿿]+\.md$/.test(rel);
  const isRule = /^\.claude\\rules\\[\w.\-\u4e00-\u9fff]+\.md$/.test(rel);
  if (!ok.includes(rel) && !isSkill && !isCmd && !isRule && !CHANGELOG_RE.test(rel)) return { ok: false, msg: '该文件不允许编辑' };
  try {
    const fp = path.join(projPath, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    if (fs.existsSync(fp)) fs.copyFileSync(fp, fp + '.bak');
    fs.writeFileSync(fp, content, 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, msg: String(e) }; }
}
function createSkill(projPath, name, content) {
  if (!/^[\w\-\u4e00-\u9fff]+$/.test(name)) return { ok: false, msg: '技能名只能用字母数字中文和短横线' };
  const dir = path.join(projPath, '.claude', 'skills', name);
  try {
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) return { ok: false, msg: '同名技能已存在' };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
    return { ok: true, rel: `.claude\\skills\\${name}\\SKILL.md` };
  } catch (e) { return { ok: false, msg: String(e) }; }
}

// ===== 提示词库 =====
const PROMPTS = P.PROMPTS;
function getPrompts() {
  try { return JSON.parse(fs.readFileSync(PROMPTS, 'utf8')); } catch { return []; }
}
function savePrompts(list) {
  try { fs.writeFileSync(PROMPTS, JSON.stringify(list, null, 2), 'utf8'); return { ok: true }; }
  catch (e) { return { ok: false, msg: String(e) }; }
}


// ===== 斜杠命令(~/.claude/commands 全局 · 项目 .claude/commands)=====
// 和技能同一个命名空间:两者都注册成 skill,都能打 /名字 调用。
// 命令 = 单文件(一段提示词);技能 = 目录(能捆脚本和附件)。
const NAME_OK = /^[\w\-\u4e00-\u9fff]+$/;

function cmdDir(scope, projPath) {
  return scope === 'global'
    ? path.join(P.CLAUDE_HOME, 'commands')
    : path.join(projPath || '', '.claude', 'commands');
}
function firstDesc(txt) {
  const m = String(txt || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) { const d = m[1].match(/^description:\s*(.+)$/m); if (d) return d[1].trim().replace(/^["']|["']$/g, ''); }
  const line = String(txt || '').split('\n').find(x => x.trim() && !x.startsWith('---'));
  return (line || '').trim().slice(0, 40);
}
function listCmdDir(dir) {
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      let desc = '';
      try { desc = firstDesc(fs.readFileSync(path.join(dir, f), 'utf8')); } catch {}
      out.push({ name: f.replace(/\.md$/, ''), desc });
    }
  } catch {}
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
function getCommands(projPath) {
  return { global: listCmdDir(cmdDir('global')), project: projPath ? listCmdDir(cmdDir('project', projPath)) : [] };
}
// 技能的中文注解表(docs/skill-zh.json)。官方技能的 description 是英文,
// 但那是模型判断"该不该调用"的依据,不能改;所以另存一份中文只给界面看。
let ZH_CACHE = { at: 0, map: {} };
function skillZh() {
  const now = Date.now();
  if (now - ZH_CACHE.at < 3000) return ZH_CACHE.map;
  let map = {};
  try {
    const fp = path.join(__dirname, '..', 'docs', 'skill-zh.json');
    map = JSON.parse(fs.readFileSync(fp, 'utf8'));
    delete map._说明;
  } catch {}
  ZH_CACHE = { at: now, map };
  return map;
}
// 全局技能(~/.claude/skills/<名>/SKILL.md)—— 和全局命令一样,任何项目都能 / 调用
function getGlobalSkills() {
  const dir = path.join(P.CLAUDE_HOME, 'skills');
  const out = [];
  try {
    for (const d of fs.readdirSync(dir)) {
      const fp = path.join(dir, d, 'SKILL.md');
      if (!fs.existsSync(fp)) continue;
      let desc = '';
      try { desc = firstDesc(fs.readFileSync(fp, 'utf8')); } catch {}
      out.push({ name: d, desc: skillZh()[d] || desc });
    }
  } catch {}
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
function readCommand(scope, name, projPath) {
  if (!NAME_OK.test(name)) return '';
  try { return fs.readFileSync(path.join(cmdDir(scope, projPath), name + '.md'), 'utf8'); } catch { return ''; }
}
function writeCommand(scope, name, content, projPath) {
  if (!NAME_OK.test(name)) return { ok: false, msg: '命令名只能用字母数字中文和短横线' };
  if (scope !== 'global' && !projPath) return { ok: false, msg: '缺少项目路径' };
  try {
    const dir = cmdDir(scope, projPath);
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, name + '.md');
    if (fs.existsSync(fp)) fs.copyFileSync(fp, fp + '.bak');
    fs.writeFileSync(fp, content, 'utf8');
    return { ok: true, path: fp };
  } catch (e) { return { ok: false, msg: String(e) }; }
}
function deleteCommand(scope, name, projPath) {
  if (!NAME_OK.test(name)) return { ok: false, msg: '命令名不合法' };
  try {
    const dir = cmdDir(scope, projPath);
    const fp = path.join(dir, name + '.md');
    if (!fs.existsSync(fp)) return { ok: false, msg: '文件不存在' };
    const tr = path.join(dir, '.trash');
    if (!fs.existsSync(tr)) fs.mkdirSync(tr, { recursive: true });
    fs.renameSync(fp, path.join(tr, name + '.md'));   // 移进 .trash,不真删
    return { ok: true };
  } catch (e) { return { ok: false, msg: String(e) }; }
}


// ===== 全局规矩：~/.claude/CLAUDE.md 与 ~/.claude/rules/*.md =====
// 这两处「每个会话都加载」，和项目 CLAUDE.md 同一类，只是作用域是所有项目。
// rules 带 paths 前置属性时，只在碰到匹配文件时才加载（User 作用域已实测生效）。
function globalDocPath(rel) {
  if (rel === 'CLAUDE.md') return path.join(P.CLAUDE_HOME, 'CLAUDE.md');
  const m = /^rules[\\/]([\w.\-\u4e00-\u9fff]+\.md)$/.exec(rel);
  if (m) return path.join(P.CLAUDE_HOME, 'rules', m[1]);
  return null;
}
function getGlobalDocs() {
  const out = [];
  try {
    if (fs.existsSync(path.join(P.CLAUDE_HOME, 'CLAUDE.md')))
      out.push({ rel: 'CLAUDE.md', desc: '总规矩 · 每个会话都加载' });
  } catch {}
  try {
    for (const f of fs.readdirSync(path.join(P.CLAUDE_HOME, 'rules'))) {
      if (!f.endsWith('.md')) continue;
      let desc = '每个会话都加载';
      try {
        const t = fs.readFileSync(path.join(P.CLAUDE_HOME, 'rules', f), 'utf8');
        if (/^paths:/m.test(t)) desc = '只在改到匹配文件时加载';
      } catch {}
      out.push({ rel: 'rules/' + f, desc });
    }
  } catch {}
  return out;
}
function readGlobalDoc(rel) {
  const fp = globalDocPath(rel);
  if (!fp) return '';
  try { return fs.readFileSync(fp, 'utf8'); } catch { return ''; }
}
function writeGlobalDoc(rel, content) {
  const fp = globalDocPath(rel);
  if (!fp) return { ok: false, msg: '不允许写这个路径' };
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    if (fs.existsSync(fp)) fs.copyFileSync(fp, fp + '.bak');
    fs.writeFileSync(fp, content, 'utf8');
    return { ok: true, path: fp };
  } catch (e) { return { ok: false, msg: String(e) }; }
}


// ===== 开着的会话列表(同步写文件,不走 localStorage)=====
// localStorage 是异步刷盘的,Electron 被强杀(任务管理器/Stop-Process -Force)就丢;
// 这里用 writeFileSync,写完即落盘。
function getOpenTabs() {
  try {
    const j = JSON.parse(fs.readFileSync(P.OPENTABS, 'utf8'));
    return { tabs: Array.isArray(j.tabs) ? j.tabs : [], active: j.active || '' };
  } catch { return { tabs: [], active: '' }; }
}
function saveOpenTabs(tabs, active) {
  try {
    fs.writeFileSync(P.OPENTABS, JSON.stringify({
      tabs: Array.isArray(tabs) ? tabs : [],
      active: active || '',
      savedAt: new Date().toISOString()
    }, null, 2), 'utf8');
    return { ok: true, n: (tabs || []).length };
  } catch (e) { return { ok: false, msg: String(e) }; }
}

module.exports = { getProjects, getSessions, getMemory, readMemoryFile, getFeed, getProjectDocs, readProjectFile, setCustomTitle,
  sessionTitle, loadTitles,          // search.js 要用:会话名的算法只许有一份
  getOpenTabs, saveOpenTabs,
  getGlobalDocs, readGlobalDoc, writeGlobalDoc,
  getCommands, getGlobalSkills, readCommand, writeCommand, deleteCommand,
  writeMemoryFile, deleteMemoryFile, writeProjectFile, createSkill, getPrompts, savePrompts, trashSession, addProject, updateProject, removeProject, saveOrder, CLAUDE_PROJECTS, FEED };
