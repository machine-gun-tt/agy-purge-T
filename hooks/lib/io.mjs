/**
 * agy-purge — hook I/O 底座
 *
 * 设计约束（来自 Antigravity hooks 协议）：
 *  - 钩子同步阻塞 agent 循环，必须极快、绝不抛错、绝不挂死。
 *  - stdout 必须是**单个** JSON 对象；任何多余输出都会破坏协议。
 *  - 不同 Antigravity 版本对 systemMessage.metadata 的处理不一致（已知 2.31.0
 *    会因 metadata map 抛 panic），因此本插件只输出纯字符串 systemMessage。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_NAME = 'agy-purge';
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const EXIT_WATCHDOG_MS = 3000;
const STDIN_IDLE_MS = 1500;

/* ------------------------------------------------------------------ 路径 */

export function geminiDir() {
  const env = process.env.GEMINI_DIR || process.env.AGY_PURGE_GEMINI_DIR;
  if (env && env.trim()) return path.resolve(expandHome(env.trim()));
  return path.join(os.homedir(), '.gemini');
}

export function configRoot() {
  const env = process.env.ANTIGRAVITY_CONFIG_DIR || process.env.GEMINI_CONFIG_DIR;
  if (env && env.trim()) return path.resolve(expandHome(env.trim()));
  return path.join(geminiDir(), 'config');
}

export function dataDir() {
  const env = process.env.PLUGIN_DATA || process.env.AGY_PURGE_DATA;
  if (env && env.trim()) return path.resolve(expandHome(env.trim()));
  const candidates = [
    path.join(geminiDir(), 'antigravity', 'plugin_data', PLUGIN_NAME),
    path.join(configRoot(), 'plugin_data', PLUGIN_NAME),
    path.join(PLUGIN_ROOT, '.data'),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {
      /* ignore */
    }
  }
  return candidates[1];
}

export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/* ------------------------------------------------------------------ 配置 */

export const DEFAULT_CONFIG = {
  version: 2,
  layers: { inject: true, gate: true, continue: false, log: true },
  prompt: {
    // once：每个会话只在 SessionStart / 首次 PreInvocation 注入一次（默认，最省 token）
    // interval：每 fullEvery 次调用重注一次
    // every：每次调用都重注（最贵，只有需要硬钉位阶时才开）
    strategy: 'once',
    fullEvery: 6,
    sessionStart: true,
    refreshOnCompaction: true,
    variant: 'auto',
  },
  gate: { autoAllow: true, askPatterns: [], denyPatterns: [] },
  continue: { max: 2 },
  log: { enabled: true, maxBytes: 262144 },
};

const MAX_CONVERSATIONS = 64;

export function configPath() {
  return path.join(dataDir(), 'config.json');
}

/** v1 → v2 迁移：老版本每次调用都注入、且默认强制续跑，两者都会烧 token。 */
export function migrateConfig(input) {
  const cfg = { ...(input || {}) };
  if ((cfg.version || 1) >= 2) return { config: cfg, migrated: false };
  cfg.version = 2;
  cfg.prompt = { ...DEFAULT_CONFIG.prompt, ...(cfg.prompt || {}) };
  if ((input?.prompt || {}).strategy === undefined) cfg.prompt.strategy = 'once';
  if ((input?.prompt || {}).refreshOnCompaction === undefined) cfg.prompt.refreshOnCompaction = true;
  cfg.layers = { ...DEFAULT_CONFIG.layers, ...(cfg.layers || {}) };
  if ((input?.layers || {}).continue === undefined || input.layers.continue === true) {
    // 老默认是「开」；强制续跑会凭空多出模型调用，迁移时关掉，要就手动开回来
    cfg.layers.continue = false;
  }
  cfg.continue = { ...DEFAULT_CONFIG.continue, ...(cfg.continue || {}) };
  cfg.log = { ...DEFAULT_CONFIG.log, ...(cfg.log || {}) };
  cfg.gate = { ...DEFAULT_CONFIG.gate, ...(cfg.gate || {}) };
  cfg.migratedFrom = input?.version || 1;
  cfg.migratedAt = new Date().toISOString();
  return { config: cfg, migrated: true };
}

export function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const { config } = migrateConfig(parsed);
    return {
      ...DEFAULT_CONFIG,
      ...config,
      layers: { ...DEFAULT_CONFIG.layers, ...(config.layers || {}) },
      prompt: { ...DEFAULT_CONFIG.prompt, ...(config.prompt || {}) },
      gate: { ...DEFAULT_CONFIG.gate, ...(config.gate || {}) },
      continue: { ...DEFAULT_CONFIG.continue, ...(config.continue || {}) },
      log: { ...DEFAULT_CONFIG.log, ...(config.log || {}) },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/* ------------------------------------------------------------------ 状态 */

function statePath() {
  return path.join(dataDir(), 'state.json');
}

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

export function writeState(state) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = `${statePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, statePath());
  } catch {
    /* 状态只是增强，写不了不影响决策 */
  }
}

/* ------------------------------------------------------------------ 提示词 */

const VARIANT_BY_MODEL = [
  [/claude|sonnet|opus|haiku/i, 'claude'],
  [/gpt|openai|oss/i, 'gpt'],
  [/gemini|flash|pro\b/i, 'gemini'],
];

export function modelVariant(modelName, forced) {
  if (forced && forced !== 'auto') return forced;
  const name = String(modelName || '');
  for (const [re, id] of VARIANT_BY_MODEL) if (re.test(name)) return id;
  return 'gemini';
}

function readIfNonEmpty(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/**
 * 覆盖提示词的解析顺序（与 dsh-purge 的 prompt-inject.md 语义一致）：
 *   1. <data>/prompt-inject.md      用户自己的覆盖稿（最高优先）
 *   2. <data>/prompt-<variant>.md   按模型分开的覆盖稿
 *   3. <plugin>/prompts/override.<variant>.md   随插件发布的默认稿
 *   4. <plugin>/prompts/override.md            兜底默认稿
 */
export function resolvePrompt(modelName, cfg = readConfig()) {
  const data = dataDir();
  const variant = modelVariant(modelName, cfg.prompt?.variant);
  const ordered = [
    { file: path.join(data, 'prompt-inject.md'), source: 'user:prompt-inject.md' },
    { file: path.join(data, `prompt-${variant}.md`), source: `user:prompt-${variant}.md` },
    { file: path.join(PLUGIN_ROOT, 'prompts', `override.${variant}.md`), source: `default:override.${variant}.md` },
    { file: path.join(PLUGIN_ROOT, 'prompts', 'override.md'), source: 'default:override.md' },
  ];
  for (const item of ordered) {
    const text = readIfNonEmpty(item.file);
    if (text) return { text, source: item.source, variant };
  }
  return { text: '', source: 'none', variant };
}

/* ------------------------------------------------- 会话级注入记账（省 token 的核心） */

/**
 * 每个会话记一条：上次注入是什么时候、注入了什么、注入时的 initialNumSteps。
 * 有了它，PreInvocation 才能在「已经注入过」时直接跳过，而不是每次都塞一段提醒——
 * 每多注入一段 systemMessage，模型就会多一次「重新对齐指令」的思考，这正是思考链
 * 变长、token 变贵的根因。
 */
export function conversationKey(payload) {
  const id = String(payload?.conversationId || '').trim();
  if (id) return id;
  const ws = Array.isArray(payload?.workspacePaths) ? payload.workspacePaths[0] : '';
  return `anon:${ws || 'unknown'}`;
}

export function getConversation(state, key) {
  const map = state?.conversations;
  if (!map || typeof map !== 'object') return null;
  return map[key] || null;
}

export function markConversation(state, key, info) {
  const map = { ...(state?.conversations || {}) };
  map[key] = { ...(map[key] || {}), ...info, at: new Date().toISOString() };
  const entries = Object.entries(map);
  if (entries.length > MAX_CONVERSATIONS) {
    entries.sort((a, b) => String(b[1]?.at || '').localeCompare(String(a[1]?.at || '')));
    return { ...(state || {}), conversations: Object.fromEntries(entries.slice(0, MAX_CONVERSATIONS)) };
  }
  return { ...(state || {}), conversations: map };
}

/** 记录更靠后的步数锚点：不注入，但让后续的「上下文被压缩」判断仍然准确。 */
export function advanceAnchor(state, key, steps) {
  const conv = getConversation(state, key);
  if (!conv) return state;
  const current = Number(conv.steps) || 0;
  if (steps <= current) return state;
  return markConversation(state, key, { ...conv, steps });
}

/* ------------------------------------------------------------------ 日志 */

export function logEvent(event, payload = {}) {
  const cfg = readConfig();
  if (!cfg.layers?.log || !cfg.log?.enabled) return;
  try {
    const dir = path.join(dataDir(), 'log');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'events.jsonl');
    try {
      const stat = fs.statSync(file);
      if (stat.size > (cfg.log.maxBytes || 262144)) {
        fs.renameSync(file, path.join(dir, 'events.jsonl.1'));
      }
    } catch {
      /* 首次写入 */
    }
    const row = {
      ts: new Date().toISOString(),
      event,
      conversationId: payload.conversationId || '',
      modelName: payload.modelName || '',
      invocationNum: payload.invocationNum ?? null,
      tool: payload.toolCall?.name || '',
      cwd: payload.cwd || '',
    };
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/* ------------------------------------------------------------------ I/O */

export function readPayload() {
  return new Promise((resolve) => {
    let raw = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      let parsed = {};
      try {
        parsed = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        parsed = {};
      }
      resolve(parsed && typeof parsed === 'object' ? parsed : {});
    };
    const timer = setTimeout(finish, STDIN_IDLE_MS);
    timer.unref?.();
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 4 * 1024 * 1024) finish();
      });
      process.stdin.on('end', () => {
        clearTimeout(timer);
        finish();
      });
      process.stdin.on('error', () => {
        clearTimeout(timer);
        finish();
      });
      process.stdin.resume();
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

export function emit(obj) {
  try {
    const text = JSON.stringify(obj ?? {});
    process.stdout.write(`${text}\n`);
  } catch {
    process.stdout.write('{}\n');
  }
}

/**
 * 钩子主入口：保证「始终输出一个合法 JSON 且退出码为 0」。
 * 任何异常、超时、坏输入都退化成 {}，绝不把错误抛回 agent 循环。
 */
export function runHook(name, handler) {
  let done = false;
  const finish = (obj) => {
    if (done) return;
    done = true;
    emit(obj);
    process.exitCode = 0;
    // 给 stdout 一点刷新时间后自然退出，避免 Windows 上的管道截断。
    setTimeout(() => process.exit(0), 5).unref?.();
  };
  const watchdog = setTimeout(() => finish({}), EXIT_WATCHDOG_MS);
  watchdog.unref?.();

  readPayload()
    .then((payload) => {
      let out = {};
      try {
        out = handler(payload) ?? {};
      } catch (error) {
        try {
          fs.mkdirSync(dataDir(), { recursive: true });
          fs.appendFileSync(
            path.join(dataDir(), 'log', 'hook-errors.log'),
            `${new Date().toISOString()} ${name}: ${error?.stack || error}\n`,
            'utf8',
          );
        } catch {
          /* ignore */
        }
        out = {};
      }
      clearTimeout(watchdog);
      finish(out);
    })
    .catch(() => {
      clearTimeout(watchdog);
      finish({});
    });
}
