import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configRoot, dataDir, geminiDir, installRoots, projectPluginDir, resolveContext } from '../lib/paths.mjs';

function withEnv(patch, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(patch)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('geminiDir 优先 AGY_PURGE_GEMINI_DIR', () => {
  withEnv({ AGY_PURGE_GEMINI_DIR: path.join(os.tmpdir(), 'agy-x'), GEMINI_DIR: path.join(os.tmpdir(), 'gem-y') }, () => {
    assert.equal(geminiDir(), path.join(os.tmpdir(), 'agy-x'));
  });
});

test('configRoot 跟随 customization 环境变量', () => {
  withEnv({ GEMINI_DIR: undefined, AGY_PURGE_GEMINI_DIR: path.join(os.tmpdir(), 'gem-z'), ANTIGRAVITY_CONFIG_DIR: undefined, GEMINI_CONFIG_DIR: undefined }, () => {
    assert.equal(configRoot(), path.join(os.tmpdir(), 'gem-z', 'config'));
  });
  withEnv({ ANTIGRAVITY_CONFIG_DIR: path.join(os.tmpdir(), 'custom') }, () => {
    assert.equal(configRoot(), path.join(os.tmpdir(), 'custom'));
  });
});

test('dataDir 尊重 PLUGIN_DATA', () => {
  const dir = path.join(os.tmpdir(), 'agy-data-probe');
  withEnv({ AGY_PURGE_DATA: undefined, PLUGIN_DATA: dir }, () => {
    assert.equal(dataDir(), dir);
  });
});

test('installRoots 支持 ANTIGRAVITY_INSTALL 覆盖', () => {
  const dir = path.join(os.tmpdir(), 'agy-install');
  withEnv({ ANTIGRAVITY_INSTALL: dir }, () => {
    assert.deepEqual(installRoots(), [dir]);
  });
});

test('resolveContext: project 作用域落在 .agents/plugins', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cwd-'));
  const ctx = resolveContext({ scope: 'project', cwd, root: path.join(cwd, 'cfg') });
  assert.equal(ctx.installDir, projectPluginDir(cwd));
  assert.equal(ctx.scope, 'project');
  assert.equal(ctx.configRoot, path.join(cwd, 'cfg'));
});
