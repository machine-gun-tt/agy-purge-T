import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildContext, install, statusAll, uninstall } from '../lib/install.mjs';
import { loadConfig } from '../lib/config.mjs';
import { writeAtomic } from '../lib/fsx.mjs';

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-inst-'));
  process.env.AGY_PURGE_GEMINI_DIR = path.join(base, 'gemini');
  process.env.AGY_PURGE_DATA = path.join(base, 'data');
  delete process.env.ANTIGRAVITY_CONFIG_DIR;
  delete process.env.GEMINI_CONFIG_DIR;
  delete process.env.PLUGIN_DATA;
  fs.mkdirSync(path.join(base, 'gemini', 'config'), { recursive: true });
  return { base, root: path.join(base, 'gemini', 'config') };
}

test('install → status 全部落地 → revert 干净回滚', () => {
  const { root } = sandbox();
  const { ctx, results } = install({ root, grants: false });
  assert.ok(fs.existsSync(path.join(ctx.installDir, 'plugin.json')));
  assert.ok(fs.existsSync(path.join(ctx.installDir, 'hooks.json')));
  assert.ok(fs.existsSync(path.join(ctx.installDir, 'hooks', 'pre-invocation.mjs')));

  const applied = results.filter((r) => r.changed).map((r) => r.id);
  assert.ok(applied.includes('plugin:files'), `应复制文件：${applied.join(',')}`);
  assert.ok(applied.includes('plugin:registered'));

  const cfg = loadConfig(root);
  assert.equal(cfg.data.plugins['agy-purge'].enabled, true);

  const pending = statusAll(ctx).filter((i) => i.state === 'pending' || i.state === 'conflict' || i.state === 'drift');
  assert.deepEqual(pending, [], '安装后不应再有未落地项');

  // 幂等：再装一次不应产生新的写入
  const again = install({ root, grants: false }).results;
  assert.deepEqual(again.filter((r) => r.changed).map((r) => r.id), []);

  const { results: revertResults } = uninstall({ root, purgeData: true });
  assert.ok(revertResults.some((r) => r.id === 'plugin:files' && r.changed));
  assert.equal(fs.existsSync(ctx.installDir), false);
  assert.equal(loadConfig(root).data.plugins?.['agy-purge'], undefined);
});

test('config.json 损坏时拒绝改写，文件字节不变', () => {
  const { root } = sandbox();
  const file = path.join(root, 'config.json');
  const broken = '{ "plugins": { /* note: 手写注释 */ } }';
  writeAtomic(file, broken);

  const { results } = install({ root });
  const reg = results.find((r) => r.id === 'plugin:registered');
  assert.equal(reg.changed, false);
  assert.match(reg.detail, /解析失败/);
  assert.equal(fs.readFileSync(file, 'utf8'), broken);

  const conflict = statusAll(buildContext({ root })).find((i) => i.id === 'plugin:registered');
  assert.equal(conflict.state, 'conflict');
});

test('drift 检测：改一个已安装文件就会被标出来', () => {
  const { root } = sandbox();
  const { ctx } = install({ root });
  const target = path.join(ctx.installDir, 'hooks', 'pre-tool-use.mjs');
  fs.appendFileSync(target, '\n// 本地手改\n');
  const files = statusAll(ctx).find((i) => i.id === 'plugin:files');
  assert.equal(files.state, 'drift');
  assert.match(files.detail, /1 个文件/);

  install({ root });
  assert.equal(statusAll(ctx).find((i) => i.id === 'plugin:files').state, 'applied');
});

test('--grants 写入授权，revert 只移除自己写的那几条', () => {
  const { root } = sandbox();
  writeAtomic(
    path.join(root, 'config.json'),
    JSON.stringify({ userSettings: { globalPermissionGrants: { allow: ['execute_url(example.com)'] } } }, null, 2),
  );
  const { ctx } = install({ root, grants: true });
  const allow = loadConfig(root).data.userSettings.globalPermissionGrants.allow;
  assert.deepEqual(allow, ['execute_url(example.com)', 'command(*)', 'execute_url(*)']);

  uninstall({ root, purgeData: false });
  const after = loadConfig(root).data.userSettings.globalPermissionGrants.allow;
  assert.deepEqual(after, ['execute_url(example.com)']);

  // 数据目录仍保留覆盖稿
  assert.ok(fs.existsSync(path.join(ctx.dataDir, 'prompt-inject.md')));
});

test('layers 参数只影响 hooks 启用位', () => {
  const { root } = sandbox();
  const { ctx } = install({ root, layers: { inject: true, gate: false, continue: false, log: false } });
  const hooks = JSON.parse(fs.readFileSync(path.join(ctx.installDir, 'hooks.json'), 'utf8'));
  assert.equal(hooks['agy-purge-inject'].enabled, true);
  assert.equal(hooks['agy-purge-gate'].enabled, false);
  assert.equal(hooks['agy-purge-continue'].enabled, false);
  assert.equal(hooks['agy-purge-log'].enabled, false);
});
