#!/usr/bin/env node
/**
 * PreInvocation：决定这一轮要不要注入覆盖稿。
 *
 * v1.2 默认 `strategy: "turn"`——**每个用户轮次注入一次**，位置紧贴用户消息之后，
 * 也就是模型调用之前，recency 最好。轮内的工具循环不再重复注入（那才是 token 黑洞），
 * 但每轮开头都会重新把位阶钉一遍，抵消宿主每轮附带的策略前言。
 *
 *   first            本会话第一次调用
 *   new-turn         lastUserInput 变了 → 新一轮
 *   compact-refresh  上下文被压缩（initialNumSteps 明显回落）
 *   every/interval   用户显式选的高频策略
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
  turnKey,
  writeState,
} from './lib/io.mjs';

runHook('PreInvocation', (payload) => {
  const cfg = readConfig();
  if (!cfg.layers?.inject) return {};

  const prompt = resolvePrompt(payload.modelName, cfg);
  if (!prompt.text) return {};

  const strategy = String(cfg.prompt?.strategy || 'turn');
  const key = conversationKey(payload);
  const turn = turnKey(payload);
  const steps = Number(payload.initialNumSteps) || 0;
  const invocation = Number.isFinite(Number(payload.invocationNum)) ? Number(payload.invocationNum) : 0;
  const fullEvery = Math.max(1, Number(cfg.prompt?.fullEvery) || 6);

  let state = readState();
  const conv = getConversation(state, key);
  const compacted =
    Boolean(conv) &&
    cfg.prompt?.refreshOnCompaction !== false &&
    steps > 0 &&
    Number(conv.steps) > 0 &&
    steps < Number(conv.steps) - 2;

  let mode = null;
  if (strategy === 'every') {
    mode = 'every';
  } else if (strategy === 'interval') {
    if (!conv || invocation === 0 || invocation % fullEvery === 0) mode = 'interval';
  } else if (!conv) {
    mode = 'first';
  } else if (compacted) {
    mode = 'compact-refresh';
  } else if (strategy === 'once') {
    mode = null;
  } else if (turn && conv.turn !== turn) {
    // 默认 turn 策略：同一轮内只注入一次
    mode = 'new-turn';
  } else if (!turn && invocation === 0) {
    // 宿主没给 lastUserInput 时退化为「每轮起点」语义
    mode = 'new-turn';
  }

  if (!mode) {
    // 不注入：只有锚点前进时才写盘，避免每次调用都刷 state.json
    if (steps > (Number(conv?.steps) || 0)) {
      writeState(advanceAnchor(state, key, steps));
    }
    logEvent('PreInvocation:skip', payload);
    return {};
  }

  state = markConversation(state, key, {
    steps,
    turn,
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
