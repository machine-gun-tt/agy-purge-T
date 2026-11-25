/**
 * agy-purge — 编排层（install / apply / revert / uninstall / repair）
 *
 * 词汇对齐 dsh-purge：apply = 落地破甲层，revert = 精确回滚，uninstall = 连数据一起清掉。
 * 全部操作幂等，且都会先备份被改的宿主文件（*.agypurge.bak）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { ensureDir, exists, readJson, removeFile, removeTree } from './fsx.mjs';
import {
  DEFAULT_GRANTS,
  ITEM_ORDER,
  buildItems,
  readState,
  runtimeConfigFile,
  writeRuntimeConfig,
  writeState,
  stateFile,
} from './patches.mjs';
import { resolveContext, PLUGIN_ID } from './paths.mjs';
import { resolveRuntime } from './runtime.mjs';
import { DEFAULT_CONFIG, migrateConfig } from '../hooks/lib/io.mjs';
import { promptFile } from './prompt.mjs';

export function readLayers(dataDir) {
  const raw = readJson(runtimeConfigFile(dataDir));
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG.layers };
  const { config } = migrateConfig(raw);
  return { ...DEFAULT_CONFIG.layers, ...((config && config.layers) || {}) };
}

export function buildContext(options = {}) {
  const scope = options.scope === 'project' ? 'project' : 'user';
  const base = resolveContext({ scope, cwd: options.cwd, root: options.root });
  const runtime = options.runtime || resolveRuntime({ install: base.host });
  const layers = { ...readLayers(base.dataDir), ...(options.layers || {}) };
  const grants =
    options.grants === true
      ? DEFAULT_GRANTS
      : Array.isArray(options.grants)
        ? options.grants
        : options.grants === false
          ? []
          : readState(base.dataDir).grantMode === true
            ? DEFAULT_GRANTS
            : [];
  return { ...base, runtime, layers, grants, repoRoot: base.repoRoot };
}

export function statusAll(ctx) {
  const items = buildItems().sort(
    (a, b) => ITEM_ORDER.indexOf(a.id) - ITEM_ORDER.indexOf(b.id),
  );
  return items.map((item) => {
    let result;
    try {
      result = item.status(ctx);
    } catch (error) {
      result = { state: 'conflict', detail: `status 抛错：${error.message}` };
    }
    return { id: item.id, title: item.title, layer: item.layer, ...result };
  });
}

export function applyAll(ctx, { items = null } = {}) {
  ensureDir(ctx.dataDir);
  // 先落运行时配置：hooks.json 的启用状态以它为准
  writeRuntimeConfig(ctx.dataDir, { layers: ctx.layers });
  const registry = buildItems().sort((a, b) => ITEM_ORDER.indexOf(a.id) - ITEM_ORDER.indexOf(b.id));
  const results = [];
  for (const item of registry) {
    if (items && !items.includes(item.id)) continue;
    let outcome;
    try {
      outcome = item.apply(ctx);
    } catch (error) {
      outcome = { changed: false, detail: `apply 抛错：${error.message}` };
    }
    results.push({ id: item.id, title: item.title, layer: item.layer, ...outcome });
  }
  writeState(ctx.dataDir, {
    version: readJson(path.join(ctx.repoRoot, 'package.json'))?.version || '0.0.0',
    pluginId: PLUGIN_ID,
    scope: ctx.scope,
    installDir: ctx.installDir,
    configRoot: ctx.configRoot,
    dataDir: ctx.dataDir,
    runtime: ctx.runtime?.ok ? { kind: ctx.runtime.kind, bin: ctx.runtime.bin, version: ctx.runtime.version } : null,
    layers: ctx.layers,
    grantMode: ctx.grants.length > 0,
    appliedAt: new Date().toISOString(),
  });
  return results;
}

export function revertAll(ctx, { purgeData = false, purgePrompt = false } = {}) {
  const registry = buildItems().sort(
    (a, b) => ITEM_ORDER.indexOf(b.id) - ITEM_ORDER.indexOf(a.id),
  );
  const results = [];
  for (const item of registry) {
    let outcome;
    try {
      outcome = item.revert(ctx);
    } catch (error) {
      outcome = { changed: false, detail: `revert 抛错：${error.message}` };
    }
    results.push({ id: item.id, title: item.title, layer: item.layer, ...outcome });
  }
  if (purgePrompt) {
    const file = promptFile(ctx.dataDir);
    const removed = removeFile(file);
    results.push({ id: 'data:prompt', title: '删除覆盖稿', changed: removed, detail: file });
  }
  if (purgeData) {
    const keep = new Set([promptFile(ctx.dataDir)]);
    let removedCount = 0;
    if (exists(ctx.dataDir)) {
      for (const entry of fs.readdirSync(ctx.dataDir, { withFileTypes: true })) {
        const full = path.join(ctx.dataDir, entry.name);
        if (keep.has(full) || full === stateFile(ctx.dataDir)) continue;
        removeTree(full);
        removedCount += 1;
      }
    }
    if (!purgePrompt) removeFile(stateFile(ctx.dataDir));
    results.push({ id: 'data:purge', title: '清理插件数据', changed: removedCount > 0, detail: `${removedCount} 项` });
  }
  if (!purgeData) {
    writeState(ctx.dataDir, { revertedAt: new Date().toISOString(), layers: {} });
  }
  return results;
}

export function install(options = {}) {
  const ctx = buildContext(options);
  const results = applyAll(ctx);
  return { ctx, results };
}

export function repair(options = {}) {
  const ctx = buildContext(options);
  const results = applyAll(ctx);
  return { ctx, results };
}

export function uninstall(options = {}) {
  const ctx = buildContext(options);
  const results = revertAll(ctx, {
    purgeData: options.purgeData !== false,
    purgePrompt: Boolean(options.purgePrompt),
  });
  return { ctx, results };
}

export function summarize(results) {
  const counts = { applied: 0, pending: 0, drift: 0, conflict: 0, skipped: 0, changed: 0, unchanged: 0 };
  for (const row of results) {
    if (row.state && counts[row.state] !== undefined) counts[row.state] += 1;
    if (typeof row.changed === 'boolean') counts[row.changed ? 'changed' : 'unchanged'] += 1;
  }
  return counts;
}

export function contextSummary(ctx) {
  const cfg = loadConfig(ctx.configRoot);
  return {
    pluginId: PLUGIN_ID,
    scope: ctx.scope,
    cwd: ctx.cwd,
    configRoot: ctx.configRoot,
    configFile: cfg.file,
    configExists: cfg.exists,
    configCorrupt: cfg.corrupt,
    installDir: ctx.installDir,
    dataDir: ctx.dataDir,
    logsDir: ctx.logsDir,
    host: ctx.host
      ? { root: ctx.host.root, asar: exists(ctx.host.asar), languageServer: exists(ctx.host.languageServer) }
      : null,
    runtime: ctx.runtime,
    layers: ctx.layers,
    grants: ctx.grants,
    stateFile: stateFile(ctx.dataDir),
  };
}
