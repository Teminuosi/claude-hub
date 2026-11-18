// Claude 总控客户端 - Electron 主进程
const { app, BrowserWindow, ipcMain, shell, clipboard, dialog } = require('electron');
const { spawn, exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const data = require('./lib/data');
const notify = require('./lib/notify');
const usage = require('./lib/usage');
const search = require('./lib/search');
const git = require('./lib/git');
const P = require('./lib/paths');
const discover = require('./lib/discover');
const agentApi = require('./lib/agent-api');
const agents = require('./lib/agents');
const ckpt = require('./lib/checkpoints');
const mcp = require('./lib/mcp');
const claudeCli = require('./lib/claude-cli');
const sysProxy = require('./lib/sysproxy').create();
const { writeJsonAtomic } = require('./lib/atomic-json');
const SETTINGS = P.CLAUDE_SETTINGS;

// 数据文件放用户数据目录(每台机器自己的),路径全部动态推导,不写死任何人的机器
const HUB_HOME = P.APP_DATA;
const CFG = P.NOTIFY_CFG;
// 给界面的完成流条数。和钩子里的 FEED_KEEP(hooks/claude-notify-hook.js)对齐 ——
// 文件本来就只留这么多行,读全不花额外成本。
// 以前是 30:一个会话聊 21 轮就占掉 21 条,4 个会话就把窗口塞满了,更早的未读会话直接
// 从抽屉里消失,只剩铃铛上一个点不掉的数字(2026-11-05 的 bug)。
const FEED_UI = 100;
let win = null;

// AppUserModelID:任务栏图标归组、跳转列表都认它。
// (本来是为系统通知加的,2026-11-03 通知改成应用内提示卡了,但这条得留着,
//  去掉会让任务栏把它当成另一个程序。)必须在 app ready 之前设,放这儿最稳。
try { if (process.platform === 'win32') app.setAppUserModelId('com.sanyue.claude-hub'); } catch {}

// ---------- 通知:钩子文件同步 + 窗口在场状态 + 铃铛提示卡 ----------
const HOOK_SRC = path.join(__dirname, 'hooks', 'claude-notify-hook.js');
const HOOK_DST = path.join(P.HOOKS_DIR, 'claude-notify-hook.js');
const PRESENCE = path.join(HUB_HOME, 'presence.json');
const TOAST_PENDING = path.join(HUB_HOME, 'toast-pending.json');

// 钩子跑在 asar 外面,所以得把它拷出去。每次启动比内容,改了就覆盖,装的永远是最新版。
function syncHookFile() {
  try {
    const src = fs.readFileSync(HOOK_SRC, 'utf8');
    let dst = null;
    try { dst = fs.readFileSync(HOOK_DST, 'utf8'); } catch {}
    if (dst === src) return { ok: true, changed: false };
    fs.mkdirSync(path.dirname(HOOK_DST), { recursive: true });
    fs.writeFileSync(HOOK_DST, src, 'utf8');
    return { ok: true, changed: true };
  } catch (err) { return { ok: false, msg: String(err.message || err) }; }
}

// 钩子靠这个判断"他正盯着这个会话呢,别打扰"
let activeSid = '';
function writePresence() {
  try {
    fs.mkdirSync(HUB_HOME, { recursive: true });
    fs.writeFileSync(PRESENCE, JSON.stringify({
      focused: !!(win && !win.isDestroyed() && win.isFocused()),
      sid: activeSid, at: Date.now()
    }), 'utf8');
  } catch {}
}

// 钩子判定"在等你"时会落一个 toast-pending.json,这里把它变成界面右上角铃铛下的提示卡。
//
// 2026-11-03 改掉了 Windows 系统通知:三月原话「系统通知弹框去了吧,点击也没用」。
// 这台 Win11 上 toast 的点击激活本来就是死路(reminder/普通场景、正文/按钮都试过不触发),
// 所以它只剩"弹一下"的作用,还占着系统通知中心。现在改成应用内卡片,点得动、能直达会话。
// 代价照实说:窗口最小化或被挡住时看不见这张卡,那种场景靠任务栏闪烁 + Telegram。
//
// 这条链路上出过的问题全是"猜不出到底哪一步没走",所以每一步都记进 notify.log
// (设置里「钩子体检」就能看),下次排查有据可依。
function toastLog(msg) {
  try {
    fs.appendFileSync(path.join(P.HOOKS_DIR, 'notify.log'),
      new Date().toLocaleString('sv-SE') + ' [toast] ' + msg + '\n', 'utf8');
  } catch {}
}

function popPendingToast() {
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(TOAST_PENDING, 'utf8')); } catch { return; }
  try { fs.unlinkSync(TOAST_PENDING); } catch {}
  if (!rec) return;
  const tag = (rec.proj || '?') + ' sid=' + String(rec.sid || '').slice(0, 8);
  if (!win || win.isDestroyed()) { toastLog('主窗口没了,这条提示卡没地方弹 ' + tag); return; }
  try {
    win.webContents.send('notify:pop', rec);
    toastLog('已派发提示卡 ' + tag);
    // 窗口不在前台时闪任务栏 —— 应用内的卡他看不见,得有个东西把他叫过来
    if (!win.isFocused()) win.flashFrame(true);
  } catch (e) { toastLog('派发提示卡失败 ' + tag + ' ' + (e && e.message)); }
}

// ---------- 小九/外部代理本机控制 API ----------
const AGENT_CFG = path.join(HUB_HOME, 'agent-api.json');
const AGENT_TASKS = path.join(HUB_HOME, 'agent-tasks');
let agentServer = null, agentService = null;
let agentState = { ok: false, host: '127.0.0.1', port: 8765, error: '' };

function loadAgentConfig() {
  let cfg = null, existed = false;
  try {
    const raw = fs.readFileSync(AGENT_CFG, 'utf8');
    existed = true;
    cfg = JSON.parse(raw.replace(/^﻿/, ''));      // 有些编辑器 / PowerShell 存盘会带 BOM,不去掉就解析失败
  } catch {}
  if (!cfg || !cfg.token) {
    // 新装的电脑(配置文件根本不存在)默认**不开**这个接口:普通用户用不到,没必要每台电脑都多开一个本机端口。
    // 要用的人把配置文件里的 enabled 改成 true 再重启。
    // 文件在、但读坏了或缺 token(老用户手改出了岔子):照老规矩重建成**开着**的 —— 不能因为换了默认值把人家的接口悄悄关掉。
    cfg = { enabled: existed, host: '127.0.0.1', port: 8765, token: crypto.randomBytes(32).toString('hex') };
  }
  // 安全铁律:机器控制 API 永远只监听回环地址,配置文件也不能把它改成公网。
  cfg.host = '127.0.0.1';
  cfg.port = Math.max(1024, Math.min(65535, Number(cfg.port) || 8765));
  cfg.enabled = cfg.enabled !== false;
  fs.mkdirSync(HUB_HOME, { recursive: true });
  writeJsonAtomic(AGENT_CFG, cfg);
  return cfg;
}

function loadAgentTasks() {
  try {
    fs.mkdirSync(AGENT_TASKS, { recursive: true });
    return fs.readdirSync(AGENT_TASKS)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(AGENT_TASKS, f), 'utf8')); } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 200);
  } catch { return []; }
}

function persistAgentTask(task) {
  try {
    fs.mkdirSync(AGENT_TASKS, { recursive: true });
    writeJsonAtomic(path.join(AGENT_TASKS, task.id + '.json'), task);
  } catch (error) {
    const visible = Object.assign({}, task, {
      persistenceError: `任务快照写入失败: ${String(error && error.message ? error.message : error)}`
    });
    try { if (win && !win.isDestroyed()) win.webContents.send('agent:task', visible); } catch {}
    throw error;
  }
  try { if (win && !win.isDestroyed()) win.webContents.send('agent:task', task); } catch {}
}

function agentStatus() {
  const tasks = agentService ? agentService.list() : [];
  return Object.assign({}, agentState, {
    configPath: AGENT_CFG,
    queued: tasks.filter(t => t.status === 'queued').length,
    running: tasks.filter(t => t.status === 'running').length,
    latest: tasks[0] || null
  });
}

async function startAgentControl() {
  const cfg = loadAgentConfig();
  agentState = { ok: false, host: cfg.host, port: cfg.port, error: '', enabled: cfg.enabled };
  if (!cfg.enabled) return agentState;
  // 老规矩不变(npm 那个 claude.cmd → 否则按 PATH 找 claude.cmd);只给「只用官方安装器装的电脑」多一条兜底。
  // 异步 + 限时:这里在启动路径上,同步扫 PATH 遇到连不上的网络路径会把窗口冻住。
  const runner = agentApi.createClaudeRunner({
    claudeCmd: await claudeCli.agentClaudeCmd(),
    // 自动化接口跑的也是 claude、也要联网:每次任务开始时按当时的系统代理算环境(和终端同一套规矩)
    envFn: async () => (await sysProxy.envFor(process.env)).env,
    timeoutMs: 30 * 60e3
  });
  agentService = agentApi.createTaskService({
    runClaude: runner,
    persist: persistAgentTask,
    initialTasks: loadAgentTasks(),
    fileExists: p => { try { return fs.statSync(p).isFile(); } catch { return false; } },
    isProjectAllowed: p => {
      const key = String(p || '').replace(/[\\/]+$/, '').toLowerCase();
      try { return data.getProjects().some(x => String(x.path || '').replace(/[\\/]+$/, '').toLowerCase() === key); }
      catch { return false; }
    }
  });
  try {
    agentServer = await agentApi.startAgentApiServer({
      host: cfg.host, port: cfg.port, token: cfg.token,
      service: agentService,
      // named(改过名的会话)是给左栏筛选用的,不往接口外带 —— 接口字段保持原样
      getProjects: () => data.getProjects().map(({ named, ...rest }) => rest),
      getSessions: projectPath => {
        const key = String(projectPath || '').replace(/[\\/]+$/, '').toLowerCase();
        const projects = data.getProjects();
        const project = projects.find(p => String(p.path || '').replace(/[\\/]+$/, '').toLowerCase() === key);
        if (!project) throw new Error('projectPath不在ClaudeHub项目清单中');
        const shared = projects.filter(p => p.sessSlug === project.sessSlug).length > 1;
        return data.getSessions(project.sessSlug, project.mainSession, project.path, shared);
      }
    });
    agentState = { ok: true, enabled: true, host: agentServer.host, port: agentServer.port, error: '' };
  } catch (error) {
    agentState.error = String(error && error.message ? error.message : error);
  }
  try { if (win && !win.isDestroyed()) win.webContents.send('agent:status', agentStatus()); } catch {}
  return agentState;
}

// ---------- 内嵌终端(node-pty, N-API 跨ABI) ----------
let pty = null;
try { pty = require('@lydell/node-pty'); } catch (e) { console.error('pty load fail:', e); }
const terms = new Map();
const termMeta = new Map();   // id -> { projPath, short, sid, title, buf }  buf=最近输出,手机接入时回放
const mobile = require('./lib/mobile');
const tunnel = require('./lib/tunnel');

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900,
    // 石墨底 —— 和界面的 --bg1 一致,窗口刚出来那一瞬间不会闪一下旧的蓝黑
    backgroundColor: '#171b20',
    title: 'Claude 总控',
    icon: path.join(__dirname, 'build', 'icon.ico'),   // Claude 官方星芒
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile('index.html');
  // 任务栏闪烁一直没人关掉过 —— 人回来点窗口就该停,不然它永远闪着
  win.on('focus', () => { try { win.flashFrame(false); } catch {} writePresence(); });
  win.on('blur', writePresence);
  win.on('show', writePresence);
}

if (process.argv.includes('--pty-test')) {
  // 无头自检:验证 pty 在 Electron 里能拉起进程并回读输出
  app.whenReady().then(() => {
    const out = path.join(__dirname, 'design-ref', 'pty-test.txt');
    if (!pty) { fs.writeFileSync(out, 'PTY LOAD FAIL'); app.exit(0); return; }
    let buf = '';
    try {
      const p = pty.spawn('cmd.exe', ['/c', 'echo PTY_OK_12345'], { name: 'xterm', cols: 80, rows: 24, cwd: __dirname, env: process.env });
      p.onData(d => buf += d);
      p.onExit(() => { try { fs.writeFileSync(out, buf); } catch {} app.exit(0); });
      setTimeout(() => { try { fs.writeFileSync(out, 'TIMEOUT:' + buf); } catch {} app.exit(0); }, 8000);
    } catch (err) { fs.writeFileSync(out, 'SPAWN FAIL:' + err); app.exit(0); }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (process.argv.includes('--pty-test')) {
  // 自检模式不走正常窗口流程
} else if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    // 首次启动:把旧版固定目录的数据搬到用户数据目录;没有项目清单就自动扫描生成
    try { P.migrateOnce(); } catch {}
    try { discover.ensureProjects(); } catch {}
    try { syncHookFile(); } catch {}      // 把通知钩子拷到 ~/.claude/hooks(asar 外)
    createWindow();
    writePresence();
    auth.restore().then(pushAuth, () => {});   // 有登录令牌就悄悄续期;不等它,连不上也不影响启动
    // 启动仅限本机的小九/自动化控制 API；失败不影响桌面总控正常使用。
    startAgentControl().catch(error => { agentState.error = String(error && error.message ? error.message : error); });
    // 盯完成流:有新完成 -> 推给界面 + 任务栏闪烁 + 刷新用量
    try {
      fs.watchFile(data.FEED, { interval: 2000 }, () => {
        if (!win || win.isDestroyed()) return;
        win.webContents.send('feed:update', data.getFeed(FEED_UI));
        setTimeout(() => { try { if (win && !win.isDestroyed()) win.webContents.send('usage:update', usage.aggregates()); } catch {} }, 1500);
        if (!win.isFocused()) win.flashFrame(true);
        popPendingToast();     // 钩子判成"在等你"的话,这儿变成右上角那张提示卡
      });
    } catch {}
    // 后台预热用量缓存(逐文件,不阻塞),完了推给界面
    setTimeout(() => {
      try {
        const dirs = data.getProjects().map(p => path.join(data.CLAUDE_PROJECTS, p.sessSlug)).filter(d => fs.existsSync(d));
        usage.warmup(dirs, () => {
          try { if (win && !win.isDestroyed()) win.webContents.send('usage:update', usage.aggregates()); } catch {}
          // 预热完再一次性回填「实测压缩点」(只写 ac/acPre/lastCtx,不碰用量数字)。
          // 账本里条目带了 ac 字段就不再扫它,所以整体只跑一次 ——
          // 顺序必须是「warmup 完了再回填」:队列只收账本里已有的条目,预热先把会话收进账本。
          try { usage.backfillCompactPoints(dirs, (found, total) => { console.log('[ctx] 回填实测压缩点:' + found + '/' + total); }); } catch {}
        });
      } catch {}
    }, 3000);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    try { if (agentServer) agentServer.close(); } catch {}
    // ⚠️ 账本是 800ms 防抖落盘的,退出时那一拍很可能还没落 —— 直接丢。
    // 而且写失败时「下一拍再试」只在后面还有人调 save() 的前提下才成立,退出就没有下一拍了。
    // 所以这里强制落一次(同步,只有 260KB)。第六轮验收 P2-3。
    try { usage.saveNow(); } catch {}
  });
}

// ---------- IPC ----------
const { ipcMain: _im } = require('electron');
_im.on('win:ctl', (e, a) => {
  if (!win) return;
  if (a === 'min') win.minimize();
  else if (a === 'max') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  else if (a === 'close') win.close();
});
ipcMain.handle('hub:projects', () => data.getProjects());
ipcMain.handle('agent:status', () => agentStatus());
ipcMain.handle('agent:tasks', () => agentService ? agentService.list() : []);
ipcMain.handle('agent:cancel', (e, id) => ({ ok: !!(agentService && agentService.cancel(String(id || ''))) }));
ipcMain.handle('hub:sessions', (e, sessSlug, mainSession, projPath) => {
  // 只有多个项目共用同一个会话目录时才严格按 cwd 分账(中文目录名会撞车)
  let shared = false;
  try { shared = data.getProjects().filter(p => p.sessSlug === sessSlug).length > 1; } catch {}
  return data.getSessions(sessSlug, mainSession, projPath, shared);
});
ipcMain.handle('hub:memory', (e, memSlug) => data.getMemory(memSlug));
ipcMain.handle('hub:memfile', (e, memSlug, file) => data.readMemoryFile(memSlug, file));
ipcMain.handle('hub:feed', () => data.getFeed(FEED_UI));
ipcMain.handle('hub:projdocs', (e, projPath) => data.getProjectDocs(projPath));
ipcMain.handle('hub:renameSession', (e, sid, title) => {
  try { return { ok: data.setCustomTitle(sid, title) }; } catch (err) { return { ok: false, msg: String(err) }; }
});
// Claude Code 自己那套会话名(会话之间互相喊的就是这个名字)。
// 它存在 ~/.claude/sessions/<pid>.json 里,和总控台的会话备注名是两套东西:
//   总控台改名  -> %APPDATA%\claude-hub\session-titles.json,只给他自己看
//   /rename 改名 -> 这里的 name 字段,别的会话 @ 它用的就是这个
// nameSource: derived=按目录名自动起的(comfyui-74 那种) / user=/rename 设的 / auto=模型起的
ipcMain.handle('hub:ccSessions', () => {
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  const out = {};
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!j || !j.sessionId || !j.name) continue;
    // 同一个 sessionId 可能有旧进程留下的陈记录,留 updatedAt 最新的那条
    const old = out[j.sessionId];
    if (old && (old.updatedAt || 0) >= (j.updatedAt || 0)) continue;
    out[j.sessionId] = {
      name: j.name, nameSource: j.nameSource || '', pid: j.pid || 0,
      status: j.status || '', cwd: j.cwd || '', updatedAt: j.updatedAt || 0
    };
  }
  return out;
});
ipcMain.handle('hub:usage', () => { try { return usage.aggregates(); } catch { return null; } });
// 当前会话上下文占用(瞬时值,离自动压缩还有多远)。usage.js 里带 2 秒缓存,顶栏定时调不会反复读盘。
ipcMain.handle('hub:ctxNow', (e, sessSlug, sid, remindAt) => { try { return usage.liveContext(sessSlug, sid, remindAt); } catch { return null; } });
// —— 全局搜索 / Git / 可写编辑 / MCP / 提示词 ——
ipcMain.handle('hub:search', (e, q, opt) => {
  try { return search.searchSessions(data.getProjects(), q, opt || {}); }
  catch (err) { return { hits: [], scanned: 0, took: 0, err: String(err) }; }
});
ipcMain.handle('hub:gitStatus', async (e, cwd) => { try { return await git.status(cwd); } catch { return { repo: false }; } });
ipcMain.handle('hub:gitDiff', async (e, cwd, file) => { try { return await git.diff(cwd, file); } catch { return ''; } });
ipcMain.handle('hub:writeMem', (e, slug, file, c) => data.writeMemoryFile(slug, file, c));
ipcMain.handle('hub:delMem', (e, slug, file) => data.deleteMemoryFile(slug, file));
ipcMain.handle('hub:writeProjFile', (e, p, rel, c) => data.writeProjectFile(p, rel, c));
ipcMain.handle('hub:createSkill', (e, p, name, c) => data.createSkill(p, name, c));
// 斜杠命令(全局 ~/.claude/commands · 项目 .claude/commands)
ipcMain.handle('hub:commands', (e, projPath) => data.getCommands(projPath));
ipcMain.handle('hub:globalSkills', () => data.getGlobalSkills());
ipcMain.handle('hub:claudeHome', () => P.CLAUDE_HOME);
// 开着的会话列表(同步落盘,强杀不丢)
ipcMain.handle('hub:getOpenTabs', () => data.getOpenTabs());
ipcMain.handle('hub:saveOpenTabs', (e, tabs, active) => {
  // 顺手记下他正在看哪个会话,钩子据此决定"要不要打扰"
  activeSid = String(active || '');
  writePresence();
  return data.saveOpenTabs(tabs, active);
});
// 全局规矩(~/.claude/CLAUDE.md 与 ~/.claude/rules/*.md)
ipcMain.handle('hub:globalDocs', () => data.getGlobalDocs());
ipcMain.handle('hub:readGlobalDoc', (e, rel) => data.readGlobalDoc(rel));
ipcMain.handle('hub:writeGlobalDoc', (e, rel, c) => data.writeGlobalDoc(rel, c));
// 用系统默认浏览器打开进阶手册(想打印/收藏时用)
ipcMain.handle('hub:openDoc', () => { try { shell.openPath(path.join(__dirname, 'docs', 'guide.html')); return true; } catch { return false; } });
ipcMain.handle('hub:readCmd', (e, scope, name, projPath) => data.readCommand(scope, name, projPath));
ipcMain.handle('hub:writeCmd', (e, scope, name, c, projPath) => data.writeCommand(scope, name, c, projPath));
ipcMain.handle('hub:delCmd', (e, scope, name, projPath) => data.deleteCommand(scope, name, projPath));
ipcMain.handle('hub:mcpList', (e, p) => { try { return data.listMcp(p); } catch { return []; } });
ipcMain.handle('hub:getPrompts', () => data.getPrompts());
ipcMain.handle('hub:savePrompts', (e, l) => data.savePrompts(l));
// 自定义 Agent(和上面 agent:* 的小九 API 是两回事)。数据只在 APP_DATA,不碰 ~/.claude。
ipcMain.handle('agents:list', () => agents.load(P.AGENTS));
ipcMain.handle('agents:save', async (e, list) => { try { return await agents.save(P.AGENTS, list); } catch (err) { return { ok: false, msg: String(err) }; } });
// MCP 页:读配置文件给界面看;增删一律走官方 claude mcp add-json / remove(lib/mcp.js)。env/headers 的值不出主进程
const mcpCwd = (p) => (typeof p === 'string' && path.isAbsolute(p)) ? p : undefined;
async function mcpRun(args, projPath, timeout) {
  const { env } = await termEnv();
  return mcp.runClaude(args, { cwd: mcpCwd(projPath), env: claudeCli.withClaudeOnPath(env), runDir: P.MCP_RUNS, timeout });
}
ipcMain.handle('mcp:config', async (e, projPath) => {
  try { return Object.assign({ ok: true }, await mcp.readConfig(P.CLAUDE_JSON, mcpCwd(projPath))); }
  catch (err) { return { ok: false, msg: String(err && err.message || err) }; }
});
ipcMain.handle('mcp:status', async (e, projPath) => {
  try {
    const r = await mcpRun(['mcp', 'list'], projPath, 90000);
    return { ok: true, list: mcp.parseList(r.out), timedOut: r.timedOut, raw: r.ok ? '' : r.out.slice(-600) };
  } catch (err) { return { ok: false, msg: String(err && err.message || err) }; }
});
// items: [{ name, scope, form? | json? }] —— 一条条加,每条报结果
ipcMain.handle('mcp:add', async (e, req) => {
  const results = [];
  try {
    const scope = req && req.scope;
    let items;
    if (req && req.mode === 'json') items = mcp.parsePasted(req.json, req.name).map(x => ({ name: x.name, cfg: x.cfg }));
    else items = [{ name: req && req.name, cfg: mcp.buildConfig((req && req.form) || {}) }];
    for (const it of items) {
      let args;
      try { args = mcp.addArgs(it.name, scope, it.cfg); } catch (err) { results.push({ name: it.name, ok: false, msg: err.message }); continue; }
      const r = await mcpRun(args, req.projPath, 60000);
      results.push({ name: it.name, ok: r.ok, msg: r.out.slice(-400) });
    }
    return { ok: results.every(r => r.ok), results };
  } catch (err) { return { ok: false, msg: String(err && err.message || err), results }; }
});
ipcMain.handle('mcp:remove', async (e, name, scope, projPath) => {
  try { const r = await mcpRun(mcp.removeArgs(name, scope), projPath, 60000); return { ok: r.ok, msg: r.out.slice(-400) }; }
  catch (err) { return { ok: false, msg: String(err && err.message || err) }; }
});
ipcMain.handle('mcp:desktop', async () => {
  const r = await mcp.readDesktop(P.CLAUDE_DESKTOP_CFG);
  return r.ok ? { ok: true, servers: r.servers.map(s => s.sum) } : r;
});
ipcMain.handle('mcp:importDesktop', async (e, names, scope, projPath) => {
  const r = await mcp.readDesktop(P.CLAUDE_DESKTOP_CFG);
  if (!r.ok) return r;
  const results = [];
  for (const s of r.servers.filter(x => Array.isArray(names) && names.includes(x.name))) {
    let args;
    try { args = mcp.addArgs(s.name, scope, s.cfg); } catch (err) { results.push({ name: s.name, ok: false, msg: err.message }); continue; }
    const x = await mcpRun(args, projPath, 60000);
    results.push({ name: s.name, ok: x.ok, msg: x.out.slice(-400) });
  }
  return { ok: results.every(x => x.ok), results };
});
// 检查点:读 Claude Code 自己的文件检查点(只读);回退走官方 claude --rewind-files,回退前先备份,能撤销
ipcMain.handle('ckpt:list', async (e, slug, sid) => {
  try { return Object.assign({ ok: true }, await ckpt.list(P.CLAUDE_PROJECTS, P.CLAUDE_HOME, slug, sid)); }
  catch (err) { return { ok: false, msg: err && err.code === 'ENOENT' ? '找不到这个会话的记录' : String(err && err.message || err) }; }
});
ipcMain.handle('ckpt:diff', async (e, slug, sid, id, key) => {
  try { return await ckpt.diff(P.CLAUDE_PROJECTS, P.CLAUDE_HOME, slug, sid, id, String(key || ''), P.CKPT_TMP); }
  catch (err) { return '(没能生成对比:' + String(err && err.message || err) + ')'; }
});
ipcMain.handle('ckpt:rewind', async (e, slug, sid, id) => {
  let bid = '';
  try {
    const { cwd } = await ckpt.list(P.CLAUDE_PROJECTS, P.CLAUDE_HOME, slug, sid);
    bid = await ckpt.backupBeforeRewind(P.CLAUDE_PROJECTS, P.CLAUDE_HOME, slug, sid, id, P.REWIND_BACKUPS);
    const { env } = await termEnv();
    const r = await ckpt.runRewind(sid, id, cwd, claudeCli.withClaudeOnPath(env));
    const backupDir = path.join(P.REWIND_BACKUPS, bid);
    // 只有 claude 在动手前就拒绝了(untouched)才能确定文件没动、删掉备份;
    // 超时 / 中途出错 / 看不懂(unsure)文件可能已经回退了一部分 —— 备份留着,界面照样给「撤销」
    if (r.state === 'untouched') {
      try { await fs.promises.rm(backupDir, { recursive: true, force: true }); } catch {}
      return { ok: false, msg: r.msg || '回退没有成功' };
    }
    // 记下回退后的样子:撤销时认得出「回退之后又被改过」的文件,不去覆盖/删除它们。记不成就按老办法撤销(拿不准就放行)
    try { await ckpt.recordAfterRewind(P.REWIND_BACKUPS, bid); } catch {}
    if (r.state === 'unsure') return { ok: false, unsure: true, bid, backupDir, msg: r.msg || '没能确认回退结果' };
    return { ok: true, bid, msg: r.msg, backupDir };
  } catch (err) { return { ok: false, msg: String(err && err.message || err) }; }
});
ipcMain.handle('ckpt:undo', async (e, bid) => {
  try { return Object.assign({ ok: true }, await ckpt.undoRewind(P.REWIND_BACKUPS, bid)); }
  catch (err) { return { ok: false, msg: String(err && err.message || err) }; }
});
// 运行:按 id 从磁盘取那一条(不信界面传来的内容),写参数文件,返回终端要执行的命令,顺手记一次运行
ipcMain.handle('agents:launch', async (e, id, projPath) => {
  try {
    const cur = await agents.load(P.AGENTS);
    const a = cur.list.find(x => x.id === id);
    if (!a) return { ok: false, msg: cur.broken ? cur.msg : '没有这个 Agent' };
    const cmd = agents.writeLaunch(P.AGENT_RUNS, a);
    try { await agents.recordRun(P.AGENTS, id, projPath); } catch {}
    return { ok: true, cmd };
  } catch (err) { return { ok: false, msg: String(err) }; }
});
ipcMain.handle('hub:usageDaily', () => { try { return usage.dailySeries(30); } catch { return []; } });
ipcMain.handle('hub:exportCsv', async () => {
  try {
    const rows = usage.exportRows();
    const r = await dialog.showSaveDialog(win, { title: '导出用量 CSV', defaultPath: 'claude-usage-' + Date.now() + '.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    fs.writeFileSync(r.filePath, '﻿' + rows, 'utf8');   // BOM 让 Excel 认中文
    return { ok: true, path: r.filePath };
  } catch (e2) { return { ok: false, msg: String(e2) }; }
});
// 官方订阅额度:跑一次 claude -p "/usage" 解析百分比(唯一能拿到官方口径的路子)
let quotaCache = { at: 0, data: null };
ipcMain.handle('hub:quota', async (e, force) => {
  if (!force && quotaCache.data && Date.now() - quotaCache.at < 60e3) return quotaCache.data;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) { if (!/^CLAUDE_?CODE/i.test(k)) env[k] = v; }
  // 查额度也是跑 claude、也要联网:和终端一样跟着系统代理走(envFor 永不抛)。
  // 要等的放在 new Promise 外面等 —— 执行器写成 async 的话,里面一抛错这个 Promise 就永远挂着。
  const px = await sysProxy.envFor(env);
  return new Promise((resolve) => {
  exec('claude --no-session-persistence -p "/usage"', { timeout: 90000, env: claudeCli.withClaudeOnPath(px.env), maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
    const s = String(out || '');
    const pick = (re) => { const m = s.match(re); return m ? { pct: +m[1], reset: (m[2] || '').trim() } : null; };
    const d = {
      ok: /% used/.test(s),
      session: pick(/Current session:\s*(\d+)% used(?:\s*·\s*resets ([^\n(]+))?/i),
      week: pick(/Current week \(all models\):\s*(\d+)% used(?:\s*·\s*resets ([^\n(]+))?/i),
      fable: pick(/Current week \(Fable\):\s*(\d+)% used(?:\s*·\s*resets ([^\n(]+))?/i),
      at: Date.now()
    };
    quotaCache = { at: Date.now(), data: d };
    resolve(d);
  });
  });
});
ipcMain.handle('hub:timeline', (e, sessSlug, sid) => {
  try { return usage.sessionTimeline(path.join(data.CLAUDE_PROJECTS, sessSlug), sid, 200); } catch { return []; }
});
// ===== 手机控制台 =====
// 桥接:把主进程的项目/终端能力暴露给手机服务(手机服务本身不碰 Electron)
const mobileBridge = {
  state() {
    let projects = [], feed = [];
    try { projects = data.getProjects(); } catch {}
    try { feed = data.getFeed(12); } catch {}
    // 会话名他随时会改,终端标题是开终端那一刻抓下来的 —— 每次都重读,别端着老名字
    let titles = {};
    try { titles = JSON.parse(fs.readFileSync(P.TITLES, 'utf8')) || {}; } catch {}
    const running = {};
    for (const [id, m] of termMeta) running[m.projPath] = (running[m.projPath] || 0) + 1;
    return {
      projects: projects.map(p => ({
        short: p.short, path: p.path, sessCount: p.sessCount,
        running: running[p.path] || 0,
        status: running[p.path] ? 'run' : 'idle',
        unread: 0
      })),
      terminals: [...termMeta].map(([id, m]) => ({
        id,
        title: (m.sid && titles[m.sid]) || m.title || m.short,
        proj: m.short
      })),
      // projName = 钩子解析过的显示名(他改过的项目名);老记录没这字段就退回文件夹名
      feed: feed.map(f => ({
        proj: f.projName || f.proj,
        sess: f.sess || (f.sid && titles[f.sid]) || '',
        ts: f.ts, task: f.task, tok: f.tok
      }))
    };
  },
  history(id) { const m = termMeta.get(id); return m ? m.buf : ''; },
  write(id, d) { const p = terms.get(id); if (p) { try { p.write(d); } catch {} } },
  async open(projPath, short, sid, title) {
    if (!pty || !projPath) return { ok: false };
    // 先把要等的东西(终端环境)等好,再做「查重 → 开」。这两步之间不许有 await:
    // 手机上连点两下同一个会话时,两个请求会前后脚进来,中间有空档就会各开一个进程。
    const px = await termEnv();
    // 已经开着同一会话就直接复用
    for (const [id, m] of termMeta) {
      if (sid && m.sid === sid) return { ok: true, id };
      if (!sid && m.projPath === projPath) return { ok: true, id };
    }
    const r = spawnTermWith(px, projPath, title || short, sid || '', '');
    // 桌面端界面也同步显示这个新终端
    try { if (r.ok && win && !win.isDestroyed()) win.webContents.send('term:external', { id: r.id, projPath, short, sid: sid || '', title: title || short }); } catch {}
    return r;
  }
};

ipcMain.handle('mobile:qr', async (e, text) => {
  try { const QR = require('qrcode'); return await QR.toDataURL(text, { margin: 1, width: 240, color: { dark: '#111', light: '#fff' } }); }
  catch { return ''; }
});
ipcMain.handle('mobile:status', () => Object.assign(mobile.status(), { tunnel: tunnel.status() }));
ipcMain.handle('mobile:start', async (e, o) => {
  const r = await mobile.start(o || {}, mobileBridge);
  return r;
});
ipcMain.handle('mobile:stop', () => { tunnel.stop(); mobile.stop(); return { ok: true }; });
ipcMain.handle('mobile:regen', () => ({ ok: true, code: mobile.regenCode() }));
ipcMain.handle('mobile:kick', (e, prefix) => ({ ok: true, left: mobile.kick(prefix) }));
ipcMain.handle('mobile:readonly', (e, v) => { mobile.setReadonly(v); return { ok: true }; });
ipcMain.handle('mobile:tunnelStart', async (e, port) => {
  const r = await tunnel.start(port || 8730);
  return r;
});
ipcMain.handle('mobile:tunnelStop', () => { tunnel.stop(); return { ok: true }; });
ipcMain.handle('mobile:tunnelDownload', async () => {
  const r = await tunnel.download(pct => { try { if (win && !win.isDestroyed()) win.webContents.send('mobile:dlProgress', pct); } catch {} });
  return r;
});

// —— 自身自动更新(GitHub Releases + 国内免费镜像自动择优) ——
let updater = null;
ipcMain.handle('app:checkUpdate', async () => {
  try {
    if (!updater) updater = require('./lib/updater').setup(win);
    if (!updater.ok) return { ok: false, msg: updater.msg };
    return await updater.check();
  } catch (e) { return { ok: false, msg: String(e) }; }
});
ipcMain.on('app:downloadUpdate', () => { try { updater && updater.download(); } catch {} });
ipcMain.on('app:installUpdate', () => { try { updater && updater.installNow(); } catch {} });
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:openExternal', (e, url) => { try { shell.openExternal(url); return true; } catch { return false; } });

// —— 账号(登录只为知道谁在用,不卡任何功能;这里出什么错都不许影响别的) ——
// 请求走 Electron 自带的网络模块(跟着系统代理走);万一包不起来就退回 Node 的 https。
let authRequest;
try { const enet = require('electron').net; if (enet && typeof enet.request === 'function') authRequest = require('./lib/auth-net').electronRequest(enet); } catch {}
// 账号模块万一起不来,换一个「永远未登录」的空壳顶上 —— 绝不能因为它让主进程起不来
let auth;
try { auth = require('./lib/auth').create({ file: P.AUTH, request: authRequest, meta: () => ({ appVersion: app.getVersion(), platform: process.platform }) }); }
catch (e) {
  console.error('[auth] 账号模块没起来:', e && e.message);
  const off = async () => ({ ok: false, error: '账号功能暂时用不了,不影响其它功能' });
  auth = { status: () => ({ loggedIn: false, email: '', offline: false }), signIn: off, signUp: off, signOut: async () => ({ ok: true }), restore: async () => {} };
}
// 界面上的登录状态只认主进程推过去的这一份:登录 / 注册 / 退出 / 启动续期完成后各推一次。
function pushAuth() { try { if (win && !win.isDestroyed()) win.webContents.send('auth:changed', auth.status()); } catch {} }
// 问状态立刻答,不等网络(启动续期一开始就把本地存的账号记进内存了)。
ipcMain.handle('auth:status', () => { try { return auth.status(); } catch { return { loggedIn: false, email: '', offline: false }; } });
ipcMain.handle('auth:signIn', async (e, email, password) => { try { return await auth.signIn(email, password); } catch { return { ok: false, error: '登录出错了,再试一次' }; } finally { pushAuth(); } });
ipcMain.handle('auth:signUp', async (e, email, password) => { try { return await auth.signUp(email, password); } catch { return { ok: false, error: '注册出错了,再试一次' }; } finally { pushAuth(); } });
ipcMain.handle('auth:signOut', async () => { try { return await auth.signOut(); } catch { return { ok: true }; } finally { pushAuth(); } });

// 扫描磁盘上"有会话但不在清单里"的项目,供界面一键补进来
ipcMain.handle('hub:discoverNew', () => {
  try { return discover.findNew(data.getProjects()); } catch { return []; }
});
ipcMain.handle('hub:pickDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择项目目录' });
  return (r.canceled || !r.filePaths.length) ? '' : r.filePaths[0];
});
ipcMain.handle('hub:updateProject', (e, p, patch) => {
  try { return data.updateProject(p, patch); } catch (err) { return { ok: false, msg: String(err) }; }
});
ipcMain.handle('hub:saveOrder', (e, paths) => { try { return data.saveOrder(paths); } catch (err) { return { ok: false, msg: String(err) }; } });
ipcMain.handle('hub:removeProject', (e, p) => {
  try { return data.removeProject(p); } catch (err) { return { ok: false, msg: String(err) }; }
});
ipcMain.handle('hub:addProject', (e, info) => {
  try { return data.addProject(info); } catch (err) { return { ok: false, msg: String(err) }; }
});
ipcMain.handle('hub:trashSession', (e, sessSlug, sid) => {
  try { return { ok: data.trashSession(sessSlug, sid) }; } catch (err) { return { ok: false, msg: String(err) }; }
});
// 模型 / 思考努力:**只读不写**(2026-11-14)。
// 以前设置里有写死的模型下拉和思考努力下拉,保存时写进 ~/.claude/settings.json:
//   - 模型清单每出一个新模型就过时一次(用户反馈「咋没有 Fable 5.2」);
//   - 顶层 effortLevel 对 Opus 5.5 之后的模型已经不生效(官方改成 modelSettings 里每个模型各记各的)。
// 所以都交还给官方的 /model 和 /effort,这里只把当前值读出来给界面显示。别再加写入口。
// <global-cfg>
ipcMain.handle('hub:getGlobalCfg', () => {
  // err:读不了(文件没有 / 坏了)。界面要把「读不到」和「没设置」分开说。
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8').replace(/^\uFEFF/, ''));
    const str = v => (typeof v === 'string' ? v : '');
    return { model: str(s.model) };
  } catch { return { model: '', err: true }; }
});
// </global-cfg>
ipcMain.handle('hub:guide', () => {
  try { return fs.readFileSync(path.join(__dirname, 'docs', '使用说明.md'), 'utf8'); } catch { return '(说明文档缺失)'; }
});
// 这台电脑装没装 Claude Code。没装的话界面给一张说明卡 + 一键安装,而不是让终端甩一屏红字。
// ⚠️ 检测本身出任何岔子都当成「装了」:宁可回到老样子(红字),也不能因为检测有毛病就不让人开会话。
// 异步 + 限时(PATH 里有连不上的网络路径时,同步查会把整个窗口卡住几十秒);超时也当成「装了」。
ipcMain.handle('claude:check', async () => { try { return await claudeCli.checkForUi(); } catch { return { found: true, unsure: true }; } });
// Claude Code 版本检查:本机版本 vs npm 最新版
ipcMain.handle('hub:checkUpdate', () => new Promise((resolve) => {
  exec('claude --version', { timeout: 20000, env: claudeCli.withClaudeOnPath(process.env) }, (e1, o1) => {
    const cur = String(o1 || '').match(/(\d+\.\d+\.\d+)/);
    exec('npm view @anthropic-ai/claude-code version --registry=https://registry.npmmirror.com', { timeout: 25000 }, (e2, o2) => {
      const latest = String(o2 || '').trim().match(/(\d+\.\d+\.\d+)/);
      resolve({ ok: !!(cur && latest), current: cur ? cur[1] : '', latest: latest ? latest[1] : '' });
    });
  });
}));
ipcMain.handle('hub:projfile', (e, projPath, rel) => data.readProjectFile(projPath, rel));

ipcMain.handle('hub:openCli', async (e, projPath, title, sid) => {
  const cmd = sid ? `claude --resume "${sid}"` : 'claude';
  try {
    // 外部终端这条退路同样要跟着系统代理走、同样要补 PATH(envFor 永不抛)
    const px = await sysProxy.envFor(process.env);
    spawn('wt.exe', ['-w', 'claudehub', 'new-tab', '--title', title || 'Claude',
      '-d', projPath, 'powershell', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass',
      '-Command', cmd], { detached: true, stdio: 'ignore', env: claudeCli.withClaudeOnPath(px.env) }).unref();
    return { ok: true };
  } catch (err) { return { ok: false, msg: String(err) }; }
});

ipcMain.handle('hub:openDir', (e, p) => { shell.openPath(p); return { ok: true }; });
// 终端里点路径前先问一下存不存在——shell.openPath 失败是静默的，不问就等于点了没反应
// ⚠️ 必须异步。这个 handler 是鼠标在终端里划过一行就会被调的,一条路径的候选清单
// 最多能有二三十条;用 fs.statSync 的话就是在主进程里连着做几十次同步 IO,
// 而主进程同时还扛着所有 IPC、终端 pty 和窗口。只要路径落在断开的映射盘(Z:\…)上,
// 单次 stat 可能要等几秒到几十秒的 SMB 超时 —— 整个程序会因为"鼠标扫过一行字"而冻住。
// ⚠️ 这里【不能】按条数封顶。候选清单是"末段中文一个一个削"出来的,长度 = 中文尾巴字数 + 3,
// 而且是长的排在前面 —— 也就是说正确答案往往排在队尾。砍条数等于把同一个缺陷的天花板
// 从 24 抬到 48:中文说明一长,链接照样整条消失,而且这个闸在主进程里,测试套根本够不着。
// 封顶的真实目的只有一个:别让一块挂死的映射盘(Z:\)把这次调用拖住。那是【时间】问题,
// 不是条数问题 —— 48 次串行 SMB 超时照样是好几分钟。所以这里用时间预算。
// 本地盘上几十次 stat 不到几毫秒,正常情况永远碰不到这条线。
const PATHINFO_BUDGET_MS = 400;
ipcMain.handle('hub:pathInfo', async (e, p) => {
  const one = async (x) => {
    try {
      const st = await fs.promises.stat(x);
      return { exists: true, isDir: st.isDirectory(), isFile: st.isFile(), path: x };
    } catch { return null; }
  };
  // 传数组 = 候选清单(长的在前),返回第一个真的存在的。
  // 终端里一条路径的右边界到底在哪(汉字是路径的一部分,还是紧跟的中文说明)只有磁盘知道。
  if (Array.isArray(p)) {
    const t0 = Date.now();
    for (const x of p) {
      const r = await one(String(x || ''));
      if (r) return r;
      if (Date.now() - t0 > PATHINFO_BUDGET_MS) break;   // 只防挂死的网络盘,本地盘碰不到
    }
    return { exists: false, isDir: false, isFile: false, path: '' };
  }
  return (await one(String(p || ''))) || { exists: false, isDir: false, isFile: false, path: String(p || '') };
});

ipcMain.handle('hub:getNotifyCfg', () => {
  // 补全默认值再给界面,省得渲染进程到处写 (c.telegram && c.telegram.xxx)
  try { return notify.loadCfg(); } catch { return notify.DEFAULTS; }
});
ipcMain.handle('hub:saveNotifyCfg', (e, patch) => {
  try {
    // 必须先读后合并:渲染进程那个保存函数是整体重建 cfg 对象,
    // 要是直接覆盖,它没管的字段(mute / dnd / 代理设置)每次保存都会被抹掉。
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(CFG, 'utf8')) || {}; } catch {}
    // patch 里显式给的键优先,没给的沿用旧值
    const assign = (dst, src) => {
      for (const k of Object.keys(src || {})) {
        if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
          dst[k] = dst[k] && typeof dst[k] === 'object' ? dst[k] : {};
          assign(dst[k], src[k]);
        } else dst[k] = src[k];
      }
    };
    const out = notify.deepDefaults(cur, notify.DEFAULTS);
    assign(out, patch || {});
    fs.mkdirSync(path.dirname(CFG), { recursive: true });
    fs.writeFileSync(CFG, JSON.stringify(out, null, 2), 'utf8');
    return { ok: true, cfg: out };
  } catch (err) { return { ok: false, msg: String(err) }; }
});
// 钩子装没装好:给设置界面一个"体检"用
ipcMain.handle('hub:hookStatus', () => {
  const out = { hookFile: false, hookFresh: false, stop: false, notification: false, matcher: '', log: '' };
  try {
    const src = fs.readFileSync(HOOK_SRC, 'utf8');
    out.hookFile = fs.existsSync(HOOK_DST);
    if (out.hookFile) out.hookFresh = fs.readFileSync(HOOK_DST, 'utf8') === src;
  } catch {}
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    const txt = JSON.stringify((s.hooks || {}).Stop || []);
    out.stop = txt.includes('claude-notify-hook.js');
    const nh = (s.hooks || {}).Notification || [];
    const hit = nh.find(b => JSON.stringify(b).includes('claude-notify-hook.js'));
    out.notification = !!hit;
    out.matcher = hit ? (hit.matcher || '') : '';
  } catch {}
  try {
    const lines = fs.readFileSync(path.join(P.HOOKS_DIR, 'notify.log'), 'utf8').split('\n').filter(Boolean);
    out.log = lines.slice(-12).join('\n');
  } catch {}
  return out;
});
ipcMain.handle('hub:syncHook', () => syncHookFile());
// ---------- 终端 IPC ----------
// 终端用的环境。两件事:
//   ① 净化:去掉 CLAUDE_CODE 标记,否则里面的 claude 会当自己是子会话,转录不落盘
//   ② Claude Code 不看系统代理、只认 HTTPS_PROXY:系统代理开着就只给这个终端带上(不改全局环境变量)。
//      用户自己设过代理变量、代理连不上、只有 SOCKS —— 都原样不动。限时且永不抛,见 lib/sysproxy.js。
// 返回 { env, applied }。这一步是异步的(要读注册表、探端口)。
function termEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) { if (!/^CLAUDE_?CODE/i.test(k)) env[k] = v; }
  return sysProxy.envFor(env);
}
async function spawnTerm(projPath, title, sid, cmdOverride) {
  if (!pty) return { ok: false, msg: 'node-pty 未就绪' };
  return spawnTermWith(await termEnv(), projPath, title, sid, cmdOverride);
}
// ⚠️ 这个函数必须保持同步(里面不许有 await)。调用方靠「查有没有同一个会话 → 立刻登记进 termMeta」
// 这两步之间没有空档来防重复开;中间一旦能插进别的请求,同一个会话就会被开出两个进程写同一份转录。
// 需要等的东西(环境)在外面等好了再传进来。
function spawnTermWith(px, projPath, title, sid, cmdOverride) {
  if (!pty) return { ok: false, msg: 'node-pty 未就绪' };
  try {
    const id = 't' + Date.now() + Math.floor(Math.random() * 1e4);
    const cmd = cmdOverride ? cmdOverride : (sid ? `claude --resume "${sid}"` : 'claude');
    // 官方安装器把 claude 装到 用户目录\.local\bin 但不加 PATH —— 这里补上(追加在末尾,已经找得到的电脑行为不变)
    // dll=true:用 node-pty 自带的新版 ConPTY(conpty.dll + OpenConsole.exe),不用系统自带的那份。
    // Win10 自带的 ConPTY 老旧:Claude Code 输出滚出屏幕的行直接丢掉(xterm 里没有滚动历史,滚轮翻不上去),
    // 输入行里中文后面的字会被吞一格、光标和文字错位。实测见 test/conpty.test.js。
    // 新版起不来(文件缺失、被拦)就退回系统自带的 —— 拿不准就放行,至少还能用。
    const spawnPs = (dll) => pty.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
      name: 'xterm-256color', cols: 120, rows: 32, cwd: projPath, env: claudeCli.withClaudeOnPath(px.env), useConptyDll: dll
    });
    let p;
    try { p = spawnPs(true); } catch { p = spawnPs(false); }
    terms.set(id, p);
    termMeta.set(id, { projPath, short: title || '', sid: sid || '', title: title || '', buf: '' });
    p.onData(d => {
      if (win && !win.isDestroyed()) win.webContents.send('term:data', { id, data: d });
      const m = termMeta.get(id);
      if (m) { m.buf += d; if (m.buf.length > 80000) m.buf = m.buf.slice(-60000); }   // 手机接入时回放
      try { mobile.pushTermData(id, d); } catch {}
    });
    p.onExit(ev => {
      terms.delete(id); termMeta.delete(id);
      if (win && !win.isDestroyed()) win.webContents.send('term:exit', { id, code: ev.exitCode });
      try { mobile.pushEvent('exit', { id }); } catch {}
    });
    return { ok: true, id, proxy: px.applied };     // proxy:这个终端带上的代理地址(没带是空串),界面在终端顶上提示一行
  } catch (err) { return { ok: false, msg: String(err) }; }
}
ipcMain.handle('term:open', (e, projPath, title, sid, cmdOverride) => spawnTerm(projPath, title, sid, cmdOverride));
ipcMain.on('term:input', (e, id, data) => { const p = terms.get(id); if (p) p.write(data); });
ipcMain.on('term:resize', (e, id, cols, rows) => { const p = terms.get(id); try { if (p) p.resize(cols, rows); } catch {} });
ipcMain.on('term:kill', (e, id) => { const p = terms.get(id); if (p) { try { p.kill(); } catch {} terms.delete(id); } });
// 手动选图片文件(剪贴板读不到时的可靠兜底)
ipcMain.handle('clip:pickImage', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择要发给 Claude 的图片', properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
  });
  return (r.canceled || !r.filePaths.length) ? '' : r.filePaths[0];
});
// 诊断:剪贴板里到底有哪些格式
ipcMain.handle('clip:formats', () => {
  try { return { formats: clipboard.availableFormats(), hasImage: !clipboard.readImage().isEmpty(), text: (clipboard.readText() || '').slice(0, 60) }; }
  catch (e) { return { formats: [], hasImage: false, err: String(e) }; }
});
// 浏览器侧读到的图片字节 -> 存盘(clipboard.readImage 读不到时的兜底)
ipcMain.handle('clip:saveBytes', (e, bytes) => {
  try {
    const dir = P.PASTES;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const f = path.join(dir, 'paste-' + Date.now() + '.png');
    fs.writeFileSync(f, Buffer.from(bytes));
    return { ok: true, path: f };
  } catch (err) { return { ok: false, msg: String(err) }; }
});
// 剪贴板图片 -> 存盘返回路径(终端 Ctrl+V 贴图用)
ipcMain.handle('clip:image', () => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return { ok: false };
    const dir = P.PASTES;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const f = path.join(dir, 'paste-' + Date.now() + '.png');
    fs.writeFileSync(f, img.toPNG());
    return { ok: true, path: f };
  } catch (err) { return { ok: false, msg: String(err) }; }
});

ipcMain.handle('hub:testNotify', async (e, channel) => {
  const rec = {
    level: 'wait', proj: '通道自测', cwd: __dirname, sid: '',
    task: '测试一下通知能不能到你手机上',
    result: '这条是手动点「测试」发的,收到就说明这条通道通了。',
    did: '自测', msg: 'Claude is waiting for your input',
    ts: new Date().toLocaleString('sv-SE').replace('T', ' ').slice(0, 19)
  };
  // 界面里的提示卡不走网络,单独一条路
  if (channel === 'toast') {
    try {
      fs.mkdirSync(HUB_HOME, { recursive: true });
      fs.writeFileSync(TOAST_PENDING, JSON.stringify(rec), 'utf8');
      popPendingToast();
      return { ok: true, msg: '已弹到右上角铃铛下面了' };
    } catch (err) { return { ok: false, msg: String(err.message || err) }; }
  }
  try { return await notify.send(rec, channel); }
  catch (err) { return { ok: false, msg: String(err) }; }
});
