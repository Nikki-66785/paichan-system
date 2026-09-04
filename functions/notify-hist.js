// v2.20.0 历史计划导入摘要端点（独立模板 + 不入合并窗 + 不@——无特定需求方）
// POST /notify-hist
// Body: { action:'hist', count, samples:[{batchNo,project,line,start,end}], ts }

export async function onRequestPost({ request, env }) {
  const auth = request.headers.get('Authorization') || '';
  const expected = 'Bearer ' + (env.MAIL_HOOK_SECRET || '');
  if (!env.MAIL_HOOK_SECRET || auth !== expected) {
    return jsonResp({ error: 'unauthorized' }, 401);
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResp({ error: 'bad json' }, 400); }

  const md = buildHistMarkdown(body);

  try {
    const res = await sendDingtalk(env, md);
    return jsonResp({ ok: true, dingtalk: res });
  } catch (e) {
    return jsonResp({ ok: false, error: String(e) }, 500);
  }
}

function buildHistMarkdown(b) {
  const count = (b.count != null) ? b.count : (b.samples ? b.samples.length : 0);
  const samples = Array.isArray(b.samples) ? b.samples : [];
  const title = `📥 历史计划已导入（${count} 条）`;
  const lines = [];
  lines.push(`## ${title}`);
  lines.push('');
  lines.push(`已从「CM排产计划历史文件」重建 **${count}** 条锁定批次（替换当前所有批次与需求）。`);
  lines.push('');
  if (samples.length) {
    lines.push('**摘要（前 10 条）：**');
    samples.slice(0, 10).forEach(function (s, i) {
      lines.push(`${i + 1}. **${s.batchNo || s.batchId || '-'}** · ${s.project || '-'} · ${s.line || '-'} · ${s.start || '-'} → ${s.end || '-'}`);
    });
    if (samples.length > 10) lines.push(`… 共 ${count} 条，详情见系统「📅 排产计划」`);
  }
  lines.push('');
  const ts = b.ts ? new Date(b.ts).toLocaleString('zh-CN', { hour12: false }) : new Date().toLocaleString('zh-CN', { hour12: false });
  lines.push(`> 触发时间：${ts}`);

  return { title, text: lines.join('\n') };
}

async function sendDingtalk(env, md) {
  const webhook = env.DINGTALK_WEBHOOK;
  const secret = env.DINGTALK_SECRET || '';
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
    at: { isAtAll: false } // v2.20.0：历史导入摘要不@任何人
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
