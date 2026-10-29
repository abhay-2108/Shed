import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isWindows, which, killProcess, processAlive as checkAlive, pause } from './platform.js';

let pty = null;
if (isWindows) {
  try {
    pty = (await import('node-pty')).default;
  } catch (err) {
    console.error('Failed to load node-pty on Windows:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Windows Terminal & Session State Management
// ---------------------------------------------------------------------------
const winSessions = new Map();
let winTtyCounter = 0;

function cleanAnsi(text) {
  return String(text || '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\].*?\x07/g, '')
    .replace(/\r/g, '');
}

// Claude Code writes ~/.claude/sessions/<pid>.json for each running interactive session, with its session ID and busy/idle status.
export function claudeLiveSessions() {
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  const live = new Map();
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => /^\d+\.json$/.test(name)); } catch { return live; }
  for (const name of names) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (!record.sessionId || !Number.isInteger(record.pid) || !processAlive(record.pid)) continue;
      live.set(record.sessionId, { pid:record.pid, status:record.status || '', statusUpdatedAt:record.statusUpdatedAt || 0, tty:ttyOf(record.pid) });
    } catch { /* A session may be writing its record. */ }
  }
  return live;
}

function processAlive(pid) {
  return checkAlive(pid);
}

// A process keeps its terminal for life, so the answer is cached (briefly, in case the PID is reused).
const ttyCache = new Map();
export function ttyOf(pid) {
  const hit = ttyCache.get(pid);
  if (hit && Date.now() - hit.at < 60000) return hit.tty;
  
  if (isWindows) {
    for (const [id, session] of winSessions) {
      if (session.pid === pid || session.childPid === pid) {
        ttyCache.set(pid, { at:Date.now(), tty:id });
        return id;
      }
    }
    const tty = `win-pty-${pid}`;
    ttyCache.set(pid, { at:Date.now(), tty });
    return tty;
  }

  const result = spawnSync('/bin/ps', ['-o', 'tty=', '-p', String(pid)], { encoding:'utf8', timeout:2000 });
  const name = (result.stdout || '').trim();
  const tty = /^ttys\d+$/.test(name) ? `/dev/${name}` : '';
  ttyCache.set(pid, { at:Date.now(), tty });
  return tty;
}

// True when `command` is the foreground program in that terminal, so typed text goes to it and not to the shell.
export function agentInForeground(tty, command) {
  if (!tty) return false;
  
  if (isWindows) {
    const session = winSessions.get(tty);
    if (!session) return true; // If external process, assume in foreground if alive
    return session.active;
  }

  const names = Array.isArray(command) ? command : [command];
  const result = spawnSync('/bin/ps', ['-t', tty.replace('/dev/', ''), '-o', 'stat=,comm='], { encoding:'utf8', timeout:2000 });
  return (result.stdout || '').split('\n').some(line => {
    const match = line.trim().match(/^(\S+)\s+(.+)$/);
    return match && match[1].includes('+') && names.includes(path.basename(match[2]));
  });
}

export function pidOnTty(tty, command) {
  if (isWindows) {
    const session = winSessions.get(tty);
    if (session && session.active) return session.pid;
    const match = tty.match(/^win-pty-(\d+)$/);
    return match ? Number(match[1]) : null;
  }

  const result = spawnSync('/bin/ps', ['-t', tty.replace('/dev/', ''), '-o', 'pid=,comm='], { encoding:'utf8', timeout:2000 });
  for (const line of (result.stdout || '').split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (match && path.basename(match[2]) === command) return Number(match[1]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// macOS AppleScript Terminal Automation
// ---------------------------------------------------------------------------
function osascript(script, args) {
  const result = spawnSync('/usr/bin/osascript', ['-', ...args], { input:script, encoding:'utf8', timeout:15000, maxBuffer:8 * 1024 * 1024 });
  if (result.error) throw new Error(`Terminal could not be reached: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim();
    if (/-1743|not allowed|Not authorized/i.test(detail)) throw new Error('macOS has not allowed the task plane to control Terminal. Approve it on the Mac under System Settings → Privacy & Security → Automation.');
    throw new Error(detail || 'Terminal did not respond.');
  }
  return result.stdout.replace(/\n$/, '');
}

const findTab = `
on findTab(ttyName)
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is ttyName and (count of processes of t) > 0 then return t
      end repeat
    end repeat
  end tell
  return missing value
end findTab
`;

function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }

function osascriptAsync(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-', ...args], { stdio:['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', error => { clearTimeout(timer); reject(new Error(`Terminal could not be reached: ${error.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve(out.replace(/\n$/, ''));
      if (/-1743|not allowed|Not authorized/i.test(err)) return reject(new Error('macOS has not allowed the task plane to control Terminal. Approve it on the Mac under System Settings → Privacy & Security → Automation.'));
      reject(new Error(err.trim() || 'Terminal did not respond.'));
    });
    child.stdin.end(script);
  });
}

// ---------------------------------------------------------------------------
// Unified Read / Type / Open Exports (macOS & Windows)
// ---------------------------------------------------------------------------

export function typeIntoTerminal(tty, text, { prompt = false, agent = '' } = {}) {
  if (isWindows) {
    const session = winSessions.get(tty);
    if (!session || !session.active) throw new Error(`${agent || 'Agent'} is no longer running in that Terminal tab.`);
    if (prompt) {
      session.pty.write(text + '\r\n');
    } else {
      session.pty.write(text);
    }
    return;
  }

  if (agent && !agentInForeground(tty, agent)) throw new Error(`${agent} is no longer running in that Terminal tab.`);
  const send = value => {
    const result = osascript(`${findTab}
on run argv
  set t to findTab(item 1 of argv)
  if t is missing value then return "missing"
  tell application "Terminal" to do script (item 2 of argv) in t
  return "ok"
end run`, [tty, value]);
    if (result !== 'ok') throw new Error('That Terminal tab is no longer open.');
  };
  if (!prompt) return send(text);
  send(`\u001b[200~${text}\u001b[201~`);
  spawnSync('/bin/sleep', ['0.6']);
  if (agent && !agentInForeground(tty, agent)) { send('\u0015'); throw new Error(`${agent} exited while the message was being typed.`); }
  send('');
}

export function readTerminal(tty, maxLines = 400) {
  if (isWindows) {
    const session = winSessions.get(tty);
    if (!session) return null;
    const history = session.buffer.slice(-maxLines).join('\n') + (session.raw ? '\n' + session.raw : '');
    return history.trim();
  }

  const text = osascript(`${findTab}
on run argv
  set t to findTab(item 1 of argv)
  if t is missing value then return "__TAB_MISSING__"
  tell application "Terminal" to return history of t
end run`, [tty]);
  if (text === '__TAB_MISSING__') return null;
  return text.replace(/\s+$/, '').split('\n').slice(-maxLines).join('\n');
}

export function openTerminal(cwd, argv, promptFile) {
  if (isWindows) {
    return openTerminalWindows(cwd, argv, promptFile);
  }

  const command = `cd ${shellQuote(cwd)} && ${argv.map(shellQuote).join(' ')}${promptFile ? ` "$(cat ${shellQuote(promptFile)}; rm -f ${shellQuote(promptFile)})"` : ''}`;
  const tty = osascript(`on run argv
  tell application "Terminal"
    set t to do script (item 1 of argv)
    return tty of t
  end tell
end run`, [command]);
  if (!/^\/dev\/ttys\d+$/.test(tty)) throw new Error('Terminal did not open a new window.');
  return tty;
}

export async function readTerminalAsync(tty, maxLines = 400) {
  if (isWindows) {
    return readTerminal(tty, maxLines);
  }

  const text = await osascriptAsync(`${findTab}
on run argv
  set t to findTab(item 1 of argv)
  if t is missing value then return "__TAB_MISSING__"
  tell application "Terminal" to return history of t
end run`, [tty]);
  if (text === '__TAB_MISSING__') return null;
  return text.replace(/\s+$/, '').split('\n').slice(-maxLines).join('\n');
}

export async function typeIntoTerminalAsync(tty, text, { prompt = false, agent = '' } = {}) {
  if (isWindows) {
    typeIntoTerminal(tty, text, { prompt, agent });
    return;
  }

  if (agent && !agentInForeground(tty, agent)) throw new Error(`${agent} is no longer running in that Terminal tab.`);
  const send = async value => {
    const result = await osascriptAsync(`${findTab}
on run argv
  set t to findTab(item 1 of argv)
  if t is missing value then return "missing"
  tell application "Terminal" to do script (item 2 of argv) in t
  return "ok"
end run`, [tty, value]);
    if (result !== 'ok') throw new Error('That Terminal tab is no longer open.');
  };
  if (!prompt) return send(text);
  await send(`\u001b[200~${text}\u001b[201~`);
  await pause(600);
  if (agent && !agentInForeground(tty, agent)) { await send('\u0015'); throw new Error(`${agent} exited while the message was being typed.`); }
  await send('');
}

export async function openTerminalAsync(cwd, argv, promptFile) {
  if (isWindows) {
    return openTerminalWindows(cwd, argv, promptFile);
  }

  const command = `cd ${shellQuote(cwd)} && ${argv.map(shellQuote).join(' ')}${promptFile ? ` "$(cat ${shellQuote(promptFile)}; rm -f ${shellQuote(promptFile)})"` : ''}`;
  const tty = await osascriptAsync(`on run argv
  tell application "Terminal"
    set t to do script (item 1 of argv)
    return tty of t
  end tell
end run`, [command]);
  if (!/^\/dev\/ttys\d+$/.test(tty)) throw new Error('Terminal did not open a new window.');
  return tty;
}

function openTerminalWindows(cwd, argv, promptFile) {
  if (!pty) throw new Error('node-pty is not installed on Windows. Run npm install.');
  
  let initialPrompt = '';
  if (promptFile && fs.existsSync(promptFile)) {
    try {
      initialPrompt = fs.readFileSync(promptFile, 'utf8').trim();
      fs.rmSync(promptFile, { force: true });
    } catch {}
  }

  const tty = `win-pty-${++winTtyCounter}`;
  const bin = which(argv[0]) || argv[0];
  const isCmd = bin.toLowerCase().endsWith('.cmd') || bin.toLowerCase().endsWith('.bat');
  const file = isCmd ? (process.env.ComSpec || 'cmd.exe') : bin;
  let args;
  if (isCmd) {
    const rest = argv.slice(1).map(arg => {
      const s = String(arg);
      return /[\s"^&|<>]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(' ');
    const fullCmd = rest ? `""${bin}" ${rest}"` : `""${bin}""`;
    args = ['/d', '/s', '/c', fullCmd];
  } else {
    args = argv.slice(1);
  }

  const ptyProcess = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 35,
    cwd: cwd && fs.existsSync(cwd) ? cwd : process.cwd(),
    env: { ...process.env, CI: '0', NO_COLOR: '1' },
    useConpty: false // WinPTY backend guarantees clean exit without AttachConsole race conditions
  });

  const session = {
    tty,
    pty: ptyProcess,
    pid: ptyProcess.pid,
    agent: argv[0],
    cwd,
    buffer: [],
    raw: '',
    active: true
  };
  winSessions.set(tty, session);

  ptyProcess.onData(data => {
    const cleaned = cleanAnsi(data);
    session.raw += cleaned;
    const lines = session.raw.split('\n');
    session.raw = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (trimmed) session.buffer.push(trimmed);
    }
    if (session.buffer.length > 500) session.buffer.splice(0, session.buffer.length - 500);
  });

  ptyProcess.onExit(() => {
    session.active = false;
  });

  if (initialPrompt) {
    setTimeout(() => {
      try {
        if (session.active) ptyProcess.write(initialPrompt + '\r\n');
      } catch {}
    }, 1000);
  }

  return tty;
}

export function processInfo(pid) {
  if (isWindows) {
    return checkAlive(pid) ? { pgid: pid, tpgid: pid, command: 'agent' } : null;
  }
  const result = spawnSync('/bin/ps', ['-o', 'pgid=,tpgid=,comm=', '-p', String(pid)], { encoding:'utf8', timeout:2000 });
  const match = (result.stdout || '').trim().match(/^(\d+)\s+(-?\d+)\s+(.+)$/);
  return match ? { pgid:Number(match[1]), tpgid:Number(match[2]), command:path.basename(match[3]) } : null;
}

const SHELLS = new Set(['login', 'zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'fish', '-fish', 'tmux', 'screen']);
function groupFor(pid, info) {
  if (info.pgid === pid) return -pid;
  if (info.pgid !== info.tpgid || info.pgid <= 1) return pid;
  const leader = processInfo(info.pgid);
  return leader && !SHELLS.has(leader.command) ? -info.pgid : pid;
}

export async function stopAgent(pid, command, { graceMs = 5000 } = {}) {
  if (isWindows) {
    for (const [id, session] of winSessions) {
      if (session.pid === pid || (command && session.agent === command)) {
        try { session.pty.kill('SIGTERM'); } catch {}
        session.active = false;
      }
    }
    killProcess(pid);
    return { stopped: true, forced: false };
  }

  const names = Array.isArray(command) ? command : [command];
  const owned = () => { const info = processInfo(pid); return info && names.includes(info.command) ? info : null; };
  const info = owned();
  if (!info) return { stopped:false, reason:'not-running' };
  const target = groupFor(pid, info);
  const signal = name => { try { process.kill(target, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  signal('SIGTERM');
  for (let waited = 0; waited < graceMs; waited += 250) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!owned()) return { stopped:true, forced:false };
  }
  if (owned()) signal('SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 300));
  return { stopped:!owned(), forced:true };
}
