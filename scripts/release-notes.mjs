#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 里抽取某个版本的「改了什么 / 修了哪些 bug」，作为 GitHub Release 说明。
 *
 * 用法：
 *   node scripts/release-notes.mjs 1.2.1          # 打印到 stdout
 *   node scripts/release-notes.mjs 1.2.1 --out dist/RELEASE_NOTES.md
 *   node scripts/release-notes.mjs --latest       # 取最新一个版本
 *
 * 单一来源：Release 说明不再手写，避免和 CHANGELOG 漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function sections(markdown) {
  const lines = markdown.split('\n');
  const out = [];
  let current = null;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const label = heading[1].trim();
      const version = /^v?(\d+\.\d+\.\d+)/.exec(label)?.[1] || null;
      current = { label, version, body: [] };
      out.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }
  return out.filter((s) => s.version);
}

function pick(list, wanted) {
  if (wanted === '--latest' || wanted === 'latest') return list[0];
  const clean = String(wanted).replace(/^v/, '');
  return list.find((s) => s.version === clean);
}

function render(section) {
  const body = section.body
    .join('\n')
    .replace(/^\n+/, '')
    // 去掉版本之间那条分隔线，避免和模板自己的 --- 重复
    .replace(/(\n\s*---\s*)+\s*$/, '')
    .replace(/\s+$/, '');
  return [
    `# agy-purge v${section.version}`,
    '',
    body,
    '',
    '---',
    '',
    '升级：`agy-purge apply` → 完全退出 Antigravity → 新开会话。回滚：`agy-purge revert`。',
    '完整历史：[CHANGELOG.md](https://github.com/machine-gun-tt/agy-purge-T/blob/master/CHANGELOG.md)',
    '',
  ].join('\n');
}

const args = process.argv.slice(2);
const wanted = args.find((a) => !a.startsWith('--')) || '--latest';
const outIndex = args.indexOf('--out');
const list = sections(read(CHANGELOG));
const section = pick(list, wanted);

if (!section) {
  process.stderr.write(`CHANGELOG.md 里没有版本 ${wanted}；现有：${list.map((s) => s.version).join(', ')}\n`);
  process.exit(1);
}

const text = render(section);
if (outIndex !== -1 && args[outIndex + 1]) {
  const target = path.resolve(ROOT, args[outIndex + 1]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
  process.stderr.write(`wrote ${path.relative(ROOT, target)} (${text.length} chars)\n`);
} else {
  process.stdout.write(text);
}
