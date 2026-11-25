/**
 * agy-purge — 覆盖提示词（prompt-inject）
 *
 * 优先级与 hooks/lib/io.mjs 的 resolvePrompt 保持一致，两边必须同步：
 *   <data>/prompt-inject.md  →  <data>/prompt-<variant>.md
 *   →  <plugin>/prompts/override.<variant>.md  →  <plugin>/prompts/override.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readText, sha256, writeAtomic } from './fsx.mjs';

export const VARIANTS = ['gemini', 'claude', 'gpt', 'generic'];
export const VARIANT_LABEL = {
  gemini: 'Gemini / Gemini Flash（默认）',
  claude: 'Claude Sonnet / Opus',
  gpt: 'GPT / OSS 系',
  generic: '通用兜底',
};

export function promptFile(dataDir) {
  return path.join(dataDir, 'prompt-inject.md');
}

export function variantFile(dataDir, variant) {
  return path.join(dataDir, `prompt-${variant}.md`);
}

export function bundledPrompt(repoRoot, variant = 'gemini') {
  const ordered = [
    path.join(repoRoot, 'prompts', `override.${variant}.md`),
    path.join(repoRoot, 'prompts', 'override.md'),
  ];
  for (const file of ordered) {
    const text = readText(file);
    if (text && text.trim()) return { text, file };
  }
  return { text: '', file: null };
}

export function resolvePromptFile(dataDir, repoRoot, { variant = 'auto' } = {}) {
  const candidates = [];
  if (variant && variant !== 'auto') {
    candidates.push({ file: variantFile(dataDir, variant), source: `user:prompt-${variant}.md` });
  }
  candidates.push({ file: promptFile(dataDir), source: 'user:prompt-inject.md' });
  for (const item of candidates) {
    const text = readText(item.file);
    if (text && text.trim()) return { ...item, text, origin: 'user' };
  }
  const bundled = bundledPrompt(repoRoot, variant === 'auto' ? 'gemini' : variant);
  return { file: bundled.file, text: bundled.text, source: bundled.file ? `default:${path.basename(bundled.file)}` : 'none', origin: 'default' };
}

export function seedPrompt(dataDir, repoRoot, { force = false } = {}) {
  const target = promptFile(dataDir);
  if (!force && fs.existsSync(target)) {
    const existing = readText(target);
    if (existing && existing.trim()) return { file: target, created: false };
  }
  const bundled = bundledPrompt(repoRoot, 'gemini');
  ensureDir(dataDir);
  writeAtomic(target, bundled.text.endsWith('\n') ? bundled.text : `${bundled.text}\n`);
  return { file: target, created: true };
}

export function savePrompt(dataDir, text, { variant = null } = {}) {
  const target = variant ? variantFile(dataDir, variant) : promptFile(dataDir);
  ensureDir(path.dirname(target));
  writeAtomic(target, text.endsWith('\n') ? text : `${text}\n`);
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
  files.push({
    scope: 'main',
    variant: null,
    file: main,
    exists: mainText !== null,
    ...promptStats(mainText || ''),
  });
  for (const variant of VARIANTS) {
    const file = variantFile(dataDir, variant);
    const text = readText(file);
    if (text === null) continue;
    files.push({ scope: 'variant', variant, file, exists: true, ...promptStats(text) });
  }
  return files;
}
