// v2.19.0 钉钉通知模块（前端埋点层）
// 用法：await mail.notify(action, payloadObj)
//
// v2.19.0 范围：提交即发（action 到 CF Pages Functions /api/notify 立即转发钉钉 webhook）
//   - 1h 合并窗（多设备同步）推迟到 v2.19.1 迭代，用 GitHub Actions cron 扫 KV
//   - 当前行为：6 路径下任一埋点触发 → 钉钉群立刻收到一条 markdown 卡片
//
// 触发源头 / 邮件类型约定：
//   lock     → lockPlan() / confirmBatch(id)        — 「排产锁定」通知
//   edit     → saveEdit() 普通分支                   — 「人工调整」通知
//   final    → saveEdit() 终态分支                   — 「批次终态」通知
//   delete   → delBatch / delBatchDirect / delBatchesSelected — 「删除批次」通知
//   new_req  → addReq()                              — 「新需求」通知
//   hist     → btnReimportHist 点击                  — 「历史计划已导入」摘要（不走 /api/notify，走 /api/notify-hist）
//
// 收件人：当前所有触发都发到钉钉群全员（同群内包含生产计划组 + 需求方）
//
// 失败兜底：若 mail.js 抛错，仅 console.warn，不影响页面写操作

(function () {
  var CF_WORKER_BASE = 'https://排产通知.pages.dev'; // 用户部署 Pages 后可改成实际域名
  var NOTIFY_URL = CF_WORKER_BASE + '/api/notify';
  var NOTIFY_HIST_URL = CF_WORKER_BASE + '/api/notify-hist';

  // 从 batch 抽出通知需要的核心字段
  function batchCore(b){
    if(!b) return {};
    return {
      batchId: b.id,
      batchNo: b.batchNo||'',
      project: b.project||'',
      type: b.type||'',
      line: b.line||'',
      start: b.start||'',
      end: b.end||'',
      status: b.status||'',
      locked: !!b.locked,
      reqId: b.reqId||'',
      note: b.note||''
    };
  }

  // 从 batch 查到它对应的需求
  function reqByBatchId(batchId){
    var st = typeof state !== 'undefined' ? state : (window.state || {batches:[], requirements:[]});
    var b = (st.batches || []).find(function(x){return x.id===batchId;});
    if(!b || !b.reqId) return null;
    return (st.requirements||[]).find(function(r){return r.id===b.reqId;}) || null;
  }

  // 构建单条通知 payload（lock/edit/final/delete 用）
  function buildBatchPayload(action, b){
    var core = batchCore(b);
    var r = b && b.reqId ? reqByBatchId(b.reqId) : null;
    return {
      action: action,
      batchId: core.batchId,
      reqId: core.reqId,
      project: core.project,
      type: core.type,
      line: core.line,
      start: core.start,
      end: core.end,
      status: core.status,
      locked: core.locked,
      batchNo: core.batchNo,
      requesterName: r ? (r.requester||'') : '',
      requesterEmail: r ? (r.requester||'') : '',
      dueDate: r ? (r.dueDate||'') : '',
      priority: r ? (r.priority||'') : '',
      note: core.note || (r ? (r.note||'') : ''),
      ts: Date.now()
    };
  }

  // 构建新需求 payload
  function buildReqPayload(r){
    return {
      action: 'new_req',
      reqId: r.id,
      project: r.henliusProject||r.atProject||r.otherProject||'',
      type: r.type||'',
      qty: r.qty||'',
      dueDate: r.dueDate||'',
      priority: r.priority||'',
      requesterName: r.requester||'',
      requesterEmail: r.requester||'',
      note: r.note||'',
      ts: Date.now()
    };
  }

  // 主入口
  function notify(action, payloadObj){
    var data;
    if(action === 'new_req'){
      data = buildReqPayload(payloadObj);
    } else if(action === 'hist'){
      data = Object.assign({ action:'hist', ts: Date.now() }, payloadObj||{});
      return post(NOTIFY_HIST_URL, data);
    } else {
      data = buildBatchPayload(action, payloadObj);
    }
    return post(NOTIFY_URL, data);
  }

  function post(url, body){
    // 失败兜底：绝对不影响页面写操作
    try {
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function(res){
        if(!res.ok){
          console.warn('[mail] notify failed', res.status, body.action, body.batchId||body.reqId);
          return { ok:false, status: res.status };
        }
        return res.json().catch(function(){ return { ok:true }; });
      }).catch(function(err){
        console.warn('[mail] notify error', err, body.action);
        return { ok:false, error: String(err) };
      });
    } catch(e){
      console.warn('[mail] sync throw', e);
      return Promise.resolve({ ok:false, error:String(e) });
    }
  }

  window.mail = { notify: notify };
})();

