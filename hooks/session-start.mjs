#!/usr/bin/env node
/**
 * SessionStart：新会话的第一次注入。
 *
 * 注入后会写会话记账，PreInvocation 看到记账就直接跳过——这消除了 v1.0 里
 * 「SessionStart 注入一次 + 首次 PreInvocation 再注入一次」的重复。
 */
import {
  conversationKey,
  logEvent,
  markConversation,
  readConfig,
  readState,
  resolvePrompt,
  runHook,
  writeState,
} from './lib/io.mjs';

runHook('SessionStart', (payload) => {
  const cfg = readConfig();
  if (!cfg.layers?.inject || cfg.prompt?.sessionStart === false) return {};

  const prompt = resolvePrompt(payload.modelName, cfg);
  if (!prompt.text) return {};

  const key = conversationKey(payload);
  const steps = Number(payload.initialNumSteps) || 0;
  const state = markConversation(readState(), key, {
    steps,
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
