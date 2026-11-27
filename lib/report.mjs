/** agy-purge — 状态采集与终端渲染 */
import { loadConfig, pluginList } from './config.mjs';
import { contextSummary, readLayers, statusAll, summarize } from './install.mjs';
import { LAYERS, readRuntimeConfig, readState, stateFile } from './patches.mjs';
import { hostFingerprint } from './paths.mjs';
import { listPromptFiles, promptStats, resolvePromptFile } from './prompt.mjs';
import { DEFAULT_CONFIG } from '../hooks/lib/io.mjs';

const GLYPH = {
  applied: '✓',
  pending: '○',
  drift: '!',
  conflict: '✗',
  skipped: '·',
};

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
};

const STATE_COLOR = { applied: 'green', pending: 'yellow', drift: 'yellow', conflict: 'red', skipped: 'gray' };

export function collectStatus(ctx) {
  const items = statusAll(ctx);
  const counts = summarize(items);
  const cfg = loadConfig(ctx.configRoot);
  const resolved = resolvePromptFile(ctx.dataDir, ctx.repoRoot);
  const runtimeCfg = readRuntimeConfig(ctx.dataDir).data || {};
  const state = readState(ctx.dataDir);

  const warnings = [];
  if (cfg.corrupt) warnings.push(`config.json 无法解析（${cfg.file}），所有写操作都会被拒绝`);
  if (!ctx.runtime?.ok) warnings.push(`没有可用 Node 运行时：${ctx.runtime?.note || '未知'}`);
  if (!ctx.host) warnings.push('未检测到 Antigravity 安装目录（可用 ANTIGRAVITY_INSTALL 指定）');
  if (items.find((i) => i.id === 'plugin:files')?.state === 'conflict') warnings.push('插件目录已被其它插件占用，换一个 configRoot 或先卸载冲突插件');
  for (const name of ['antigravity-filter-bypass', 'agy-powertools']) {
    const entry = pluginList(cfg.data).find((p) => p.id === name);
    if (entry && entry.enabled && name === 'antigravity-filter-bypass') {
      warnings.push(`检测到同时启用的 ${name}：两个插件都会接管 PreToolUse，先确认谁优先`);
    }
  }
  if (items.find((i) => i.id === 'prompt:seeded')?.state === 'pending') warnings.push('覆盖稿未落盘，注入层会回落到插件内置默认稿');

  const currentHost = hostFingerprint(ctx.host);
  const appliedHost = state.host?.id || null;
  const hostChanged = Boolean(currentHost && appliedHost && currentHost.id !== appliedHost);
  if (hostChanged) {
    warnings.push(
      `Antigravity 已换构建（${String(appliedHost).slice(0, 12)} → ${currentHost.id.slice(0, 12)}）：先 agy-purge apply 重渲染 hooks，再开新会话；行为变软时按 host-drift 处理`,
    );
  }

  return {
    ok: counts.conflict === 0,
    context: contextSummary(ctx),
    host: { current: currentHost?.id || null, appliedAtLastApply: appliedHost, changed: hostChanged },
    items,
    counts,
    layers: LAYERS,
    layersState: { ...readLayers(ctx.dataDir), ...(runtimeCfg.layers || {}) },
    prompt: {
      file: resolved.file,
      source: resolved.source,
      origin: resolved.origin,
      ...promptStats(resolved.text),
      files: listPromptFiles(ctx.dataDir),
    },
    state: {
      file: stateFile(ctx.dataDir),
      installedAt: state.appliedAt || null,
      version: state.version || null,
      runtime: state.runtime || null,
      revertedAt: state.revertedAt || null,
    },
    behavior: {
      strategy: runtimeCfg.prompt?.strategy || 'once',
      fullEvery: runtimeCfg.prompt?.fullEvery ?? 6,
      refreshOnCompaction: runtimeCfg.prompt?.refreshOnCompaction !== false,
      continueEnabled: (runtimeCfg.layers?.continue ?? DEFAULT_CONFIG.layers.continue) !== false,
      continueMax: runtimeCfg.continue?.max ?? 0,
      configVersion: runtimeCfg.version ?? 1,
      conversations: Object.keys(state.conversations || {}).length,
      lastInjection: state.conversations ? Object.values(state.conversations).sort((a, b) => String(b?.at || '').localeCompare(String(a?.at || '')))[0] || null : null,
    },
    warnings,
  };
}

function paint(text, color, enabled) {
  if (!enabled || !color) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

export function renderStatus(status, { color = process.stdout.isTTY && !process.env.NO_COLOR } = {}) {
  const lines = [];
  const c = status.context;

  lines.push(paint('agy-purge · Antigravity 破甲层', 'bold', color));
  lines.push('');
  lines.push(`${paint('宿主', 'gray', color)}       ${c.host ? c.host.root : '未检测到'}`);
  lines.push(`${paint('定制根', 'gray', color)}     ${c.configRoot}`);
  lines.push(`${paint('安装目录', 'gray', color)}   ${c.installDir}`);
  lines.push(`${paint('数据目录', 'gray', color)}   ${c.dataDir}`);
  lines.push(
    `${paint('运行时', 'gray', color)}     ${c.runtime?.ok ? `${c.runtime.note} · node v${c.runtime.version} · ${c.runtime.bin}` : `不可用 —— ${c.runtime?.note || ''}`}`,
  );
  lines.push(
    `${paint('覆盖稿', 'gray', color)}     ${status.prompt.source} · ${status.prompt.chars} 字符 · ${status.prompt.sha256.slice(0, 12)}`,
  );
  const behavior = status.behavior || {};
  const strategyLabel = { turn: '每轮一次（默认）', once: '每会话一次（最省）', interval: `每 ${behavior.fullEvery} 次`, every: '每次调用（最贵）' }[behavior.strategy] || behavior.strategy;
  lines.push(
    `${paint('注入策略', 'gray', color)}   ${strategyLabel} · 已记账会话 ${behavior.conversations ?? 0}${behavior.configVersion < 3 ? ' · 配置为旧版，待迁移' : ''}`,
  );
  lines.push(
    `${paint('续跑', 'gray', color)}       ${behavior.continueEnabled ? `开（上限 ${behavior.continueMax}）` : '关（不额外增加模型调用）'}`,
  );
  lines.push('');

  lines.push(paint('补丁项', 'bold', color));
  for (const item of status.items) {
    const glyph = GLYPH[item.state] || '?';
    const label = paint(`${glyph} ${item.state.padEnd(8)}`, STATE_COLOR[item.state], color);
    lines.push(`  ${label} ${item.id.padEnd(18)} ${item.detail}`);
  }
  lines.push('');

  lines.push(paint('破甲层', 'bold', color));
  for (const [id, meta] of Object.entries(status.layers)) {
    const on = status.layersState[id] !== false;
    const mark = on ? paint('● 开', 'green', color) : paint('○ 关', 'gray', color);
    lines.push(`  ${mark}  ${meta.title.padEnd(8)} ${paint(meta.desc, 'gray', color)}`);
  }

  if (status.state.installedAt) {
    lines.push('');
    lines.push(
      `${paint('上次 apply', 'gray', color)} ${status.state.installedAt}${status.state.version ? ` · v${status.state.version}` : ''}`,
    );
  }
  if (status.warnings.length) {
    lines.push('');
    lines.push(paint('警告', 'bold', color));
    for (const warning of status.warnings) lines.push(`  ${paint('!', 'yellow', color)} ${warning}`);
  }
  lines.push('');
  const counts = status.counts;
  lines.push(
    paint(
      `合计：applied ${counts.applied} · pending ${counts.pending} · drift ${counts.drift} · conflict ${counts.conflict} · skipped ${counts.skipped}`,
      'gray',
      color,
    ),
  );
  return lines.join('\n');
}

export function renderApplyResults(results, { color = process.stdout.isTTY && !process.env.NO_COLOR } = {}) {
  const lines = [];
  for (const row of results) {
    const mark = row.changed ? paint('✓', 'green', color) : paint('·', 'gray', color);
    lines.push(`  ${mark} ${row.id.padEnd(18)} ${row.detail}`);
  }
  return lines.join('\n');
}

export function relativeToHome(file) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home && file && file.startsWith(home)) return `~${file.slice(home.length)}`;
  return file;
}

export function statusJson(ctx) {
  return JSON.stringify(collectStatus(ctx), null, 2);
}

export { ANSI };
