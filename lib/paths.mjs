/**
 * agy-purge — 路径发现
 *
 * 不硬编码任何盘符 / 用户名。解析顺序与 Antigravity 自身一致：
 *   gemini 根    : $GEMINI_DIR → ~/.gemini
 *   customization: $ANTIGRAVITY_CONFIG_DIR → $GEMINI_CONFIG_DIR → <gemini>/config
 *   插件目录     : <customization>/plugins
 *   插件数据     : $PLUGIN_DATA → <gemini>/antigravity/plugin_data/agy-purge
 *   安装目录     : $ANTIGRAVITY_INSTALL → 平台默认候选
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ID = 'agy-purge';
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function envDir(name) {
  const value = process.env[name];
  return value && value.trim() ? path.resolve(expandHome(value.trim())) : null;
}

export function geminiDir() {
  return envDir('AGY_PURGE_GEMINI_DIR') || envDir('GEMINI_DIR') || path.join(os.homedir(), '.gemini');
}

export function configRoot() {
  return (
    envDir('ANTIGRAVITY_CONFIG_DIR') ||
    envDir('GEMINI_CONFIG_DIR') ||
    path.join(geminiDir(), 'config')
  );
}

export function pluginsDir(root = configRoot()) {
  return path.join(root, 'plugins');
}

export function pluginInstallDir(root = configRoot()) {
  return path.join(pluginsDir(root), PLUGIN_ID);
}

export function dataDir() {
  return (
    envDir('AGY_PURGE_DATA') ||
    envDir('PLUGIN_DATA') ||
    path.join(geminiDir(), 'antigravity', 'plugin_data', PLUGIN_ID)
  );
}

export function logsDir() {
  return path.join(dataDir(), 'log');
}

export function userDataDir() {
  const forced = envDir('ANTIGRAVITY_USER_DATA');
  if (forced) return forced;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Antigravity');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Antigravity');
}

/** Antigravity 安装根（含 resources/ 的那一层）。返回全部命中的候选。 */
export function installRoots() {
  const forced = envDir('ANTIGRAVITY_INSTALL');
  if (forced) return [forced];

  const candidates = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      path.join(local, 'Programs', 'Antigravity'),
      path.join(local, 'Programs', 'antigravity'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Antigravity'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Antigravity'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Antigravity.app/Contents', path.join(os.homedir(), 'Applications', 'Antigravity.app', 'Contents'));
  } else {
    candidates.push('/opt/Antigravity', '/usr/share/antigravity', '/usr/lib/antigravity', path.join(os.homedir(), '.local', 'share', 'antigravity'));
  }
  return candidates;
}

export function findInstall() {
  for (const root of installRoots()) {
    try {
      if (fs.existsSync(path.join(root, 'resources'))) {
        return {
          root,
          resources: path.join(root, 'resources'),
          asar: path.join(root, 'resources', 'app.asar'),
          languageServer: path.join(root, 'resources', 'bin', process.platform === 'win32' ? 'language_server.exe' : 'language_server'),
          executable:
            process.platform === 'win32'
              ? path.join(root, 'Antigravity.exe')
              : process.platform === 'darwin'
                ? path.join(root, 'MacOS', 'Antigravity')
                : path.join(root, 'antigravity'),
        };
      }
    } catch {
      /* 继续找下一个候选 */
    }
  }
  return null;
}

/** 项目级（团队共享）定制根：<cwd>/.agents */
export function projectAgentsDir(cwd = process.cwd()) {
  return path.join(path.resolve(cwd), '.agents');
}

export function projectPluginDir(cwd = process.cwd()) {
  return path.join(projectAgentsDir(cwd), 'plugins', PLUGIN_ID);
}

/**
 * 宿主构建指纹：app.asar 的尺寸 + sha256。
 * Antigravity 升级后这个值一定变——用它判断「插件是不是还配着当前这版宿主」。
 */
export function hostFingerprint(host = findInstall()) {
  if (!host) return null;
  try {
    const bytes = fs.readFileSync(host.asar);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    return { id: `${bytes.length}-${sha}`, size: bytes.length, sha256: sha, at: new Date().toISOString() };
  } catch {
    return null;
  }
}

export function resolveContext({ scope = 'user', cwd = process.cwd(), root } = {}) {
  const customizationRoot = root ? path.resolve(root) : configRoot();
  const project = scope === 'project';
  return {
    scope,
    cwd: path.resolve(cwd),
    geminiDir: geminiDir(),
    configRoot: customizationRoot,
    pluginsDir: pluginsDir(customizationRoot),
    installDir: project ? projectPluginDir(cwd) : pluginInstallDir(customizationRoot),
    dataDir: dataDir(),
    logsDir: logsDir(),
    userDataDir: userDataDir(),
    repoRoot: REPO_ROOT,
    host: findInstall(),
    configFile: path.join(customizationRoot, 'config.json'),
  };
}
