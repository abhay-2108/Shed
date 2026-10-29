import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { liveSessionStates } from './live.js';
import { spawnToolSync } from './platform.js';

const home = os.homedir();
const roots = {
  codex: path.join(home, '.codex', 'sessions'),
  claude: path.join(home, '.claude', 'projects'),
  gemini: path.join(home, '.gemini', 'tmp'),
  geminiBrain: path.join(home, '.gemini', 'antigravity-cli', 'brain'),
  pi: path.join(home, '.pi', 'agent', 'sessions'),
};

function walk(dir, accept, maxDepth = 5, depth = 0, out = []) {
  if (depth > maxDepth) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, accept, maxDepth, depth + 1, out);
    else if (entry.isFile() && accept(full)) out.push(full);
  }
  return out;
}

function sliceFile(file, bytes, fromEnd = false) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = fromEnd ? Math.max(0, size - bytes) : 0;
    const buffer = Buffer.alloc(Math.min(bytes, size));
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (fromEnd && start > 0) text = text.slice(text.indexOf('\n') + 1);
    if (!fromEnd && size > bytes) text = text.slice(0, text.lastIndexOf('\n'));
    return text;
  } finally { fs.closeSync(fd); }
}

function jsonLines(text) {
  return text.split('\n').flatMap(line => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

// For showing a message: unlike clean(), keeps line breaks so Markdown survives;
// drops only the harness-injected blocks a person never wrote or reads.
function displayText(text, limit = 12000) {
  return String(text || '')
    .replace(/<(environment_context|system-reminder|oai-mem-citation)>[\s\S]*?<\/\1>/g, '')
    .replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit);
}

function clean(text, limit = 220) {
  return String(text || '').replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c?.type !== 'tool_result').map(c => typeof c === 'string' ? c : c.text || c.content || '').filter(x => typeof x === 'string' && x).join('\n\n');
}

function isUsefulPrompt(text) {
  const value = clean(text, 1000);
  if (/^\s*<(command-name|command-message|local-command-stdout|local-command-caveat|system-reminder)>/i.test(String(text || ''))) return false;
  return value.length > 8 && !/^(# AGENTS\.md instructions|<environment_context>|<permissions instructions>|You are Codex,)/i.test(value);
}

function lastModel(text) {
  const found = [...text.matchAll(/"model"\s*:\s*"([^"<]{1,100})"/g)].map(match => match[1]);
  return found.at(-1) || '';
}

function codexRecord(file) {
  const stat = fs.statSync(file);
  const lines = jsonLines(sliceFile(file, 256 * 1024));
  const meta = lines.find(x => x.type === 'session_meta')?.payload || {};
  const prompts = lines.filter(x => x.type === 'response_item' && x.payload?.type === 'message' && x.payload.role === 'user')
    .map(x => contentText(x.payload.content)).filter(isUsefulPrompt);
  const title = clean(prompts.find(x => !x.includes('AGENTS.md')) || prompts[0] || path.basename(meta.cwd || '', '/'));
  const tail = sliceFile(file, 128 * 1024, true);
  const recent = jsonLines(tail).filter(x => x.type === 'response_item' && x.payload?.type === 'message' && x.payload.role === 'user').map(x => contentText(x.payload.content)).filter(isUsefulPrompt);
  const id = path.basename(file).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/)?.[1] || meta.id || meta.session_id;
  if (!id) return null;
  return { id: `codex:${id}`, nativeId: id, harness: 'codex', title: title || 'Untitled Codex session', lastPrompt: clean(recent.at(-1), 260), cwd: meta.cwd || '', currentModel: lastModel(tail), updatedAt: stat.mtime.toISOString(), file, source: 'desktop' };
}

function claudeRecord(file) {
  const stat = fs.statSync(file);
  const lines = jsonLines(sliceFile(file, 256 * 1024));
  const first = lines.find(x => x.type === 'user' && !x.isSidechain && isUsefulPrompt(contentText(x.message?.content)));
  const title = clean(contentText(first?.message?.content));
  const tail = sliceFile(file, 128 * 1024, true);
  const recent = jsonLines(tail).filter(x => x.type === 'user' && !x.isSidechain).map(x => contentText(x.message?.content)).filter(isUsefulPrompt);
  const id = first?.sessionId || path.basename(file, '.jsonl');
  return { id: `claude:${id}`, nativeId: id, harness: 'claude', title: title || 'Untitled Claude session', lastPrompt: clean(recent.at(-1), 260), cwd: first?.cwd || '', currentModel: lastModel(tail), updatedAt: stat.mtime.toISOString(), file, source: 'desktop' };
}

function geminiRecord(file) {
  const stat = fs.statSync(file);
  if (stat.size > 8 * 1024 * 1024) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const first = messages.find(x => x.type === 'user' || x.role === 'user');
  const last = messages.filter(x => x.type === 'user' || x.role === 'user').at(-1);
  const title = clean(first?.content || first?.text || first?.message);
  const id = data.sessionId || path.basename(file, '.json');
  return { id: `gemini:${id}`, nativeId: id, harness: 'gemini', title: title || 'Untitled Gemini session', lastPrompt: clean(last?.content || last?.text || last?.message, 260), cwd: data.cwd || '', currentModel: [...messages].reverse().find(x => typeof x.model === 'string')?.model || '', updatedAt: data.lastUpdated || stat.mtime.toISOString(), file, source: 'desktop' };
}

function geminiBrainRecord(file) {
  const stat = fs.statSync(file);
  const head = sliceFile(file, 64 * 1024);
  const lines = jsonLines(head);
  const userItems = lines.filter(x => x.type === 'USER_INPUT' && x.content);
  const firstRaw = userItems[0]?.content || '';
  const firstReqMatch = firstRaw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  const firstPrompt = clean(firstReqMatch ? firstReqMatch[1] : firstRaw, 200);
  if (!firstPrompt) return null;

  const tail = sliceFile(file, 64 * 1024, true);
  const tailLines = jsonLines(tail);
  const lastRaw = tailLines.filter(x => x.type === 'USER_INPUT' && x.content).at(-1)?.content || firstRaw;
  const lastReqMatch = lastRaw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  const lastPrompt = clean(lastReqMatch ? lastReqMatch[1] : lastRaw, 260);

  const convIdMatch = file.match(/[\\/]brain[\\/]([0-9a-f-]{36})[\\/]/i);
  const id = convIdMatch ? convIdMatch[1] : path.basename(path.dirname(path.dirname(path.dirname(file))));

  // Dynamically extract the workspace CWD from the transcript rather than hardcoding a machine path.
  const cwdMatch = head.match(/"cwd"\s*:\s*"([^"]{2,260})"/);
  const workspaceMatch = head.match(/Command Working Directory:\s*([^\n\r"]{2,260})/);
  const cwd = cwdMatch?.[1] || workspaceMatch?.[1]?.trim() || '';

  // Extract the most-recently-chosen model from the transcript; default to empty string.
  const modelMatch = [...(tail + head).matchAll(/"Model Selection" from [^"]*"[^"]*" to ([^\n.]+)/g)].at(-1);
  const currentModel = modelMatch?.[1]?.trim() || '';

  return {
    id: `gemini:${id}`,
    nativeId: id,
    harness: 'gemini',
    title: firstPrompt || 'Antigravity session',
    lastPrompt,
    cwd,
    currentModel,
    updatedAt: stat.mtime.toISOString(),
    file,
    source: 'desktop',
    engine: 'agy'
  };
}

function piRecord(file) {
  const stat = fs.statSync(file);
  const lines = jsonLines(sliceFile(file, 256 * 1024));
  const meta = lines.find(x => x.type === 'session') || {};
  const prompts = lines.filter(x => x.type === 'message' && x.message?.role === 'user').map(x => contentText(x.message.content)).filter(isUsefulPrompt);
  const tail = sliceFile(file, 128 * 1024, true);
  const recent = jsonLines(tail).filter(x => x.type === 'message' && x.message?.role === 'user').map(x => contentText(x.message.content)).filter(isUsefulPrompt);
  const id = meta.id || path.basename(file, '.jsonl').match(/[0-9a-f]{8}-[0-9a-f-]{27,}/)?.[0];
  if (!id) return null;
  return { id:`pi:${id}`, nativeId:id, harness:'pi', title:clean(prompts[0]) || 'Untitled Pi session', lastPrompt:clean(recent.at(-1), 260), cwd:meta.cwd || '', currentModel:lastModel(tail), updatedAt:stat.mtime.toISOString(), file, source:'desktop' };
}

// Asking the OpenCode CLI for its sessions takes about half a second, so its list is reused for a minute.
let opencodeCache = { at:0, rows:[] };
function opencodeCached() {
  if (Date.now() - opencodeCache.at > 60000) opencodeCache = { at:Date.now(), rows:opencodeRecords() };
  return opencodeCache.rows;
}

function opencodeRecords() {
  const dbPath = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare(`
        SELECT id, title, directory, time_created, time_updated, model
        FROM session_v2
        WHERE parent_id IS NULL
        ORDER BY time_updated DESC
        LIMIT 100
      `).all();

      return rows.map(row => {
        const updated = row.time_updated || row.time_created || Date.now();
        let model = '';
        try { model = JSON.parse(row.model)?.id || ''; } catch {}

        let lastPrompt = '';
        try {
          const lastMsg = db.prepare(`
            SELECT data FROM session_message
            WHERE session_id = ? AND type = 'user'
            ORDER BY seq DESC LIMIT 1
          `).get(row.id);
          if (lastMsg) {
            const parsed = JSON.parse(lastMsg.data);
            lastPrompt = clean(parsed.text || '', 260);
          }
        } catch {}

        return {
          id: `opencode:${row.id}`,
          nativeId: row.id,
          harness: 'opencode',
          title: clean(row.title) || 'Untitled OpenCode session',
          lastPrompt,
          cwd: row.directory || '',
          currentModel: model,
          updatedAt: typeof updated === 'number' ? new Date(updated).toISOString() : updated,
          file: null,
          source: 'desktop'
        };
      });
    } catch (err) {}
  }

  const result = spawnToolSync('opencode', ['session', 'list', '--format', 'json'], { encoding:'utf8', timeout:5000, maxBuffer:4 * 1024 * 1024 });
  if (result.status !== 0) return [];
  let rows;
  try { rows = JSON.parse(result.stdout); } catch { return []; }
  if (!Array.isArray(rows)) rows = rows.sessions;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(row => {
    const id = row.id || row.sessionId;
    if (!id) return [];
    const updated = row.time?.updated || row.updatedAt || row.updated;
    return [{ id:`opencode:${id}`, nativeId:id, harness:'opencode', title:clean(row.title || row.name) || 'Untitled OpenCode session', lastPrompt:'', cwd:row.directory || row.cwd || '', updatedAt:typeof updated === 'number' ? new Date(updated).toISOString() : updated || new Date().toISOString(), file:null, source:'desktop' }];
  });
}

// Parsing a transcript reads up to 384 KB of it, and there are hundreds; reuse the result until the file changes.
// Cap at 2000 entries to prevent unbounded growth when many sessions accumulate over time.
const parsed = new Map();
const PARSED_CACHE_LIMIT = 2000;
function parseCached(file, parse) {
  const stat = fs.statSync(file);
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = parsed.get(file);
  if (hit && hit.key === key) return hit.item;
  const item = parse(file);
  if (parsed.size >= PARSED_CACHE_LIMIT) parsed.delete(parsed.keys().next().value);
  parsed.set(file, { key, item });
  return item;
}

export function discoverSessions() {
  const inputs = [
    ...walk(roots.codex, f => f.endsWith('.jsonl'), 5).map(file => [file, codexRecord]),
    ...walk(roots.claude, f => f.endsWith('.jsonl') && !/[\\/]subagents[\\/]/.test(f), 3).map(file => [file, claudeRecord]),
    ...walk(roots.gemini, f => f.endsWith('.json') && /[\\/]chats[\\/]/.test(f), 4).map(file => [file, geminiRecord]),
    ...walk(roots.geminiBrain, f => f.endsWith('transcript.jsonl'), 5).map(file => [file, geminiBrainRecord]),
    ...walk(roots.pi, f => f.endsWith('.jsonl'), 3).map(file => [file, piRecord]),
  ];
  const sessions = [];
  for (const [file, parse] of inputs) {
    try { const item = parseCached(file, parse); if (item) sessions.push(item); } catch { /* Ignore incomplete live files. */ }
  }
  try { sessions.push(...opencodeCached()); } catch {}
  const live = liveSessionStates(sessions);
  return sessions.filter(session => !(session.title.startsWith('Untitled ') && !session.cwd))
    .map(session => ({ ...session, liveState:live.get(session.id)?.liveState || 'history', tty:live.get(session.id)?.tty || '' }))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function sessionMessages(session) {
  const file = session.file;
  if (session.harness === 'opencode') {
    const dbPath = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
    if (fs.existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const rows = db.prepare(`
          SELECT type, data, time_created
          FROM session_message
          WHERE session_id = ?
          ORDER BY seq ASC
          LIMIT 80
        `).all(session.nativeId);

        return rows.map(r => {
          let text = '';
          try {
            const parsed = JSON.parse(r.data);
            text = displayText(parsed.text || parsed.content?.[0]?.text || parsed.parts?.map(p => p.text).join('\n') || '');
          } catch {}
          return {
            role: r.type === 'user' ? 'user' : 'assistant',
            text,
            at: typeof r.time_created === 'number' ? new Date(r.time_created).toISOString() : r.time_created
          };
        }).filter(x => x.text).slice(-60);
      } catch {}
    }

    const result = spawnToolSync('opencode', ['export', session.nativeId], { encoding:'utf8', timeout:5000, maxBuffer:6 * 1024 * 1024 });
    if (result.status !== 0) return [];
    try {
      const data = JSON.parse(result.stdout);
      return (data.messages || []).map(x => ({ role:x.role || x.info?.role || 'assistant', text:displayText(x.content || x.text || x.parts?.map(p => p.text).join('\n')), at:x.timestamp || x.time?.created })).filter(x => x.text).slice(-60);
    } catch { return []; }
  }
  if (!file || !fs.existsSync(file)) return [];
  if (session.harness === 'gemini') {
    if (file.endsWith('.jsonl')) {
      const rows = jsonLines(sliceFile(file, 2 * 1024 * 1024, true));
      return rows.flatMap(row => {
        if (row.type === 'USER_INPUT' && row.content) {
          const match = row.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
          const text = displayText((match ? match[1] : row.content).trim());
          if (text) return [{ role: 'user', text, at: row.created_at }];
        }
        if (row.type === 'PLANNER_RESPONSE' && row.content) {
          const text = displayText(row.content);
          if (text) return [{ role: 'assistant', text, at: row.created_at }];
        }
        return [];
      }).slice(-60);
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (data.messages || []).map(x => ({ role: x.type === 'user' || x.role === 'user' ? 'user' : 'assistant', text: displayText(x.content || x.text || x.message), at: x.timestamp || x.time })).filter(x => x.text).slice(-60);
  }
  const rows = jsonLines(sliceFile(file, 2 * 1024 * 1024, true));
  const messages = [];
  for (const row of rows) {
    if (session.harness === 'codex' && row.type === 'response_item' && row.payload?.type === 'message' && ['user', 'assistant'].includes(row.payload.role)) {
      const text = displayText(contentText(row.payload.content));
      if (text && !(row.payload.role === 'user' && !isUsefulPrompt(text))) messages.push({ role: row.payload.role, text, at: row.timestamp });
    }
    if (session.harness === 'claude' && ['user', 'assistant'].includes(row.type) && !row.isSidechain) {
      const raw = contentText(row.message?.content), text = displayText(raw);
      if (text && !(row.type === 'user' && !isUsefulPrompt(raw))) messages.push({ role: row.type, text, at: row.timestamp });
    }
    if (session.harness === 'pi' && row.type === 'message' && ['user', 'assistant'].includes(row.message?.role)) {
      const text = displayText(contentText(row.message.content));
      if (text) messages.push({ role:row.message.role, text, at:row.timestamp });
    }
  }
  return messages.slice(-60);
}

export function codexQueuedProgress(task) {
  if (task.harness !== 'codex' || !task.transcriptFile || !fs.existsSync(task.transcriptFile)) return null;
  const rows = jsonLines(sliceFile(task.transcriptFile, 4 * 1024 * 1024, true));
  const expected = clean(task.agentPrompt || task.prompt, 20000).slice(0, 80);
  let found = false;
  let working = false;
  let completed = false;
  const output = [];
  for (const row of rows) {
    if (!found) {
      if (row.type !== 'response_item' || row.payload?.type !== 'message' || row.payload.role !== 'user') continue;
      if (Date.parse(row.timestamp || '') < Date.parse(task.createdAt) - 2000) continue;
      found = clean(contentText(row.payload.content), 20000).startsWith(expected);
      continue;
    }
    if (row.type === 'event_msg' && row.payload?.type === 'task_started') working = true;
    if (row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'assistant') {
      const message = displayText(contentText(row.payload.content));
      if (message) output.push(message);
    }
    if (row.type === 'event_msg' && row.payload?.type === 'task_complete') { completed = true; break; }
    if (row.type === 'event_msg' && row.payload?.type === 'turn_aborted') return { status:'failed', output:output.join('\n\n'), error:'The Codex turn was interrupted.' };
  }
  return found ? { status:completed ? 'completed' : 'running', output:output.join('\n\n'), working } : null;
}

export function publicSession(session) {
  const { file, nativeId, ...safe } = session;
  return safe;
}

const scans = new Map();
const CHUNK = 8 * 1024 * 1024;
export function claudeTerminalProgress(task) {
  if (!task.transcriptFile || !fs.existsSync(task.transcriptFile)) return { found:false, output:'' };
  const expected = clean(task.agentPrompt || task.prompt, 20000).slice(0, 80);
  const key = task.id || `${task.transcriptFile}|${task.createdAt}|${expected}`;
  let scan = scans.get(key);
  if (!scan || scan.file !== task.transcriptFile) {
    scan = { file:task.transcriptFile, offset:Math.max(0, Number(task.transcriptOffset) || 0), rest:Buffer.alloc(0), foundAt:null, output:[] };
    scans.set(key, scan);
    if (scans.size > 100) scans.delete(scans.keys().next().value);
  }
  const fd = fs.openSync(scan.file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < scan.offset) Object.assign(scan, { offset:0, rest:Buffer.alloc(0), foundAt:null, output:[] });
    while (scan.offset < size) {
      const buffer = Buffer.alloc(Math.min(CHUNK, size - scan.offset));
      const read = fs.readSync(fd, buffer, 0, buffer.length, scan.offset);
      if (!read) break;
      scan.offset += read;
      const data = Buffer.concat([scan.rest, buffer.subarray(0, read)]);
      const end = data.lastIndexOf(10);
      scan.rest = end < 0 ? data : data.subarray(end + 1);
      if (end < 0) continue;
      for (const row of jsonLines(data.subarray(0, end).toString('utf8'))) {
        if (row.isSidechain) continue;
        if (!scan.foundAt) {
          if (row.type !== 'user' || Date.parse(row.timestamp || '') < Date.parse(task.createdAt) - 5000) continue;
          const raw = contentText(row.message?.content);
          if (isUsefulPrompt(raw) && clean(raw, 20000).startsWith(expected)) scan.foundAt = Date.parse(row.timestamp);
          continue;
        }
        if (row.type === 'assistant') {
          const message = displayText(contentText(row.message?.content));
          if (message) scan.output.push(message);
        }
      }
    }
  } finally { fs.closeSync(fd); }
  return { found:Boolean(scan.foundAt), foundAt:scan.foundAt, output:scan.output.join('\n\n') };
}

export function findCodexTranscript(task) {
  const since = Date.parse(task.createdAt) - 5000;
  const expected = clean(task.agentPrompt || task.prompt, 20000).slice(0, 80);
  const recent = walk(roots.codex, f => f.endsWith('.jsonl'), 5)
    .map(file => { try { return { file, mtime:fs.statSync(file).mtimeMs, birth:fs.statSync(file).birthtimeMs }; } catch { return null; } })
    .filter(x => x && x.birth >= since)
    .sort((a, b) => b.birth - a.birth);
  for (const { file } of recent) {
    const rows = jsonLines(sliceFile(file, 512 * 1024));
    const meta = rows.find(x => x.type === 'session_meta')?.payload || {};
    if (task.cwd && meta.cwd && path.resolve(meta.cwd) !== path.resolve(task.cwd)) continue;
    const opened = rows.some(x => x.type === 'response_item' && x.payload?.type === 'message' && x.payload.role === 'user' && clean(contentText(x.payload.content), 20000).startsWith(expected));
    const id = meta.id || path.basename(file).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/)?.[1];
    if (opened && id) return { file, id };
  }
  return null;
}
