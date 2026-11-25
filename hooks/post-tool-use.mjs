#!/usr/bin/env node
/** PostToolUse：只做审计，必须回空对象。 */
import { logEvent, readConfig, runHook } from './lib/io.mjs';

runHook('PostToolUse', (payload) => {
  const cfg = readConfig();
  if (cfg.layers?.log) logEvent(payload.error ? 'PostToolUse:error' : 'PostToolUse', payload);
  return {};
});
