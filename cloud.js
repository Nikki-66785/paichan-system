/* =====================================================
 * cloud.js — CloudBase 云同步层（排产系统 v2.5 → v2.11.0：确认弹窗走主应用模态 + 清空/导入云端需求同步 + 操作日志上云 op_logs）
 *
 * 作用：让「需求填报」与「排产计划」在多人浏览器之间实时共享。
 *   · requests   集合：需求（每条需求一个文档，多人提交互不覆盖）
 *   · plan_state 集合：排产计划（单文档，管理员维护，大家加载）
 * 两个集合均有实时监听（watch）：他人提交需求、调整/锁定排产，几秒内自动同步，无需刷新。
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

  // 云端需求 → 合并 → 回调主逻辑（initial=首次同步：补传本地独有+应用计划；watch 触发时只做增量合并）
  // v2.11.0 ⑱：确认弹窗统一走主应用注入的 uiConfirm（自定义模态，兼容微信/企微内嵌浏览器）；
  // 主应用未注入（cloud.js 独立运行/旧版页面）时降级为原生 confirm 并同步回调
  function uiConfirmC(msg, cb) {
    if (hook && typeof hook.uiConfirm === 'function') { hook.uiConfirm(msg, cb); return; }
    var r = (typeof confirm === 'function') ? confirm(msg) : true;
    cb(!!r);
  }
  function applyCloudReqs(cloudReqs, cloudPlan, initial) {
    var localReqs = (hook.getReqs && hook.getReqs()) || [];

    // 需求合并：以本地顺序为基准；云端有 → 用云端版本（云端权威）；云端新增 → 追加末尾；本地独有（离线提交）→ 保留并补传云端
    var cloudById = {}, localById = {};
    cloudReqs.forEach(function (d) { if (d && d.data && d.data.id) cloudById[d.data.id] = d.data; });
    localReqs.forEach(function (r) { localById[r.id] = r; });
    var merged = localReqs.map(function (r) { return cloudById[r.id] || r; });
    var newIds = [];
    Object.keys(cloudById).forEach(function (id) {
      if (!localById[id]) { merged.push(cloudById[id]); newIds.push(id); }
    });
    var localOnly = localReqs.filter(function (r) { return !cloudById[r.id]; });

    if (hook.applyReqs) hook.applyReqs(merged);
    // 共享收尾：保存本地 + 刷新界面 + 首次同步补传（dirty 分支异步确认后也要执行，故提取为函数）
    var finishApply = function () {
      // 云端同步引发的本地保存不回传计划（内容来自云端，回传是冗余写且可能引发推送风暴）
      applyingRemotePlan = true;
      if (hook.afterSync) hook.afterSync();
      applyingRemotePlan = false;

      if (initial) {
        localOnly.forEach(function (r) { pushReq(r); });                  // 补传本地独有（幂等）
        if ((!cloudPlan || !cloudPlan.data) && hook.getPlan) pushPlan();  // 云端无计划 → 初始化
        if (localOnly.length) toast('已同步云端需求 ' + cloudReqs.length + ' 条，并补传本地新增 ' + localOnly.length + ' 条');
      } else if (newIds.length) {
        toast('📥 收到其他用户新需求 ' + newIds.length + ' 条');
        // 主逻辑弹「一键排产」提示条（不自动重排，由人确认后触发）
        if (hook.onRemoteReqs) hook.onRemoteReqs(newIds.length);
      }
    };
    // v2.10.0 本地新鲜度：首次同步时若本机有未上云的修改（上次推送失败/节流窗口内关闭页面），不静默用云端覆盖——
    // 由用户选择：「确定」保留本机版本并强制上传；「取消」放弃本机修改、使用云端版本
    if (initial && cloudPlan && cloudPlan.data && hook.isDirty && hook.isDirty()) {
      uiConfirmC('⚠️ 检测到本机有尚未同步到云端的修改（上次推送可能失败或页面提前关闭）。\n\n「确定」= 保留本机版本并上传覆盖云端\n「取消」= 放弃本机修改，使用云端版本', function (ok) {
        if (ok) {
          // 保留本机：先登记云端当前版本（避免随后的 watch 回声误判），再强制上传（用户已明确选择，跳过冲突检测）
          if (cloudPlan.updatedAt) rememberPlanVersion(cloudPlan.updatedAt);
          forcePushPlan();
        } else {
          if (hook.applyPlan) hook.applyPlan(cloudPlan.data);
          if (hook.clearDirty) hook.clearDirty();
        }
        finishApply();
      });
      return;
    }
    if (initial && hook.applyPlan && cloudPlan && cloudPlan.data) hook.applyPlan(cloudPlan.data);
    finishApply();
  }

  // 打开页面时全量拉一次
  function syncDown() {
    if (!ready || !hook) return;
    Promise.all([
      getAll(REQ_COLL),
      db.collection(PLAN_COLL).doc(PLAN_ID).get()
        .then(function (r) { return (r && r.data) || null; })
        .catch(function () { return null; })
    ]).then(function (res) {
      applyCloudReqs(res[0] || [], res[1] || null, true);
      // 登记云端计划版本：初次 watch 快照会立即推送当前文档，据此跳过（避免打开页面误报「计划已更新」）
      if (res[1] && res[1].updatedAt) rememberPlanVersion(res[1].updatedAt);
      startWatch();       // 需求实时监听
      startPlanWatch();   // 计划实时监听
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

  // ---------- 实时监听：其他人提交/修改需求，几秒内自动出现，无需刷新 ----------
  var watchHandle = null, watchTimer = null;
  function startWatch() {
    if (!ready || watchHandle) return;
    if (typeof WebSocket === 'undefined') {
      console.warn('[cloud] 当前环境不支持 WebSocket，实时同步降级为打开页面时同步');
      return;
    }
    try {
      // v3 SDK 实时回调名为 onChange（v2 是 onSnapshot，两者都传以兼容）
      // 注意：实时推送对范围条件（gt/lt 等）支持有限，这里用空条件监听集合全部文档
      watchHandle = db.collection(REQ_COLL).where({}).watch({
        onChange: function (snap) {
          if (!snap || !snap.docs) return;
          console.log('[cloud] watch 快照：云端需求 ' + snap.docs.length + ' 条');
          // 防抖 300ms：自己写入也会触发快照，避免重复合并
          clearTimeout(watchTimer);
          watchTimer = setTimeout(function () { applyCloudReqs(snap.docs, null, false); }, 300);
        },
        onSnapshot: function (snap) {
          if (!snap || !snap.docs) return;
          console.log('[cloud] watch 快照：云端需求 ' + snap.docs.length + ' 条');
          clearTimeout(watchTimer);
          watchTimer = setTimeout(function () { applyCloudReqs(snap.docs, null, false); }, 300);
        },
        onError: function (err) {
          console.warn('[cloud] 实时监听断开（刷新页面可重新同步）：', err);
          watchHandle = null;
        }
      });
    } catch (e) {
      // watch 不可用（旧浏览器/网络限制）→ 静默降级为「打开页面时同步」，不影响主流程
      console.warn('[cloud] 实时监听不可用，回退为打开页面时同步：', e);
      watchHandle = null;
    }
  }

  // ---------- 实时监听：排产计划（他人调整/锁定后，本页几秒内自动更新） ----------
  // planVersions：本会话「经手」的计划版本号（updatedAt）集合——自己推送/初次下载的都登记在册，
  //   watch 收到在册版本 → 回声，跳过（用精确匹配而非大小比较，避免不同机器时钟偏差误判）
  // applyingRemotePlan：正在应用云端同步数据（此时本地 save() 不回传云端，避免冗余写与推送风暴）
  var planWatchHandle = null, planWatchTimer = null;
  var planVersions = [], applyingRemotePlan = false;

  function rememberPlanVersion(ts) {
    if (!ts) return;
    planVersions.push(ts);
    if (planVersions.length > 20) planVersions.shift(); // 上限，防长期运行内存增长
  }

  function startPlanWatch() {
    if (!ready || planWatchHandle) return;
    if (typeof WebSocket === 'undefined') {
      console.warn('[cloud] 当前环境不支持 WebSocket，计划实时同步降级为打开页面时同步');
      return;
    }
    try {
      planWatchHandle = db.collection(PLAN_COLL).where({}).watch({
        onChange: onPlanSnap,
        onSnapshot: onPlanSnap,
        onError: function (err) {
          console.warn('[cloud] 计划实时监听断开（刷新页面可重新同步）：', err);
          planWatchHandle = null;
        }
      });
    } catch (e) {
      console.warn('[cloud] 计划实时监听不可用，回退为打开页面时同步：', e);
      planWatchHandle = null;
    }
  }
  function onPlanSnap(snap) {
    var docs = (snap && snap.docs) || [];
    var doc = null;
    docs.forEach(function (d) { if (d && d._id === PLAN_ID && d.data) doc = d; });
    if (!doc) { docs.forEach(function (d) { if (d && d.data && d.data.batches) doc = d; }); } // 兜底：取第一个含批次的文档
    if (!doc || !doc.data || !doc.data.batches) return;
    if (doc.updatedAt && planVersions.indexOf(doc.updatedAt) >= 0) return; // 自己推送/已下载的版本 → 回声，跳过
    clearTimeout(planWatchTimer);
    planWatchTimer = setTimeout(function () {
      applyingRemotePlan = true;
      rememberPlanVersion(doc.updatedAt); // 应用即登记，防止期间重复触发
      if (hook.applyPlan) hook.applyPlan(doc.data);
      if (hook.afterSync) hook.afterSync(); // 保存本地 + 重新渲染
      applyingRemotePlan = false;
      toast('📋 排产计划已更新（其他用户调整/锁定）');
    }, 300);
  }

  // ---------- 写入 ----------
  // v3 SDK 两个坑：
  // ① set() payload 不能含 _id（INVALID_PARAM 且不 reject，静默失败）
  // ② doc(id).set() 只能新建，文档已存在时报 E11000 duplicate key
  // 因此统一用 upsert：先 update，updated===0（不存在）再 set 创建
  function upsert(coll, id, payload, label) {
    return db.collection(coll).doc(id).update(payload).then(function (res) {
      if (res && res.code) { console.warn('[cloud] ' + label + '更新被拒：', res.code, res.message || ''); return false; }
      if (res && res.updated > 0) return true;
      return db.collection(coll).doc(id).set(payload).then(function (r2) {
        if (r2 && r2.code) { console.warn('[cloud] ' + label + '写入被拒：', r2.code, r2.message || ''); return false; }
        return true;
      });
    }).catch(function (e) {
      console.warn('[cloud] ' + label + '写入失败：', e);
      return false;
    });
  }
  function pushReq(r) {
    if (!ready || !r || !r.id) return;
    upsert(REQ_COLL, r.id, { data: r, updatedAt: Date.now() }, '需求');
  }
  function delReqCloud(id) {
    if (!ready || !id) return;
    db.collection(REQ_COLL).doc(id).remove()
      .catch(function (e) { console.warn('[cloud] 需求删除失败：', e); });
  }
  // v2.11.0 ⑲：清空云端全部需求文档（「清空全部数据」/「导入覆盖」时调用，防止旧需求下次打开时「复活」）
  function delAllReqs() {
    if (!ready) return;
    getAll(REQ_COLL).then(function (rows) {
      (rows || []).forEach(function (d) {
        if (d && d._id) db.collection(REQ_COLL).doc(d._id).remove()
          .catch(function (e) { console.warn('[cloud] 云端需求删除失败：', d._id, e); });
      });
    }).catch(function (e) { console.warn('[cloud] 云端需求集合读取失败（清空未完成）：', e); });
  }
  // v2.11.0 ㉑：操作审计日志上云（op_logs 集合，每条一文档；失败静默降级为仅本机记录）
  function pushOpLog(entry) {
    if (!ready || !entry) return;
    try {
      db.collection('op_logs').add({ data: entry, updatedAt: Date.now() })
        .catch(function (e) { console.warn('[cloud] 操作日志上传失败（仅本机记录）：', e); });
    } catch (e) { console.warn('[cloud] 操作日志上传异常：', e); }
  }
  function fetchOpLogs() {
    if (!ready) return Promise.resolve([]);
    return db.collection('op_logs').orderBy('updatedAt', 'desc').limit(100).get()
      .then(function (res) {
        return ((res && res.data) || []).map(function (d) { return d && d.data ? d.data : null; }).filter(Boolean);
      })
      .catch(function (e) { console.warn('[cloud] 操作日志拉取失败：', e); return []; });
  }
  function pushPlan() {
    if (!ready || !hook || !hook.getPlan) return;
    var p = hook.getPlan();
    if (!p || !p.batches) return;
    // 冲突检测（v2.9.4）：推送前先读云端当前版本，
    // 若云端存在本会话未见过、也未推送过的 updatedAt（其他用户在本地未同步期间写入了新版本），
    // 提示用户选择覆盖或改为拉取云端，避免静默 last-write-wins 互相覆盖。
    db.collection(PLAN_COLL).doc(PLAN_ID).get()
      .then(function (r) {
        var doc = (r && r.data) || null;
        if (doc && doc.updatedAt && planVersions.indexOf(doc.updatedAt) < 0) {
          uiConfirmC('⚠️ 云端存在其他用户的更新版本（本页尚未同步）。\n\n确定用本页计划覆盖云端版本？\n「取消」将改为拉取云端最新版本到本页。', function (ok) {
            if (!ok) {
              // 不覆盖：应用云端版本（本地未同步的改动将被云端版本替换，与 watch 实时同步行为一致）
              applyingRemotePlan = true;
              rememberPlanVersion(doc.updatedAt);
              if (hook.applyPlan && doc.data) hook.applyPlan(doc.data);
              if (hook.afterSync) hook.afterSync();
              applyingRemotePlan = false;
              toast('已拉取云端最新计划（本页版本未覆盖云端）');
              return;
            }
            doPushPlan(p);
          });
          return;
        }
        doPushPlan(p);
      })
      .catch(function () { doPushPlan(p); }); // 云端读取失败（权限/网络）→ 按原逻辑直接推送
  }
  // v2.10.0 体积预警：云端单文档约 1MB 上限，超 800KB 提醒清理快照（同会话只提醒一次）
  var sizeWarned = false;
  function doPushPlan(p) {
    var ts = Date.now();
    rememberPlanVersion(ts); // 登记版本，抑制自己推送触发的 watch 回声
    try {
      var sz = JSON.stringify(p).length;
      if (sz > 800 * 1024 && !sizeWarned) {
        sizeWarned = true;
        toast('⚠️ 排产数据体积约 ' + Math.round(sz / 1024) + 'KB，接近云端 1MB 上限，同步可能失败。建议在「排产分析 → 快照管理」删除旧快照');
      }
    } catch (e) { /* 体积测量失败不影响推送 */ }
    // v2.10.0 推送结果回调：成功清除本地脏标记；失败显式告知用户（不再静默吞掉，防止刷新后被云端旧版覆盖）
    upsert(PLAN_COLL, PLAN_ID, { data: p, updatedAt: ts }, '计划').then(function (ok) {
      if (ok) {
        if (hook.clearDirty) hook.clearDirty();
      } else {
        if (hook.onPushFail) hook.onPushFail();
      }
    });
  }
  // 破坏性本地操作（清空/删除快照等，用户已明确确认）需要立即云端生效：
  // ①绕过 800ms 节流——避免用户在节流窗口内刷新/关闭导致推送未执行、云端旧数据下次打开时回填；
  // ②跳过冲突检测弹窗——用户已确认的破坏性操作应直接覆盖云端，而不是因弹窗取消而半途而废。
  function forcePushPlan() {
    if (!ready || !hook || !hook.getPlan) return;
    var p = hook.getPlan();
    if (!p || !p.batches) return;
    doPushPlan(p);
  }
  // 主逻辑 save() 调用：节流推送计划（需求变更由 pushReq/delReqCloud 单独处理）
  function onSaved() {
    if (!ready) return;
    if (applyingRemotePlan) return; // 远端计划刚应用到本地，不再回传
    clearTimeout(saveTimer);
    saveTimer = setTimeout(pushPlan, 800);
  }

  window.CloudSync = {
    connect: connect, isReady: isReady, onSaved: onSaved,
    pushReq: pushReq, delReqCloud: delReqCloud, delAllReqs: delAllReqs,
    pushPlan: pushPlan, forcePushPlan: forcePushPlan,
    pushOpLog: pushOpLog, fetchOpLogs: fetchOpLogs // v2.11.0 ㉑ 操作日志上云
  };
})();
