import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ensureGrants,
  grantList,
  isPluginEnabled,
  loadConfig,
  pluginList,
  removeGrants,
  removePluginEntry,
  saveConfig,
  setPluginEnabled,
} from '../lib/config.mjs';
import { writeAtomic } from '../lib/fsx.mjs';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cfg-'));

test('loadConfig: 不存在 → exists=false 且 data 为空对象', () => {
  const root = tmpRoot();
  const cfg = loadConfig(root);
  assert.equal(cfg.exists, false);
  assert.equal(cfg.corrupt, false);
  assert.deepEqual(cfg.data, {});
});

test('loadConfig: 坏 JSON → corrupt，绝不静默修复', () => {
  const root = tmpRoot();
  writeAtomic(path.join(root, 'config.json'), '{ this is not json');
  const cfg = loadConfig(root);
  assert.equal(cfg.corrupt, true);
  assert.equal(cfg.exists, true);
});

test('setPluginEnabled 保留其它条目', () => {
  const data = { plugins: { swarm: { enabled: true } }, userSettings: { themeMode: 'LIGHT' } };
  const next = setPluginEnabled(data, 'agy-purge', true);
  assert.equal(next.plugins['agy-purge'].enabled, true);
  assert.equal(next.plugins.swarm.enabled, true);
  assert.equal(next.userSettings.themeMode, 'LIGHT');
  assert.equal(isPluginEnabled(next, 'agy-purge'), true);
  assert.equal(isPluginEnabled(next, 'unknown'), null);
});

test('removePluginEntry 只删自己的键', () => {
  const data = { plugins: { 'agy-purge': { enabled: true }, swarm: { enabled: true } } };
  const next = removePluginEntry(data, 'agy-purge');
  assert.deepEqual(Object.keys(next.plugins), ['swarm']);
});

test('ensureGrants 幂等且不重复', () => {
  const data = { userSettings: { globalPermissionGrants: { allow: ['execute_url(example.com)'] } } };
  const first = ensureGrants(data, ['command(*)', 'execute_url(*)']);
  assert.deepEqual(first.added, ['command(*)', 'execute_url(*)']);
  const second = ensureGrants(first.data, ['command(*)', 'execute_url(*)']);
  assert.deepEqual(second.added, []);
  assert.deepEqual(grantList(second.data), ['execute_url(example.com)', 'command(*)', 'execute_url(*)']);
});

test('removeGrants 精确移除，不动别人的授权', () => {
  const data = { userSettings: { globalPermissionGrants: { allow: ['command(*)', 'execute_url(example.com)'] } } };
  const next = removeGrants(data, ['command(*)']);
  assert.deepEqual(next.removed, ['command(*)']);
  assert.deepEqual(grantList(next.data), ['execute_url(example.com)']);
});

test('saveConfig: 写入前留备份，备份内容是最初版本', () => {
  const root = tmpRoot();
  writeAtomic(path.join(root, 'config.json'), '{"plugins":{}}\n');
  saveConfig(root, { plugins: { 'agy-purge': { enabled: true } } });
  assert.ok(fs.existsSync(path.join(root, 'config.json.agypurge.bak')));
  assert.equal(fs.readFileSync(path.join(root, 'config.json.agypurge.bak'), 'utf8'), '{"plugins":{}}\n');
  assert.equal(loadConfig(root).data.plugins['agy-purge'].enabled, true);
});

test('pluginList 汇总插件与来源', () => {
  const data = {
    plugins: {
      'agy-purge': { enabled: true },
      'chrome-devtools-plugin': { installedFrom: { id: 'official/plugin/chrome-devtools-plugin', version: '1.10.1' } },
    },
  };
  const list = pluginList(data);
  assert.equal(list.length, 2);
  assert.equal(list[1].id, 'chrome-devtools-plugin');
  assert.equal(list[1].version, '1.10.1');
});
