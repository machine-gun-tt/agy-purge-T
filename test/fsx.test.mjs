import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  backupOnce,
  copyTree,
  hasBackup,
  readJson,
  restoreBackup,
  sha256,
  walkFiles,
  writeAtomic,
  writeJson,
} from '../lib/fsx.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fsx-'));

test('writeAtomic 落盘且不留临时文件', () => {
  const dir = tmp();
  const file = path.join(dir, 'nested', 'a.txt');
  writeAtomic(file, 'hello');
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['a.txt']);
});

test('backupOnce 不会覆盖已有备份', () => {
  const dir = tmp();
  const file = path.join(dir, 'c.json');
  writeAtomic(file, 'version-1');
  backupOnce(file);
  assert.ok(hasBackup(file));
  writeAtomic(file, 'version-2');
  backupOnce(file);
  assert.equal(fs.readFileSync(`${file}.agypurge.bak`, 'utf8'), 'version-1');
  assert.equal(fs.readFileSync(file, 'utf8'), 'version-2');
});

test('restoreBackup 还原并清掉备份', () => {
  const dir = tmp();
  const file = path.join(dir, 'c.json');
  writeAtomic(file, '{"a":1}');
  backupOnce(file);
  writeAtomic(file, '{"a":2}');
  assert.equal(restoreBackup(file), true);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  assert.equal(hasBackup(file), false);
});

test('restoreBackup 无备份时返回 false', () => {
  const dir = tmp();
  const file = path.join(dir, 'none.json');
  writeAtomic(file, '{}');
  assert.equal(restoreBackup(file), false);
});

test('writeJson 稳定缩进 + 结尾换行', () => {
  const dir = tmp();
  const file = path.join(dir, 'x.json');
  writeJson(file, { b: 2, a: [1] });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "b": 2,\n  "a": [\n    1\n  ]\n}\n');
  assert.deepEqual(readJson(file), { b: 2, a: [1] });
});

test('readJson: 缺文件返回 null，坏 JSON 返回 undefined', () => {
  const dir = tmp();
  assert.equal(readJson(path.join(dir, 'missing.json')), null);
  writeAtomic(path.join(dir, 'bad.json'), '{oops');
  assert.equal(readJson(path.join(dir, 'bad.json')), undefined);
});

test('walkFiles 排序并给出 sha256', () => {
  const dir = tmp();
  writeAtomic(path.join(dir, 'b.txt'), 'b');
  writeAtomic(path.join(dir, 'a.txt'), 'a');
  writeAtomic(path.join(dir, 'sub', 'c.txt'), 'c');
  const rows = walkFiles(dir);
  assert.deepEqual(rows.map((r) => r.path), ['a.txt', 'b.txt', 'sub/c.txt']);
  assert.equal(rows[0].sha256, sha256('a'));
});

test('copyTree 跳过 .git / node_modules / test', () => {
  const src = tmp();
  writeAtomic(path.join(src, 'keep.txt'), 'k');
  writeAtomic(path.join(src, '.git', 'config'), 'x');
  writeAtomic(path.join(src, 'node_modules', 'dep.js'), 'x');
  writeAtomic(path.join(src, 'test', 'a.test.mjs'), 'x');
  const dest = path.join(tmp(), 'out');
  copyTree(src, dest);
  assert.ok(fs.existsSync(path.join(dest, 'keep.txt')));
  assert.equal(fs.existsSync(path.join(dest, '.git')), false);
  assert.equal(fs.existsSync(path.join(dest, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(dest, 'test')), false);
});
