/**
 * agy-purge — 运行时解析
 *
 * Antigravity 的 hook 命令在 Windows 上由 `cmd /c` 执行、在 Unix 上由 `sh -c`
 * 执行，且 cwd 是插件目录。用户机器不一定装了 Node，所以这里按顺序找一个能用
 * 的解释器，并把**绝对路径**写进 hooks.json：
 *
 *   1. $AGY_PURGE_NODE
 *   2. 当前进程可执行体（CLI 本身就是 node 时最可靠）
 *   3. PATH 上的 node
 *   4. Antigravity 自带的 agy-node 垫片（<userData>/bin/agy-node.cmd）
 *   5. Antigravity.exe + ELECTRON_RUN_AS_NODE=1（Electron 内置 Node）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { userDataDir } from './paths.mjs';

export const MIN_NODE_MAJOR = 18;

export function quoteArg(value) {
  const text = String(value);
  return `"${text.replace(/"/g, '\\"')}"`;
}

export function nodeMajor(bin, env = {}) {
  try {
    const res = spawnSync(bin, ['-e', 'process.stdout.write(process.versions.node)'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    if (res.error || res.status !== 0) return null;
    const major = Number(String(res.stdout || '').trim().split('.')[0]);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

function whichNode() {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  if (res.status !== 0) return null;
  const first = String(res.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return first || null;
}

function agyNodeShim() {
  const dir = path.join(userDataDir(), 'bin');
  const names = process.platform === 'win32' ? ['agy-node.cmd', 'agy-node.exe', 'agy-node'] : ['agy-node', 'agy-node.sh'];
  for (const name of names) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function electronBinary(install) {
  if (!install) return null;
  const exe = process.platform === 'darwin' ? path.join(install.root, 'MacOS', 'Antigravity') : install.executable;
  return exe && fs.existsSync(exe) ? exe : null;
}

/**
 * @returns {{
 *   ok: boolean, kind: 'node'|'agy-node'|'electron'|null, version: number|null,
 *   bin: string|null, env: Record<string,string>, note: string
 * }}
 */
export function resolveRuntime({ install = null } = {}) {
  const forced = process.env.AGY_PURGE_NODE && process.env.AGY_PURGE_NODE.trim();
  if (forced) {
    const bin = path.resolve(forced);
    const major = nodeMajor(bin);
    if (major && major >= MIN_NODE_MAJOR) {
      return { ok: true, kind: 'node', version: major, bin, env: {}, note: 'AGY_PURGE_NODE' };
    }
    return { ok: false, kind: 'node', version: major, bin, env: {}, note: `AGY_PURGE_NODE 不可用或低于 v${MIN_NODE_MAJOR}` };
  }

  if (!/electron/i.test(process.versions.electron || '') && process.execPath) {
    const major = nodeMajor(process.execPath);
    if (major && major >= MIN_NODE_MAJOR) {
      return { ok: true, kind: 'node', version: major, bin: process.execPath, env: {}, note: '当前进程' };
    }
  }

  const onPath = whichNode();
  if (onPath) {
    const major = nodeMajor(onPath);
    if (major && major >= MIN_NODE_MAJOR) {
      return { ok: true, kind: 'node', version: major, bin: onPath, env: {}, note: 'PATH' };
    }
  }

  const shim = agyNodeShim();
  if (shim) {
    const major = nodeMajor(shim);
    if (major && major >= MIN_NODE_MAJOR) {
      return { ok: true, kind: 'agy-node', version: major, bin: shim, env: {}, note: 'Antigravity agy-node 垫片' };
    }
  }

  const electron = electronBinary(install);
  if (electron) {
    const env = { ELECTRON_RUN_AS_NODE: '1' };
    const major = nodeMajor(electron, env);
    if (major && major >= MIN_NODE_MAJOR) {
      return { ok: true, kind: 'electron', version: major, bin: electron, env, note: 'Antigravity.exe (ELECTRON_RUN_AS_NODE)' };
    }
  }

  return { ok: false, kind: null, version: null, bin: null, env: {}, note: `未找到 Node ≥ ${MIN_NODE_MAJOR}` };
}

/** 生成写进 hooks.json 的整条命令（含平台差异的环境变量前缀）。 */
export function renderCommand(runtime, scriptPath, extraArgs = []) {
  if (!runtime?.ok) return null;
  const args = [scriptPath, ...extraArgs].map(quoteArg).join(' ');
  const envPrefix = Object.entries(runtime.env || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  if (!envPrefix) return `${quoteArg(runtime.bin)} ${args}`;
  if (process.platform === 'win32') {
    // 外层已是 cmd /c，这里再用 set 给子进程带环境变量
    return `set ${Object.entries(runtime.env).map(([k, v]) => `${k}=${v}`).join('&& set ')}&& ${quoteArg(runtime.bin)} ${args}`;
  }
  return `${envPrefix} ${quoteArg(runtime.bin)} ${args}`;
}
