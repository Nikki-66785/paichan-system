// v2.19.0 主通知端点
// POST /api/notify
// Body: { action, batchId, reqId, project, type, line, start, end, status, batchNo, requesterEmail, requesterName, dueDate, priority, note, ts }
// Auth: Authorization: Bearer <MAIL_HOOK_SECRET>  ← 用户在 CF Pages Dashboard Secrets 配置

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

  // 3. build markdown
  const md = buildMarkdown(body);

  // 4. send to dingtalk
  try {
    const res = await sendDingtalk(env, md);
    return jsonResp({ ok: true, dingtalk: res });
  } catch (e) {
    return jsonResp({ ok: false, error: String(e) }, 500);
  }
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
  lines.push(`> 触发时间：${ts} · 来自临床生产智能排产系统 v2.19.0`);

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
