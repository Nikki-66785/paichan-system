// v2.19.1 钉钉通知模块（前端埋点层 + 1h 合并窗调度器）
// 用法：await mail.notify(action, payloadObj)
//
// v2.19.1 行为：1h 合并窗（同 batchId 1h 内多次变动合并成一封钉钉消息）
//   - 每次 notify() → POST /api/notify → 后台写 KV（merge:<batchId>）
//   - 首次 notify 时本地 setTimeout 1h → POST /api/notify-flush（后台发汇总）
//   - localStorage (pcn_pending_flushes) 持久化未到期调度，页面重载后恢复
//   - 已过期的项页面加载时立即 flush 兜底
//   - 若 CF Pages 未绑定 MAIL_KV：服务端退回 v2.19.0 立即发，前端仍调度但 flush 端点会返回 noop
//
// 触发源头 / 邮件类型约定：
//   lock     → lockPlan() / confirmBatch(id)        — 「排产锁定」通知
//   edit     → saveEdit() 普通分支                   — 「人工调整」通知
//   final    → saveEdit() 终态分支                   — 「批次终态」通知
//   delete   → delBatch / delBatchDirect / delBatchesSelected — 「删除批次」通知
//   new_req  → addReq()                              — 「新需求」通知（合并键=reqId）
//   hist     → btnReimportHist 点击                  — 「历史计划已导入」摘要（不走合并窗，走 /api/notify-hist）
//
// 收件人：当前所有触发都发到钉钉群全员（同群内包含生产计划组 + 需求方）
//
// 失败兜底：若 mail.js 抛错，仅 console.warn，不影响页面写操作

(function () {
  var CF_WORKER_BASE = 'https://排产通知.pages.dev'; // 用户部署 Pages 后可改成实际域名
  var NOTIFY_URL = CF_WORKER_BASE + '/api/notify';
  var NOTIFY_HIST_URL = CF_WORKER_BASE + '/api/notify-hist';
  var FLUSH_URL = CF_WORKER_BASE + '/api/notify-flush';
  var FLUSH_MS = 60 * 60 * 1000; // 1h
  var STORAGE_KEY = 'pcn_pending_flushes';
  var pendingFlushes = {}; // batchId -> expiryTs
  var schedulerReady = false;

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
      // new_req 也走合并窗（合并键=reqId）
      scheduleFlush(data.reqId);
    } else if(action === 'hist'){
      data = Object.assign({ action:'hist', ts: Date.now() }, payloadObj||{});
      return post(NOTIFY_HIST_URL, data);
    } else {
      data = buildBatchPayload(action, payloadObj);
      scheduleFlush(data.batchId);
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

  // ---------- v2.19.1 合并窗调度器 ----------

  // 调度一个 batchId 的 1h 后 flush（仅首次启动，已有调度则跳过）
  function scheduleFlush(batchId) {
    if (!batchId) return;
    if (pendingFlushes[batchId]) return; // 已有调度
    var expiry = Date.now() + FLUSH_MS;
    pendingFlushes[batchId] = expiry;
    savePendingFlushes();
    setTimeout(function () { executeFlush(batchId); }, FLUSH_MS);
  }

  // 真正调 flush 端点 + 清掉本地记录
  function executeFlush(batchId) {
    delete pendingFlushes[batchId];
    savePendingFlushes();
    try {
      return fetch(FLUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: batchId })
      }).then(function (res) {
        if (!res.ok) {
          console.warn('[mail] flush failed', res.status, batchId);
          return { ok: false, status: res.status };
        }
        return res.json().catch(function () { return { ok: true }; });
      }).catch(function (err) {
        console.warn('[mail] flush error', err, batchId);
        return { ok: false, error: String(err) };
      });
    } catch (e) {
      console.warn('[mail] flush sync throw', e);
      return Promise.resolve({ ok: false, error: String(e) });
    }
  }

  function savePendingFlushes() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pendingFlushes));
    } catch (e) { /* localStorage 不可用时静默 */ }
  }

  function loadPendingFlushes() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return {};
      return data;
    } catch (e) {
      return {};
    }
  }

  // 页面加载时恢复调度：已过期立即 flush，未过期重新 setTimeout
  function bootstrapFlusher() {
    if (schedulerReady) return;
    schedulerReady = true;
    var saved = loadPendingFlushes();
    var now = Date.now();
    Object.keys(saved).forEach(function (batchId) {
      var expiry = saved[batchId];
      if (typeof expiry !== 'number' || expiry <= 0) return;
      if (expiry <= now) {
        executeFlush(batchId);
      } else {
        pendingFlushes[batchId] = expiry;
        setTimeout(function () { executeFlush(batchId); }, expiry - now);
      }
    });
  }

  window.mail = { notify: notify };

  // DOM 就绪后启动调度器（已就绪则立即跑）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapFlusher);
  } else {
    bootstrapFlusher();
  }
})();

