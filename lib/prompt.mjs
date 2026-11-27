/**
 * agy-purge — 覆盖提示词（prompt-inject）
 *
 * 优先级与 hooks/lib/io.mjs 的 promptCandidates 必须完全一致，两边都要改：
 *   <data>/prompt-inject.md                用户稿（最高优先）
 *   <data>/prompt-<family>-<tier>.md       用户按家族+档位分稿
 *   <data>/prompt-<family>.md              用户按家族分稿
 *   <plugin>/prompts/override.<family>-<tier>.md  内置分档稿
 *   <plugin>/prompts/override.<family>.md         内置家族稿
 *   <plugin>/prompts/override.<tier>.md           内置档位兜底
 *   <plugin>/prompts/override.md                  总兜底
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readText, sha256, writeAtomic } from './fsx.mjs';

export const FAMILIES = ['gemini', 'claude', 'gpt'];
export const TIERS = ['light', 'strong'];
export const VARIANT_LABEL = {
  gemini: 'Gemini / Gemini Flash',
  claude: 'Claude Sonnet / Opus',
  gpt: 'GPT / OSS 系',
  generic: '通用兜底',
};

const FAMILY_BY_MODEL = [
  [/claude|sonnet|opus|haiku/i, 'claude'],
  [/gpt|openai|oss/i, 'gpt'],
  [/gemini|flash|pro\b|neon/i, 'gemini'],
];
const STRONG_MODEL = /neon|ultra|high|thinking|opus|sonnet|pro\b|max|reason/i;
const LIGHT_MODEL = /flash|mini|lite|fast|medium|small|nano/i;

export function modelFamily(modelName) {
  const name = String(modelName || '');
  for (const [re, id] of FAMILY_BY_MODEL) if (re.test(name)) return id;
  return 'gemini';
}

export function modelTier(modelName) {
  const name = String(modelName || '');
  if (STRONG_MODEL.test(name)) return 'strong';
  if (LIGHT_MODEL.test(name)) return 'light';
  return 'light';
}

export function promptFile(dataDir) {
  return path.join(dataDir, 'prompt-inject.md');
}

export function variantFile(dataDir, variant) {
  return path.join(dataDir, `prompt-${variant}.md`);
}

export function candidates(dataDir, repoRoot, { modelName = '', forced = 'auto' } = {}) {
  const family = forced && forced !== 'auto' ? forced : modelFamily(modelName);
  const tier = forced && forced !== 'auto' ? 'light' : modelTier(modelName);
  return {
    family,
    tier,
    ordered: [
      { file: promptFile(dataDir), source: 'user:prompt-inject.md', id: 'user' },
      { file: path.join(dataDir, `prompt-${family}-${tier}.md`), source: `user:prompt-${family}-${tier}.md`, id: 'user-tier' },
      { file: path.join(dataDir, `prompt-${family}.md`), source: `user:prompt-${family}.md`, id: 'user-family' },
      { file: path.join(repoRoot, 'prompts', `override.${family}-${tier}.md`), source: `default:override.${family}-${tier}.md`, id: 'bundled-tier' },
      { file: path.join(repoRoot, 'prompts', `override.${family}.md`), source: `default:override.${family}.md`, id: 'bundled-family' },
      { file: path.join(repoRoot, 'prompts', `override.${tier}.md`), source: `default:override.${tier}.md`, id: 'bundled-tier-generic' },
      { file: path.join(repoRoot, 'prompts', 'override.md'), source: 'default:override.md', id: 'bundled-default' },
    ],
  };
}

/** 内置稿：按家族+档位找，找不到再往下退。 */
export function bundledPrompt(repoRoot, { family = 'gemini', tier = 'light' } = {}) {
  const ordered = [
    path.join(repoRoot, 'prompts', `override.${family}-${tier}.md`),
    path.join(repoRoot, 'prompts', `override.${family}.md`),
    path.join(repoRoot, 'prompts', `override.${tier}.md`),
    path.join(repoRoot, 'prompts', 'override.md'),
  ];
  for (const file of ordered) {
    const text = readText(file);
    if (text && text.trim()) return { text, file, family, tier };
  }
  return { text: '', file: null, family, tier };
}

function readSeededSha(dataDir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    return String(state?.seededSha || '');
  } catch {
    return '';
  }
}

export function resolvePromptFile(dataDir, repoRoot, { variant = 'auto', modelName = '' } = {}) {
  const { family, tier, ordered } = candidates(dataDir, repoRoot, { modelName, forced: variant });
  const seededSha = readSeededSha(dataDir);
  for (const item of ordered) {
    const text = readText(item.file);
    if (!text || !text.trim()) continue;
    // 与 hook 一致：自动种子稿不冒充用户覆盖，否则按模型分档永远不会生效
    if (item.id === 'user' && seededSha && sha256(text) === seededSha) continue;
    return { ...item, text, origin: item.id.startsWith('user') ? 'user' : 'default', family, tier };
  }
  const bundled = bundledPrompt(repoRoot, { family, tier });
  return {
    file: bundled.file,
    text: bundled.text,
    source: bundled.file ? `default:${path.basename(bundled.file)}` : 'none',
    origin: 'default',
    family,
    tier,
  };
}

export function seedPrompt(dataDir, repoRoot, { force = false } = {}) {
  const target = promptFile(dataDir);
  if (!force && fs.existsSync(target)) {
    const existing = readText(target);
    if (existing && existing.trim()) return { file: target, created: false, sha256: sha256(existing) };
  }
  const bundled = bundledPrompt(repoRoot, { family: 'gemini', tier: 'light' });
  ensureDir(dataDir);
  const text = normalizePromptText(bundled.text);
  writeAtomic(target, text);
  return { file: target, created: true, sha256: sha256(text) };
}

/** 统一结尾换行，避免「改了一个换行就判定用户改过」。 */
export function normalizePromptText(text) {
  const value = String(text || '');
  return value.endsWith('\n') ? value : `${value}\n`;
}

/**
 * 内置稿的升级：只有当磁盘上的稿子仍是**我们上次写下的那一版**（sha 一致，
 * 或仍带我们的标题）时才替换。用户自己动过一个字就不碰——覆盖稿是用户文件。
 */
export function upgradeBundledPrompt(dataDir, repoRoot, { seededSha, autoUpgrade = true } = {}) {
  const file = promptFile(dataDir);
  const current = readText(file);
  const bundled = bundledPrompt(repoRoot, { family: 'gemini', tier: 'light' });
  if (!bundled.text) return { changed: false, reason: 'no-bundled' };

  const nextText = normalizePromptText(bundled.text);
  const nextSha = sha256(nextText);
  if (!current || !current.trim()) {
    ensureDir(dataDir);
    writeAtomic(file, nextText);
    return { changed: true, sha256: nextSha, reason: 'seeded' };
  }
  const currentSha = sha256(current);
  if (currentSha === nextSha) return { changed: false, sha256: currentSha, reason: 'current' };
  if (!autoUpgrade) return { changed: false, sha256: currentSha, reason: 'disabled' };

  const looksBundled = /^#\s*(执行层覆盖稿|工作约定)/.test(current.trimStart());
  const trusted = seededSha ? currentSha === seededSha : looksBundled;
  if (!trusted) return { changed: false, sha256: currentSha, reason: 'user-edited' };

  writeAtomic(file, nextText);
  return { changed: true, sha256: nextSha, reason: 'upgraded' };
}

export function savePrompt(dataDir, text, { variant = null } = {}) {
  const target = variant ? variantFile(dataDir, variant) : promptFile(dataDir);
  ensureDir(path.dirname(target));
  writeAtomic(target, normalizePromptText(text));
  return target;
}

export function resetPrompt(dataDir, repoRoot, { variant = null } = {}) {
  const target = variant ? variantFile(dataDir, variant) : promptFile(dataDir);
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  if (!variant) return seedPrompt(dataDir, repoRoot, { force: true }).file;
  return target;
}

export function promptStats(text) {
  const normalized = String(text || '');
  return {
    chars: normalized.length,
    bytes: Buffer.byteLength(normalized, 'utf8'),
    lines: normalized ? normalized.split(/\r?\n/).length : 0,
    sha256: sha256(normalized),
  };
}

export function listPromptFiles(dataDir) {
  const files = [];
  const main = promptFile(dataDir);
  const mainText = readText(main);
  files.push({ scope: 'main', variant: null, file: main, exists: mainText !== null, ...promptStats(mainText || '') });
  let entries = [];
  try {
    entries = fs.readdirSync(dataDir);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    const match = /^prompt-(.+)\.md$/.exec(name);
    if (!match) continue;
    const file = path.join(dataDir, name);
    const text = readText(file);
    if (text === null) continue;
    files.push({ scope: 'variant', variant: match[1], file, exists: true, ...promptStats(text) });
  }
  return files;
}
