// v2.19.1 合并窗 flush 端点
// POST /api/notify-flush
// Body: { batchId }
// Auth: Authorization: Bearer <MAIL_HOOK_SECRET>
//
// 由前端 mail.js 在 1h 合并窗到期时调用：
//   setTimeout(() => fetch('/api/notify-flush', { method:'POST', body:{batchId} }), 3600000)
//
// 行为：
//   - KV 中存在 merge:<batchId>：构造合并 markdown → 发钉钉 → 删除 entry → 返回 {ok, eventCount}
//   - KV 中不存在：返回 {ok, noop: true}（幂等，不报错）
//   - MAIL_KV 未绑定：返回 {error: 'kv not configured'} 400（前端应自行降级）
//
// 安全：
//   - delete 不存在的 key 不会报错
//   - 多 tab / 重复 flush 安全

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

  const { batchId } = body;
  if (!batchId) return jsonResp({ error: 'missing batchId' }, 400);

  if (!env.MAIL_KV) return jsonResp({ error: 'kv not configured' }, 400);

  const key = 'merge:' + batchId;

  // 3. 读 entry
  let entry = null;
  try {
    const raw = await env.MAIL_KV.get(key);
    if (raw) entry = JSON.parse(raw);
  } catch (e) {
    return jsonResp({ ok: false, error: 'kv read failed: ' + String(e) }, 500);
  }

  if (!entry) {
    return jsonResp({ ok: true, noop: true, batchId });
  }

  // 4. 发 + 删
  const md = buildMergedMarkdown(entry);
  let dingtalk;
  try {
    dingtalk = await sendDingtalk(env, md);
  } catch (e) {
    // 发失败也要删（避免卡住后续 flush），但返回错误
    try { await env.MAIL_KV.delete(key); } catch (_) {}
    return jsonResp({ ok: false, error: String(e), batchId, eventCount: entry.events.length }, 500);
  }

  try { await env.MAIL_KV.delete(key); } catch (_) { /* idempotent */ }

  return jsonResp({ ok: true, batchId, eventCount: entry.events.length, dingtalk });
}

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

async function sendDingtalk(env, md) {
  const webhook = env.DINGTALK_WEBHOOK;
  const secret = env.DINGTALK_SECRET || '';
  const atAll = env.DINGTALK_AT_ALL === 'true';

  if (!webhook) throw new Error('DINGTALK_WEBHOOK not configured');

  let url = webhook;
  const headers = { 'Content-Type': 'application/json' };

  if (secret) {
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
