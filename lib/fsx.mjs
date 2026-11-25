/** agy-purge — 文件底座：原子写、一次性备份、可逆恢复。 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BACKUP_SUFFIX = '.agypurge.bak';

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** 先写临时文件再 rename，避免半截文件被宿主读到。 */
export function writeAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function writeJson(file, value) {
  return writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 首次改动前留一份原件。
 * 已存在备份时**不覆盖**——重复 apply 必须保住最原始的那份。
 */
export function backupOnce(file, suffix = BACKUP_SUFFIX) {
  const backup = `${file}${suffix}`;
  if (!isFile(file) || exists(backup)) return backup;
  fs.copyFileSync(file, backup);
  return backup;
}

export function hasBackup(file, suffix = BACKUP_SUFFIX) {
  return isFile(`${file}${suffix}`);
}

export function restoreBackup(file, suffix = BACKUP_SUFFIX) {
  const backup = `${file}${suffix}`;
  if (!isFile(backup)) return false;
  ensureDir(path.dirname(file));
  fs.copyFileSync(backup, file);
  fs.rmSync(backup, { force: true });
  return true;
}

export function dropBackup(file, suffix = BACKUP_SUFFIX) {
  const backup = `${file}${suffix}`;
  if (!isFile(backup)) return false;
  fs.rmSync(backup, { force: true });
  return true;
}

export function removeFile(file) {
  if (!exists(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

export function removeTree(dir) {
  if (!exists(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

const COPY_SKIP = new Set(['.git', 'node_modules', '.data', 'test', '.github', '.DS_Store']);

export function copyTree(src, dest, { skip = COPY_SKIP } = {}) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to, { skip });
    else if (entry.isFile()) {
      ensureDir(path.dirname(to));
      fs.copyFileSync(from, to);
    }
  }
  return dest;
}

/** 目录内全部文件（相对路径 + 绝对路径 + sha256 + 字节数），用于 .agy-install.json。 */
export function walkFiles(dir, { skip = COPY_SKIP } = {}) {
  const out = [];
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(full);
        out.push({
          path: path.relative(dir, full).split(path.sep).join('/'),
          absolute: full,
          bytes: bytes.length,
          sha256: sha256(bytes),
        });
      }
    }
  };
  walk(dir);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** 只读、无副作用：判断文件是否可写（Windows 上 ACL 只读也算）。 */
export function isWritable(p) {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
