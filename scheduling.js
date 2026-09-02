/* =========================================================
 * 生物制药排产引擎 scheduling.js
 * 纯逻辑模块，无 DOM 依赖。浏览器(window.Scheduling)与
 * Node(module.exports) 均可使用。
 * 规则依据：排产逻辑.xlsx（产线情况 / CB / Mab / ADC DS / DP）
 * 默认口径（可经 rules 参数覆盖，UI 规则页可配置）：
 *   - CB：固定周二开工，周期10天，生产间隔4天（上批完成→下批开始）
 *   - MCB→WCB：间隔1个月(30天)，按完成日算
 *   - 正式工艺转移1个月(30天)后才可开始生产
 *   - Mab(SJ1DS)：周期=种子培养20+反应器培养15+下游纯化7(默认42天，需求提报
 *         用默认，生产计划在人工干预时按项目调整)；批间开始>=8天，下罐间隔>=10天，
 *         下罐=开始+种子+反应器；同产线所有批硬约束
 *   - ADC DS：GMP Mab完成后2周、Non-GMP Mab(来源PD)完成后1个月(硬约束)；
 *         LP放行完成后才可生产；错开下罐，建议下罐后2天
 *   - DP：周期四段=准备+灌装+冻干+清场（默认水针3+1+0+1=5天、冻干3+1+3~4+1=7~8天；
 *         目检包装不计入排产周期，完成日期=生产完成；放大测试批次无包装；
 *         需二次稀配时准备+1天；各段可在人工干预时调整）；
 *         灌装日期自动=开始日期+准备天数；包装完成日期=完成日期+包装天数
 *         (dp.packDays，默认10天，规则页可调，仅正式 DP 批次)；
 *         C7CM DP 同产线清场后2天开始下一批，SJ2 ADC DP / SJ2CM DP
 *         清场后4天；ADC Non-GMP与同项目ADC DS间隔1个月、其余间隔2周；
 *         冻干需先排1批放大测试且正式批与测试批间隔2个月(从测试批完成日算)；
 *         APS 占用8天、按产线固定月份当月内任排（产线当年有生产时自动生成）
 *   - 排产方向：正排优先（最早可开工），正排找不到槽位时按交期倒排
 *         兜底；最早可排完成日晚于交期时标预警（此时已无满足交期的槽位）
 * ========================================================= */
(function (root) {
  'use strict';

  // ---------------- 日期工具 ----------------
  function p(s) {
    if (s instanceof Date) return new Date(s.getFullYear(), s.getMonth(), s.getDate());
    if (typeof s === 'string' && s) {
      var a = s.split('-').map(Number);
      return new Date(a[0], a[1] - 1, a[2]);
    }
    return null;
  }
  function f(d) {
    return d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : '';
  }
  function add(d, n) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  }
  function diff(a, b) { return Math.round((a - b) / 86400000); }
  function maxD() {
    var m = null;
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v) { v = p(v); if (!m || v > m) m = v; }
    }
    return m;
  }

  // ---------------- 默认规则参数 ----------------
  var DEFAULTS = {
    cb: { weekday: 2, cycle: 10, gap: 4 },            // 周二开始(getDay()=2)，周期10天，生产间隔4天（上批完成→下批开始）
    mcbWcbGapDays: 30,                                // MCB→WCB 间隔1个月（按完成日算）
    processTransferGapDays: 30,                       // 正式工艺转移后1个月才可生产
    mab: { seedDays: 20, reactorDays: 15, purifyDays: 7, minStartGap: 8, harvestGap: 10, harvestOffset: 35 }, // 周期=种子培养20+反应器培养15+下游纯化7(合计42)；需求提报用默认，生产计划在人工干预时按项目调整；批间开始>=8天；下罐间隔>=10天；下罐=开始+种子+反应器(默认35)（同产线所有批硬约束）
    adcDs: { harvestAfterDays: 2, gmpMabDays: 14, nonGmpMabDays: 30 }, // 下罐后2天（建议）；GMP Mab完成后2周；Non-GMP Mab(PD来源)完成后1个月
    dp: { clearGapC7: 2, clearGapSJ2: 4, diluteExtraDays: 1, packDays: 10,
          // 周期四段 = 准备 + 灌装 + 冻干 + 清场（目检包装不计入排产周期，完成日期=生产完成）
          // 包装完成日期 = DP完成日期 + packDays（默认10天，规则页可调；仅正式 DP 批次）
          segs: {
            'SJ2 ADC DP': { 水针: [3,1,0,1], 冻干: [3,1,4,1] },
            'C7CM DP':    { 水针: [3,1,0,1], 冻干: [3,1,3,1] },
            'SJ2CM DP':   { 水针: [3,1,0,1], 冻干: [3,1,4,1] }
          } }, // C7CM DP清场后2天；SJ2产线清场后4天；二次稀配准备+1天
    adcDp: { nonGmpGapDays: 30, otherGapDays: 14 },   // ADC Non-GMP间隔1个月；其余2周
    freezeDry: { testGapDays: 60 },                   // 冻干正式生产与放大测试间隔2个月
    aps: { cycle: 8, months: { 'C7CM DP': [3, 8, 12], 'SJ2 ADC DP': [3, 9], 'SJ2CM DP': [8, 10] } }
  };

  // ---------------- 产线定义 ----------------
  var LINES = {
    'SJ2 CB':     { type: 'cb',    cycle: 10,              name: 'SJ2 CB 细胞库' },
    'SJ1DS':      { type: 'mab',   cycle: 42,              name: 'SJ1DS Mab原液' },
    'SJ2DS':      { type: 'mab',   cycle: 42,              name: 'SJ2DS Mab原液' },
    'SJ2 ADC DS': { type: 'adcDs', cycle: 7,               name: 'SJ2 ADC DS' },
    'SJ2 ADC DP': { type: 'dp',    cycle: { 水针: 5, 冻干: 8 }, name: 'SJ2 ADC DP' },   // 周期不含目检包装（包装走 packDays）
    'C7CM DP':    { type: 'dp',    cycle: { 水针: 5, 冻干: 7 }, name: 'C7CM DP' },
    'SJ2CM DP':   { type: 'dp',    cycle: { 水针: 5, 冻干: 8 }, name: 'SJ2CM DP' }
  };

  function cycleOf(line, dosage) {
    var c = LINES[line].cycle;
    return typeof c === 'number' ? c : (c[dosage] || 5);
  }

  // DP 需二次稀配时，制剂准备 3天→4天，即周期 +1 天（排产逻辑.xlsx DP 规则8）
  // Mab 周期 = 种子培养 + 反应器培养 + 下游纯化（默认 20+15+7=42 天），各段可按需求覆盖（req.mabSeedDays 等）
  function mabSegs(req, R) {
    var m = (R && R.mab) || {};
    var seed = (req && req.mabSeedDays != null && req.mabSeedDays !== '') ? Number(req.mabSeedDays) : (m.seedDays != null ? m.seedDays : 20);
    var reactor = (req && req.mabReactorDays != null && req.mabReactorDays !== '') ? Number(req.mabReactorDays) : (m.reactorDays != null ? m.reactorDays : 15);
    var purify = (req && req.mabPurifyDays != null && req.mabPurifyDays !== '') ? Number(req.mabPurifyDays) : (m.purifyDays != null ? m.purifyDays : 7);
    if (!(seed > 0)) seed = 20; if (!(reactor > 0)) reactor = 15; if (!(purify > 0)) purify = 7;
    return { seed: seed, reactor: reactor, purify: purify };
  }
  // DP 周期四段 = 准备 + 灌装 + 冻干 + 清场（排产逻辑.xlsx DP 组成；目检包装不计入排产周期）
  // 默认值按产线+剂型取自 R.dp.segs；需二次稀配时准备 +diluteExtraDays 天；
  // 旧版规则/批次数据若存了第5段（目检包装）自动忽略，包装天数统一走 R.dp.packDays；
  // s.inspect 仅作信息展示（=该批次包装天数，不参与 total）；放大测试批次无包装
  function dpSegs(line, dosage, req, R, scaleTest) {
    var d = (R && R.dp) || {};
    var seg = (d.segs && d.segs[line] && d.segs[line][dosage]) || [3, 1, 0, 1];
    if (seg.length > 4) seg = seg.slice(0, 4); // 兼容旧版5段数据（第5段目检包装已迁移至 packDays）
    var s = { prep: seg[0] || 0, fill: seg[1] || 0, freeze: seg[2] || 0, clear: seg[3] || 0, inspect: 0 };
    if (req && req.secondaryDilution) s.prep += (d.diluteExtraDays != null ? d.diluteExtraDays : 1);
    if (scaleTest || (req && req.batchKind === '放大测试')) s.inspect = 0; // 放大测试无需包装
    else s.inspect = (d.packDays != null ? d.packDays : 10); // 包装天数（信息展示，体现在包装完成日期）
    s.total = s.prep + s.fill + s.freeze + s.clear;
    return s;
  }
  function cyc(line, dosage, req, R, scaleTest) {
    if (LINES[line] && LINES[line].type === 'mab') {
      var sg = mabSegs(req, R);
      return sg.seed + sg.reactor + sg.purify;
    }
    if (LINES[line] && LINES[line].type === 'dp') return dpSegs(line, dosage, req, R, scaleTest).total;
    return cycleOf(line, dosage);
  }

  function mergeRules(u) {
    var r = JSON.parse(JSON.stringify(DEFAULTS));
    if (u) {
      for (var k in u) {
        // 嵌套对象按键合并（兼容旧版只存了部分键的规则数据）
        if (u[k] && typeof u[k] === 'object' && !Array.isArray(u[k]) && r[k] && typeof r[k] === 'object') {
          for (var kk in u[k]) r[k][kk] = u[k][kk];
        }
        else r[k] = u[k];
      }
    }
    return r;
  }

  // ---------------- 排产器 ----------------
  function Scheduler(rules) {
    this.R = mergeRules(rules);
    var self = this;

    // 上下文：产线占用、同项目索引、告警
    function Ctx(existing) {
      this.occ = existing.map(function (b) { return { b: b }; });
      this.all = existing.slice();
      this.genByProject = {};
      this.warnings = [];
      this.seq = 1;
    }
    Ctx.prototype.conflicts = function (line, start, end, newType) {
      return self.conflicts(line, start, end, this, newType);
    };
    Ctx.prototype.addBatch = function (nb) {
      this.occ.push({ b: nb });
      this.all.push(nb);
      var g = this.genByProject[nb.project] || (this.genByProject[nb.project] = []);
      g.push(nb);
    };
    Ctx.prototype.findUpstream = function (project, type) {
      // 项目标识匹配：批次的项目号或 Henlius号 任一命中即可
      // （AT项目号字段已移除，新需求以 Henlius 项目号作为标识；历史批次两者皆有）
      function hit(b) { return b.type === type && (b.project === project || (b.henlius && b.henlius === project)); }
      var arr = this.genByProject[project];
      if (arr) for (var i = arr.length - 1; i >= 0; i--) if (hit(arr[i])) return arr[i];
      for (var j = this.all.length - 1; j >= 0; j--) if (hit(this.all[j])) return this.all[j];
      return null;
    };
    Ctx.prototype.warn = function (msg, type, req) {
      this.warnings.push({ msg: msg, type: type || '', reqId: req ? req.id : null });
    };
    this.Ctx = Ctx;
  }

  // 终态批次（人工标记：中止/失败/取消）不占用产能，其槽位可被后续批次复用
  var FINAL_STATUS = { '中止': 1, '失败': 1, '取消': 1 };

  // 产线冲突检查：新批次 (start,end) 与已有批次是否冲突
  // newType: 新批次类型（可选，设备维护用简单重叠而非产线间隔规则）
  Scheduler.prototype.conflicts = function (line, start, end, ctx, newType) {
    var R = this.R, lt = LINES[line] && LINES[line].type;
    if (!lt) return false; // 未知产线（如"其他"）不参与占用约束
    var isMaint = newType === '设备维护'; // 新批次为设备维护时用简单重叠
    var ls = ctx.occ.filter(function (o) { return o.b.line === line; });
    for (var i = 0; i < ls.length; i++) {
      var b = ls[i].b, bs = p(b.start), be = p(b.end);
      if (FINAL_STATUS[b.status]) continue; // 终态批次不占产能
      // 设备维护 vs 任何批次（含设备维护 vs 设备维护）：仅检查日期重叠，不要求产线间隔
      if (isMaint || b.type === '设备维护') {
        if (diff(start, be) <= 0 && diff(bs, end) <= 0) return true; // 简单重叠
        continue;
      }
      if (lt === 'cb') {
        if (diff(start, be) < R.cb.gap && diff(bs, end) < R.cb.gap) return true; // 生产间隔4天：上批完成→下批开始
      } else if (lt === 'mab') {
        if (Math.abs(diff(start, bs)) < R.mab.minStartGap) return true; // 开始间隔>=8天
        var hb = b.harvestDate ? p(b.harvestDate) : add(bs, R.mab.harvestOffset);
        if (Math.abs(diff(add(start, R.mab.harvestOffset), hb)) < R.mab.harvestGap) return true; // 下罐间隔>=10天
      } else if (lt === 'adcDs') {
        if (diff(start, be) <= 0 && diff(bs, end) <= 0) return true;    // 区间不重叠
      } else if (lt === 'dp') {
        // 产线间隔区分：C7CM DP 清场后2天；SJ2 ADC DP / SJ2CM DP 清场后4天
        var gap = line === 'C7CM DP' ? R.dp.clearGapC7 : R.dp.clearGapSJ2;
        if (diff(start, be) < gap && diff(bs, end) < gap) return true;
      }
    }
    return false;
  };

  // 最早可开工日（依赖链）
  Scheduler.prototype.earliestFor = function (req, type, ctx) {
    var R = this.R, d = null;
    if (req.processTransferDate) d = maxD(d, add(p(req.processTransferDate), R.processTransferGapDays));
    var proj = req.atProject;
    if (type === 'WCB' || type === 'Mab') {
      var mcb = ctx.findUpstream(proj, 'MCB');
      var mcbEnd = mcb ? p(mcb.end) : (req.mcbDate ? p(req.mcbDate) : null);
      if (mcbEnd) d = maxD(d, add(mcbEnd, R.mcbWcbGapDays));
      else ctx.warn('未找到同项目MCB批次（' + (proj || '?') + '），按工艺转移后1个月起排', type, req);
    }
    if (type === 'ADC DS') {
      var mab = ctx.findUpstream(proj, 'Mab');
      if (mab) {
        var hv = mab.harvestDate ? p(mab.harvestDate) : add(p(mab.start), R.mab.harvestOffset);
        // 按Mab来源区分硬约束：GMP Mab完成后>=2周；Non-GMP Mab（来源PD）完成后>=1个月；建议下罐后2天
        var mabGap = mab.gmp ? R.adcDs.gmpMabDays : R.adcDs.nonGmpMabDays;
        d = maxD(d, add(p(mab.end), mabGap), add(hv, R.adcDs.harvestAfterDays));
      } else ctx.warn('未找到同项目Mab批次（' + (proj || '?') + '），无法确定下罐依赖，按工艺转移后1个月起排', type, req);
      if (req.lpReleaseDate) d = maxD(d, p(req.lpReleaseDate)); // LP放行完成后才可生产
    }
    if (type === 'ADC DP' || type === 'CM DP') {
      var up = ctx.findUpstream(proj, type === 'ADC DP' ? 'ADC DS' : 'Mab');
      if (up) {
        d = maxD(d, add(p(up.end), 1));
        if (type === 'ADC DP') {
          var gap = req.gmp ? R.adcDp.otherGapDays : R.adcDp.nonGmpGapDays;
          d = maxD(d, add(p(up.end), gap));
        }
      } else if (req.mcbDate) {
        d = maxD(d, add(p(req.mcbDate), R.mcbWcbGapDays));
      } else ctx.warn('未找到同项目上游批次（' + (proj || '?') + '），按工艺转移后1个月起排', type, req);
    }
    return d;
  };

  // 正排：从 earliest 起找第一个可行槽位
  Scheduler.prototype.placeForward = function (line, earliest, cycle, ctx) {
    var R = this.R, s = p(earliest);
    if (LINES[line].type === 'cb') while (s.getDay() !== R.cb.weekday) s = add(s, 1);
    var guard = 0;
    while (guard++ < 4000) {
      var e = add(s, cycle - 1);
      if (!ctx.conflicts(line, s, e)) return { start: s, end: e };
      s = LINES[line].type === 'cb' ? add(s, 7) : add(s, 1);
    }
    return null;
  };

  // 倒排：从交期往前找第一个可行槽位（正排失败时兜底）
  Scheduler.prototype.placeBackward = function (line, earliest, due, cycle, ctx) {
    var R = this.R, t = add(p(due), -(cycle - 1));
    if (LINES[line].type === 'cb') while (t.getDay() !== R.cb.weekday) t = add(t, -1);
    var guard = 0;
    while (t >= p(earliest) && guard++ < 4000) {
      if (!ctx.conflicts(line, t, add(t, cycle - 1))) return { start: t, end: add(t, cycle - 1) };
      t = LINES[line].type === 'cb' ? add(t, -7) : add(t, -1);
    }
    return null;
  };

  // 单批排产：正排优先（最早可开工），正排找不到槽位时按交期倒排兜底
  Scheduler.prototype.placeBatch = function (req, type, line, dosage, due, ctx) {
    var R = this.R, cycle = cyc(line, dosage, req, R);
    var earliest = maxD(this.earliestFor(req, type, ctx) || new Date(), new Date()); // 不早于今天，避免排到过去
    var pl = this.placeForward(line, earliest, cycle, ctx);
    if (!pl) pl = this.placeBackward(line, earliest, due, cycle, ctx);
    if (!pl) { // 产线长期饱和：按最早日期强排并预警，请人工调整
      var s0 = p(earliest);
      if (LINES[line].type === 'cb') while (s0.getDay() !== R.cb.weekday) s0 = add(s0, 1);
      pl = { start: s0, end: add(s0, cycle - 1) };
      return { start: pl.start, end: pl.end, warning: '产线长期饱和，已按最早日期强排，请人工调整' };
    }
    // 正排取最早可行槽位；若其完成日已晚于交期，则不存在满足交期的槽位，标预警
    var warning = p(pl.end) > p(due) ? '交期无法满足（最早可排完成日已晚于交期）' : null;
    return { start: pl.start, end: pl.end, warning: warning };
  };

  // 主入口：排产全部需求
  // reqs: 需求数组（详见 HTML 表单字段）
  // existing: 已锁定/已存在批次（历史导入）
  // 返回 { batches: 新生成批次, warnings: 告警数组 }
  Scheduler.prototype.schedule = function (reqs, existing, startSeq) {
    var R = this.R, self = this;
    var ctx = new this.Ctx(existing || []);
    // 批次 id 从 startSeq 起递增（UI 传入当前最大 NB 编号+1，避免跨次排产 id 冲突）
    ctx.seq = startSeq || 1;
    var out = [];
    var pr = { 高: 0, 中: 1, 低: 2 };
    var sorted = (reqs || []).slice().sort(function (a, b) {
      var pa = pr[a.priority] != null ? pr[a.priority] : 1;
      var pb = pr[b.priority] != null ? pr[b.priority] : 1;
      if (pa !== pb) return pa - pb;
      return String(a.createdAt || '') < String(b.createdAt || '') ? -1 : 1;
    });

    var testGen = {}; // reqId -> 测试批

    sorted.forEach(function (req) {
      var baseType = req.type; // 'CB' | 'Mab' | 'ADC DS' | 'DP' | 'EQP'
      var dpKind = req.dpKind; // 'ADC' | 'CM'
      var dosage = req.dosage;
      var due = req.dueDate;
      var cnt = Math.max(1, parseInt(req.batchCount, 10) || 1);

      // 设备维护保养：直接按指定日期占位，无产品约束/周期/依赖
      if (baseType === 'EQP') {
        var eqpLine = req.maintLine || '其他';
        var eqpS = p(req.maintStart), eqpE = p(req.maintEnd);
        if (!eqpS || !eqpE) { ctx.warn('设备维护需求缺少日期：' + (req.note || ''), '设备维护', req); return; }
        var eqpConflict = ctx.conflicts(eqpLine, eqpS, eqpE, '设备维护'); // Ctx.prototype 内部已透传 this；勿多加 ctx 参数
        var eqpBatch = {
          id: 'NB' + (ctx.seq++), reqId: req.id, seq: 1, type: '设备维护', line: eqpLine,
          start: f(eqpS), end: f(eqpE), project: req.maintKind || '设备维护', henlius: '',
          gmp: false, priority: req.priority || '中', requester: req.requester || '',
          locked: false, status: eqpConflict ? '预警' : '自动',
          warning: eqpConflict ? '与现有批次产线冲突，请人工调整' : null,
          autoGenerated: false, note: req.note || req.maintKind || ''
        };
        ctx.addBatch(eqpBatch); out.push(eqpBatch);
        return; // 设备维护不参与后续 APS/冻干测试等逻辑
      }

      for (var n = 1; n <= cnt; n++) {
        var type, line;
        if (baseType === 'CB') { type = req.cbKind === 'WCB' ? 'WCB' : 'MCB'; line = 'SJ2 CB'; }
        else if (baseType === 'Mab') { type = 'Mab'; line = req.mabLine || 'SJ1DS'; } // v2.16.0：Mab 产线可选 SJ1/SJ2
        else if (baseType === 'ADC DS') { type = 'ADC DS'; line = 'SJ2 ADC DS'; }
        else { // DP
          type = dpKind === 'ADC' ? 'ADC DP' : 'CM DP';
          line = dpKind === 'ADC' ? 'SJ2 ADC DP' : (req.dpLine || 'C7CM DP');
        }

        // 冻干：先生成1批放大测试（同一需求只1批），正式批与测试批间隔2个月
        var testAfter = null;
        if ((type === 'ADC DP' || type === 'CM DP') && dosage === '冻干' && n === 1 && req.scaleTest !== false) {
          // 该需求已锁定的放大测试批不再重复生成
          var lockedTest = null;
          for (var lt = ctx.all.length - 1; lt >= 0; lt--) {
            if (ctx.all[lt].type === '冻干放大测试' && ctx.all[lt].reqId === req.id && ctx.all[lt].locked) { lockedTest = ctx.all[lt]; break; }
          }
          if (!testGen[req.id] && !lockedTest) {
            var tEarliest = maxD(this.earliestFor(req, type, ctx) || new Date(), new Date()); // 不早于今天
            // 同产线已有测试批完成日 +2个月
            var lastTest = null;
            for (var i = ctx.all.length - 1; i >= 0; i--) {
              var tb = ctx.all[i];
              if (tb.type === '冻干放大测试' && tb.line === line) { if (!lastTest || tb.end > lastTest.end) lastTest = tb; }
            }
            if (lastTest) tEarliest = maxD(tEarliest, add(p(lastTest.end), R.freezeDry.testGapDays));
            var tSeg = dpSegs(line, '冻干', req, R, true); // 放大测试批次不含目检包装
            var tf = this.placeForward(line, tEarliest, tSeg.total, ctx);
            if (tf) {
              var tBatch = {
                id: 'NB' + (ctx.seq++), reqId: req.id, seq: n, type: '冻干放大测试', line: line, dosage: '冻干',
                start: f(tf.start), end: f(tf.end), project: req.atProject, henlius: req.henliusProject, requester: req.requester || '',
                gmp: req.type==='CB' ? true : !!req.gmp, priority: req.priority, locked: false, status: '自动', // 细胞库建库均为 GMP 批次
                autoGenerated: true, note: '冻干放大测试（自动生成）',
                dpSegs: tSeg, // 周期四段（人工干预可调）
                fillDate: f(add(tf.start, tSeg.prep)) // 灌装日期自动=开始+准备天数
              };
              ctx.addBatch(tBatch); out.push(tBatch);
              testGen[req.id] = tBatch;
            }
          }
          if (testGen[req.id]) testAfter = p(testGen[req.id].end);
          else if (lockedTest) testAfter = p(lockedTest.end);
        }

        var pl = this.placeBatch(req, type, line, dosage, due, ctx);
        // 冻干正式批需与测试批间隔2个月
        if (testAfter && diff(pl.start, testAfter) < R.freezeDry.testGapDays) {
          var need = add(testAfter, R.freezeDry.testGapDays);
          if (need > pl.start) {
            var f2 = this.placeForward(line, maxD(need, pl.start), cyc(line, dosage, req, R), ctx);
            pl.start = f2.start; pl.end = f2.end;
            if (add(pl.start, cyc(line, dosage, req, R) - 1) > p(due)) pl.warning = '交期可能无法满足（受冻干放大测试间隔2个月限制）';
          }
        }

        var harvest = null, mabPhases = null, dpSeg = null, fill = null;
        if (type === 'Mab') {
          var sg = mabSegs(req, R);
          harvest = f(add(pl.start, sg.seed + sg.reactor)); // 下罐=开始+种子培养+反应器培养
          mabPhases = '种子培养' + sg.seed + '天 + 反应器培养' + sg.reactor + '天 + 下游纯化' + sg.purify + '天（合计' + (sg.seed + sg.reactor + sg.purify) + '天）';
        } else if (LINES[line] && LINES[line].type === 'dp') {
          dpSeg = dpSegs(line, dosage, req, R); // 周期四段（人工干预可调；目检包装不计入周期，见包装完成日期）
          fill = f(add(pl.start, dpSeg.prep)); // 灌装日期自动=开始+准备天数
        }
        // 包装完成日期 = DP完成日期 + packDays（默认10天，规则可调；仅正式 DP 批次，放大测试/APS 不含）
        var packDate = null;
        if (type === 'ADC DP' || type === 'CM DP') {
          packDate = f(add(pl.end, R.dp.packDays != null ? R.dp.packDays : 10));
        }
        var batch = {
          id: 'NB' + (ctx.seq++), reqId: req.id, seq: n, type: type, line: line, dosage: dosage,
          start: f(pl.start), end: f(pl.end), harvestDate: harvest, fillDate: fill, packDate: packDate, mabPhases: mabPhases, project: req.atProject,
          henlius: req.henliusProject, gmp: req.type==='CB' ? true : !!req.gmp, priority: req.priority, requester: req.requester || '',
          mabSeed: type === 'Mab' ? sg.seed : null, mabReactor: type === 'Mab' ? sg.reactor : null,
          mabPurify: type === 'Mab' ? sg.purify : null, dpSegs: dpSeg,
          locked: false, status: pl.warning ? '预警' : '自动', warning: pl.warning,
          autoGenerated: false, note: ''
        };
        ctx.addBatch(batch); out.push(batch);
      }
    }, this);

    // ---- APS 模拟灌装（按产线固定月份自动生成）----
    // 规则（排产逻辑.xlsx DP 表）：某产线当年有生产时，在每年固定月份各生成1批；
    // 过去年份已有历史计划，不回溯生成；已有同月APS则不重复。
    var curYear = new Date().getFullYear();
    Object.keys(R.aps.months).forEach(function (line) {
      var months = R.aps.months[line];
      var lineBatches = ctx.all.filter(function (b) { return b.line === line && b.type !== 'APS'; });
      if (!lineBatches.length) return;
      var yearSet = {};
      lineBatches.forEach(function (b) { if (b.start) yearSet[p(b.start).getFullYear()] = 1; });
      Object.keys(yearSet).forEach(function (yr) {
        var y = Number(yr);
        if (y < curYear) return;
        months.forEach(function (m) {
          var dup = ctx.all.some(function (b) {
            if (b.type !== 'APS' || b.line !== line || !b.start) return false;
            var d = p(b.start);
            return d.getFullYear() === y && d.getMonth() + 1 === m;
          });
          if (dup) return;
          var first = new Date(y, m - 1, 1), last = new Date(y, m, 0);
          var d0 = new Date(first), placed = false;
          while (d0 <= last) {
            var e0 = add(d0, R.aps.cycle - 1);
            if (e0 <= last && !ctx.conflicts(line, d0, e0)) {
              var apsBatch = {
                id: 'NB' + (ctx.seq++), reqId: null, seq: 1, type: 'APS', line: line, dosage: '水针',
                start: f(d0), end: f(e0), project: '培养基模拟灌装', henlius: '', gmp: false,
                priority: '中', locked: false, status: '自动', autoGenerated: true,
                note: y + '年' + m + '月APS（规则自动生成）'
              };
              ctx.addBatch(apsBatch); out.push(apsBatch);
              placed = true; break;
            }
            d0 = add(d0, 1);
          }
          if (!placed) ctx.warn(line + ' ' + y + '年' + m + '月 APS 无法插入（产线排满），请人工调整', 'APS');
        });
      });
    });

    return { batches: out, warnings: ctx.warnings };
  };

  Scheduler.DEFAULTS = DEFAULTS;
  Scheduler.LINES = LINES;
  Scheduler.utils = { p: p, f: f, add: add, diff: diff, cycleOf: cycleOf, WEEKDAYS: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] };

  if (typeof module !== 'undefined' && module.exports) module.exports = Scheduler;
  else root.Scheduling = Scheduler;
})(typeof window !== 'undefined' ? window : this);
