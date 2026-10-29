import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { which, spawnTool } from './platform.js';

export const harnessNames = ['codex', 'claude', 'gemini', 'pi', 'opencode'];
const credentialEnv = {
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA'],
  opencode: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'],
  pi: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'],
};
let checkedAt = 0;
let pending;
let snapshot = Object.fromEntries(harnessNames.map(name => [name, { installed:false, state:'checking', detail:'Checking the CLI', checkedAt:null }]));

function run(command, args, timeoutMs = 5000) {
  return new Promise(resolve => {
    let output = '';
    let settled = false;
    let child;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    try { child = spawnTool(command, args, { env:{ ...process.env, NO_COLOR:'1', CI:'1' }, stdio:['ignore','pipe','pipe'] }); }
    catch (error) { return resolve({ ok:false, output:error.message }); }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok:false, output:'The CLI did not respond in time.' }); }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-4000); });
    child.on('error', error => finish({ ok:false, output:error.message }));
    child.on('close', code => finish({ ok:code === 0, output:output.trim() }));
  });
}

function result(installed, state, detail) {
  return { installed, state, detail, checkedAt:new Date().toISOString() };
}

async function probe(name) {
  const installed = Boolean(which(name) || (name === 'gemini' && which('agy')));
  if (!installed) return result(false, 'offline', 'CLI is not installed');
  const targetCmd = (name === 'gemini' && !which('gemini') && which('agy')) ? 'agy' : name;
  const version = await run(targetCmd, ['--version'], 12000);
  if (!version.ok) return result(true, 'offline', version.output || 'CLI did not respond');
  if (name === 'codex') {
    const auth = await run(name, ['login', 'status']);
    return auth.ok && /logged in/i.test(auth.output) ? result(true, 'ready', 'CLI responds; Codex login is active') : result(true, 'needs_auth', 'Sign in with codex login');
  }
  if (name === 'gemini') {
    if (credentialEnv.gemini.some(key => Boolean(process.env[key]))) return result(true, 'ready', 'CLI responds; Gemini API key is configured');
    try {
      const home = os.homedir();
      const geminiDir = path.join(home, '.gemini');
      if (fs.existsSync(path.join(geminiDir, 'oauth_creds.json')) || fs.existsSync(path.join(geminiDir, 'google_accounts.json')) || fs.existsSync(path.join(geminiDir, 'antigravity-cli')) || fs.existsSync(path.join(geminiDir, 'settings.json'))) {
        return result(true, 'ready', 'CLI responds; Antigravity Gemini authentication active');
      }
      return result(true, 'needs_auth', 'Sign in to Gemini from this computer');
    } catch { return result(true, 'ready', 'CLI responds; Gemini ready'); }
  }
  if (name === 'opencode') {
    if (credentialEnv.opencode.some(key => Boolean(process.env[key]))) return result(true, 'ready', 'CLI responds; a provider key is configured');
    try {
      const home = os.homedir();
      if (fs.existsSync(path.join(home, '.opencode')) || fs.existsSync('.opencode')) {
        return result(true, 'ready', 'CLI responds; OpenCode workspace detected');
      }
    } catch {}
    const auth = await run(name, ['auth', 'list'], 3000);
    const output = (auth.output || '').replace(/\x1b\[[0-9;]*m/g, '');
    if (auth.ok && /\b[1-9]\d* credentials?\b/i.test(output)) return result(true, 'ready', 'CLI responds; provider credentials are configured');
    if (auth.output && /already in use|connected/i.test(auth.output)) return result(true, 'ready', 'CLI responds; OpenCode service active');
    return result(true, 'ready', 'CLI responds; OpenCode ready');
  }
  if (name === 'claude') {
    const auth = await run(name, ['auth', 'status']);
    let loggedIn = false;
    try { loggedIn = JSON.parse(auth.output).loggedIn === true; } catch { loggedIn = /logged in/i.test(auth.output); }
    return auth.ok && loggedIn ? result(true, 'ready', 'CLI responds; Claude login is active') : result(true, 'needs_auth', 'Sign in to Claude Code from this machine');
  }
  if (name === 'pi') {
    if (credentialEnv.pi.some(key => Boolean(process.env[key]))) return result(true, 'ready', 'CLI responds; a provider key is configured');
    try {
      const file = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'), 'auth.json');
      const credentials = JSON.parse(fs.readFileSync(file, 'utf8'));
      const usable = Object.values(credentials).some(entry => entry && typeof entry === 'object' && (entry.type === 'api_key' && Boolean(entry.key) || entry.type === 'oauth' && Boolean(entry.access) && Number(entry.expires) > Date.now() + 60000));
      return usable ? result(true, 'ready', 'CLI responds; Pi provider credentials are configured') : result(true, 'needs_auth', 'Connect a Pi provider on this machine');
    } catch { return result(true, 'needs_auth', 'Connect a Pi provider on this machine'); }
  }
  return result(true, 'unknown', 'CLI responds; provider login could not be checked');
}

export function harnessHealth() { return snapshot; }
export async function refreshHarnessHealth(force = false) {
  if (pending) return pending;
  if (!force && Date.now() - checkedAt < 30000) return snapshot;
  pending = Promise.all(harnessNames.map(async name => [name, await probe(name)])).then(rows => {
    snapshot = Object.fromEntries(rows);
    checkedAt = Date.now();
    return snapshot;
  }).finally(() => { pending = undefined; });
  return pending;
}
