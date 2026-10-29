import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { which, isWindows } from './platform.js';

// Gives Shed its https address: a Cloudflare Quick Tunnel, whose random URL changes when it restarts, or a named
// Cloudflare tunnel when relay.json holds its { hostname, token }, so the address (and phone push subscriptions) never
// change. This process restarts the tunnel when that file changes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.LAYA_DATA_DIR || process.env.JEV_DATA_DIR || path.join(root, '.jev-data');
const urlFile = path.join(dataDir, 'remote-url');
const relayFile = path.join(dataDir, 'relay.json');
const port = Number(process.env.PORT || 4378);
fs.mkdirSync(dataDir, { recursive:true, mode:0o700 });
fs.rmSync(urlFile, { force:true });

function findCloudflared() {
  if (process.env.CLOUDFLARED) return process.env.CLOUDFLARED;
  const found = which('cloudflared');
  if (found) return found;
  if (isWindows) {
    const systemDrive = process.env.SystemDrive || 'C:';
    const progFiles = process.env['ProgramFiles'] || path.join(systemDrive, 'Program Files');
    const progFilesX86 = process.env['ProgramFiles(x86)'] || path.join(systemDrive, 'Program Files (x86)');
    const progData = process.env['ProgramData'] || path.join(systemDrive, 'ProgramData');
    const candidates = [
      path.join(progFilesX86, 'cloudflared', 'cloudflared.exe'),
      path.join(progFiles, 'cloudflared', 'cloudflared.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
      path.join(progData, 'chocolatey', 'bin', 'cloudflared.exe'),
    ];
    return candidates.find(file => fs.existsSync(file)) || 'cloudflared';
  }
  return ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'].find(file => fs.existsSync(file)) || 'cloudflared';
}
function findNgrok() {
  if (process.env.NGROK_BIN) return process.env.NGROK_BIN;
  const found = which('ngrok');
  if (found && fs.existsSync(found) && fs.statSync(found).size > 0) return found;
  if (isWindows) {
    const systemDrive = process.env.SystemDrive || 'C:';
    const progFiles = process.env['ProgramFiles'] || path.join(systemDrive, 'Program Files');
    const candidates = [
      path.join(root, 'bin', 'ngrok.exe'),
      path.join(root, 'ngrok.exe'),
      path.join(progFiles, 'ngrok', 'ngrok.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'ngrok', 'ngrok.exe'),
      path.join(process.env.USERPROFILE || '', 'bin', 'ngrok.exe'),
    ];
    return candidates.find(file => fs.existsSync(file) && fs.statSync(file).size > 0) || 'ngrok';
  }
  return ['/opt/homebrew/bin/ngrok', '/usr/local/bin/ngrok'].find(file => fs.existsSync(file)) || 'ngrok';
}
function readRelay() {
  try {
    const relay = JSON.parse(fs.readFileSync(relayFile, 'utf8'));
    if (relay.provider === 'ngrok' || relay.ngrok || (relay.domain && !relay.token)) {
      const domain = (relay.domain || relay.hostname || relay.ngrok?.domain || '').replace(/^https?:\/\//, '');
      const authtoken = relay.authtoken || relay.token || relay.ngrok?.authtoken || process.env.NGROK_AUTHTOKEN || '';
      if (domain) return { provider:'ngrok', domain, authtoken };
    }
    return relay.token && /^[a-z0-9.-]+$/.test(relay.hostname || '') ? { provider:'cloudflare', ...relay } : null;
  } catch {
    if (process.env.NGROK_DOMAIN) {
      return { provider:'ngrok', domain:process.env.NGROK_DOMAIN.replace(/^https?:\/\//, ''), authtoken:process.env.NGROK_AUTHTOKEN || '' };
    }
    return null;
  }
}
function writeUrl(url) {
  fs.writeFileSync(urlFile, url + '\n', { mode:0o600 });
  try { fs.chmodSync(urlFile, 0o600); } catch {}
}

const cloudflared = findCloudflared();
const quickUrl = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
let child = null, relayKey = '', stopping = false;

function start() {
  const relay = readRelay();
  relayKey = relay ? `${relay.provider || 'cf'}|${relay.domain || relay.hostname}|${relay.token || relay.authtoken}` : '';
  fs.rmSync(urlFile, { force:true });
  if (relay?.provider === 'ngrok') {
    const ngrokBin = findNgrok();
    const domain = relay.domain;
    const args = ['http', String(port), `--url=${domain}`];
    if (relay.authtoken) args.push(`--authtoken=${relay.authtoken}`);
    child = spawn(ngrokBin, args, { cwd:root, env:{ ...process.env }, stdio:['ignore', 'pipe', 'pipe'] });
  } else if (relay) {
    child = spawn(cloudflared, ['tunnel', '--no-autoupdate', 'run'], { cwd:root, env:{ ...process.env, TUNNEL_TOKEN:relay.token }, stdio:['ignore', 'pipe', 'pipe'] });
  } else {
    child = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { cwd:root, stdio:['ignore', 'pipe', 'pipe'] });
  }
  const current = child;
  const readOutput = chunk => {
    const value = chunk.toString();
    process.stdout.write(value);
    if (relay?.provider === 'ngrok') {
      if (/started tunnel|url=https|online|Session Status/i.test(value) || value.includes(relay.domain)) writeUrl(`https://${relay.domain}`);
    } else {
      if (relay && /Registered tunnel connection/i.test(value)) writeUrl(`https://${relay.hostname}`);
      const matches = !relay && value.match(quickUrl);
      if (matches?.length) writeUrl(matches.at(-1));
    }
  };
  if (relay?.provider === 'ngrok') {
    setTimeout(() => { if (child === current && !fs.existsSync(urlFile)) writeUrl(`https://${relay.domain}`); }, 1500);
  }
  current.stdout.on('data', readOutput);
  current.stderr.on('data', readOutput);
  current.on('error', error => { process.stderr.write(`${error.message}\n`); fs.rmSync(urlFile, { force:true }); process.exitCode = 1; });
  current.on('close', code => {
    if (current !== child) return; // replaced by a restart
    fs.rmSync(urlFile, { force:true });
    if (!stopping) process.exit(code || 1); // launchd starts it again
  });
}
// Adding or removing relay.json swaps the tunnel without restarting the whole service.
fs.watchFile(relayFile, { interval:3000 }, () => {
  const relay = readRelay();
  // Build the comparison key in the same format as relayKey in start().
  const newKey = relay ? `${relay.provider || 'cf'}|${relay.domain || relay.hostname}|${relay.token || relay.authtoken}` : '';
  if (newKey === relayKey) return;
  const old = child;
  child = null;
  old?.kill('SIGTERM');
  start();
});
start();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; child?.kill(signal); process.exit(0); });
