/**
 * agy-purge — 本地面板（dock）
 *
 * dsh-purge 的招牌是会话旁的 dock；Antigravity 没有给第三方任意 UI 的入口，
 * 所以这里起一个只监听回环地址的小 HTTP 面板：`agy-purge serve`。
 * 零依赖、带 CSRF 令牌、POST 才写盘。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { buildContext, applyAll, revertAll } from './install.mjs';
import { collectStatus, renderStatus } from './report.mjs';
import { readLayers } from './install.mjs';
import { savePrompt, promptStats } from './prompt.mjs';
import { runDoctor, renderDoctor } from './doctor.mjs';
import { LAYERS, writeRuntimeConfig } from './patches.mjs';

const TOKEN = crypto.randomBytes(16).toString('hex');

function json(res, status, body) {
  const text = JSON.stringify(body ?? {});
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function page(ctx) {
  const status = collectStatus(ctx);
  const layers = status.layersState;
  const promptFileInfo = status.prompt;
  const promptText = readPromptText(ctx);
  const promptMeta = promptStats(promptText);
  const layerCards = Object.entries(LAYERS)
    .map(
      ([id, meta]) => `
      <label class="layer ${layers[id] !== false ? 'on' : 'off'}" data-layer="${id}">
        <input type="checkbox" ${layers[id] !== false ? 'checked' : ''} onchange="toggleLayer('${id}', this.checked)">
        <div><strong>${meta.title}</strong><span>${meta.desc}</span></div>
      </label>`,
    )
    .join('');
  const itemRows = status.items
    .map((i) => `<tr class="s-${i.state}"><td class="glyph">${{ applied: '✓', pending: '○', drift: '!', conflict: '✗', skipped: '·' }[i.state] || '?'}</td><td>${i.id}</td><td>${escapeHtml(i.detail)}</td></tr>`)
    .join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>agy-purge</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--line:#262b36;--text:#e6e9ef;--dim:#8b93a7;--ok:#3ddc97;--warn:#ffb454;--bad:#ff6b6b;--accent:#6ba8ff}
  @media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--card:#fff;--line:#e2e5ea;--text:#1c2027;--dim:#667085}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Noto Sans SC",sans-serif}
  header{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;gap:14px;align-items:baseline}
  h1{font-size:16px;margin:0;letter-spacing:.3px}h1 span{color:var(--accent)}
  .meta{color:var(--dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  main{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;padding:18px 22px 40px}
  @media (max-width:900px){main{grid-template-columns:1fr}}
  section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  section h2{font-size:13px;margin:0 0 12px;color:var(--dim);font-weight:600;letter-spacing:.4px;text-transform:uppercase}
  .layer{display:flex;gap:10px;align-items:flex-start;padding:9px 10px;border:1px solid var(--line);border-radius:9px;margin-bottom:8px;cursor:pointer}
  .layer.on{border-color:oklch(0.72 0.15 155 / .45)}
  .layer input{margin-top:3px}.layer strong{display:block;font-size:13px}.layer span{display:block;color:var(--dim);font-size:12px}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  td.glyph{width:18px;text-align:center;font-weight:700}
  tr.s-applied td.glyph{color:var(--ok)}tr.s-pending td.glyph,tr.s-drift td.glyph{color:var(--warn)}tr.s-conflict td.glyph{color:var(--bad)}tr.s-skipped td.glyph{color:var(--dim)}
  textarea{width:100%;min-height:220px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:9px;padding:10px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;resize:vertical}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}
  button{background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:7px 12px;font-size:12.5px;cursor:pointer}
  button:hover{border-color:var(--accent)}button.primary{background:color-mix(in oklab,var(--accent) 22%,var(--card));border-color:color-mix(in oklab,var(--accent) 55%,var(--line))}
  pre{white-space:pre-wrap;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;color:var(--dim);margin:0;max-height:260px;overflow:auto}
  .pill{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:2px 8px}
  .warn{color:var(--warn);font-size:12px;margin:6px 0}
</style></head>
<body>
<header>
  <h1>agy-purge <span>破甲层</span></h1>
  <div class="meta">${escapeHtml(status.context.installDir)}</div>
  <div class="pill">${status.prompt.source} · ${promptFileInfo.chars} 字符</div>
</header>
<main>
  <section>
    <h2>破甲层</h2>
    ${layerCards}
    <div class="row">
      <button class="primary" onclick="act('/api/apply')">Apply</button>
      <button onclick="act('/api/revert')">Revert</button>
      <button onclick="act('/api/doctor')">体检</button>
    </div>
    <div id="msg"></div>
  </section>
  <section>
    <h2>补丁项</h2>
    <table>${itemRows}</table>
    ${status.warnings.map((w) => `<div class="warn">! ${escapeHtml(w)}</div>`).join('')}
  </section>
  <section>
    <h2>覆盖稿 · ${escapeHtml(String(status.prompt.file || ''))}</h2>
    <textarea id="prompt">${escapeHtml(promptText)}</textarea>
    <div class="row">
      <button class="primary" onclick="savePrompt()">保存</button>
      <span class="meta" id="pstat">${promptMeta.chars} 字符 · ${promptMeta.sha256.slice(0, 12)}</span>
    </div>
  </section>
  <section>
    <h2>输出</h2>
    <pre id="out">${escapeHtml(renderStatus(status, { color: false }))}</pre>
  </section>
</main>
<script>
const TOKEN = ${JSON.stringify(TOKEN)};
async function poster(url, body){
  const r = await fetch(url, {method:'POST', headers:{'content-type':'application/json','x-agy-token':TOKEN}, body: JSON.stringify(body||{})});
  return r.json();
}
async function refresh(){
  const s = await (await fetch('/api/status', {headers:{'x-agy-token':TOKEN}})).json();
  document.getElementById('out').textContent = s.text || '';
}
async function act(url){
  const box = document.getElementById('msg');
  box.textContent = '执行中…';
  const r = await poster(url, {});
  box.textContent = (r.lines || []).join('\\n');
  await refresh();
  location.reload();
}
async function toggleLayer(id, on){
  await poster('/api/layers', {layers:{[id]: on}});
  await refresh();
  location.reload();
}
async function savePrompt(){
  const text = document.getElementById('prompt').value;
  const r = await poster('/api/prompt', {text});
  document.getElementById('pstat').textContent = r.chars + ' 字符 · ' + String(r.sha256 || '').slice(0,12);
}
</script>
</body></html>`;
}

function readPromptText(ctx) {
  try {
    const { prompt } = collectStatus(ctx);
    return prompt.file ? fs.readFileSync(prompt.file, 'utf8') : '';
  } catch {
    return '';
  }
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function startServer(options = {}) {
  const port = Number(options.port) || 7878;
  const host = options.host || '127.0.0.1';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    const ctx = buildContext(options);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page(ctx));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const status = collectStatus(ctx);
      json(res, 200, { ...status, text: renderStatus(status, { color: false }) });
      return;
    }
    if (url.pathname === '/api/shutdown' && req.method === 'POST') {
      json(res, 200, { ok: true });
      server.close(() => process.exit(0));
      return;
    }
    if (req.method !== 'POST') {
      json(res, 404, { error: 'not found' });
      return;
    }
    if (req.headers['x-agy-token'] !== TOKEN) {
      json(res, 403, { error: 'bad token' });
      return;
    }
    const body = await readBody(req);

    if (url.pathname === '/api/apply') {
      const results = applyAll(ctx);
      json(res, 200, { ok: true, results, lines: results.map((r) => `${r.changed ? '✓' : '·'} ${r.id} ${r.detail}`) });
      return;
    }
    if (url.pathname === '/api/revert') {
      const results = revertAll(ctx);
      json(res, 200, { ok: true, results, lines: results.map((r) => `${r.changed ? '✓' : '·'} ${r.id} ${r.detail}`) });
      return;
    }
    if (url.pathname === '/api/layers') {
      const patch = body?.layers || {};
      writeRuntimeConfig(ctx.dataDir, { layers: { ...readLayers(ctx.dataDir), ...patch } });
      const results = applyAll(ctx, { items: ['plugin:hooks', 'runtime:config'] });
      json(res, 200, { ok: true, results, lines: results.map((r) => `${r.changed ? '✓' : '·'} ${r.id} ${r.detail}`) });
      return;
    }
    if (url.pathname === '/api/prompt') {
      const text = String(body?.text || '');
      const file = savePrompt(ctx.dataDir, text, { variant: body?.variant || null });
      json(res, 200, { ok: true, file, ...promptStats(text) });
      return;
    }
    if (url.pathname === '/api/doctor') {
      const report = runDoctor(ctx, { selfTest: true });
      json(res, 200, { ok: report.ok, failed: report.failed, warned: report.warned, checks: report.checks, lines: renderDoctor(report, { color: false }).split('\n') });
      return;
    }
    json(res, 404, { error: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({ server, port, host, url: `http://${host}:${port}/`, token: TOKEN });
    });
  });
}
