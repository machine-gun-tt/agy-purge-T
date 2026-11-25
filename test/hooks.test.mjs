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

function writeCfg(data, cfg) {
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(cfg), 'utf8');
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
  initialNumSteps: 0,
  executionNum: 1,
  terminationReason: 'NO_TOOL_CALL',
  fullyIdle: true,
  toolCall: { id: 't1', name: 'run_command', args: { CommandLine: 'echo hi' } },
};

/* ------------------------------------------------------------------ 注入层 */

test('PreInvocation 首次注入完整覆盖稿', () => {
  const data = sandbox();
  const out = runHook('pre-invocation.mjs', { ...BASE, conversationId: 'c-first', invocationNum: 0 }, { data });
  assert.equal(out.status, 0);
  const text = out.parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
  assert.ok(text.length > 300, `注入内容过短：${text.slice(0, 80)}`);
  assert.match(text, /执行层覆盖稿|小码酱/);
  assert.equal(out.parsed.injectSteps[0].systemMessage.metadata, undefined, '不得携带 metadata（宿主 2.31 会 panic）');
});

test('同一会话只注入一次（省 token 的核心）', () => {
  const data = sandbox();
  const first = runHook('pre-invocation.mjs', { ...BASE, conversationId: 'c-once', invocationNum: 0 }, { data });
  assert.equal(first.parsed?.injectSteps?.length, 1);

  const second = runHook('pre-invocation.mjs', { ...BASE, conversationId: 'c-once', invocationNum: 1 }, { data });
  assert.deepEqual(second.parsed, {}, '第二轮不应再注入');

  const other = runHook('pre-invocation.mjs', { ...BASE, conversationId: 'c-other', invocationNum: 0 }, { data });
  assert.equal(other.parsed?.injectSteps?.length, 1, '新会话应重新注入');
});

test('SessionStart 之后 PreInvocation 不重复注入', () => {
  const data = sandbox();
  const start = runHook('session-start.mjs', { ...BASE, conversationId: 'c-sess' }, { data });
  assert.equal(start.parsed?.injectSteps?.length, 1);

  const next = runHook('pre-invocation.mjs', { ...BASE, conversationId: 'c-sess', invocationNum: 0 }, { data });
  assert.deepEqual(next.parsed, {});
});

test('上下文被压缩后重新注入', () => {
  const data = sandbox();
  runHook('pre-invocation.mjs', { ...BASE, conversationId: 'c-compact', invocationNum: 0, initialNumSteps: 40 }, { data });

  const grown = runHook('pre-invocation.mjs', { ...BASE, conversationId: 'c-compact', invocationNum: 5, initialNumSteps: 60 }, { data });
  assert.deepEqual(grown.parsed, {});

  const compacted = runHook('pre-invocation.mjs', { ...BASE, conversationId: 'c-compact', invocationNum: 6, initialNumSteps: 8 }, { data });
  assert.equal(compacted.parsed?.injectSteps?.length, 1, '步数回落应视为压缩并重注');
});

test('strategy=interval 只在整轮重注', () => {
  const data = sandbox();
  writeCfg(data, { version: 2, prompt: { strategy: 'interval', fullEvery: 6 } });
  assert.equal(runHook('pre-invocation.mjs', { ...BASE, conversationId: 'c-int', invocationNum: 0 }, { data }).parsed?.injectSteps?.length, 1);
  assert.deepEqual(runHook('pre-invocation.mjs', { ...BASE, conversationId: 'c-int', invocationNum: 3 }, { data }).parsed, {});
  assert.equal(runHook('pre-invocation.mjs', { ...BASE, conversationId: 'c-int', invocationNum: 6 }, { data }).parsed?.injectSteps?.length, 1);
});

test('strategy=every 每次注入（显式选择才这么贵）', () => {
  const data = sandbox();
  writeCfg(data, { version: 2, prompt: { strategy: 'every' } });
  for (const n of [0, 1, 2]) {
    const out = runHook('pre-invocation.mjs', { ...BASE, conversationId: 'c-every', invocationNum: n }, { data });
    assert.equal(out.parsed?.injectSteps?.length, 1, `第 ${n} 轮应注入`);
  }
});

test('用户 prompt-inject.md 优先于按模型分稿', () => {
  const data = sandbox();
  fs.writeFileSync(path.join(data, 'prompt-inject.md'), 'CUSTOM-OVERRIDE-MARKER\n', 'utf8');
  const out = runHook('pre-invocation.mjs', { ...BASE, conversationId: 'c-custom', invocationNum: 0 }, { data });
  const text = out.parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
  assert.match(text, /CUSTOM-OVERRIDE-MARKER/);
});

test('SessionStart 也注入', () => {
  const data = sandbox();
  const out = runHook('session-start.mjs', { ...BASE, conversationId: 'c-start' }, { data });
  assert.ok((out.parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || '').length > 100);
});

/* ------------------------------------------------------------------ 审批层 */

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
  writeCfg(data, { version: 2, gate: { denyPatterns: ['rm -rf'] } });
  const payload = { ...BASE, toolCall: { id: 't3', name: 'run_command', args: { CommandLine: 'rm -rf /tmp/x' } } };
  const out = runHook('pre-tool-use.mjs', payload, { data });
  assert.equal(out.parsed?.decision, 'deny');
  assert.match(out.parsed?.reason || '', /denyPatterns/);
});

test('askPatterns 改成弹确认', () => {
  const data = sandbox();
  writeCfg(data, { version: 2, gate: { askPatterns: ['git push'] } });
  const payload = { ...BASE, toolCall: { id: 't4', name: 'run_command', args: { CommandLine: 'git push origin main' } } };
  const out = runHook('pre-tool-use.mjs', payload, { data });
  assert.equal(out.parsed?.decision, 'ask');
});

test('层关闭后钩子回空对象', () => {
  const data = sandbox();
  writeCfg(data, { version: 2, layers: { gate: false } });
  const out = runHook('pre-tool-use.mjs', BASE, { data });
  assert.deepEqual(out.parsed, {});
});

/* ------------------------------------------------------------------ 续跑层 */

test('Stop 默认不续跑（避免凭空多出模型调用）', () => {
  const data = sandbox();
  const out = runHook('stop.mjs', { ...BASE, executionNum: 1 }, { data });
  assert.deepEqual(out.parsed, {});
});

test('显式开启续跑后生效，且受上限约束', () => {
  const data = sandbox();
  writeCfg(data, { version: 2, layers: { continue: true }, continue: { max: 2 } });
  const first = runHook('stop.mjs', { ...BASE, executionNum: 1 }, { data });
  assert.equal(first.parsed?.decision, 'continue');
  const capped = runHook('stop.mjs', { ...BASE, executionNum: 2 }, { data });
  assert.deepEqual(capped.parsed, {});
});

test('Stop 不接管报错与用户取消', () => {
  const data = sandbox();
  writeCfg(data, { version: 2, layers: { continue: true }, continue: { max: 2 } });
  assert.deepEqual(runHook('stop.mjs', { ...BASE, terminationReason: 'ERROR', error: 'boom' }, { data }).parsed, {});
  assert.deepEqual(runHook('stop.mjs', { ...BASE, terminationReason: 'USER_CANCELED' }, { data }).parsed, {});
});

/* ------------------------------------------------------------------ 迁移 / 健壮性 */

test('v1 配置自动迁移：关掉强制续跑、改为 once', () => {
  const data = sandbox();
  writeCfg(data, {
    version: 1,
    layers: { inject: true, gate: true, continue: true, log: true },
    prompt: { fullEvery: 6 },
    continue: { max: 2 },
  });

  const stop = runHook('stop.mjs', { ...BASE, executionNum: 1 }, { data });
  assert.deepEqual(stop.parsed, {}, '迁移后不应再强制续跑');

  const pre = runHook('pre-invocation.mjs', { ...BASE, conversationId: 'c-mig', invocationNum: 0 }, { data });
  assert.equal(pre.parsed?.injectSteps?.length, 1);
  const again = runHook('pre-invocation.mjs', { ...BASE, conversationId: 'c-mig', invocationNum: 1 }, { data });
  assert.deepEqual(again.parsed, {}, '迁移后应按 once 去重');
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
