#!/usr/bin/env node
/**
 * SessionStart：v1.2 起默认**不注入**。
 *
 * 原因：SessionStart 发生在用户消息之前，注入后模型还要「跨过」整段用户消息才回答；
 * 而 PreInvocation 每轮开始时注入的位置更贴近调用点，recency 更好，成本一样是每轮一次。
 * 少注一次也顺手消掉了会话开头那条多余的 "Hook Json SessionStart" 步骤。
 *
 * 需要旧行为就设 `prompt.sessionStart: true`。
 */
import {
  conversationKey,
  logEvent,
  markConversation,
  readConfig,
  readState,
  resolvePrompt,
  runHook,
  turnKey,
  writeState,
} from './lib/io.mjs';

runHook('SessionStart', (payload) => {
  const cfg = readConfig();
  if (!cfg.layers?.inject || cfg.prompt?.sessionStart !== true) {
    logEvent('SessionStart:skip', payload);
    return {};
  }

  const prompt = resolvePrompt(payload.modelName, cfg);
  if (!prompt.text) return {};

  const key = conversationKey(payload);
  const state = markConversation(readState(), key, {
    steps: Number(payload.initialNumSteps) || 0,
    turn: turnKey(payload),
    mode: 'session-start',
    source: prompt.source,
    variant: prompt.variant,
    modelName: payload.modelName || '',
  });
  writeState(state);
  logEvent('SessionStart', payload);

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
