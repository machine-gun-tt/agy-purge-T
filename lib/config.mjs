/**
 * agy-purge — Antigravity 的 config.json 读写
 *
 * 文件：<customization>/config.json
 * 结构（只关心我们动的那几块）：
 *   { "plugins": { "<dir>": { "enabled": bool } },
 *     "userSettings": { "globalPermissionGrants": { "allow": ["command(...)"] } } }
 *
 * 原则：**绝不覆盖无法解析的文件**。解析失败就报 corrupt 并让用户自己处理，
 * 免得把别人的配置洗掉。
 */
import path from 'node:path';
import { backupOnce, exists, readJson, readText, sha256, writeJson } from './fsx.mjs';

export function loadConfig(root) {
  const file = path.join(root, 'config.json');
  const text = readText(file);
  if (text === null) {
    return { file, exists: false, corrupt: false, data: {} };
  }
  const parsed = readJson(file);
  if (parsed === undefined) {
    return { file, exists: true, corrupt: true, data: {}, hash: sha256(text) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { file, exists: true, corrupt: true, data: {}, hash: sha256(text) };
  }
  return { file, exists: true, corrupt: false, data: parsed, hash: sha256(text) };
}

export function saveConfig(root, state) {
  const file = path.join(root, 'config.json');
  backupOnce(file);
  writeJson(file, state);
  return file;
}

export function pluginEntry(data, id) {
  return data?.plugins?.[id] ?? null;
}

export function isPluginEnabled(data, id) {
  const entry = pluginEntry(data, id);
  if (!entry) return null; // 未登记 → 走 plugin.json 默认（enabled）
  return entry.enabled !== false;
}

export function setPluginEnabled(data, id, enabled) {
  const next = structuredClone(data || {});
  next.plugins = next.plugins && typeof next.plugins === 'object' ? next.plugins : {};
  const prev = next.plugins[id] && typeof next.plugins[id] === 'object' ? next.plugins[id] : {};
  next.plugins[id] = { ...prev, enabled: Boolean(enabled) };
  return next;
}

export function removePluginEntry(data, id) {
  const next = structuredClone(data || {});
  if (next.plugins && typeof next.plugins === 'object') delete next.plugins[id];
  return next;
}

export function grantList(data) {
  const allow = data?.userSettings?.globalPermissionGrants?.allow;
  return Array.isArray(allow) ? allow : [];
}

export function ensureGrants(data, grants) {
  const next = structuredClone(data || {});
  const wanted = grants.filter((g) => typeof g === 'string' && g.trim());
  if (!wanted.length) return { data: next, added: [] };
  next.userSettings = next.userSettings && typeof next.userSettings === 'object' ? next.userSettings : {};
  const holder = next.userSettings.globalPermissionGrants;
  const allow = Array.isArray(holder?.allow) ? [...holder.allow] : [];
  const added = [];
  for (const grant of wanted) {
    const key = grant.trim();
    if (!allow.includes(key)) {
      allow.push(key);
      added.push(key);
    }
  }
  next.userSettings.globalPermissionGrants = { ...(holder || {}), allow };
  return { data: next, added };
}

export function removeGrants(data, grants) {
  const next = structuredClone(data || {});
  const holder = next?.userSettings?.globalPermissionGrants;
  if (!Array.isArray(holder?.allow)) return { data: next, removed: [] };
  const drop = new Set(grants.map((g) => String(g).trim()).filter(Boolean));
  const kept = holder.allow.filter((g) => !drop.has(g));
  const removed = holder.allow.filter((g) => drop.has(g));
  next.userSettings.globalPermissionGrants = { ...holder, allow: kept };
  return { data: next, removed };
}

export function pluginList(data) {
  const plugins = data?.plugins;
  if (!plugins || typeof plugins !== 'object') return [];
  return Object.entries(plugins).map(([id, entry]) => ({
    id,
    enabled: entry?.enabled !== false,
    installedFrom: entry?.installedFrom?.id || null,
    version: entry?.installedFrom?.version || null,
  }));
}

export function backupsPresent(root) {
  return exists(path.join(root, 'config.json.agypurge.bak'));
}
