/**
 * agy-purge — 补丁项（"Clean" 页的数据源）
 *
 * 每一项都是可重入的：status() 只读，apply() 幂等，revert() 精确回滚。
 * 没有任何一项会改写 Antigravity 的二进制或 app.asar —— 见
 * docs/why-no-binary-patch.md：hooks 站在审批闸门和模型调用的**上游**，
 * 改宿主字节既没必要，也会在升级后碎掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ensureGrants, grantList, isPluginEnabled, removeGrants, removePluginEntry, saveConfig, setPluginEnabled } from './config.mjs';
import { backupOnce, ensureDir, exists, isDir, isFile, readJson, readText, removeFile, removeTree, sha256, walkFiles, writeJson, writeAtomic } from './fsx.mjs';
import { PLUGIN_ID } from './paths.mjs';
import { bundledPrompt, normalizePromptText, promptFile, upgradeBundledPrompt } from './prompt.mjs';
import { DEFAULT_CONFIG, migrateConfig } from '../hooks/lib/io.mjs';
import { renderCommand } from './runtime.mjs';

export const LAYERS = {
  inject: { id: 'inject', title: '提示词注入层', desc: '每个用户轮次注入一次覆盖稿（SessionStart 可选）' },
  gate: { id: 'gate', title: '审批放行层', desc: 'PreToolUse 全量 allow + 权限令牌' },
  continue: { id: 'continue', title: '强制续跑层', desc: 'Stop 在模型偷懒收工时拉回循环' },
  log: { id: 'log', title: '审计层', desc: 'PostToolUse 写事件日志，便于复核' },
};

export const HOOK_SCRIPTS = [
  { key: 'sessionStart', file: 'hooks/session-start.mjs', event: 'SessionStart', timeout: 10, layer: 'inject', hookId: 'agy-purge-inject' },
  { key: 'preInvocation', file: 'hooks/pre-invocation.mjs', event: 'PreInvocation', timeout: 10, layer: 'inject', hookId: 'agy-purge-inject' },
  { key: 'preToolUse', file: 'hooks/pre-tool-use.mjs', event: 'PreToolUse', timeout: 10, layer: 'gate', hookId: 'agy-purge-gate', matcher: '*' },
  { key: 'postToolUse', file: 'hooks/post-tool-use.mjs', event: 'PostToolUse', timeout: 5, layer: 'log', hookId: 'agy-purge-log', matcher: '*' },
  { key: 'stop', file: 'hooks/stop.mjs', event: 'Stop', timeout: 5, layer: 'continue', hookId: 'agy-purge-continue' },
];

export const DEFAULT_GRANTS = ['command(*)', 'execute_url(*)'];

const COPY_DIRS = ['hooks', 'lib', 'rules', 'skills', 'prompts', 'docs', 'assets'];
const ROOT_FILES = ['plugin.json', 'project.json', 'LICENSE', 'NOTICE.md', 'README.md'];

/* --------------------------------------------------------------- hooks 渲染 */

export function renderHooks(installDir, runtime, layers = DEFAULT_CONFIG.layers) {
  const out = {};
  for (const script of HOOK_SCRIPTS) {
    const enabled = layers?.[script.layer] !== false;
    out[script.hookId] = out[script.hookId] || { enabled: false };
    if (enabled) out[script.hookId].enabled = true;
    const absolute = path.join(installDir, script.file.split('/').join(path.sep));
    const command = renderCommand(runtime, absolute);
    const handler = { type: 'command', command: command || `node ${script.file}`, timeout: script.timeout };
    if (script.matcher) {
      out[script.hookId][script.event] = [{ matcher: script.matcher, hooks: [handler] }];
    } else {
      out[script.hookId][script.event] = [handler];
    }
  }
  // 任一 hook 组若全部层关闭，则整组 enabled:false
  for (const [id, group] of Object.entries(out)) {
    const events = Object.keys(group).filter((k) => k !== 'enabled');
    const layerOf = HOOK_SCRIPTS.find((s) => s.hookId === id);
    group.enabled = events.length > 0 && layers?.[layerOf?.layer] !== false;
  }
  return out;
}

function installedHooksHealth(installDir, runtime) {
  const file = path.join(installDir, 'hooks.json');
  const data = readJson(file);
  if (data === undefined) return { state: 'corrupt', file };
  if (!data) return { state: 'missing', file };
  const commands = [];
  for (const group of Object.values(data)) {
    for (const [event, value] of Object.entries(group || {})) {
      if (event === 'enabled') continue;
      for (const entry of value || []) {
        const list = Array.isArray(entry?.hooks) ? entry.hooks : [entry];
        for (const handler of list) if (handler?.command) commands.push(handler.command);
      }
    }
  }
  const absolute = commands.filter((c) => runtime?.bin && c.includes(runtime.bin)).length;
  const missingScripts = commands.filter((c) => {
    const match = c.match(/"([^"]+\.mjs)"/);
    return match ? !isFile(match[1]) : false;
  });
  return { state: 'ok', file, commands: commands.length, absolute, missingScripts };
}

/* ------------------------------------------------------------------ 状态文件 */

export function stateFile(dataDir) {
  return path.join(dataDir, 'state.json');
}

export function readState(dataDir) {
  return readJson(stateFile(dataDir)) || {};
}

export function writeState(dataDir, patch) {
  ensureDir(dataDir);
  const next = { ...readState(dataDir), ...patch, updatedAt: new Date().toISOString() };
  writeJson(stateFile(dataDir), next);
  return next;
}

export function runtimeConfigFile(dataDir) {
  return path.join(dataDir, 'config.json');
}

/**
 * 读取运行时配置并做 v1 → v2 迁移。
 * 迁移不写盘，只有 apply / writeRuntimeConfig 才落盘。
 */
export function readRuntimeConfig(dataDir) {
  const file = runtimeConfigFile(dataDir);
  const raw = readJson(file);
  if (raw === undefined) return { file, exists: true, corrupt: true, data: null, migrated: false };
  if (!raw) return { file, exists: false, corrupt: false, data: null, migrated: false };
  const { config, migrated } = migrateConfig(raw);
  return { file, exists: true, corrupt: false, data: config, migrated };
}

export function writeRuntimeConfig(dataDir, patch = {}, { force = false } = {}) {
  const file = runtimeConfigFile(dataDir);
  const raw = readJson(file);
  if (force || !raw) {
    writeJson(file, { ...DEFAULT_CONFIG, ...patch });
    return file;
  }
  const { config: current, migrated } = migrateConfig(raw);
  const merged = {
    ...current,
    ...patch,
    version: DEFAULT_CONFIG.version,
    layers: { ...DEFAULT_CONFIG.layers, ...(current.layers || {}), ...(patch.layers || {}) },
    prompt: { ...DEFAULT_CONFIG.prompt, ...(current.prompt || {}), ...(patch.prompt || {}) },
    gate: { ...DEFAULT_CONFIG.gate, ...(current.gate || {}), ...(patch.gate || {}) },
    continue: { ...DEFAULT_CONFIG.continue, ...(current.continue || {}), ...(patch.continue || {}) },
    log: { ...DEFAULT_CONFIG.log, ...(current.log || {}), ...(patch.log || {}) },
  };
  if (migrated) {
    merged.migratedFrom = current.migratedFrom;
    merged.migratedAt = current.migratedAt;
  }
  writeJson(file, merged);
  return file;
}

/* ------------------------------------------------------------------ 补丁项 */

/**
 * 每一项的接口：
 *   status(ctx) → { state, detail }
 *   apply(ctx)  → { changed, detail }
 *   revert(ctx) → { changed, detail }
 * state ∈ applied | pending | drift | conflict | skipped
 */

export function buildItems() {
  return [
    {
      id: 'plugin:files',
      title: '插件文件落地',
      layer: 'core',
      status(ctx) {
        const manifest = readJson(path.join(ctx.installDir, 'plugin.json'));
        if (manifest === undefined) return { state: 'conflict', detail: 'plugin.json 无法解析' };
        if (!manifest) return { state: 'pending', detail: `未安装到 ${ctx.installDir}` };
        if (manifest.name !== PLUGIN_ID) return { state: 'conflict', detail: `目录已被其它插件占用：${manifest.name}` };
        const drift = driftFiles(ctx);
        if (drift.length) return { state: 'drift', detail: `${drift.length} 个文件与仓库版本不一致` };
        return { state: 'applied', detail: `v${manifest.version || '?'} → ${ctx.installDir}` };
      },
      apply(ctx) {
        ensureDir(ctx.installDir);
        const pruned = pruneRemoved(ctx);
        let copied = 0;
        for (const entry of COPY_DIRS) {
          const src = path.join(ctx.repoRoot, entry);
          if (!isDir(src)) continue;
          copied += syncDirCounted(src, path.join(ctx.installDir, entry));
        }
        for (const file of ROOT_FILES) {
          const src = path.join(ctx.repoRoot, file);
          if (!isFile(src)) continue;
          const dest = path.join(ctx.installDir, file);
          if (sameContent(src, dest)) continue;
          ensureDir(ctx.installDir);
          fs.copyFileSync(src, dest);
          copied += 1;
        }
        writeManifest(ctx);
        const parts = [];
        if (copied) parts.push(`同步 ${copied} 个文件`);
        if (pruned) parts.push(`清理 ${pruned} 个已移除文件`);
        return { changed: copied > 0 || pruned > 0, detail: parts.length ? parts.join('，') : '文件已是最新' };
      },
      revert(ctx) {
        const removed = removeTree(ctx.installDir);
        return { changed: removed, detail: removed ? `已删除 ${ctx.installDir}` : '本来就不存在' };
      },
    },
    {
      id: 'plugin:hooks',
      title: 'hooks.json 渲染',
      layer: 'core',
      status(ctx) {
        const health = installedHooksHealth(ctx.installDir, ctx.runtime);
        if (health.state === 'missing') return { state: 'pending', detail: 'hooks.json 尚未生成' };
        if (health.state === 'corrupt') return { state: 'conflict', detail: 'hooks.json 无法解析' };
        if (!ctx.runtime?.ok) return { state: 'conflict', detail: '没有可用 Node 运行时' };
        if (health.missingScripts.length) return { state: 'drift', detail: `脚本缺失：${health.missingScripts.join(', ')}` };
        if (health.absolute !== health.commands) return { state: 'drift', detail: `${health.commands - health.absolute} 条命令未固定解释器路径` };
        return { state: 'applied', detail: `${health.commands} 条命令，解释器 ${ctx.runtime.bin}` };
      },
      apply(ctx) {
        if (!ctx.runtime?.ok) return { changed: false, detail: '没有可用 Node 运行时，保持相对命令' };
        const file = path.join(ctx.installDir, 'hooks.json');
        const rendered = renderHooks(ctx.installDir, ctx.runtime, ctx.layers);
        const before = readText(file);
        const after = `${JSON.stringify(rendered, null, 2)}\n`;
        if (before === after) return { changed: false, detail: '已是最新' };
        if (before !== null) backupOnce(file);
        writeAtomic(file, after);
        return { changed: true, detail: '按当前运行时重写 hooks 命令' };
      },
      revert(ctx) {
        const file = path.join(ctx.installDir, 'hooks.json');
        const removed = removeFile(file);
        return { changed: removed, detail: removed ? '已移除渲染后的 hooks.json' : '无 hooks.json' };
      },
    },
    {
      id: 'plugin:registered',
      title: '注册到 config.json',
      layer: 'core',
      status(ctx) {
        const cfg = loadConfig(ctx.configRoot);
        if (cfg.corrupt) return { state: 'conflict', detail: 'config.json 解析失败，拒绝改写' };
        const enabled = isPluginEnabled(cfg.data, PLUGIN_ID);
        if (enabled === null) return { state: 'pending', detail: 'config.json 没有 agy-purge 条目' };
        return enabled
          ? { state: 'applied', detail: `${cfg.file} → plugins.${PLUGIN_ID}.enabled = true` }
          : { state: 'pending', detail: '条目存在但被禁用' };
      },
      apply(ctx) {
        const cfg = loadConfig(ctx.configRoot);
        if (cfg.corrupt) return { changed: false, detail: 'config.json 解析失败，跳过' };
        const next = setPluginEnabled(cfg.data, PLUGIN_ID, true);
        if (JSON.stringify(next) === JSON.stringify(cfg.data)) return { changed: false, detail: '已是启用状态' };
        saveConfig(ctx.configRoot, next);
        return { changed: true, detail: '写入 plugins.agy-purge.enabled = true' };
      },
      revert(ctx) {
        const cfg = loadConfig(ctx.configRoot);
        if (cfg.corrupt) return { changed: false, detail: 'config.json 解析失败，跳过' };
        const next = removePluginEntry(cfg.data, PLUGIN_ID);
        if (JSON.stringify(next) === JSON.stringify(cfg.data)) return { changed: false, detail: '无条目' };
        saveConfig(ctx.configRoot, next);
        return { changed: true, detail: '移除 config.json 中的条目' };
      },
    },
    {
      id: 'prompt:seeded',
      title: '覆盖提示词落盘',
      layer: 'inject',
      status(ctx) {
        const file = promptFile(ctx.dataDir);
        const text = readText(file);
        if (text === null) return { state: 'pending', detail: file };
        if (!text.trim()) return { state: 'pending', detail: '文件为空' };
        const state = readState(ctx.dataDir);
        const runtimeCfg = readRuntimeConfig(ctx.dataDir).data || {};
        const currentSha = sha256(text);
        const bundled = bundledPrompt(ctx.repoRoot, 'gemini');
        const bundledSha = bundled.text ? sha256(normalizePromptText(bundled.text)) : null;
        if (
          runtimeCfg.prompt?.autoUpgrade !== false &&
          state.seededSha &&
          currentSha === state.seededSha &&
          bundledSha &&
          bundledSha !== currentSha
        ) {
          return { state: 'drift', detail: `${text.length} 字符，但内置稿已升级（v3）；apply 会替换这份未被改动的默认稿` };
        }
        return { state: 'applied', detail: `${text.length} 字符 · ${currentSha.slice(0, 12)}` };
      },
      apply(ctx) {
        const state = readState(ctx.dataDir);
        const runtimeCfg = readRuntimeConfig(ctx.dataDir).data || {};
        const result = upgradeBundledPrompt(ctx.dataDir, ctx.repoRoot, {
          seededSha: state.seededSha,
          autoUpgrade: runtimeCfg.prompt?.autoUpgrade !== false,
        });
        if (result.changed) {
          writeState(ctx.dataDir, { seededSha: result.sha256 });
          const label = result.reason === 'seeded' ? '写入默认覆盖稿' : '升级内置覆盖稿到 v3';
          return { changed: true, detail: label };
        }
        if (result.reason === 'user-edited') return { changed: false, detail: '保留用户自己改过的覆盖稿' };
        if (result.reason === 'disabled') return { changed: false, detail: 'autoUpgrade 已关，保留现有覆盖稿' };
        return { changed: false, detail: '覆盖稿已是最新' };
      },
      revert(ctx) {
        return { changed: false, detail: '覆盖稿为用户文件，revert 不删除（用 uninstall --purge-prompt 才删）' };
      },
    },
    {
      id: 'runtime:config',
      title: 'hooks 运行时配置',
      layer: 'core',
      status(ctx) {
        const cfg = readRuntimeConfig(ctx.dataDir);
        if (cfg.corrupt) return { state: 'conflict', detail: `${cfg.file} 无法解析` };
        if (!cfg.exists) return { state: 'pending', detail: cfg.file };
        if (cfg.migrated) return { state: 'drift', detail: `配置是旧版本；运行时已按 v3 解释（每轮一次注入 / 续跑关），apply 会把迁移写盘` };
        const off = Object.entries(ctx.layers).filter(([, on]) => on === false).map(([k]) => k);
        const strategy = cfg.data?.prompt?.strategy || 'turn';
        const stopCap = cfg.data?.layers?.continue === false ? '停' : `上限 ${cfg.data?.continue?.max ?? 0}`;
        return {
          state: 'applied',
          detail: `v${cfg.data?.version ?? 3} · 注入 ${strategy} · 续跑 ${stopCap}${off.length ? ` · 已关：${off.join(', ')}` : ''}`,
        };
      },
      apply(ctx) {
        const file = runtimeConfigFile(ctx.dataDir);
        const before = readText(file);
        writeRuntimeConfig(ctx.dataDir, { layers: ctx.layers });
        const after = readText(file);
        return { changed: before !== after, detail: file };
      },
      revert(ctx) {
        const removed = removeFile(runtimeConfigFile(ctx.dataDir));
        return { changed: removed, detail: removed ? '已删除运行时配置（回落到默认值）' : '无运行时配置' };
      },
    },
    {
      id: 'host:grants',
      title: '全局权限授予（Always Allow）',
      layer: 'gate',
      status(ctx) {
        if (!ctx.grants.length) return { state: 'skipped', detail: '未启用（--grants 才写）' };
        const cfg = loadConfig(ctx.configRoot);
        if (cfg.corrupt) return { state: 'conflict', detail: 'config.json 解析失败' };
        const allow = grantList(cfg.data);
        const missing = ctx.grants.filter((g) => !allow.includes(g));
        return missing.length
          ? { state: 'pending', detail: `缺 ${missing.length} 条：${missing.join(', ')}` }
          : { state: 'applied', detail: `${ctx.grants.length} 条已在 globalPermissionGrants.allow` };
      },
      apply(ctx) {
        if (!ctx.grants.length) return { changed: false, detail: '未启用' };
        const cfg = loadConfig(ctx.configRoot);
        if (cfg.corrupt) return { changed: false, detail: 'config.json 解析失败，跳过' };
        const { data, added } = ensureGrants(cfg.data, ctx.grants);
        if (!added.length) return { changed: false, detail: '已全部存在' };
        saveConfig(ctx.configRoot, data);
        writeState(ctx.dataDir, { appliedGrants: [...new Set([...(readState(ctx.dataDir).appliedGrants || []), ...added])] });
        return { changed: true, detail: `新增 ${added.join(', ')}` };
      },
      revert(ctx) {
        const cfg = loadConfig(ctx.configRoot);
        if (cfg.corrupt) return { changed: false, detail: 'config.json 解析失败，跳过' };
        const ours = readState(ctx.dataDir).appliedGrants || ctx.grants;
        const { data, removed } = removeGrants(cfg.data, ours);
        if (!removed.length) return { changed: false, detail: '没有本插件写入的授权' };
        saveConfig(ctx.configRoot, data);
        writeState(ctx.dataDir, { appliedGrants: [] });
        return { changed: true, detail: `移除 ${removed.join(', ')}` };
      },
    },
    {
      id: 'project:registry',
      title: '项目级注册（.agents/plugins.json）',
      layer: 'core',
      status(ctx) {
        if (ctx.scope !== 'project') return { state: 'skipped', detail: '仅 --scope project' };
        const file = path.join(ctx.cwd, '.agents', 'plugins.json');
        const data = readJson(file);
        if (data === undefined) return { state: 'conflict', detail: `${file} 无法解析` };
        if (!data) return { state: 'pending', detail: '尚无 .agents/plugins.json' };
        const entries = Array.isArray(data.entries) ? data.entries : [];
        const hit = entries.some((e) => String(e?.path || '').includes(PLUGIN_ID));
        return hit ? { state: 'applied', detail: file } : { state: 'pending', detail: '未登记到 entries' };
      },
      apply(ctx) {
        if (ctx.scope !== 'project') return { changed: false, detail: '仅 --scope project' };
        const file = path.join(ctx.cwd, '.agents', 'plugins.json');
        const data = readJson(file) || {};
        const entries = Array.isArray(data.entries) ? [...data.entries] : [];
        if (entries.some((e) => String(e?.path || '').includes(PLUGIN_ID))) return { changed: false, detail: '已登记' };
        entries.push({ path: `plugins/${PLUGIN_ID}` });
        ensureDir(path.dirname(file));
        backupOnce(file);
        writeJson(file, { ...data, entries });
        return { changed: true, detail: file };
      },
      revert(ctx) {
        if (ctx.scope !== 'project') return { changed: false, detail: '仅 --scope project' };
        const file = path.join(ctx.cwd, '.agents', 'plugins.json');
        const data = readJson(file);
        if (!data || !Array.isArray(data.entries)) return { changed: false, detail: '无登记' };
        const entries = data.entries.filter((e) => !String(e?.path || '').includes(PLUGIN_ID));
        if (entries.length === data.entries.length) return { changed: false, detail: '无登记' };
        writeJson(file, { ...data, entries });
        return { changed: true, detail: '已从 .agents/plugins.json 移除' };
      },
    },
  ];
}



/** 只写真正有差异的文件，让 apply 保持严格幂等。 */
function syncDirCounted(src, dest) {  ensureDir(dest);
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.data', '.DS_Store'].includes(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) count += syncDirCounted(from, to);
    else if (entry.isFile()) {
      if (sameContent(from, to)) continue;
      fs.copyFileSync(from, to);
      count += 1;
    }
  }
  return count;
}

/* ------------------------------------------------- 安装清单与「已移除文件」清理 */

const MANIFEST_FILE = '.agy-install.json';
// 历史上装过、后来从仓库删掉的文件：没有清单时也要清掉
const LEGACY_FILES = ['README.en.md'];

function readManifest(installDir) {
  const data = readJson(path.join(installDir, MANIFEST_FILE));
  return Array.isArray(data?.files) ? data.files : [];
}

function expectedPaths(ctx) {
  const expected = new Set();
  for (const dir of COPY_DIRS) {
    const src = path.join(ctx.repoRoot, dir);
    if (!isDir(src)) continue;
    for (const file of walkFiles(src)) expected.add(`${dir}/${file.path}`);
  }
  for (const file of ROOT_FILES) if (isFile(path.join(ctx.repoRoot, file))) expected.add(file);
  return expected;
}

/**
 * 升级时清掉仓库里已经不存在的文件（例如删掉的 README.en.md）。
 * 依据上次 apply 写下的 `.agy-install.json`，只删我们自己装过的东西；
 * 没有清单的老安装则只处理 LEGACY_FILES 里点名的文件。
 */
function pruneRemoved(ctx) {
  const expected = expectedPaths(ctx);
  const previous = readManifest(ctx.installDir);
  const candidates = new Set([...previous, ...LEGACY_FILES]);
  let removed = 0;
  for (const rel of candidates) {
    if (typeof rel !== 'string' || expected.has(rel)) continue;
    const abs = path.join(ctx.installDir, rel.split('/').join(path.sep));
    if (!isFile(abs)) continue;
    fs.rmSync(abs, { force: true });
    removed += 1;
  }
  return removed;
}

function writeManifest(ctx) {
  // 只记「我们装了什么」，不记目录里的一切——用户自己塞进来的文件永远不会被误删
  const files = [...expectedPaths(ctx)].sort();
  const pkg = readJson(path.join(ctx.repoRoot, 'package.json')) || {};
  writeJson(path.join(ctx.installDir, MANIFEST_FILE), {
    plugin: PLUGIN_ID,
    version: pkg.version || null,
    generatedAt: new Date().toISOString(),
    files,
  });
}

function sameContent(a, b) {
  try {
    const left = fs.readFileSync(a);
    const right = fs.readFileSync(b);
    return left.length === right.length && sha256(left) === sha256(right);
  } catch {
    return false;
  }
}

export function driftFiles(ctx) {
  const drift = [];
  const check = (rel, sourceAbs) => {
    const target = path.join(ctx.installDir, rel.split('/').join(path.sep));
    const bytes = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (!bytes) drift.push(rel);
    else if (sha256(bytes) !== sha256(fs.readFileSync(sourceAbs))) drift.push(rel);
  };
  for (const dir of COPY_DIRS) {
    const src = path.join(ctx.repoRoot, dir);
    if (!isDir(src)) continue;
    for (const file of walkFiles(src)) check(`${dir}/${file.path}`, file.absolute);
  }
  for (const file of ROOT_FILES) {
    const src = path.join(ctx.repoRoot, file);
    if (isFile(src)) check(file, src);
  }
  return drift;
}

export function countFiles(dir) {
  return exists(dir) && isDir(dir) ? walkFiles(dir).length : 0;
}

export const ITEM_ORDER = [
  'plugin:files',
  'plugin:hooks',
  'plugin:registered',
  'prompt:seeded',
  'runtime:config',
  'host:grants',
  'project:registry',
];
