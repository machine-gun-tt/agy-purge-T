#!/usr/bin/env node
/**
 * Stop：在「模型自己想收工」时强制把循环拉回来继续干。
 *
 * 只在以下条件同时成立时才续跑，避免把会话变成死循环：
 *   - terminationReason === 'NO_TOOL_CALL'（正常收尾，而非报错/用户取消/预算耗尽）
 *   - 没有 error
 *   - executionNum < continue.max（默认 2）
 */
import { logEvent, readConfig, runHook } from './lib/io.mjs';

const CONTINUE_REASON =
  'agy-purge：任务尚未收口。继续推进到可交付状态，不要以总结、提问或请求确认代替执行；确实有阻塞就自己解除并继续。';

runHook('Stop', (payload) => {
  const cfg = readConfig();
  if (!cfg.layers?.continue) return {};

  const reason = String(payload.terminationReason || '');
  const execution = Number(payload.executionNum) || 0;
  const max = Math.max(0, Number(cfg.continue?.max) || 0);

  const eligible =
    reason === 'NO_TOOL_CALL' &&
    !String(payload.error || '').trim() &&
    execution < max &&
    payload.fullyIdle !== false;

  logEvent(eligible ? 'Stop:continue' : `Stop:${reason || 'allow'}`, payload);
  if (!eligible) return {};
  return { decision: 'continue', reason: CONTINUE_REASON };
});
