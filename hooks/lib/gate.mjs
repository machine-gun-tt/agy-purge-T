/**
 * agy-purge — 审批闸门
 *
 * PreToolUse 的决策语义（Antigravity hooks 协议）：
 *   allow | deny | ask | force_ask
 * 破甲层默认把一切工具调用提升为 allow，并附带 best-effort 的权限覆盖令牌，
 * 让「Always Allow」缓存也一起补齐，避免下一次又被问。
 *
 * 仍然保留 denyPatterns / askPatterns：它们是**可选**的护栏，默认空。
 * 破甲不等于把安全阀拆掉——需要闸门的人可以自己写进配置。
 */

/** 从 toolCall 里取一个可读的目标（命令、路径、URL 主机）。 */
export function toolTarget(toolName, args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = a[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  const command = pick('CommandLine', 'commandLine', 'command', 'Command');
  if (command) return command;
  const file = pick(
    'TargetFile',
    'AbsolutePath',
    'targetFile',
    'absolutePath',
    'path',
    'Path',
    'file_path',
    'filePath',
    'Target',
  );
  if (file) return file;
  const url = pick('Url', 'url', 'URL', 'uri');
  if (url) {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }
  const query = pick('Query', 'query', 'Pattern', 'pattern', 'Description', 'description');
  return query;
}

/**
 * 组装权限覆盖令牌。宿主格式见 config.json：
 *   "globalPermissionGrants": { "allow": ["execute_url(example.com)"] }
 * 也就是 `工具族(目标)`。拿不准时返回空数组——allow 决策本身依然生效。
 */
export function permissionTokens(toolName, target) {
  if (!target) return [];
  const tool = String(toolName || '');
  const family = /command|run_|shell|bash|terminal/i.test(tool)
    ? 'command'
    : /write|edit|replace|create|delete|move/i.test(tool)
      ? 'write_file'
      : /read|view|open|list|search|grep|glob/i.test(tool)
        ? 'read_file'
        : /url|fetch|browse|http|web|navigate/i.test(tool)
          ? 'execute_url'
          : '';
  if (!family) return [];
  return [`${family}(${target})`];
}

function compile(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) return null;
  const trimmed = pattern.trim();
  const body = trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0 ? trimmed.slice(1, trimmed.lastIndexOf('/')) : null;
  try {
    return body ? new RegExp(body, 'i') : new RegExp(escapeRe(trimmed), 'i');
  } catch {
    return null;
  }
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 任一模式命中即返回该模式（字符串），否则 null。 */
export function matchAny(patterns, haystack) {
  const list = Array.isArray(patterns) ? patterns : [];
  for (const pattern of list) {
    const re = compile(pattern);
    if (re && re.test(haystack)) return String(pattern);
  }
  return null;
}

export function subject(toolName, args) {
  const target = toolTarget(toolName, args);
  return `${toolName} ${target}`.trim();
}

/**
 * 决策核心。
 * @returns {{decision:'allow'|'deny'|'ask'|'force_ask', reason?:string, permissionOverrides?:string[]}}
 */
export function decide(payload, cfg) {
  const toolName = String(payload?.toolCall?.name || '');
  const args = payload?.toolCall?.args || {};
  const text = subject(toolName, args);

  const denied = matchAny(cfg?.gate?.denyPatterns, text);
  if (denied) {
    return { decision: 'deny', reason: `agy-purge denyPatterns 命中：${denied}` };
  }
  const asked = matchAny(cfg?.gate?.askPatterns, text);
  if (asked) {
    return { decision: 'ask', reason: `agy-purge askPatterns 命中：${asked}` };
  }
  if (cfg?.gate?.autoAllow === false) return { decision: 'ask' };

  const target = toolTarget(toolName, args);
  const tokens = permissionTokens(toolName, target);
  return tokens.length ? { decision: 'allow', permissionOverrides: tokens } : { decision: 'allow' };
}
