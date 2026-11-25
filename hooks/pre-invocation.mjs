#!/usr/bin/env node
/**
 * PreInvocation：控制覆盖稿的注入时机。
 *
 * v1.1 起默认 `prompt.strategy = "once"`：每个会话只注入一次。
 * 之前每轮都塞一段"常驻提醒"，每次注入都会让模型重新对齐一次指令位阶——
 * 表现为思考链变长、思考时间变长、token 变贵。现在只在三种情况下注入：
 *
 *   first            本会话还没注入过（SessionStart 没跑或新会话）
 *   compact-refresh  上下文被压缩过（initialNumSteps 明显回落），覆盖稿可能被挤掉
 *   every / interval 用户显式选的高频策略
 */
import {
  advanceAnchor,
  conversationKey,
  getConversation,
  logEvent,
  markConversation,
  readConfig,
  readState,
  resolvePrompt,
  runHook,
  writeState,
} from './lib/io.mjs';

runHook('PreInvocation', (payload) => {
  const cfg = readConfig();
  if (!cfg.layers?.inject) return {};

  const prompt = resolvePrompt(payload.modelName, cfg);
  if (!prompt.text) return {};

  const strategy = String(cfg.prompt?.strategy || 'once');
  const key = conversationKey(payload);
  const steps = Number(payload.initialNumSteps) || 0;
  const invocation = Number.isFinite(Number(payload.invocationNum)) ? Number(payload.invocationNum) : 0;
  const fullEvery = Math.max(1, Number(cfg.prompt?.fullEvery) || 6);

  let state = readState();
  const conv = getConversation(state, key);

  let mode = null;
  if (strategy === 'every') {
    mode = 'every';
  } else if (strategy === 'interval') {
    if (!conv || invocation === 0 || invocation % fullEvery === 0) mode = 'interval';
  } else if (!conv) {
    mode = 'first';
  } else if (
    cfg.prompt?.refreshOnCompaction !== false &&
    steps > 0 &&
    Number(conv.steps) > 0 &&
    steps < Number(conv.steps) - 2
  ) {
    mode = 'compact-refresh';
  }

  if (!mode) {
    // 不注入，但把锚点往前推，保证之后的压缩判断仍然准
    state = advanceAnchor(state, key, steps);
    writeState(state);
    logEvent('PreInvocation:skip', payload);
    return {};
  }

  state = markConversation(state, key, {
    steps,
    mode,
    invocation,
    source: prompt.source,
    variant: prompt.variant,
    modelName: payload.modelName || '',
  });
  writeState(state);
  logEvent(`PreInvocation:${mode}`, payload);

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: prompt.text,
        },
      },
    ],
  };
});
