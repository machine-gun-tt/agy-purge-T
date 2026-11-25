import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderHooks } from '../lib/patches.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hooks-'));
  fs.mkdirSync(path.join(base, 'data'), { recursive: true });
  return base;
}

function runHook(script, payload, { data, raw = null, timeout = 15000 } = {}) {
  const env = { ...process.env, PLUGIN_DATA: data, AGY_PURGE_DATA: data };
  delete env.ANTIGRAVITY_CONFIG_DIR;
  const res = spawnSync(process.execPath, [path.join(REPO, 'hooks', script)], {
    input: raw !== null ? raw : JSON.stringify(payload),
    encoding: 'utf8',
    timeout,
    cwd: REPO,
    env,
  });
  const stdout = String(res.stdout || '').trim();
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = undefined;
  }
  return { status: res.status, stdout, parsed, stderr: String(res.stderr || '') };
}

const BASE = {
  conversationId: 'c-1',
  workspacePaths: ['/tmp/ws'],
  modelName: 'gemini-3-pro',
  lastUserInput: 'probe',
  cwd: '/tmp/ws',
  invocationNum: 0,
  executionNum: 1,
  terminationReason: 'NO_TOOL_CALL',
  fullyIdle: true,
  toolCall: { id: 't1', name: 'run_command', args: { CommandLine: 'echo hi' } },
};

test('PreInvocation 首次注入完整覆盖稿', () => {
  const data = sandbox();
  const out = runHook('pre-invocation.mjs', { ...BASE, invocationNum: 0 }, { data });
  assert.equal(out.status, 0);
  const text = out.parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
  assert.ok(text.length > 300, `注入内容过短：${text.slice(0, 80)}`);
  assert.match(text, /执行层覆盖稿|小码酱/);
  assert.equal(out.parsed.injectSteps[0].systemMessage.metadata, undefined, '不得携带 metadata（宿主 2.31 会 panic）');
});

test('PreInvocation 非整轮只注入常驻提醒', () => {
  const data = sandbox();
  const out = runHook('pre-invocation.mjs', { ...BASE, invocationNum: 3 }, { data });
  const text = out.parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
  assert.match(text, /常驻位阶/);
  assert.ok(text.length < 400, '提醒应当比完整稿短');
});

test('用户 prompt-inject.md 优先于按模型分稿', () => {
  const data = sandbox();
  fs.writeFileSync(path.join(data, 'prompt-inject.md'), 'CUSTOM-OVERRIDE-MARKER\n', 'utf8');
  const out = runHook('pre-invocation.mjs', { ...BASE, invocationNum: 0 }, { data });
  const text = out.parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
  assert.match(text, /CUSTOM-OVERRIDE-MARKER/);
});

test('SessionStart 也注入', () => {
  const data = sandbox();
  const out = runHook('session-start.mjs', BASE, { data });
  assert.ok((out.parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || '').length > 100);
});

test('PreToolUse 放行并补齐权限令牌', () => {
  const data = sandbox();
  const out = runHook('pre-tool-use.mjs', BASE, { data });
  assert.equal(out.parsed?.decision, 'allow');
  assert.deepEqual(out.parsed?.permissionOverrides, ['command(echo hi)']);
});

test('PreToolUse 文件写工具映射到 write_file', () => {
  const data = sandbox();
  const payload = { ...BASE, toolCall: { id: 't2', name: 'write_to_file', args: { TargetFile: '/tmp/a.md' } } };
  const out = runHook('pre-tool-use.mjs', payload, { data });
  assert.equal(out.parsed?.decision, 'allow');
  assert.deepEqual(out.parsed?.permissionOverrides, ['write_file(/tmp/a.md)']);
});

test('denyPatterns 能拦住指定命令', () => {
  const data = sandbox();
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ gate: { denyPatterns: ['rm -rf'] } }), 'utf8');
  const payload = { ...BASE, toolCall: { id: 't3', name: 'run_command', args: { CommandLine: 'rm -rf /tmp/x' } } };
  const out = runHook('pre-tool-use.mjs', payload, { data });
  assert.equal(out.parsed?.decision, 'deny');
  assert.match(out.parsed?.reason || '', /denyPatterns/);
});

test('askPatterns 改成弹确认', () => {
  const data = sandbox();
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ gate: { askPatterns: ['git push'] } }), 'utf8');
  const payload = { ...BASE, toolCall: { id: 't4', name: 'run_command', args: { CommandLine: 'git push origin main' } } };
  const out = runHook('pre-tool-use.mjs', payload, { data });
  assert.equal(out.parsed?.decision, 'ask');
});

test('层关闭后钩子回空对象', () => {
  const data = sandbox();
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ layers: { gate: false } }), 'utf8');
  const out = runHook('pre-tool-use.mjs', BASE, { data });
  assert.deepEqual(out.parsed, {});
});

test('Stop 在正常收尾时续跑，超过上限就放行', () => {
  const data = sandbox();
  const first = runHook('stop.mjs', { ...BASE, executionNum: 1 }, { data });
  assert.equal(first.parsed?.decision, 'continue');

  const capped = runHook('stop.mjs', { ...BASE, executionNum: 2 }, { data });
  assert.deepEqual(capped.parsed, {});
});

test('Stop 不接管报错与用户取消', () => {
  const data = sandbox();
  const errored = runHook('stop.mjs', { ...BASE, terminationReason: 'ERROR', error: 'boom' }, { data });
  assert.deepEqual(errored.parsed, {});
  const canceled = runHook('stop.mjs', { ...BASE, terminationReason: 'USER_CANCELED' }, { data });
  assert.deepEqual(canceled.parsed, {});
});

test('PostToolUse 恒回空对象', () => {
  const data = sandbox();
  const out = runHook('post-tool-use.mjs', { ...BASE, stepIdx: 3 }, { data });
  assert.deepEqual(out.parsed, {});
});

test('坏输入不炸：非 JSON stdin 也是合法 JSON + 退出码 0', () => {
  const data = sandbox();
  const out = runHook('pre-invocation.mjs', null, { data, raw: 'not-json-at-all' });
  assert.equal(out.status, 0);
  assert.notEqual(out.parsed, undefined, 'stdout 必须始终是一个合法 JSON 对象');
  // 载荷坏了也照样注入——宿主侧宁可多注入一次，也不要静默失效
  const text = out.parsed?.injectSteps?.[0]?.systemMessage?.systemMessage;
  assert.ok(text === undefined || typeof text === 'string');
});

test('renderHooks 结构符合协议：分组事件带 matcher，扁平事件直接是列表', () => {
  const installDir = path.join(os.tmpdir(), 'agy-render-probe');
  const runtime = { ok: true, kind: 'node', bin: 'C:\\node\\node.exe', env: {} };
  const hooks = renderHooks(installDir, runtime, { inject: true, gate: true, continue: true, log: false });

  assert.ok(Array.isArray(hooks['agy-purge-inject'].SessionStart));
  assert.equal(hooks['agy-purge-inject'].SessionStart[0].hooks, undefined);
  assert.equal(hooks['agy-purge-gate'].PreToolUse[0].matcher, '*');
  assert.ok(Array.isArray(hooks['agy-purge-gate'].PreToolUse[0].hooks));
  assert.equal(hooks['agy-purge-log'].enabled, false, 'log 层关闭时整组应禁用');
  assert.match(hooks['agy-purge-gate'].PreToolUse[0].hooks[0].command, /pre-tool-use\.mjs/);
});
