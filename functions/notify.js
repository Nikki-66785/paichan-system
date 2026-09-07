// v2.20.0 主通知端点（钉钉@需求方）
// POST /notify
// Body: { action, batchId, reqId, project, type, line, start, end, status, batchNo, requesterEmail, requesterName, reqEmail, dueDate, priority, note, atMobiles, ts }
// Auth: Authorization: Bearer <MAIL_HOOK_SECRET>  ← 用户在 CF Pages Dashboard Secrets 配置
//
// v2.20.3 变更：new_req 后端兜底强制@生产计划（手机号 18918901089）——用户的刚性规则。
//   原因：@逻辑原在 mail.js 前端（new_req 注入 atMobiles），但浏览器若缓存旧版 mail.js（?v=2200，
//   走 lookupPhone 动态查需求方手机号，查不到即不带 atMobiles），提交的新需求卡片就不会@。
//   现在后端在 action==='new_req' 时无条件覆盖 body.atMobiles=['18918901089']，保证必定@生产计划，
//   与前端版本无关（前端新版注入同样的值，无冲突）。
//
// v2.20.2 变更：所有 toLocaleString 加 timeZone:'Asia/Shanghai'——CF Workers 默认 UTC，
//   此前触发时间/窗口显示成 UTC（如北京时间 09:08 显示成 01:08）。
//
// v2.20.1 修复浏览器直连：加 CORS 头 + onRequestOptions 预检 + Origin 白名单鉴权
//   （v2.19.0 起前端 mail.js 跨域直连本端点，但 ①未带 Bearer→401 ②OPTIONS 预检 405，
//    浏览器触发的通知从未通过；冒烟脚本带 Bearer 直连掩盖了该问题）
//   鉴权：Bearer <MAIL_HOOK_SECRET>（脚本路径）或 Origin ∈ 白名单（浏览器路径）二选一
//
// v2.20.0 变更：不再@全员，改@需求方本人——payload 带 atMobiles（前端 CloudBase queryUser 查的手机号）时
//   at:{atMobiles,isAtAll:false}，卡片末尾追加 @手机号 文本（钉钉高亮要求）；无 atMobiles → 不@，消息照发。
//   KV entry 存 atMobiles 供 flush 合并汇总时 @。旧 @全员开关（AT_ALL env）不再生效。
//
// v2.19.3 变更：卡片每行一个字段（列表美化）、去「来源」落款；新需求去优先级/备注；批次变动去批次行/优先级/备注/来源
//
// v2.19.2 变更：action=new_req 不走合并窗，直接立即发（新需求时效性强）
//
// v2.19.1 行为：1h 合并窗（需 CF Pages → Functions → KV bindings 绑定命名空间 MAIL_KV）
//   - KV 缺失：退回 v2.19.0 行为（立即发，不报错）
//   - KV 命中 + 窗口内：append events，不发（前端 1h 后调 /api/notify-flush 汇总）
//   - KV 命中 + 窗口外：先 flush 老的，再 append 本次
//   - 写 KV 配 expirationTtl=7200（2h 安全网）
//
// 前端配套：mail.js 在首次埋点时 setTimeout 1h → POST /api/notify-flush
// flush 端点详见 functions/notify-flush.js

// v2.20.1：跨域支持——允许前端（GitHub Pages）直连
const ALLOWED_ORIGINS = ['https://nikki-66785.github.io'];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// v2.20.1：Bearer（脚本）或 Origin 白名单（浏览器）任一通过即放行
function isAuthed(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (env.MAIL_HOOK_SECRET && auth === 'Bearer ' + env.MAIL_HOOK_SECRET) return true;
  const origin = request.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.indexOf(origin) !== -1;
}

export async function onRequestPost({ request, env }) {
  // 1. auth
  if (!isAuthed(request, env)) {
    return jsonResp({ error: 'unauthorized' }, 401);
  }

  // 2. parse
  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResp({ error: 'bad json' }, 400); }

  const { action } = body;
  if (!action) return jsonResp({ error: 'missing action' }, 400);

  // v2.19.2：新需求立即发，不进合并窗
  if (action === 'new_req') {
    // v2.20.3：后端兜底强制@生产计划——即使前端 mail.js 因缓存跑旧版（lookupPhone 查不到手机号未带
    //   atMobiles），也保证新需求卡片必定@生产计划（用户的刚性规则）。
    body.atMobiles = ['18918901089'];
    return sendImmediate(env, body);
  }

  // 3. feature detect：MAIL_KV 未配置时退回 v2.19.0 立即发
  if (!env.MAIL_KV) {
    return sendImmediate(env, body);
  }

  // 4. 1h 合并窗
  const batchId = body.batchId || body.reqId;
  if (!batchId) return jsonResp({ error: 'missing batchId/reqId' }, 400);

  const key = 'merge:' + batchId;
  const now = Date.now();
  const WINDOW_MS = 60 * 60 * 1000;

  let entry = null;
  try {
    const raw = await env.MAIL_KV.get(key);
    if (raw) entry = JSON.parse(raw);
  } catch (e) {
    console.warn('[notify] KV read error', String(e));
  }

  // 窗口外：先 flush 老的，再 append 本次
  if (entry && (now - entry.windowStart) >= WINDOW_MS) {
    try { await flushMerged(env, entry); } catch (e) { console.warn('[notify] flush old failed', String(e)); }
    entry = null;
  }

  if (!entry) {
    entry = {
      batchId,
      batchNo: body.batchNo || '',
      reqId: body.reqId || '',
      project: body.project || '',
      type: body.type || '',
      line: body.line || '',
      start: body.start || '',
      end: body.end || '',
      status: body.status || '',
      locked: !!body.locked,
      atMobiles: Array.isArray(body.atMobiles) ? body.atMobiles : [], // v2.20.0 @需求方
      windowStart: now,
      lastUpdate: now,
      events: []
    };
  }

  // 字段以最新一次通知为准（合并窗内覆盖）
  if (body.batchNo) entry.batchNo = body.batchNo;
  if (body.reqId) entry.reqId = body.reqId;
  if (body.project) entry.project = body.project;
  if (body.type) entry.type = body.type;
  if (body.line) entry.line = body.line;
  if (body.start) entry.start = body.start;
  if (body.end) entry.end = body.end;
  if (body.status) entry.status = body.status;
  entry.locked = !!body.locked;
  if (Array.isArray(body.atMobiles) && body.atMobiles.length) entry.atMobiles = body.atMobiles; // v2.20.0 字段以最新一次为准
  entry.lastUpdate = now;
  entry.events.push({ action: body.action, ts: now });

  // 写 KV（2h TTL 安全网）
  try {
    await env.MAIL_KV.put(key, JSON.stringify(entry), { expirationTtl: 7200 });
  } catch (e) {
    return jsonResp({ ok: false, error: 'kv put failed: ' + String(e) }, 500);
  }

  return jsonResp({
    ok: true,
    merged: true,
    batchId,
    eventCount: entry.events.length,
    windowStart: entry.windowStart,
    flushScheduledBy: 'client'
  });
}

function buildMarkdown(b) {
  // v2.19.3：新需求卡片精简（去掉优先级/备注/来源），每行一个字段
  if (b.action === 'new_req') {
    const title = `🆕 新需求 · ${b.project || b.reqId}`;
    const lines = [];
    lines.push(`## ${title}`);
    lines.push('');
    lines.push(`- **项目**：${b.project || '-'}`);
    lines.push(`- **类型**：${b.type || '-'}`);
    lines.push(`- **数量**：${b.qty || '-'}`);
    if (b.dueDate) lines.push(`- **交期**：${b.dueDate}`);
    if (b.requesterName) lines.push(`- **需求人**：${b.requesterName}`);
    lines.push('');
    const ts = b.ts ? new Date(b.ts).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
    lines.push(`> 触发时间：${ts}`);
    return { title, text: lines.join('\n') };
  }

  const actionName = {
    lock: '🔒 排产锁定',
    edit: '✏️ 人工调整',
    final: '🏁 批次终态',
    delete: '🗑️ 删除批次'
  }[b.action] || b.action;

  // v2.19.3：批次变动卡片精简（去掉批次行/优先级/备注/来源），每行一个字段
  const title = `${actionName} · ${b.batchNo || b.batchId || b.reqId}`;
  const lines = [];
  lines.push(`## ${title}`);
  lines.push('');
  if (b.project) lines.push(`- **项目**：${b.project}`);
  if (b.type) lines.push(`- **类型**：${b.type}`);
  if (b.line) lines.push(`- **产线**：${b.line}`);
  if (b.start || b.end) lines.push(`- **排程**：${b.start || '-'} → ${b.end || '-'}`);
  const statusNote = b.action === 'lock' ? '（已锁定，作为已占用产能）' : b.action === 'final' ? '（已终态，不再占用产能）' : b.action === 'delete' ? '（已删除）' : '';
  lines.push(`- **状态**：${b.status || '-'}${statusNote}`);
  if (b.dueDate) lines.push(`- **交期**：${b.dueDate}`);
  if (b.requesterName) lines.push(`- **需求人**：${b.requesterName}`);
  lines.push('');
  const ts = b.ts ? new Date(b.ts).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  lines.push(`> 触发时间：${ts}`);

  return { title, text: lines.join('\n') };
}

// v2.20.0：atMobiles 非空 → 按手机号@需求方（卡片末尾追加 @手机号 文本，钉钉高亮要求）；否则不@任何人
async function sendDingtalk(env, md, atMobiles) {
  const webhook = env.DINGTALK_WEBHOOK;
  const secret = env.DINGTALK_SECRET || '';

  if (!webhook) throw new Error('DINGTALK_WEBHOOK not configured');

  let url = webhook;
  const headers = { 'Content-Type': 'application/json' };

  if (secret) {
    // 加签
    const ts = String(Date.now());
    const stringToSign = ts + '\n' + secret;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(stringToSign));
    const signB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
    const encoded = encodeURIComponent(signB64);
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}timestamp=${ts}&sign=${encoded}`;
  }

  let text = md.text;
  const at = { isAtAll: false }; // v2.20.0：不再@全员
  const phones = Array.isArray(atMobiles) ? atMobiles.filter(Boolean) : [];
  if (phones.length) {
    at.atMobiles = phones;
    text = md.text + '\n\n' + phones.map(function (p) { return '@' + p; }).join(' ');
  }

  const payload = {
    msgtype: 'markdown',
    markdown: { title: md.title, text: text },
    at: at
  };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  const txt = await res.text();
  let json; try { json = JSON.parse(txt); } catch (e) { json = { raw: txt }; }
  if (json.errcode && json.errcode !== 0) {
    throw new Error('dingtalk errcode=' + json.errcode + ' msg=' + (json.errmsg||''));
  }
  return json;
}

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders())
  });
}

// ---------- v2.19.1 helpers ----------

// 立即发：MAIL_KV 缺失时的 fallback（行为等同 v2.19.0 立即发；v2.20.0 起带 atMobiles @需求方）
async function sendImmediate(env, body) {
  const md = buildMarkdown(body);
  try {
    const res = await sendDingtalk(env, md, body.atMobiles);
    return jsonResp({ ok: true, merged: false, dingtalk: res });
  } catch (e) {
    return jsonResp({ ok: false, error: String(e) }, 500);
  }
}

// 发送合并 markdown + 删除 KV entry（幂等：entry 不存在时 delete 不报错）
async function flushMerged(env, entry) {
  const md = buildMergedMarkdown(entry);
  let result;
  try {
    result = await sendDingtalk(env, md, entry.atMobiles); // v2.20.0 合并汇总也@需求方
  } catch (e) {
    result = { err: String(e) };
  }
  try { await env.MAIL_KV.delete('merge:' + entry.batchId); } catch (_) { /* idempotent */ }
  return result;
}

// 构造合并窗的 markdown 卡片
function buildMergedMarkdown(entry) {
  const span = Math.max(0, entry.lastUpdate - entry.windowStart);
  const minutes = Math.max(1, Math.round(span / 60000));
  const actionName = {
    lock: '🔒 排产锁定',
    edit: '✏️ 人工调整',
    final: '🏁 批次终态',
    delete: '🗑️ 删除批次'
  };
  const lines = [];
  const title = `📋 批次汇总 · ${entry.batchNo || entry.batchId}（${entry.events.length} 次变动）`;
  lines.push(`## ${title}`);
  lines.push('');
  if (entry.batchNo) lines.push(`- **批次**：${entry.batchNo}`);
  if (entry.reqId) lines.push(`- **需求**：${entry.reqId}`);
  if (entry.project) lines.push(`- **项目**：${entry.project}`);
  if (entry.type) lines.push(`- **类型**：${entry.type}`);
  if (entry.line) lines.push(`- **产线**：${entry.line}`);
  if (entry.start || entry.end) lines.push(`- **排程**：${entry.start || '-'} → ${entry.end || '-'}`);
  const statusSuffix = entry.locked ? '（已锁定，作为已占用产能）' : '';
  lines.push(`- **当前状态**：${entry.status || '-'}${statusSuffix}`);
  lines.push('');
  lines.push(`### 📜 变动记录（共 ${entry.events.length} 次，跨越 ${minutes} 分钟）`);
  lines.push('');
  for (const ev of entry.events) {
    const ts = new Date(ev.ts).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
    const an = actionName[ev.action] || ev.action;
    lines.push(`- ${an} · ${ts}`);
  }
  lines.push('');
  const wStart = new Date(entry.windowStart).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  const wEnd = new Date(entry.lastUpdate).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  lines.push(`> 窗口：${wStart} → ${wEnd}`);
  return { title, text: lines.join('\n') };
}
