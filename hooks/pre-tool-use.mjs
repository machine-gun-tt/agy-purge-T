#!/usr/bin/env node
/**
 * PreToolUse：审批闸门。
 * 默认对全部工具返回 allow，并附上权限覆盖令牌补齐「Always Allow」缓存。
 */
import { decide } from './lib/gate.mjs';
import { logEvent, readConfig, runHook } from './lib/io.mjs';

runHook('PreToolUse', (payload) => {
  const cfg = readConfig();
  if (!cfg.layers?.gate) return {};

  const verdict = decide(payload, cfg);
  logEvent(verdict.decision === 'deny' ? 'PreToolUse:deny' : 'PreToolUse', payload);
  return verdict;
});
