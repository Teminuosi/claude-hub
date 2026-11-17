// 路径抽象层:所有位置动态推导,不写死任何人的机器路径
// 兼容两种运行方式:Electron 主进程(用 userData)/ 纯 node 脚本(用 ~/.claude-hub)
const os = require('os');
const fs = require('fs');
const path = require('path');

// 数据目录:Electron 与纯 node 必须指向同一处,否则界面和脚本各写各的(踩过)
// 用 appData 根目录 + 固定文件夹名,不跟随 productName 变化
let appData = null;
try {
  const { app } = require('electron');
  if (app && app.getPath) appData = path.join(app.getPath('appData'), 'claude-hub');
} catch {}
if (!appData) {
  appData = (process.platform === 'win32' && process.env.APPDATA)
    ? path.join(process.env.APPDATA, 'claude-hub')
    : path.join(os.homedir(), '.claude-hub');
}
try { if (!fs.existsSync(appData)) fs.mkdirSync(appData, { recursive: true }); } catch {}

const HOME = os.homedir();
const CLAUDE_HOME = path.join(HOME, '.claude');

const P = {
  APP_DATA: appData,                                        // 本客户端自己的数据
  CLAUDE_HOME,
  CLAUDE_PROJECTS: path.join(CLAUDE_HOME, 'projects'),      // Claude Code 的会话/记忆
  CLAUDE_SETTINGS: path.join(CLAUDE_HOME, 'settings.json'),
  CLAUDE_JSON: path.join(HOME, '.claude.json'),
  HOOKS_DIR: path.join(CLAUDE_HOME, 'hooks'),
  FEED: path.join(CLAUDE_HOME, 'hooks', 'done-feed.jsonl'), // 完成流(钩子写入)
  // 客户端自己的数据文件(全部在 APP_DATA 下,不进 git)
  PROJECTS_JSON: path.join(appData, 'projects.json'),
  NOTIFY_CFG: path.join(appData, 'notify-config.json'),
  TITLES: path.join(appData, 'session-titles.json'),
  USAGE_CACHE: path.join(appData, 'usage-cache.json'),
  PROMPTS: path.join(appData, 'prompts.json'),
  AGENTS: path.join(appData, 'agents.json'),           // 自定义 Agent(lib/agents.js)
  AGENT_RUNS: path.join(appData, 'agent-runs'),        // 每次运行前写的参数文件(终端读它启动 claude)
  REWIND_BACKUPS: path.join(appData, 'rewind-backups'), // 检查点回退前,被动到的文件原样存一份(撤销用)
  CKPT_TMP: path.join(appData, 'tmp'),                 // 生成检查点对比时用的空文件
  MCP_RUNS: path.join(appData, 'tmp', 'mcp'),          // 调 claude mcp add-json 时的参数文件(用完就删)
  CLAUDE_DESKTOP_CFG: path.join(path.dirname(appData), 'Claude', 'claude_desktop_config.json'), // Claude Desktop 的 MCP 配置(只读,导入用)
  PASTES: path.join(appData, 'pastes'),
  OPENTABS: path.join(appData, 'open-tabs.json'),  // 开着的会话（同步落盘，强杀不丢）
  AUTH: path.join(appData, 'auth.json')            // 登录令牌(绝不进仓库,见 .gitignore)
};

// 从旧版本(开发机固定目录)平滑迁移一次,用户无感
function migrateOnce() {
  const legacyDir = 'F:\\claude-project\\claude-hub';
  const altDir = path.join(HOME, '.claude-hub');     // 早期版本的回退目录
  const pairs = [
    [path.join(altDir, 'projects.json'), P.PROJECTS_JSON],
    [path.join(altDir, 'prompts.json'), P.PROMPTS],
    ['F:\\claude-project\\projects.json', P.PROJECTS_JSON],
    [path.join(legacyDir, 'notify-config.json'), P.NOTIFY_CFG],
    [path.join(legacyDir, 'session-titles.json'), P.TITLES],
    [path.join(legacyDir, 'usage-cache.json'), P.USAGE_CACHE],
    [path.join(legacyDir, 'prompts.json'), P.PROMPTS]
  ];
  let n = 0;
  for (const [from, to] of pairs) {
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) { fs.copyFileSync(from, to); n++; }
    } catch {}
  }
  return n;
}

module.exports = Object.assign(P, { migrateOnce });
