import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const harnesses = ['codex', 'claude', 'gemini', 'pi', 'opencode'];

const curated = {
  claude: [
    { id: 'opus', label: 'Opus', description: 'Deep reasoning and complex implementation.', enabled: true },
    { id: 'sonnet', label: 'Sonnet', description: 'Balanced coding and everyday tasks.', enabled: true },
    { id: 'haiku', label: 'Haiku', description: 'Fast, simple tasks and lightweight edits.', enabled: true },
  ],
  gemini: [
    { id: 'Gemini 3.8 Flash (High)', label: 'Gemini 3.8 Flash (High)', description: 'Fast, high reasoning effort in Antigravity.', enabled: true },
    { id: 'Gemini 3.8 Flash (Medium)', label: 'Gemini 3.8 Flash (Medium)', description: 'Balanced speed and reasoning in Antigravity.', enabled: true },
    { id: 'Gemini 3.8 Flash (Low)', label: 'Gemini 3.8 Flash (Low)', description: 'Fast responses for quick edits.', enabled: true },
    { id: 'Claude Sonnet 4.6 (Thinking)', label: 'Claude Sonnet 4.6 (Thinking)', description: 'Claude Sonnet with extended thinking in Antigravity.', enabled: true },
    { id: 'Claude Opus 4.6', label: 'Claude Opus 4.6', description: 'Claude Opus for complex tasks in Antigravity.', enabled: true },
  ],
  pi: [],
  opencode: [
    { id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet', description: 'State-of-the-art coding and agentic reasoning.', enabled: true },
    { id: 'gpt-4o', label: 'GPT-4o', description: 'High-speed multimodal reasoning and code generation.', enabled: true },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Complex reasoning with large context window.', enabled: true },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Fast, balanced coding model.', enabled: true },
    { id: 'deepseek-chat', label: 'DeepSeek', description: 'Efficient reasoning and general coding.', enabled: true },
  ],
};

function codexDefaults(home = os.homedir()) {
  let configured = '';
  try { configured = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').match(/^model\s*=\s*"([^"]+)"/m)?.[1] || ''; } catch {}
  let models = [];
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'models_cache.json'), 'utf8'));
    models = (cache.models || []).filter(m => m.visibility === 'list' && m.supported_in_api !== false)
      .map(m => ({ id:m.slug, label:m.display_name || m.slug, description:m.description || '', enabled:true }));
  } catch {}
  if (configured && !models.some(m => m.id === configured)) models.unshift({ id:configured, label:configured, description:'Current Codex default.', enabled:true });
  const preferred = models.filter(m => /^(gpt-6-astra|gpt-6-sol|gpt-6-luna)$/.test(m.id));
  return { models:(preferred.length >= 2 ? preferred : models.slice(0, 6)), defaultModel:configured };
}

export function defaultModelConfig(harness, home = os.homedir()) {
  if (harness === 'codex') return codexDefaults(home);
  if (!harnesses.includes(harness)) throw new Error('Unsupported harness.');
  return { models:curated[harness].map(model => ({ ...model })), defaultModel:'' };
}

export function modelConfig(harness, overrides = {}, home = os.homedir()) {
  if (!harnesses.includes(harness)) throw new Error('Unsupported harness.');
  const saved = overrides?.[harness];
  return saved ? { models:saved.models.map(model => ({ ...model })), defaultModel:saved.defaultModel || '' } : defaultModelConfig(harness, home);
}

export function validateModelConfig(harness, input) {
  if (!harnesses.includes(harness)) throw new Error('Unsupported harness.');
  if (!Array.isArray(input.models) || input.models.length > 16) throw new Error('Use at most 16 models per harness.');
  const seen = new Set();
  const models = input.models.map(model => {
    if (!model || typeof model.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/()\s-]{0,99}$/.test(model.id)) throw new Error('Model IDs must be 1–100 letters, numbers, spaces, dots, slashes, colons, parentheses, dashes, or underscores.');
    if (seen.has(model.id)) throw new Error('Model IDs must be unique within a harness.');
    seen.add(model.id);
    const label = String(model.label || model.id).trim();
    const description = String(model.description || '').trim();
    if (label.length > 100 || description.length > 300) throw new Error('Model label or description is too long.');
    return { id:model.id, label, description, enabled:model.enabled !== false };
  });
  const defaultModel = String(input.defaultModel || '');
  if (defaultModel && !models.some(model => model.id === defaultModel && model.enabled)) throw new Error('Default model must be an enabled model.');
  return { models, defaultModel };
}
