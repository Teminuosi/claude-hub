// 带超时地跑一个外部命令,超时就把**整棵进程树**杀掉。
//
// 为什么不用 exec / execFile 自带的 timeout:那个只杀直接子进程。我们跑的是 powershell.exe / cmd.exe,
// 真正干活的 claude.exe 是它的子进程 —— Windows 上杀了外壳,claude 照样在后台跑:
//   · MCP 页「重新检测」每超时一次就多留一个 claude;
//   · 检查点回退超时后 claude 还在改文件,我们却以为「没回退」(见 test/killtree.test.js)。
// 所以自己计时,到点用 taskkill /T /F 连子带孙一起结束。
const { exec, execFile } = require('child_process');

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

// args 为 null 时 file 是整条命令(走 shell,同 exec);否则同 execFile。
// 返回 { err, stdout, stderr, timedOut } —— 不 reject。stdin 立刻关掉(claude 不会干等管道输入)。
function runKillable(file, args, opts, timeoutMs) {
  return new Promise(resolve => {
    let timedOut = false, timer = null;
    const done = (err, stdout, stderr) => {
      clearTimeout(timer);
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut });
    };
    const o = Object.assign({ windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, opts || {});
    delete o.timeout;
    const c = args ? execFile(file, args, o, done) : exec(file, o, done);
    if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; killTree(c.pid); }, timeoutMs);
    try { c.stdin.end(); } catch {}
  });
}

module.exports = { killTree, runKillable };
