#!/usr/bin/env node
/**
 * SessionStart：新会话第一句话之前就把覆盖稿压进轨迹。
 * 这样即使某次 PreInvocation 被宿主跳过或超时，会话依然处于破甲状态。
 */
import { logEvent, readConfig, resolvePrompt, runHook, writeState, readState } from './lib/io.mjs';

runHook('SessionStart', (payload) => {
  const cfg = readConfig();
  if (!cfg.layers?.inject || cfg.prompt?.sessionStart === false) return {};

  const prompt = resolvePrompt(payload.modelName, cfg);
  logEvent('SessionStart', payload);
  if (!prompt.text) return {};

  const state = readState();
  writeState({
    ...state,
    lastSessionStart: {
      at: new Date().toISOString(),
      conversationId: payload.conversationId || '',
      source: prompt.source,
      variant: prompt.variant,
      modelName: payload.modelName || '',
    },
  });

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
