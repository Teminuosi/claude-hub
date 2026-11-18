// 检查点页(lib/checkpoints.js):读 Claude Code 自己的文件检查点(/rewind 用的同一份数据)。
//
// 背景:2026-11-17 加「检查点」页。ClaudeHub 原来没有检查点,Claude Code 有:每条提问打一个快照,
// 记在会话 jsonl 的 file-history-snapshot / file-history-delta 里,文件内容备份在 ~/.claude/file-history/<会话>/。
// 实测(真的 claude,haiku):提问「改 a.txt、新建 b.txt」后,
//   快照(提问那一刻)  trackedFileBackups = {}
//   delta a.txt       snapshotMessageId=那条提问, backup = acc…@v1(改动前的内容)
//   delta b.txt       backup = null(那时还不存在)
//   下一个快照         a.txt → acc…@v2, b.txt → 49f…@v2
// 然后 claude --resume <会话> --rewind-files <提问id>(要 CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1)
// → a.txt 回到 v1,b.txt 被删掉。不设那个开关会报 "File rewinding is not enabled."
//
// 踩过的坑:realParentDir 是文件**自己所在的目录**,不是相对路径的起点。按起点拼会拼出
// D:\proj\lib\lib\agents.js,文件「不存在」,全被标成「删」。
//
// 钉住的几件事:
//   · 「提问 M 那一刻」= 快照 M + delta(snapshotMessageId=M);isSnapshotUpdate 合进同一条
//   · 每个检查点只列这一轮真动过的文件,新 / 改 / 删 分对;最后一个跟磁盘比
//   · 没有提问的快照(/exit 那种)不算检查点,但当「下一刻」的参照
//   · 回退前的备份能完整撤销:改过的放回去,原来没有的删掉
//   · 只认 UUID 形式的会话和提问 id;测试不碰真实的 ~/.claude
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ck = require('../lib/checkpoints');

const SID = 'b4f1e144-9dbd-4b6f-9002-6a79401686f9';
const Q1 = '6d9dced9-fc80-4427-9508-e7d776944754';
const Q2 = '7e0e0000-0000-4000-8000-000000000002';
const EXIT = '38e10710-33ea-4e04-9b40-c3145009d7d6';
const iso = (minAgo) => new Date(Date.now() - minAgo * 60e3).toISOString();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ckpt-'));
  const proj = path.join(root, 'proj');
  const home = path.join(root, 'claude');
  const slug = 'C--proj';
  fs.mkdirSync(path.join(proj, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(home, 'projects', slug), { recursive: true });
  const hist = path.join(home, 'file-history', SID);
  fs.mkdirSync(hist, { recursive: true });
  // 备份内容
  fs.writeFileSync(path.join(hist, 'aaaa@v1'), 'v1 原始内容\n');
  fs.writeFileSync(path.join(hist, 'aaaa@v2'), 'v2 被改过\n');
  fs.writeFileSync(path.join(hist, 'bbbb@v2'), 'new\n');
  fs.writeFileSync(path.join(hist, 'aaaa@v3'), 'v3 第二轮\n');
  // 磁盘上现在的样子:a 是第二轮改完的 v3;b 第二轮删掉了;c 第二轮新建
  fs.writeFileSync(path.join(proj, 'a.txt'), 'v3 第二轮\n');
  fs.writeFileSync(path.join(proj, 'lib', 'c.js'), 'c\n');
  const L = [
    { type: 'mode', cwd: proj },
    { type: 'file-history-snapshot', messageId: Q1, snapshot: { messageId: Q1, trackedFileBackups: {}, timestamp: iso(30) }, isSnapshotUpdate: false },
    { type: 'user', uuid: Q1, timestamp: iso(30), cwd: proj, message: { role: 'user', content: '改 a.txt,新建 b.txt' } },
    { type: 'file-history-delta', snapshotMessageId: Q1, trackingPath: 'a.txt', backup: { backupFileName: 'aaaa@v1', version: 1, realParentDir: proj } },
    { type: 'file-history-delta', snapshotMessageId: Q1, trackingPath: 'b.txt', backup: { backupFileName: null, version: 1, realParentDir: proj } },
    // 同一文件的第二条 delta 不算(只认第一次)
    { type: 'file-history-delta', snapshotMessageId: Q1, trackingPath: 'a.txt', backup: { backupFileName: 'zzzz@v9', version: 9, realParentDir: proj } },
    { type: 'user', uuid: 'tool-result-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
    { type: 'file-history-snapshot', messageId: Q2, snapshot: { messageId: Q2, trackedFileBackups: { 'a.txt': { backupFileName: 'aaaa@v2', realParentDir: proj }, 'b.txt': { backupFileName: 'bbbb@v2', realParentDir: proj } }, timestamp: iso(20) }, isSnapshotUpdate: false },
    { type: 'user', uuid: Q2, timestamp: iso(20), message: { role: 'user', content: [{ type: 'text', text: '<command-name>/fix</command-name><command-args>再改</command-args>' }] } },
    // 相对路径带子目录:realParentDir 是文件自己所在的目录
    { type: 'file-history-delta', snapshotMessageId: Q2, trackingPath: 'lib\\c.js', backup: { backupFileName: null, version: 1, realParentDir: path.join(proj, 'lib') } },
    // 没有提问的快照(/exit):只当参照
    { type: 'file-history-snapshot', messageId: EXIT, snapshot: { messageId: EXIT, trackedFileBackups: { 'a.txt': { backupFileName: 'aaaa@v3', realParentDir: proj }, 'b.txt': { backupFileName: null, realParentDir: proj } }, timestamp: iso(10) }, isSnapshotUpdate: false },
    { type: 'file-history-snapshot', messageId: EXIT, snapshot: { messageId: EXIT, trackedFileBackups: { 'lib\\c.js': { backupFileName: 'cccc@v2', realParentDir: path.join(proj, 'lib') } } }, isSnapshotUpdate: true }
  ];
  fs.writeFileSync(path.join(home, 'projects', slug, SID + '.jsonl'), L.map(x => JSON.stringify(x)).join('\n') + '\nnot json\n');
  return { root, proj, home, slug, hist };
}

test('parse:快照 + delta 合成「那一刻」;isSnapshotUpdate 合进同一条;只认第一条 delta', () => {
  const f = fixture();
  const p = ck.parse(fs.readFileSync(path.join(f.home, 'projects', f.slug, SID + '.jsonl'), 'utf8'));
  assert.equal(p.cwd, f.proj);
  assert.deepEqual(p.snaps.map(s => s.id), [Q1, Q2, EXIT]);
  assert.deepEqual(p.snaps[0].files, { 'a.txt': { backup: 'aaaa@v1', dir: f.proj }, 'b.txt': { backup: null, dir: f.proj } });
  assert.equal(p.snaps[1].prompt, '/fix 再改');
  assert.ok('lib\\c.js' in p.snaps[1].files);
  assert.equal(p.snaps[2].prompt, null);
  assert.deepEqual(Object.keys(p.snaps[2].files).sort(), ['a.txt', 'b.txt', 'lib\\c.js']);
});

test('list:每个检查点只列这一轮动过的文件,新 / 改 / 删 分对;/exit 不算检查点;新的在上', async () => {
  const f = fixture();
  const r = await ck.list(path.join(f.home, 'projects'), f.home, f.slug, SID);
  assert.deepEqual(r.items.map(i => i.id), [Q2, Q1]);
  const [q2, q1] = r.items;
  assert.equal(q1.prompt, '改 a.txt,新建 b.txt');
  assert.deepEqual(q1.files.map(x => [x.key, x.kind]).sort(), [['a.txt', '改'], ['b.txt', '新']]);
  assert.deepEqual(q2.files.map(x => [x.key, x.kind]).sort(), [['a.txt', '改'], ['b.txt', '删'], ['lib\\c.js', '新']]);
  // 子目录里的文件拼对了绝对路径(不是 proj\lib\lib\c.js)
  assert.equal(q2.files.find(x => x.key === 'lib\\c.js').abs, path.join(f.proj, 'lib', 'c.js'));
});

test('list:最后一个检查点跟磁盘比 —— 没再动过的不列', async () => {
  const f = fixture();
  // 去掉 /exit 快照:Q2 成了最后一个,只能跟磁盘比
  const jf = path.join(f.home, 'projects', f.slug, SID + '.jsonl');
  fs.writeFileSync(jf, fs.readFileSync(jf, 'utf8').split('\n').filter(l => !l.includes(EXIT)).join('\n'));
  fs.writeFileSync(path.join(f.proj, 'a.txt'), 'v2 被改过\n');      // 和 Q2 那一刻一样 → 不列
  fs.writeFileSync(path.join(f.proj, 'b.txt'), 'new\n');
  const q2 = (await ck.list(path.join(f.home, 'projects'), f.home, f.slug, SID)).items[0];
  assert.deepEqual(q2.files.map(x => [x.key, x.kind]), [['lib\\c.js', '新']]);
});

test('diff:这一轮的改动(没有 git 时给一句说明,不抛)', async () => {
  const f = fixture();
  const d = await ck.diff(path.join(f.home, 'projects'), f.home, f.slug, SID, Q1, 'a.txt', path.join(f.root, 'tmp'));
  if (d.startsWith('(没能生成对比')) return;
  assert.match(d, /^-v1 原始内容$/m);
  assert.match(d, /^\+v2 被改过$/m);
  const nb = await ck.diff(path.join(f.home, 'projects'), f.home, f.slug, SID, Q1, 'b.txt', path.join(f.root, 'tmp'));
  assert.match(nb, /^\+new$/m);
  assert.equal(await ck.diff(path.join(f.home, 'projects'), f.home, f.slug, SID, Q1, 'nope.txt', path.join(f.root, 'tmp')), '(找不到这个检查点或文件)');
});

test('回退前备份 → 撤销:改过的放回去,原来没有的删掉', async () => {
  const f = fixture();
  const bk = path.join(f.root, 'rewind-backups');
  const bid = await ck.backupBeforeRewind(path.join(f.home, 'projects'), f.home, f.slug, SID, Q1, bk, 123);
  assert.equal(bid, '123');
  // 模拟官方回退把文件弄回 Q1 那一刻:a = v1,c 被删,b 不存在
  fs.writeFileSync(path.join(f.proj, 'a.txt'), 'v1 原始内容\n');
  fs.unlinkSync(path.join(f.proj, 'lib', 'c.js'));
  fs.writeFileSync(path.join(f.proj, 'b.txt'), '回退时冒出来的');
  const r = await ck.undoRewind(bk, bid);
  assert.equal(fs.readFileSync(path.join(f.proj, 'a.txt'), 'utf8'), 'v3 第二轮\n');
  assert.equal(fs.readFileSync(path.join(f.proj, 'lib', 'c.js'), 'utf8'), 'c\n');
  assert.equal(fs.existsSync(path.join(f.proj, 'b.txt')), false);
  assert.deepEqual(r, { restored: 2, removed: 1, skipped: [] });   // 没记过回退后的指纹(老备份):照原来的做法全部放回
  await assert.rejects(ck.undoRewind(bk, '../x'));
});

// 2026-11-17 自查:原来「没成功 = 文件没动」就删备份。可超时时 claude 可能已经回退了一半,
// 删了备份就再也撤销不了。现在只有 claude 在动手前就拒绝了才删,其余一律留着。
test('回退结果分类:只有「动手前就拒绝」才算文件没动;超时 / 中途出错 / 看不懂都要留备份', () => {
  const c = (o) => ck.classifyRewind(Object.assign({ err: null, stdout: '', stderr: '', timedOut: false }, o)).state;
  const fail = { code: 1 };
  assert.equal(c({ stdout: `Files rewound to state at message ${Q1}` }), 'ok');
  assert.equal(c({ err: fail, stderr: 'Error: File rewinding is not enabled.' }), 'untouched');
  assert.equal(c({ err: fail, stderr: 'No file checkpoint found for this message.' }), 'untouched');
  assert.equal(c({ err: fail, stderr: 'Error: --rewind-files requires a user message UUID, but x is not a user message in this session' }), 'untouched');
  assert.equal(c({ err: fail, stderr: `No conversation found with session ID: ${SID}` }), 'untouched');
  assert.equal(c({ err: fail, stderr: "'claude' is not recognized as an internal or external command" }), 'untouched');
  assert.equal(c({ err: { killed: true }, timedOut: true, stdout: 'Files rewound' }), 'unsure');   // 超时:哪怕输出里有 rewound
  assert.equal(c({ err: fail, stderr: 'Failed to rewind: EBUSY: resource busy or locked' }), 'unsure');
  assert.equal(c({ err: fail, stderr: '' }), 'unsure');
  assert.equal(c({ stdout: '???' }), 'unsure');
});

test('只认 UUID / 合法 slug;官方回退命令长这样', async () => {
  assert.equal(ck.rewindCommand(SID, Q1), `claude --resume "${SID}" --rewind-files "${Q1}"`);
  assert.throws(() => ck.rewindCommand(SID, 'x" & del *'));
  assert.throws(() => ck.rewindCommand('abc', Q1));
  await assert.rejects(ck.list('/p', '/h', '..\\..', SID));
  await assert.rejects(ck.list('/p', '/h', 'ok', '../../etc'));
});

// 2026-11-17 自查(审查第 7 条):撤销时会删掉「回退前不存在」的文件、覆盖改过的文件 ——
// 回退之后人又新建 / 改过的,也一起被删 / 被盖。现在回退刚做完就记下每个文件的指纹,撤销时指纹对不上的不碰。
test('撤销回退:回退之后又被改过 / 新建的文件不碰,其余照常放回', async () => {
  const f = fixture();
  const bk = path.join(f.root, 'rewind-backups');
  const P2 = path.join(f.home, 'projects');
  const bid = await ck.backupBeforeRewind(P2, f.home, f.slug, SID, Q1, bk, 456);
  // 官方回退的结果:a = v1,c 被删,b 不存在
  fs.writeFileSync(path.join(f.proj, 'a.txt'), 'v1 原始内容\n');
  fs.unlinkSync(path.join(f.proj, 'lib', 'c.js'));
  await ck.recordAfterRewind(bk, bid);
  // 回退之后人又动了:新建了 b.txt、改了 a.txt;c.js 没动
  fs.writeFileSync(path.join(f.proj, 'b.txt'), '我后来新建的');
  fs.writeFileSync(path.join(f.proj, 'a.txt'), '我后来改的');
  const r = await ck.undoRewind(bk, bid);
  assert.equal(fs.readFileSync(path.join(f.proj, 'b.txt'), 'utf8'), '我后来新建的');
  assert.equal(fs.readFileSync(path.join(f.proj, 'a.txt'), 'utf8'), '我后来改的');
  assert.equal(fs.readFileSync(path.join(f.proj, 'lib', 'c.js'), 'utf8'), 'c\n');   // 没被动过的照常放回
  assert.equal(r.restored, 1);
  assert.equal(r.removed, 0);
  assert.deepEqual(r.skipped.map(p => path.basename(p)).sort(), ['a.txt', 'b.txt']);
});

