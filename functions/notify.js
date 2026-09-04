// v2.19.1 主通知端点（1h 合并窗）
// POST /api/notify
// Body: { action, batchId, reqId, project, type, line, start, end, status, batchNo, requesterEmail, requesterName, dueDate, priority, note, ts }
// Auth: Authorization: Bearer <MAIL_HOOK_SECRET>  ← 用户在 CF Pages Dashboard Secrets 配置
//
// v2.19.1 行为：1h 合并窗（需 CF Pages → Functions → KV bindings 绑定命名空间 MAIL_KV）
//   - KV 缺失：退回 v2.19.0 行为（立即发，不报错）
//   - KV 命中 + 窗口内：append events，不发（前端 1h 后调 /api/notify-flush 汇总）
//   - KV 命中 + 窗口外：先 flush 老的，再 append 本次
//   - 写 KV 配 expirationTtl=7200（2h 安全网）
//
// 前端配套：mail.js 在首次埋点时 setTimeout 1h → POST /api/notify-flush
// flush 端点详见 functions/notify-flush.js

export async function onRequestPost({ request, env }) {
  // 1. auth
  const auth = request.headers.get('Authorization') || '';
  const expected = 'Bearer ' + (env.MAIL_HOOK_SECRET || '');
  if (!env.MAIL_HOOK_SECRET || auth !== expected) {
    return jsonResp({ error: 'unauthorized' }, 401);
  }

  // 2. parse
  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResp({ error: 'bad json' }, 400); }

  const { action } = body;
  if (!action) return jsonResp({ error: 'missing action' }, 400);

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
  const actionName = {
    lock: '🔒 排产锁定',
    edit: '✏️ 人工调整',
    final: '🏁 批次终态',
    delete: '🗑️ 删除批次'
  }[b.action] || b.action;

  const title = `${actionName} · ${b.batchNo || b.batchId || b.reqId}`;
  const lines = [];
  lines.push(`## ${title}`);
  lines.push('');
  lines.push(`**批次**　${b.batchNo || '-'}　(${b.batchId || b.reqId || '-'})`);
  lines.push(`**项目**　${b.project || '-'}`);
  lines.push(`**类型**　${b.type || '-'}　　**产线**　${b.line || '-'}`);
  lines.push(`**排程**　${b.start || '-'} → ${b.end || '-'}`);
  lines.push(`**状态**　${b.status || '-'}${b.action === 'lock' ? '　（已锁定，作为已占用产能）' : ''}${b.action === 'final' ? '　（已终态，不再占用产能）' : ''}${b.action === 'delete' ? '　（已删除）' : ''}`);
  if (b.dueDate) lines.push(`**交期**　${b.dueDate}`);
  if (b.requesterName) lines.push(`**需求人**　${b.requesterName}`);
  if (b.priority) lines.push(`**优先级**　${b.priority}`);
  if (b.note) lines.push(`**备注**　${b.note}`);
  lines.push('');
  const ts = b.ts ? new Date(b.ts).toLocaleString('zh-CN', { hour12: false }) : new Date().toLocaleString('zh-CN', { hour12: false });
  lines.push(`> 触发时间：${ts} · 来自临床生产智能排产系统 v2.19.1`);

  return { title, text: lines.join('\n') };
}

async function sendDingtalk(env, md) {
  const webhook = env.DINGTALK_WEBHOOK;
  const secret = env.DINGTALK_SECRET || '';
  const atAll = env.DINGTALK_AT_ALL === 'true';

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

  const payload = {
    msgtype: 'markdown',
    markdown: { title: md.title, text: md.text },
    at: { isAtAll: atAll }
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
    headers: { 'Content-Type': 'application/json' }
  });
}

// ---------- v2.19.1 helpers ----------

// 立即发：MAIL_KV 缺失时的 fallback（行为等同 v2.19.0）
async function sendImmediate(env, body) {
  const md = buildMarkdown(body);
  try {
    const res = await sendDingtalk(env, md);
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
    result = await sendDingtalk(env, md);
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
  lines.push(`**批次**　${entry.batchNo || '-'}　(${entry.batchId})`);
  if (entry.reqId) lines.push(`**需求**　${entry.reqId}`);
  lines.push(`**项目**　${entry.project || '-'}`);
  lines.push(`**类型**　${entry.type || '-'}　　**产线**　${entry.line || '-'}`);
  lines.push(`**排程**　${entry.start || '-'} → ${entry.end || '-'}`);
  const statusSuffix = entry.locked ? '　（已锁定，作为已占用产能）' : '';
  lines.push(`**当前状态**　${entry.status || '-'}${statusSuffix}`);
  lines.push('');
  lines.push(`### 📜 变动记录（共 ${entry.events.length} 次，跨越 ${minutes} 分钟）`);
  lines.push('');
  for (const ev of entry.events) {
    const ts = new Date(ev.ts).toLocaleString('zh-CN', { hour12: false });
    const an = actionName[ev.action] || ev.action;
    lines.push(`- ${an} · ${ts}`);
  }
  lines.push('');
  const wStart = new Date(entry.windowStart).toLocaleString('zh-CN', { hour12: false });
  const wEnd = new Date(entry.lastUpdate).toLocaleString('zh-CN', { hour12: false });
  lines.push(`> 窗口：${wStart} → ${wEnd} · 来自临床生产智能排产系统 v2.19.1`);
  return { title, text: lines.join('\n') };
}
