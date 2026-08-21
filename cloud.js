/* =====================================================
 * cloud.js — CloudBase 云同步层（排产系统 v2.5）
 *
 * 作用：让「需求填报」与「排产计划」在多人浏览器之间实时共享。
 *   · requests   集合：需求（每条需求一个文档，多人提交互不覆盖）
 *   · plan_state 集合：排产计划（单文档，管理员维护，大家加载）
 * 未配置 envId / SDK 未加载 / 网络不可用 → 自动降级为纯本地模式（localStorage）。
 *
 * 接入步骤（详见「CloudBase 接入说明.md」）：
 *   1. 腾讯云控制台开通 CloudBase 环境（免费额度即可）
 *   2. 环境 → 登录授权 → 开启「匿名登录」
 *   3. 数据库 → 创建集合 requests、plan_state → 权限规则「所有用户可读，所有用户可写」
 *   4. 把环境 ID 填到 排产系统.html 顶部 window.CLOUD_CONFIG.envId
 * ===================================================== */
(function () {
  'use strict';

  var CFG = window.CLOUD_CONFIG || {};
  var REQ_COLL = 'requests';   // 需求集合
  var PLAN_COLL = 'plan_state'; // 排产计划集合
  var PLAN_ID = 'main';

  var db = null, ready = false;
  var retriedLogin = false; // 凭证缺失自动重登标志（每次会话最多一次）
  var saveTimer = null;
  var hook = null;      // 主逻辑注入的读写回调
  var statusEl = null;

  function enabled() {
    return !!(CFG.envId && typeof window.cloudbase !== 'undefined' && window.cloudbase.init);
  }
  function isReady() { return ready; }

  function toast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._h);
    toast._h = setTimeout(function () { t.classList.remove('show'); }, 3500);
  }
  function setStatus(txt, cls) {
    if (!statusEl) return;
    statusEl.textContent = txt;
    statusEl.className = cls || '';
  }
  // 提取错误关键信息（兼容多层嵌套结构），用于直接显示根因
  // maxLen：显示截断长度（默认 46，title 里传更大的值看完整错误）
  function shortErr(e, maxLen) {
    if (e == null) return '';
    maxLen = maxLen || 46;
    function pick(o, depth) {
      if (o == null) return '';
      if (typeof o === 'string') return o;
      if (typeof o === 'number' || typeof o === 'boolean') return String(o);
      if (typeof o !== 'object') return String(o);
      if (depth > 4) return stringify(o);
      // 优先检查常见错误字段（可能是对象，递归进入）
      var keys = ['errMsg', 'message', 'msg', 'error', 'err', 'details', 'detail', 'reason', 'statusText', 'data'];
      for (var i = 0; i < keys.length; i++) {
        if (o[keys[i]] != null && o[keys[i]] !== '') {
          var v = o[keys[i]];
          // data 若为数组（查询结果等）直接序列化，不深入
          if (keys[i] === 'data' && Array.isArray(v)) return stringify(o);
          var s = pick(v, depth + 1);
          if (s) return s;
        }
      }
      // 无关键字段 → 序列化对象本身（如 {code:.., msg:..}）
      return stringify(o);
    }
    function stringify(o) {
      try {
        var seen = [];
        var j = JSON.stringify(o, function (k, v) {
          if (typeof v === 'object' && v !== null) {
            if (seen.indexOf(v) >= 0) return '[Circular]';
            seen.push(v);
          }
          return v;
        });
        if (j && j !== '{}') return j;
      } catch (x) { /* 忽略 */ }
      return '[未知错误]';
    }
    var m = String(pick(e, 0)).trim();
    if (m.length > maxLen) m = m.slice(0, maxLen) + '…';
    return m;
  }

  // ---------- 连接：初始化 + 匿名登录 ----------
  var appRef = null; // 保留 app 引用供重登使用
  function reSignIn() {
    return appRef.auth({ persistence: 'none' }).anonymousAuthProvider().signIn();
  }
  function connect(h) {
    hook = h || hook;
    statusEl = document.getElementById('cloudStatus');
    if (!enabled()) { setStatus('📴 本地模式', 'cloud-off'); return; }
    // file:// 等非 http(s) 方式打开时 Origin 不在安全域名白名单，匿名登录必失败
    if (window.location && window.location.protocol && window.location.protocol.indexOf('http') !== 0) {
      setStatus('⚠️ 本地文件无法连云，请用线上地址访问', 'cloud-off');
      if (statusEl) statusEl.title = '云端同步需要从 https://nikki-66785.github.io/paichan-system/ 打开页面';
      return;
    }
    var app;
    // v3 SDK 根据 envId 自动路由到正确地域（网关 host 不带 region），无需硬编码 region
    try { app = appRef = window.cloudbase.init({ env: CFG.envId, region: CFG.region }); }
    catch (e) { console.warn('[cloud] init 失败：', e); setStatus('⚠️ 云端连接失败', 'cloud-off'); return; }
    // persistence:'none'：登录态不落 localStorage，每次刷新都全新匿名登录，
    // 避免复用已过期的本地凭证导致数据库访问返回 unauthenticated（401）
    app.auth({ persistence: 'none' }).anonymousAuthProvider().signIn()
      .then(function () {
        db = app.database();
        ready = true;
        setStatus('☁️ 已连接', 'cloud-on');
        toast('☁️ 已连接云端，需求实时共享');
        syncDown();
      })
      .catch(function (e) {
        console.warn('[cloud] 匿名登录失败：请确认控制台已开启「匿名登录」', e);
        setStatus('⚠️ 云端未连接：' + shortErr(e), 'cloud-off');
        if (statusEl) statusEl.title = '完整错误：' + shortErr(e, 300); // hover 看完整错误
      });
  }

  // ---------- 读取：分页拉取集合 ----------
  function getAll(coll) {
    var out = [], skip = 0, step = 100;
    function page() {
      return db.collection(coll).skip(skip).limit(step).get().then(function (res) {
        var rows = (res && res.data) || [];
        out = out.concat(rows);
        if (rows.length >= step) { skip += step; return page(); }
        return out;
      });
    }
    return page();
  }

  // 云端拉取 → 合并 → 回调主逻辑
  function syncDown() {
    if (!ready || !hook) return;
    Promise.all([
      getAll(REQ_COLL),
      db.collection(PLAN_COLL).doc(PLAN_ID).get()
        .then(function (r) { return (r && r.data) || null; })
        .catch(function () { return null; })
    ]).then(function (res) {
      var cloudReqs = res[0] || [];
      var cloudPlan = res[1];
      var localReqs = (hook.getReqs && hook.getReqs()) || [];

      // 需求合并：以本地顺序为基准；云端有 → 用云端版本（云端权威）；云端新增 → 追加末尾；本地独有（离线提交）→ 保留并补传云端
      var cloudById = {}, localById = {};
      cloudReqs.forEach(function (d) { if (d && d.data && d.data.id) cloudById[d.data.id] = d.data; });
      localReqs.forEach(function (r) { localById[r.id] = r; });
      var merged = localReqs.map(function (r) { return cloudById[r.id] || r; });
      Object.keys(cloudById).forEach(function (id) { if (!localById[id]) merged.push(cloudById[id]); });
      var localOnly = localReqs.filter(function (r) { return !cloudById[r.id]; });

      if (hook.applyReqs) hook.applyReqs(merged);
      if (hook.applyPlan && cloudPlan && cloudPlan.data) hook.applyPlan(cloudPlan.data);
      if (hook.afterSync) hook.afterSync();

      localOnly.forEach(function (r) { pushReq(r); });                    // 补传本地独有（幂等）
      if ((!cloudPlan || !cloudPlan.data) && hook.getPlan) pushPlan();    // 云端无计划 → 初始化
      if (localOnly.length) toast('已同步云端需求 ' + cloudReqs.length + ' 条，并补传本地新增 ' + localOnly.length + ' 条');
    }).catch(function (e) {
      var full = shortErr(e, 300);
      console.warn('[cloud] 拉取失败：', e);
      // 凭证缺失（signIn 内部失败被 SDK 吞掉等）→ 重新匿名登录后重试一次
      if (!retriedLogin && /unauthenticated|credentials not found|401/i.test(full)) {
        retriedLogin = true;
        console.warn('[cloud] 检测到凭证缺失，尝试重新匿名登录…');
        reSignIn().then(function () {
          db = appRef.database(); ready = true;
          syncDown();
        }).catch(function (e2) {
          setStatus('⚠️ 云端未连接：' + shortErr(e2), 'cloud-off');
          if (statusEl) statusEl.title = '完整错误：' + shortErr(e2, 300);
        });
        return;
      }
      setStatus('⚠️ 同步失败：' + shortErr(e), 'cloud-off');
      if (statusEl) statusEl.title = '完整错误：' + full; // hover 看完整错误
    });
  }

  // ---------- 写入 ----------
  function pushReq(r) {
    if (!ready || !r || !r.id) return;
    db.collection(REQ_COLL).doc(r.id).set({ _id: r.id, data: r, updatedAt: Date.now() })
      .catch(function (e) { console.warn('[cloud] 需求写入失败：', e); });
  }
  function delReqCloud(id) {
    if (!ready || !id) return;
    db.collection(REQ_COLL).doc(id).remove()
      .catch(function (e) { console.warn('[cloud] 需求删除失败：', e); });
  }
  function pushPlan() {
    if (!ready || !hook || !hook.getPlan) return;
    var p = hook.getPlan();
    if (!p || !p.batches) return;
    db.collection(PLAN_COLL).doc(PLAN_ID).set({ _id: PLAN_ID, data: p, updatedAt: Date.now() })
      .catch(function (e) { console.warn('[cloud] 计划写入失败：', e); });
  }
  // 主逻辑 save() 调用：节流推送计划（需求变更由 pushReq/delReqCloud 单独处理）
  function onSaved() {
    if (!ready) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(pushPlan, 800);
  }

  window.CloudSync = {
    connect: connect, isReady: isReady, onSaved: onSaved,
    pushReq: pushReq, delReqCloud: delReqCloud, pushPlan: pushPlan
  };
})();
