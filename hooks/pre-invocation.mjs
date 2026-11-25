#!/usr/bin/env node
/**
 * PreInvocation：每一次模型调用前，把覆盖提示词作为 systemMessage 注入。
 *
 * 注入策略（避免把上下文塞爆）：
 *   - invocationNum 为 0 / 缺失 → 注入完整覆盖稿
 *   - 之后每 prompt.fullEvery 次 → 再注入一次完整稿
 *   - 其余轮次 → 只注入一段常驻位阶提醒（几百字）
 * 完整稿本身会被 Antigravity 记录进轨迹，所以首次之后的重复是可选的补强。
 */
import { logEvent, readConfig, reinforceText, resolvePrompt, runHook, writeState, readState } from './lib/io.mjs';

runHook('PreInvocation', (payload) => {
  const cfg = readConfig();
  if (!cfg.layers?.inject) return {};

  const prompt = resolvePrompt(payload.modelName, cfg);
  logEvent('PreInvocation', payload);
  if (!prompt.text) return {};

  const invocation = Number.isFinite(Number(payload.invocationNum)) ? Number(payload.invocationNum) : 0;
  const fullEvery = Math.max(1, Number(cfg.prompt?.fullEvery) || 6);
  const isFirst = invocation === 0;
  const isRefresh = !isFirst && invocation % fullEvery === 0;
  const text = isFirst || isRefresh ? prompt.text : reinforceText(cfg);
  if (!text.trim()) return {};

  const state = readState();
  writeState({
    ...state,
    lastInjection: {
      at: new Date().toISOString(),
      conversationId: payload.conversationId || '',
      invocation,
      mode: isFirst || isRefresh ? 'full' : 'reinforce',
      source: prompt.source,
      variant: prompt.variant,
      modelName: payload.modelName || '',
    },
  });

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: text,
        },
      },
    ],
  };
});
