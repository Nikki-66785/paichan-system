/* =====================================================
 * cloud.js — CloudBase 云同步层（排产系统 v2.13.0 → v2.14.0：登录用户名下发（需求人自动绑定账号）+ 账号面板（自助修改密码/退出切换）+ 角色绑定登录身份（方案A权限分层）+ 状态栏点击弹出账号面板 + 邮箱登录（安全加固方案A）+ 确认弹窗走主应用模态 + 清空/导入云端需求同步 + 操作日志上云 op_logs）
 *
 * 作用：让「需求填报」与「排产计划」在多人浏览器之间实时共享。
 *   · requests   集合：需求（每条需求一个文档，多人提交互不覆盖）
 *   · plan_state 集合：排产计划（单文档，管理员维护，大家加载）
 *   · op_logs    集合：操作审计日志（v2.11.0 起上云，v2.12.0 起附带操作者邮箱）
 * 两个集合均有实时监听（watch）：他人提交需求、调整/锁定排产，几秒内自动同步，无需刷新。
 * 未配置 envId / SDK 未加载 / 网络不可用 → 自动降级为纯本地模式（localStorage）。
 *
 * 接入步骤（详见「数据安全加固指南.md」方案A）：
 *   1. 腾讯云控制台开通 CloudBase 环境（免费额度即可）
 *   2. 环境 → 身份验证 → 开启「邮箱登录」+ 创建团队成员用户（保留匿名登录作过渡）
 *   3. 数据库 → 创建集合 requests、plan_state、op_logs → 权限规则「auth != null 可读写」
 *   4. 把环境 ID 填到 排产系统.html 顶部 window.CLOUD_CONFIG.envId
 * ===================================================== */
(function () {
  'use strict';

  var CFG = window.CLOUD_CONFIG || {};
  var REQ_COLL = 'requests';   // 需求集合
  var PLAN_COLL = 'plan_state'; // 排产计划集合
  var PLAN_ID = 'main';
  // v2.13.0 角色白名单：列表内邮箱登录 = 「生产计划」角色（可调整/锁定/删除/清空/导入）；
  // 其他邮箱/匿名 = 「需求方」角色（可填报需求、查看全部页面）。可用 CLOUD_CONFIG.planAdmins 追加。
  var PLAN_ADMINS = ['shunchao_zhang@henlius.com'].concat(CFG.planAdmins || []).map(function (s) { return String(s || '').trim().toLowerCase(); });

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

  // ---------- 连接：初始化 + 邮箱登录（v2.12.0 方案A：persistence:'local' 记住会话，刷新免登录） ----------
  var appRef = null; // 保留 app 引用供重登使用
  var authRef = null;      // auth 实例（登录/登出）
  var curEmail = '';       // 当前登录邮箱（空 = 匿名/未知），用于操作日志追溯与状态栏展示
  var adminFlag = false;   // v2.13.0：当前身份是否「生产计划」角色（邮箱白名单判定）
  var EMAIL_KEY = 'paichan_login_email'; // 本地记住登录邮箱（会话恢复时显示用）

  function rememberEmail(email) {
    curEmail = email || '';
    try {
      if (curEmail) localStorage.setItem(EMAIL_KEY, curEmail);
      else localStorage.removeItem(EMAIL_KEY);
    } catch (e) { /* 隐私模式等场景忽略 */ }
  }
  // 登录成功/会话恢复后的统一入口
  function onAuthed() {
    db = appRef.database();
    ready = true;
    // v2.13.0：角色绑定登录身份——管理员白名单邮箱=生产计划，其他/匿名=需求方
    adminFlag = PLAN_ADMINS.indexOf((curEmail || '').toLowerCase()) >= 0;
    if (curEmail) setStatus(adminFlag ? '☁️ 已连接·' + curEmail + '（生产计划）' : '☁️ 已连接·' + curEmail + '（需求方）', 'cloud-on');
    else setStatus('☁️ 已连接·匿名（需求方）', 'cloud-on'); // v2.12.1：匿名状态显式标出，提示用户可切换
    if (statusEl) statusEl.title = (curEmail ? '当前登录：' + curEmail + (adminFlag ? '（生产计划）' : '（需求方）') : '当前为匿名登录（需求方权限），建议用邮箱账号') + '。点击此处可修改密码或退出并切换账号';
    if (hook && typeof hook.setRole === 'function') {
      try { hook.setRole(adminFlag); } catch (e) { console.warn('[cloud] setRole 回调异常：', e); }
    }
    // v2.14.0：登录用户名下发（邮箱前缀，小写归一与角色判定一致）——主文件据此把「需求人」自动绑定为当前账号，无需人工填写
    if (hook && typeof hook.setUser === 'function') {
      try { hook.setUser(curEmail ? curEmail.toLowerCase().split('@')[0] : ''); } catch (e) { console.warn('[cloud] setUser 回调异常：', e); }
    }
    toast('☁️ 已连接云端，需求实时共享');
    syncDown();
  }
  // v2.13.0：当前登录身份是否为「生产计划」角色。
  // 本地模式（未配置云）与连接建立前的启动瞬间不拦截，保持离线单机全功能；
  // 连接后以登录邮箱白名单为准（防 F12 手改 state.role 绕过 UI）。
  function isPlanAdmin() {
    if (!enabled()) return true;
    if (!ready) return true;
    return adminFlag;
  }
  // 登录框（v2.12.0 方案A）：邮箱+密码；匿名登录保留为过渡降级路径
  function showLogin(tip) {
    if (document.getElementById('loginOverlay')) { // 已在登录页
      var tipEl2 = document.getElementById('loginTip');
      if (tipEl2 && tip) tipEl2.textContent = tip;
      return;
    }
    var ov = document.createElement('div');
    ov.id = 'loginOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:300;display:flex;align-items:center;justify-content:center;font-family:inherit';
    ov.innerHTML =
      '<div style="background:#fff;border-radius:12px;padding:22px;width:min(360px,92vw);box-shadow:0 12px 40px rgba(0,0,0,.18)">' +
        '<div style="font-size:16px;font-weight:600;color:#0f172a;margin-bottom:4px">☁️ 云端同步登录</div>' +
        '<div id="loginTip" style="font-size:12px;color:#64748b;margin-bottom:14px">' + (tip || '请使用管理员分配的邮箱账号登录') + '</div>' +
        '<input id="loginEmail" type="email" placeholder="邮箱" autocomplete="username" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;margin-bottom:10px;outline:none">' +
        '<input id="loginPwd" type="password" placeholder="密码" autocomplete="current-password" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;margin-bottom:6px;outline:none">' +
        '<div id="loginErr" style="font-size:12px;color:#dc2626;min-height:16px;margin-bottom:8px"></div>' +
        '<button id="loginOk" style="width:100%;padding:10px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer">登 录</button>' +
        '<button id="loginAnon" style="width:100%;margin-top:8px;padding:8px;border:none;border-radius:8px;background:#f1f5f9;color:#475569;font-size:13px;cursor:pointer">暂不登录，匿名继续（过渡期）</button>' +
      '</div>';
    document.body.appendChild(ov);
    var emailEl = document.getElementById('loginEmail'),
        pwdEl = document.getElementById('loginPwd'),
        errEl = document.getElementById('loginErr'),
        okBtn = document.getElementById('loginOk');
    try { emailEl.value = localStorage.getItem(EMAIL_KEY) || ''; } catch (e) { /* 忽略 */ }
    setTimeout(function () { (emailEl.value ? pwdEl : emailEl).focus(); }, 50);
    function err(msg) { errEl.textContent = msg || '登录失败，请检查邮箱和密码'; okBtn.disabled = false; okBtn.textContent = '登 录'; }
    function doLogin() {
      var email = (emailEl.value || '').trim(), pwd = pwdEl.value || '';
      if (!email || email.indexOf('@') < 0) { err('请输入有效邮箱'); return; }
      if (!pwd) { err('请输入密码'); return; }
      okBtn.disabled = true; okBtn.textContent = '登录中…'; errEl.textContent = '';
      authRef.signInWithEmailAndPassword(email, pwd)
        .then(function () {
          rememberEmail(email);
          ov.remove();
          onAuthed();
        })
        .catch(function (e) {
          console.warn('[cloud] 邮箱登录失败：', e);
          var c = (e && e.code) || '';
          if (/invalid-email|INVALID_EMAIL/i.test(c)) err('邮箱格式不正确');
          else if (/user-not-found|USER_NOT_FOUND|no user/i.test(c)) err('账号不存在，请联系管理员创建');
          else if (/wrong-password|invalid-password|WRONG_PASS|INVALID_PASS/i.test(c)) err('密码错误');
          else if (/too-many|TOO_MANY/i.test(c)) err('尝试次数过多，请稍后再试');
          else err('登录失败：' + shortErr(e));
        });
    }
    okBtn.addEventListener('click', doLogin);
    [emailEl, pwdEl].forEach(function (el) {
      el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doLogin(); });
    });
    document.getElementById('loginAnon').addEventListener('click', function () {
      okBtn.disabled = true; errEl.textContent = '';
      authRef.anonymousAuthProvider().signIn()
        .then(function () {
          rememberEmail('');
          ov.remove();
          onAuthed(); // 匿名也是 auth != null，过渡期可继续读写
        })
        .catch(function (e) {
          console.warn('[cloud] 匿名登录失败：请确认控制台未关闭「匿名登录」', e);
          err('匿名登录失败：' + shortErr(e) + '（控制台可能已关闭匿名登录）');
          okBtn.disabled = false;
        });
    });
  }
  // v2.14.0：账号面板——点击状态栏弹出：已登录账号可「修改密码」或「退出切换」；匿名仅退出
  function showAccountPanel() {
    if (document.getElementById('acctOverlay')) return; // 已打开
    var ov = document.createElement('div');
    ov.id = 'acctOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:300;display:flex;align-items:center;justify-content:center;font-family:inherit';
    ov.innerHTML =
      '<div style="background:#fff;border-radius:12px;padding:22px;width:min(360px,92vw);box-shadow:0 12px 40px rgba(0,0,0,.18);text-align:center">' +
        '<div style="font-size:16px;font-weight:600;color:#0f172a;margin-bottom:4px">👤 账号管理</div>' +
        '<div style="font-size:12.5px;color:#64748b;margin-bottom:16px">' + (curEmail ? '当前登录：' + curEmail : '当前为匿名登录（需求方权限）') + '</div>' +
        (curEmail ? '<button id="acctPwd" style="width:100%;padding:10px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer;margin-bottom:8px">🔑 修改密码</button>' : '') +
        '<button id="acctLogout" style="width:100%;padding:10px;border:none;border-radius:8px;background:' + (curEmail ? '#f1f5f9;color:#475569' : '#2563eb;color:#fff') + ';font-size:14px;cursor:pointer;margin-bottom:8px">' + (curEmail ? '🚪 退出并切换账号' : '🚪 退出，改用邮箱登录') + '</button>' +
        '<button id="acctClose" style="width:100%;padding:8px;border:none;border-radius:8px;background:none;color:#94a3b8;font-size:13px;cursor:pointer">取消</button>' +
      '</div>';
    document.body.appendChild(ov);
    function close() { ov.remove(); }
    ov.addEventListener('click', function (ev) { if (ev.target === ov) close(); });
    document.getElementById('acctClose').addEventListener('click', close);
    document.getElementById('acctLogout').addEventListener('click', function () {
      close();
      uiConfirmC('退出当前账号（' + (curEmail || '匿名') + '）并重新登录？', function (ok) {
        if (ok) logout();
      });
    });
    var pwdBtn = document.getElementById('acctPwd');
    if (pwdBtn) pwdBtn.addEventListener('click', function () { close(); showPwdBox(); });
  }
  // v2.14.0：修改密码框（CloudBase auth.updatePassword(新密码, 旧密码)）
  function showPwdBox() {
    if (document.getElementById('pwdOverlay')) return;
    if (!curEmail) { toast('匿名账号无密码，请先退出改用邮箱登录'); return; }
    var ov = document.createElement('div');
    ov.id = 'pwdOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:300;display:flex;align-items:center;justify-content:center;font-family:inherit';
    ov.innerHTML =
      '<div style="background:#fff;border-radius:12px;padding:22px;width:min(360px,92vw);box-shadow:0 12px 40px rgba(0,0,0,.18)">' +
        '<div style="font-size:16px;font-weight:600;color:#0f172a;margin-bottom:4px">🔑 修改密码</div>' +
        '<div style="font-size:12px;color:#64748b;margin-bottom:14px">账号：' + curEmail + '</div>' +
        '<input id="pwdOld" type="password" placeholder="当前密码" autocomplete="current-password" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;margin-bottom:10px;outline:none">' +
        '<input id="pwdNew" type="password" placeholder="新密码（至少 8 位）" autocomplete="new-password" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;margin-bottom:10px;outline:none">' +
        '<input id="pwdNew2" type="password" placeholder="再次输入新密码" autocomplete="new-password" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;margin-bottom:6px;outline:none">' +
        '<div id="pwdErr" style="font-size:12px;color:#dc2626;min-height:16px;margin-bottom:8px"></div>' +
        '<button id="pwdOk" style="width:100%;padding:10px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer">确认修改</button>' +
        '<button id="pwdCancel" style="width:100%;margin-top:8px;padding:8px;border:none;border-radius:8px;background:none;color:#94a3b8;font-size:13px;cursor:pointer">取消</button>' +
      '</div>';
    document.body.appendChild(ov);
    var oldEl = document.getElementById('pwdOld'),
        newEl = document.getElementById('pwdNew'),
        new2El = document.getElementById('pwdNew2'),
        errEl = document.getElementById('pwdErr'),
        okBtn = document.getElementById('pwdOk');
    setTimeout(function () { oldEl.focus(); }, 50);
    function err(msg) { errEl.textContent = msg || ''; okBtn.disabled = false; okBtn.textContent = '确认修改'; }
    function close() { ov.remove(); }
    function doChange() {
      var oldPwd = oldEl.value || '', newPwd = newEl.value || '', new2 = new2El.value || '';
      if (!oldPwd) { err('请输入当前密码'); return; }
      if (!newPwd || newPwd.length < 8) { err('新密码至少 8 位'); return; }
      if (newPwd !== new2) { err('两次输入的新密码不一致'); return; }
      okBtn.disabled = true; okBtn.textContent = '提交中…'; errEl.textContent = '';
      changePwd(oldPwd, newPwd).then(function () {
        close();
        toast('✅ 密码修改成功，下次登录请使用新密码');
      }).catch(function (e) {
        console.warn('[cloud] 修改密码失败：', e);
        var c = (e && e.code) || '';
        if (/wrong-password|invalid-password|INVALID_PASS|old.?pass/i.test(c + ' ' + shortErr(e))) err('当前密码不正确');
        else if (/weak|WEAK|invalid new/i.test(c)) err('新密码强度不足，请更换更复杂的密码');
        else err('修改失败：' + shortErr(e));
      });
    }
    okBtn.addEventListener('click', doChange);
    [oldEl, newEl, new2El].forEach(function (el) {
      el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doChange(); });
    });
    document.getElementById('pwdCancel').addEventListener('click', close);
    ov.addEventListener('click', function (ev) { if (ev.target === ov) close(); });
  }
  // 修改密码（暴露到 CloudSync.changePwd 供测试）：CloudBase 签名 updatePassword(新密码, 旧密码)
  function changePwd(oldPwd, newPwd) {
    if (!authRef) return Promise.reject(new Error('未连接云端'));
    return authRef.updatePassword(newPwd, oldPwd);
  }
  function connect(h) {
    hook = h || hook;
    statusEl = document.getElementById('cloudStatus');
    // v2.12.1：点击状态栏退出/切换账号——微信/企微内嵌浏览器无 F12，
    // 被本地匿名会话「锁死」的用户（hasLoginState 命中即跳过登录框）只能靠这个 UI 入口解锁
    // v2.14.0：入口升级为「账号面板」——已登录账号可自助修改密码；匿名仍可直接退出
    if (statusEl) {
      statusEl.style.cursor = 'pointer';
      statusEl.addEventListener('click', function () {
        if (!ready) return;
        showAccountPanel();
      });
    }
    if (!enabled()) { setStatus('📴 本地模式', 'cloud-off'); return; }
    // file:// 等非 http(s) 方式打开时 Origin 不在安全域名白名单，登录必失败
    if (window.location && window.location.protocol && window.location.protocol.indexOf('http') !== 0) {
      setStatus('⚠️ 本地文件无法连云，请用线上地址访问', 'cloud-off');
      if (statusEl) statusEl.title = '云端同步需要从 https://nikki-66785.github.io/paichan-system/ 打开页面';
      return;
    }
    var app;
    // v3 SDK 根据 envId 自动路由到正确地域（网关 host 不带 region），无需硬编码 region
    try { app = appRef = window.cloudbase.init({ env: CFG.envId, region: CFG.region }); }
    catch (e) { console.warn('[cloud] init 失败：', e); setStatus('⚠️ 云端连接失败', 'cloud-off'); return; }
    // v2.12.0 方案A：邮箱登录（persistence:'local' 记住会话）；旧版匿名 persistence:'none' 已弃用
    authRef = app.auth({ persistence: 'local' });
    var st = null;
    try { st = authRef.hasLoginState(); } catch (e) { console.warn('[cloud] 会话检查异常：', e); }
    if (st && typeof st.then === 'function') { // 部分版本返回 Promise
      st.then(function (s) { s ? onAuthed() : showLogin(); }).catch(function () { showLogin(); });
    } else if (st) { // 同步返回 LoginState
      try { var u = st.user; rememberEmail((u && (u.email || (u.userInfo && u.userInfo.email) || u.username)) || (localStorage.getItem(EMAIL_KEY) || '')); } catch (e2) { /* 忽略 */ }
      onAuthed();
    } else {
      showLogin();
    }
  }
  // 退出登录（换人使用共用电脑时在浏览器控制台执行 CloudSync.logout()）
  function logout() {
    if (!authRef) return;
    try { localStorage.removeItem(EMAIL_KEY); } catch (e) { /* 忽略 */ }
    authRef.signOut().then(function () { location.reload(); }).catch(function (e) {
      console.warn('[cloud] 退出失败：', e);
      location.reload();
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
      // 凭证失效（token 过期/被改密）→ 退出登录态并重新弹出登录框（登录成功后 onAuthed 会重试 syncDown）
      if (!retriedLogin && /unauthenticated|credentials not found|401/i.test(full)) {
        retriedLogin = true;
        console.warn('[cloud] 检测到凭证失效，需重新登录');
        ready = false;
        try { authRef.signOut().catch(function () {}); } catch (e2) { /* 忽略 */ }
        rememberEmail('');
        showLogin('登录已过期或凭证失效，请重新登录');
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
  // v2.12.0 方案A：邮箱登录后自动附带 by（操作者邮箱），审计可追溯到人；匿名登录时无 by
  function pushOpLog(entry) {
    if (!ready || !entry) return;
    try {
      if (curEmail) entry.by = curEmail;
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
    connect: connect, isReady: isReady, onSaved: onSaved, logout: logout,
    isPlanAdmin: isPlanAdmin, // v2.13.0 角色查询：主文件 isPlanner() 据此强制身份
    changePwd: changePwd, // v2.14.0 自助修改密码（参数：旧密码, 新密码）
    pushReq: pushReq, delReqCloud: delReqCloud, delAllReqs: delAllReqs,
    pushPlan: pushPlan, forcePushPlan: forcePushPlan,
    pushOpLog: pushOpLog, fetchOpLogs: fetchOpLogs // v2.11.0 ㉑ 操作日志上云
  };
})();
