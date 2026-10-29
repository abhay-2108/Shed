import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

/**
 * Cross-platform command locator (equivalent to Unix `which` / Windows `where.exe`).
 * Checks PATH and platform-appropriate extensions (.exe, .cmd, .bat, etc.).
 */
export function which(cmd) {
  if (!cmd) return '';
  if (isWindows) {
    const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map(e => e.toLowerCase());
    const dirs = (process.env.PATH || '').split(path.delimiter);
    // If command already contains path separators
    if (cmd.includes('/') || cmd.includes('\\')) {
      if (fs.existsSync(cmd) && fs.statSync(cmd).isFile()) return path.resolve(cmd);
      for (const ext of exts) {
        const full = cmd + ext;
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return path.resolve(full);
      }
    }
    const systemDrive = process.env.SystemDrive || 'C:';
    const progFiles = process.env['ProgramFiles'] || path.join(systemDrive, 'Program Files');
    const progFilesX86 = process.env['ProgramFiles(x86)'] || path.join(systemDrive, 'Program Files (x86)');
    const commonProgramDirs = [
      path.join(progFilesX86, 'cloudflared'),
      path.join(progFiles, 'cloudflared'),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links')
    ];
    for (const dir of [...dirs, ...commonProgramDirs]) {
      if (!dir) continue;
      for (const ext of [...exts, '']) {
        const full = path.join(dir, cmd + ext);
        try {
          if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
        } catch {}
      }
    }
    try {
      const res = spawnSync('where.exe', [cmd], { encoding: 'utf8', timeout: 2000 });
      if (res.status === 0 && res.stdout) {
        const first = res.stdout.trim().split(/\r?\n/)[0];
        if (first) return first;
      }
    } catch {}
    return '';
  }
  try {
    const res = spawnSync('which', [cmd], { encoding: 'utf8', timeout: 2000 });
    return res.status === 0 ? res.stdout.trim() : '';
  } catch {
    return '';
  }
}

export function commandExists(cmd) {
  return Boolean(which(cmd));
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Returns a list of running processes [{ pid, command }].
 */
export function getProcessList() {
  if (isWindows) {
    try {
      const res = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 4000 });
      if (res.status !== 0 || !res.stdout) return [];
      const lines = res.stdout.split(/\r?\n/);
      const list = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        const match = line.match(/^"([^"]+)","(\d+)"/);
        if (match) {
          list.push({ pid: Number(match[2]), command: match[1] });
        }
      }
      return list;
    } catch {
      return [];
    }
  }
  try {
    const result = spawnSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8', timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout.split('\n').map(line => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function killProcess(pid, signal = 'SIGTERM') {
  if (isWindows) {
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 3000 });
      return true;
    } catch {
      try { process.kill(pid, signal); return true; } catch { return false; }
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function escapeCmdArg(arg) {
  if (typeof arg !== 'string') arg = String(arg);
  if (/[\s"^&|<>]/.test(arg)) {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return arg || '""';
}

export function spawnTool(command, args = [], options = {}) {
  const exe = which(command) || command;
  if (isWindows) {
    const isCmd = exe.toLowerCase().endsWith('.cmd') || exe.toLowerCase().endsWith('.bat');
    if (isCmd) {
      const formattedArgs = args.map(escapeCmdArg).join(' ');
      const fullCmd = formattedArgs ? `""${exe}" ${formattedArgs}"` : `""${exe}""`;
      return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', fullCmd], {
        ...options,
        windowsVerbatimArguments: true,
      });
    }
    return spawn(exe, args, options);
  }
  return spawn(command, args, options);
}

export function spawnToolSync(command, args = [], options = {}) {
  const exe = which(command) || command;
  if (isWindows) {
    const isCmd = exe.toLowerCase().endsWith('.cmd') || exe.toLowerCase().endsWith('.bat');
    if (isCmd) {
      const formattedArgs = args.map(escapeCmdArg).join(' ');
      const fullCmd = formattedArgs ? `""${exe}" ${formattedArgs}"` : `""${exe}""`;
      return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', fullCmd], {
        ...options,
        windowsVerbatimArguments: true,
      });
    }
    return spawnSync(exe, args, options);
  }
  return spawnSync(command, args, options);
}

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
