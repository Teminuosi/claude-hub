// 检查点:读 Claude Code 自己的文件检查点(/rewind 用的同一份数据),给「检查点」页用。
//
// 数据都是 Claude Code 写的,这里**只读**:
//   ~/.claude/projects/<slug>/<会话>.jsonl 里
//     file-history-snapshot  每条用户提问一条:messageId = 那条提问,trackedFileBackups = 那一刻已被跟踪的文件
//                            (isSnapshotUpdate 的是对同一条的补充)
//     file-history-delta     这一轮第一次被改动的文件:snapshotMessageId 指向这一轮的提问,
//                            backup 是改动前的样子(backupFileName 为 null = 那时这个文件还不存在)
//   ~/.claude/file-history/<会话>/<backupFileName>  备份的文件内容
// 所以「提问 M 那一刻文件 F 的样子」= 快照 M 里的 F,没有就看 delta 里 snapshotMessageId=M 的 F。
//
// 真正回退文件用官方命令:claude --resume <会话> --rewind-files <提问 id>(和 /rewind 同一套逻辑)。
// 它在非交互方式下要 CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1 才肯做 —— 只给这一条命令设,不改任何配置。
// 回退前把会被动到的文件当前的样子先存一份到 APP_DATA(rewind-backups),撤销就是把这份放回去。
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { runKillable } = require('./killtree');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[A-Za-z0-9-]+$/;
const BACKUP_NAME = /^[0-9a-f]+@v\d+$/i;

// 提问的文字:字符串,或 [{type:'text',text}] —— 只有工具结果的那种不是提问
function promptText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some(c => c && c.type === 'tool_result')) return null;
  const t = content.filter(c => c && c.type === 'text').map(c => c.text || '').join('\n');
  return t || null;
}

// 给人看的提问:斜杠命令显示成命令本身,去掉系统塞进来的标签
function displayPrompt(t) {
  const s = String(t || '');
  const cmd = s.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) { const args = s.match(/<command-args>([^<]*)<\/command-args>/); return (cmd[1] + ' ' + (args ? args[1] : '')).trim(); }
  return s.replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/g, '').replace(/\s+/g, ' ').trim();
}

// 解析一份会话记录 → 按出现顺序的快照,每个带上「那一刻各文件的样子」
function parse(text) {
  const prompts = new Map();
  const order = [];                 // 快照 messageId,按第一次出现的顺序
  const snaps = new Map();          // messageId → { at, files: { key: { backup, dir } } }
  const deltas = new Map();         // snapshotMessageId → { key: { backup, dir } }(同一文件只认第一条)
  let cwd = '';
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let x; try { x = JSON.parse(line); } catch { continue; }
    if (!x || typeof x !== 'object') continue;
    if (!cwd && typeof x.cwd === 'string') cwd = x.cwd;
    if (x.type === 'user' && x.uuid && x.message && !x.isMeta) {
      const t = promptText(x.message.content);
      if (t !== null) prompts.set(x.uuid, { text: t, at: Date.parse(x.timestamp) || 0 });
    } else if (x.type === 'file-history-snapshot' && x.snapshot && x.messageId) {
      const files = {};
      for (const [k, v] of Object.entries(x.snapshot.trackedFileBackups || {})) {
        if (v && typeof v === 'object') files[k] = { backup: v.backupFileName || null, dir: v.realParentDir || '' };
      }
      const old = snaps.get(x.messageId);
      if (old) Object.assign(old.files, files);
      else { order.push(x.messageId); snaps.set(x.messageId, { at: Date.parse(x.snapshot.timestamp) || 0, files }); }
    } else if (x.type === 'file-history-delta' && x.snapshotMessageId && x.trackingPath && x.backup) {
      const d = deltas.get(x.snapshotMessageId) || {};
      if (!(x.trackingPath in d)) d[x.trackingPath] = { backup: x.backup.backupFileName || null, dir: x.backup.realParentDir || '' };
      deltas.set(x.snapshotMessageId, d);
    }
  }
  const list = order.map(id => {
    const s = snaps.get(id);
    const files = Object.assign({}, deltas.get(id) || {}, s.files);
    const p = prompts.get(id);
    return { id, at: s.at || (p && p.at) || 0, prompt: p ? displayPrompt(p.text) : null, files };
  });
  return { cwd, snaps: list };
}

// realParentDir 是文件自己所在的目录(不是相对路径的起点):有它就用「它 + 文件名」,没有才拿会话 cwd 拼相对路径
const absOf = (key, f, cwd) => path.isAbsolute(key) ? key : (f.dir ? path.join(f.dir, path.basename(key)) : path.join(cwd || '', key));

// 每个检查点这一轮改了哪些文件:这一刻的样子 vs 下一个快照的样子(最后一个跟磁盘比,要读文件,由调用方给 readSame)
// 返回只含「提问」的检查点(/exit 之类没有提问的快照只当下一刻的参照)
async function checkpoints(parsed, readSame) {
  const { snaps, cwd } = parsed;
  const out = [];
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    if (s.prompt === null) continue;
    const next = snaps[i + 1] || null;
    const files = [];
    for (const [key, f] of Object.entries(s.files)) {
      const abs = absOf(key, f, cwd);
      let after;   // 'same' | 'changed' | 'deleted'
      if (next && key in next.files) {
        const nb = next.files[key].backup;
        after = nb === f.backup ? 'same' : (nb === null ? 'deleted' : 'changed');
      } else if (next) {
        after = 'same';                                // 下一刻没记:这一轮没动过它
      } else {
        after = await readSame(f.backup, abs);         // 最后一个:和磁盘上现在的比
      }
      if (after === 'same') continue;
      const kind = f.backup === null ? '新' : (after === 'deleted' ? '删' : '改');
      files.push({ key, abs, kind });
    }
    out.push({ id: s.id, at: s.at, prompt: s.prompt, files });
  }
  return out;
}

// ---------- 带磁盘的部分 ----------
function sessionPaths(projectsDir, claudeHome, slug, sid) {
  if (!SLUG.test(String(slug || '')) || !UUID.test(String(sid || ''))) throw new Error('会话参数不对');
  return { jsonl: path.join(projectsDir, slug, sid + '.jsonl'), histDir: path.join(claudeHome, 'file-history', sid) };
}

async function readOrNull(p) { try { return await fs.promises.readFile(p); } catch { return null; } }

async function list(projectsDir, claudeHome, slug, sid) {
  const sp = sessionPaths(projectsDir, claudeHome, slug, sid);
  const text = await fs.promises.readFile(sp.jsonl, 'utf8');
  const parsed = parse(text);
  const readSame = async (backup, abs) => {
    const now = await readOrNull(abs);
    if (backup === null) return now === null ? 'same' : 'changed';
    if (now === null) return 'deleted';
    if (!BACKUP_NAME.test(backup)) return 'changed';
    const old = await readOrNull(path.join(sp.histDir, backup));
    return old && old.equals(now) ? 'same' : 'changed';
  };
  return { cwd: parsed.cwd, items: (await checkpoints(parsed, readSame)).reverse() };   // 新的在上
}

// 某个检查点里某个文件这一轮的改动(统一 diff 文本)
async function diff(projectsDir, claudeHome, slug, sid, id, key, tmpDir) {
  const sp = sessionPaths(projectsDir, claudeHome, slug, sid);
  const parsed = parse(await fs.promises.readFile(sp.jsonl, 'utf8'));
  const i = parsed.snaps.findIndex(s => s.id === id);
  if (i < 0 || !(key in parsed.snaps[i].files)) return '(找不到这个检查点或文件)';
  const f = parsed.snaps[i].files[key];
  const next = parsed.snaps[i + 1];
  const side = (backup) => (backup !== null && BACKUP_NAME.test(backup)) ? path.join(sp.histDir, backup) : null;
  const before = side(f.backup);
  let after;
  if (next && key in next.files) after = side(next.files[key].backup);
  else after = absOf(key, f, parsed.cwd);                         // 最后一个:磁盘上现在的
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const empty = path.join(tmpDir, 'empty');
  await fs.promises.writeFile(empty, '');
  const exists = async (p) => { try { await fs.promises.access(p); return true; } catch { return false; } };
  const a = before && await exists(before) ? before : empty;
  const b = after && await exists(after) ? after : empty;
  return gitDiffNoIndex(a, b);
}

function gitDiffNoIndex(a, b) {
  return new Promise(resolve => {
    // 有差异时 git 返回 1,不算错;只有拿不到输出才说明
    execFile('git', ['diff', '--no-index', '--no-color', '--', a, b], { timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      const out = String(stdout || '');
      if (!out && err && err.code !== 1) return resolve('(没能生成对比:需要能运行 git)');
      // 去掉头上那几行临时路径,只留改动块
      resolve(out.split('\n').filter((l, i) => !(i < 5 && /^(diff --git|index |--- |\+\+\+ |new file|deleted file)/.test(l))).join('\n').slice(0, 400000) || '(内容相同)');
    });
  });
}

// 回退前把这个会话跟踪过的所有文件现在的样子存一份,返回备份 id
async function backupBeforeRewind(projectsDir, claudeHome, slug, sid, id, backupRoot, now = Date.now()) {
  const sp = sessionPaths(projectsDir, claudeHome, slug, sid);
  const parsed = parse(await fs.promises.readFile(sp.jsonl, 'utf8'));
  const seen = new Map();
  for (const s of parsed.snaps) for (const [key, f] of Object.entries(s.files)) {
    const abs = absOf(key, f, parsed.cwd);
    if (!seen.has(abs.toLowerCase())) seen.set(abs.toLowerCase(), abs);
  }
  const bid = String(now);
  const dir = path.join(backupRoot, bid);
  await fs.promises.mkdir(dir, { recursive: true });
  const files = [];
  let n = 0;
  for (const abs of seen.values()) {
    const buf = await readOrNull(abs);
    if (buf === null) { files.push({ path: abs, existed: false }); continue; }
    const stored = String(n++);
    await fs.promises.writeFile(path.join(dir, stored), buf);
    files.push({ path: abs, existed: true, stored });
  }
  await fs.promises.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ sid, id, at: now, files }, null, 2));
  return bid;
}

// 文件内容的指纹;不存在 = null
const crypto = require('crypto');
async function fingerprint(p) {
  const buf = await readOrNull(p);
  return buf === null ? null : crypto.createHash('sha256').update(buf).digest('hex');
}

// 回退刚做完时,记下每个文件「回退后的样子」(指纹)。撤销时靠它认出「回退之后又被人改过」的文件。
async function recordAfterRewind(backupRoot, bid) {
  const mf = path.join(backupRoot, checkBid(bid), 'manifest.json');
  const m = JSON.parse(await fs.promises.readFile(mf, 'utf8'));
  for (const f of m.files || []) if (f && typeof f.path === 'string') f.after = await fingerprint(f.path);
  await fs.promises.writeFile(mf, JSON.stringify(m, null, 2));
}
function checkBid(bid) { if (!/^\d+$/.test(String(bid || ''))) throw new Error('备份 id 不对'); return String(bid); }

// 撤销回退:按备份放回去(备份时不存在的文件,现在有了就删掉)。
// 但回退之后又被改过的文件(现在的指纹 ≠ 回退刚做完时的)一律不碰 —— 那是人后来的改动,覆盖 / 删除都会弄丢它。
// 没记过指纹的(老备份、记指纹那一步失败)照原来的做法处理。
async function undoRewind(backupRoot, bid) {
  const dir = path.join(backupRoot, checkBid(bid));
  const m = JSON.parse(await fs.promises.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  let restored = 0, removed = 0;
  const skipped = [];
  for (const f of m.files || []) {
    if (!f || typeof f.path !== 'string' || !path.isAbsolute(f.path)) continue;
    if ('after' in f && (await fingerprint(f.path)) !== f.after) { skipped.push(f.path); continue; }
    if (f.existed && /^\d+$/.test(String(f.stored))) {
      await fs.promises.mkdir(path.dirname(f.path), { recursive: true });
      await fs.promises.writeFile(f.path, await fs.promises.readFile(path.join(dir, String(f.stored))));
      restored++;
    } else if (!f.existed) {
      try { await fs.promises.unlink(f.path); removed++; } catch {}
    }
  }
  return { restored, removed, skipped };
}

// 官方回退。env 由调用方给(已补 PATH、已去掉 CLAUDE_CODE 标记);这里只加开关。
function rewindCommand(sid, id) {
  if (!UUID.test(String(sid || '')) || !UUID.test(String(id || ''))) throw new Error('参数不对');
  return `claude --resume "${sid}" --rewind-files "${id}"`;
}
// 回退的结果分三种,决定那份「回退前备份」要不要留:
//   ok        claude 说 rewound —— 留着,给「撤销」用
//   untouched claude 在动手**之前**就拒绝了(没开开关 / 没这个检查点 / 没这个会话 / 根本没找到 claude)
//             —— 文件肯定没动,备份可以删
//   unsure    其余一切:超时、中途报错、输出看不懂 —— 文件可能已经回退了一部分,备份必须留着(拿不准就放行)
const UNTOUCHED = /File rewinding is not enabled|No file checkpoint found|is not a user message in this session|No conversation found|is not recognized as|command not found|ENOENT/i;
function classifyRewind({ err, stdout, stderr, timedOut }) {
  const out = (String(stdout || '') + String(stderr || '')).trim();
  const msg = out || (err ? String(err.message || err) : '');
  if (timedOut) return { state: 'unsure', msg: '等了 60 秒 claude 还没回退完,已强行结束。' + (out ? '\n' + out : '') };
  if (!err && /rewound/i.test(out)) return { state: 'ok', msg };
  if (UNTOUCHED.test(msg)) return { state: 'untouched', msg };
  return { state: 'unsure', msg };
}
async function runRewind(sid, id, cwd, env, timeoutMs = 60000) {
  const cmd = rewindCommand(sid, id);
  // 超时要连 claude.exe 一起杀(只杀 cmd.exe 的话 claude 还在后台改文件)
  const r = await runKillable(cmd, null, { cwd, env: Object.assign({}, env, { CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1' }) }, timeoutMs);
  return classifyRewind(r);
}

module.exports = { parse, checkpoints, displayPrompt, promptText, list, diff, backupBeforeRewind, recordAfterRewind, undoRewind, rewindCommand, runRewind, classifyRewind, UUID };
