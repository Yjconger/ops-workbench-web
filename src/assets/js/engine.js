/* engine.js — 运营分析引擎（纯函数，无 DOM 依赖）
 * 浏览器：window.OpsEngine；Node：require 后自测。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.OpsEngine = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ================= 通用工具 =================
  function num(v) {
    if (v === null || v === undefined) { return null; }
    var s = String(v).replace(/[,\s%]/g, '').replace(/[（(].*?[)）]/g, '');
    if (s === '' || s === '-' || s === '—') { return null; }
    var n = Number(s);
    return isNaN(n) ? null : n;
  }
  function round(n, d) { var p = Math.pow(10, d === undefined ? 1 : d); return Math.round(n * p) / p; }
  function pct(a, b) { return b ? round((a / b) * 100, 1) : 0; }
  function signedPct(n) { return (n > 0 ? '+' : '') + round(n, 1) + '%'; }
  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/\|/g, '／').replace(/\r?\n/g, ' '); }
  function mdTable(head, rows) {
    if (!rows.length) { return '_（无数据）_'; }
    var out = ['| ' + head.join(' | ') + ' |', '| ' + head.map(function () { return '---'; }).join(' | ') + ' |'];
    rows.forEach(function (r) { out.push('| ' + r.map(esc).join(' | ') + ' |'); });
    return out.join('\n');
  }
  function splitCSVLine(line) {
    // 支持引号包裹（含逗号）的简单 CSV
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (q) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else { q = false; } }
        else { cur += c; }
      } else if (c === '"') { q = true; }
      else if (c === ',') { out.push(cur); cur = ''; }
      else { cur += c; }
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }
  function parseCSV(text) {
    return String(text).replace(/^\uFEFF/, '').split(/\r?\n/)
      .filter(function (l) { return l.trim() !== '' && l.trim().charAt(0) !== '#'; })
      .map(splitCSVLine);
  }

  // ================= 数据解析 =================
  /** 当日指标：表头 指标,数值,对比值,对比口径 */
  function parseDailyCSV(text, date) {
    var rows = parseCSV(text), out = [], head = null;
    if (!rows.length) { return out; }
    head = rows[0].map(function (h) { return h.replace(/\s/g, ''); });
    var iMetric = head.indexOf('指标'), iValue = head.indexOf('数值'), iCmp = head.indexOf('对比值'), iBasis = head.indexOf('对比口径');
    if (iMetric < 0 || iValue < 0) { return out; }
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      out.push({
        date: date, metric: r[iMetric], value: num(r[iValue]),
        compare: iCmp >= 0 ? num(r[iCmp]) : null,
        basis: iBasis >= 0 ? r[iBasis] : '', source: 'daily'
      });
    }
    return out;
  }
  /** 周指标：表头 周,指标,数值,环比,同比（同一文件可含多周） */
  function parseWeeklyCSV(text) {
    var rows = parseCSV(text), out = [], head = null;
    if (!rows.length) { return out; }
    head = rows[0].map(function (h) { return h.replace(/\s/g, ''); });
    var iWeek = head.indexOf('周'), iMetric = head.indexOf('指标'), iValue = head.indexOf('数值');
    if (iMetric < 0 || iValue < 0) { return out; }
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var wk = iWeek >= 0 ? r[iWeek] : '';
      out.push({ date: wk, metric: r[iMetric], value: num(r[iValue]), source: 'weekly' });
    }
    return out;
  }
  /** 用户行为：用户ID,注册日期,最近活跃日期,累计订单数,累计付费金额,反馈次数,最近反馈日期,渠道,备注 */
  function parseUsersCSV(text) {
    var rows = parseCSV(text), out = [], head = null;
    if (!rows.length) { return out; }
    head = rows[0].map(function (h) { return h.replace(/\s/g, ''); });
    function idx(name) { return head.indexOf(name); }
    var iId = idx('用户ID'), iReg = idx('注册日期'), iAct = idx('最近活跃日期'), iOrd = idx('累计订单数'),
      iAmt = idx('累计付费金额'), iFb = idx('反馈次数'), iFbD = idx('最近反馈日期'), iCh = idx('渠道'), iNote = idx('备注');
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (iId >= 0 && !r[iId]) { continue; }
      out.push({
        id: iId >= 0 ? r[iId] : 'U' + i,
        regDate: iReg >= 0 ? r[iReg] : '',
        lastActive: iAct >= 0 ? r[iAct] : '',
        orders: iOrd >= 0 ? (num(r[iOrd]) || 0) : 0,
        amount: iAmt >= 0 ? (num(r[iAmt]) || 0) : 0,
        fbCount: iFb >= 0 ? (num(r[iFb]) || 0) : 0,
        lastFbDate: iFbD >= 0 ? r[iFbD] : '',
        channel: iCh >= 0 ? r[iCh] : '',
        note: iNote >= 0 ? r[iNote] : ''
      });
    }
    return out;
  }
  /** 反馈文本：一行一条，时间 | 渠道 | 用户ID | 内容；# 开头为注释 */
  function parseFeedbackTXT(text, date) {
    return String(text).replace(/^\uFEFF/, '').split(/\r?\n/)
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l !== '' && l.charAt(0) !== '#'; })
      .map(function (l, i) {
        var parts = l.split('|').map(function (s) { return s.trim(); });
        var content = parts.length >= 4 ? parts.slice(3).join(' ') : l;
        return {
          date: date, time: parts.length >= 4 ? parts[0] : '', channel: parts.length >= 4 ? parts[1] : '',
          userId: parts.length >= 4 ? parts[2] : '', content: content
        };
      });
  }

  // ================= 反馈分析 =================
  function classifySentiment(content, cfg) {
    var fb = cfg.feedback, hitN = [], hitP = [];
    fb.negativePatterns.forEach(function (w) { if (content.indexOf(w) >= 0) { hitN.push(w); } });
    (fb.negativeRegex || []).forEach(function (p) { if (new RegExp(p).test(content)) { hitN.push('句式: ' + p); } });
    fb.positivePatterns.forEach(function (w) { if (content.indexOf(w) >= 0) { hitP.push(w); } });
    // 正面词与负面词同现时，看是否"比之前更好"这种对比句式（判为正面）
    var better = /(比之前|比上(个)?(版本|月)|现在好)/.test(content);
    var sentiment = '中性';
    if (hitN.length && hitP.length) { sentiment = better ? '正面' : (hitN.length >= hitP.length ? '负面' : '正面'); }
    else if (hitN.length) { sentiment = '负面'; }
    else if (hitP.length) { sentiment = '正面'; }
    return { sentiment: sentiment, evidence: hitN.concat(hitP).slice(0, 4) };
  }
  function classifyCategory(content, cfg) {
    var cats = cfg.feedback.categories, best = null;
    for (var i = 0; i < cats.length; i++) {
      var c = cats[i];
      for (var j = 0; j < c.keywords.length; j++) {
        if (content.indexOf(c.keywords[j]) >= 0) { best = c; break; }
      }
      if (best) { break; }
    }
    if (!best) { best = cats[cats.length - 1]; }
    return best;
  }
  var STOP = ['这个', '那个', '我们', '你们', '他们', '自己', '可以', '还是', '已经', '现在', '之前', '今天', '昨天', '每次', '一直', '根本', '结果', '客户', '什么', '时候', '怎么', '问题', '使用', '一个', '两个', '三次', '两次'];
  function extractKeywords(content, max) {
    var words = (content.match(/[\u4e00-\u9fa5]{2,4}|[A-Za-z]{3,}/g) || [])
      .filter(function (w) { return STOP.indexOf(w) < 0; });
    var freq = {};
    words.forEach(function (w) { freq[w] = (freq[w] || 0) + 1; });
    return Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a] || b.length - a.length; }).slice(0, max || 3);
  }
  /** 逐条打标 + 汇总（情感分布 / 高频问题 / 需求优先级） */
  function analyzeFeedback(items, cfg, opts) {
    opts = opts || {};
    var annotated = items.map(function (it) {
      var s = classifySentiment(it.content, cfg);
      var c = classifyCategory(it.content, cfg);
      return {
        date: it.date, time: it.time, channel: it.channel, userId: it.userId, content: it.content,
        sentiment: s.sentiment, evidence: s.evidence, category: c.name, severity: c.severity,
        keywords: extractKeywords(it.content, 3)
      };
    });

    var sent = { 负面: 0, 中性: 0, 正面: 0 };
    annotated.forEach(function (a) { sent[a.sentiment]++; });
    var total = annotated.length || 0;

    // 高频问题 Top5：按 问题类型 聚合，取代表原话
    var byCat = {};
    annotated.forEach(function (a) {
      if (!byCat[a.category]) { byCat[a.category] = { name: a.category, items: [], users: {}, severity: a.severity }; }
      byCat[a.category].items.push(a);
      if (a.userId) { byCat[a.category].users[a.userId] = 1; }
    });
    var issues = Object.keys(byCat).map(function (k) {
      var g = byCat[k];
      var reps = g.items.filter(function (x) { return x.sentiment === '负面'; }).slice(0, 2);
      return {
        name: g.name, count: g.items.length, users: Object.keys(g.users).length, severity: g.severity,
        samples: (reps.length ? reps : g.items).slice(0, 2).map(function (x) { return x.content; })
      };
    }).sort(function (a, b) { return b.count - a.count; }).slice(0, 5);

    // 需求提炼：问题类型 → 需求条目 + 优先级
    var capRank = { 'P0': 0, 'P1': 1, 'P2': 2 };
    var capOf = { '计费问题': 'P0', '性能问题': 'P0', '体验问题': 'P1', '内容问题': 'P1', '功能缺失': 'P1', '其他': 'P2' };
    var actionOf = {
      '计费问题': '拉取失败订单明细定位支付链路，涉资金工单当日闭环',
      '性能问题': '定位慢接口并单独打点，先做限流 / 降级止损',
      '体验问题': '复核入口与文案，必要时热修复并回访',
      '内容问题': '核对数据与文案来源后修正',
      '功能缺失': '纳入需求池，评估影响面后排期',
      '其他': '客服侧补充信息后二次归类'
    };
    var P = cfg.feedback.priority;
    var requirements = issues.map(function (is) {
      var score = is.count * 2 + is.users * 3 + is.severity * 2;
      var level = score >= 20 ? 'P0' : (score >= 8 ? 'P1' : 'P2');
      var cap = capOf[is.name] || 'P2';
      if (capRank[level] < capRank[cap]) { level = cap; }
      var kw = {};
      byCat[is.name].items.forEach(function (x) { x.keywords.forEach(function (k) { kw[k] = (kw[k] || 0) + 1; }); });
      var topKw = Object.keys(kw).sort(function (a, b) { return kw[b] - kw[a]; }).slice(0, 3);
      return {
        category: is.name, title: topKw.join(' / ') || is.name, level: level, score: score,
        mentions: is.count, users: is.users, samples: is.samples, action: actionOf[is.name] || '',
        reason: '提及 ' + is.count + ' 次 / ' + is.users + ' 位用户 / 类型权重 ' + is.severity + ' → 分值 ' + score + (level !== (score >= 20 ? 'P0' : (score >= 8 ? 'P1' : 'P2')) ? '（按类型上限降档）' : '')
      };
    }).sort(function (a, b) { return capRank[a.level] - capRank[b.level] || b.score - a.score; });

    var small = total > 0 && total < 10;
    var report = [
      '### 一、情感分布',
      mdTable(['情感', '条数', '占比', '代表原话'], ['负面', '中性', '正面'].map(function (k) {
        var sample = ''; for (var i = 0; i < annotated.length; i++) { if (annotated[i].sentiment === k) { sample = annotated[i].content; break; } }
        return [k, sent[k], pct(sent[k], total) + '%', sample];
      })),
      '',
      '### 二、高频问题 Top5',
      mdTable(['排名', '问题类型', '提及条数', '涉及用户', '代表原话'], issues.map(function (is, i) {
        return [i + 1, is.name, is.count, is.users, is.samples[0] || ''];
      })),
      '',
      '### 三、需求建议（带优先级）',
      mdTable(['优先级', '需求', '依据', '建议动作'], requirements.map(function (r) {
        return [r.level, r.title + '（' + r.category + '）', r.reason, r.action];
      })),
      '',
      '### 四、需要进一步确认的点',
      [small ? '- 样本仅 ' + total + ' 条，**样本过小，结论仅供参考**。' : '- 样本 ' + total + ' 条，可支撑方向性判断。',
        '- 未提供反馈的日期无法纳入分析，建议核对导出是否为全量。',
        '- 情感判定基于规则词表，涉反讽 / 否定句式建议人工复核抽样。'].join('\n')
    ].join('\n');

    return {
      total: total, annotated: annotated, sentiment: sent, sentimentPct: { 负面: pct(sent['负面'], total), 中性: pct(sent['中性'], total), 正面: pct(sent['正面'], total) },
      issues: issues, requirements: requirements, smallSample: small, report: report,
      negativeCount: sent['负面'],
      negativeRate: pct(sent['负面'], total)
    };
  }

  // ================= 日期工具 =================
  function toDate(s) {
    if (!s) { return null; }
    var m = String(s).match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  function daysBetween(a, b) {
    var d1 = toDate(a), d2 = toDate(b);
    return (d1 && d2) ? Math.round((d2 - d1) / 86400000) : null;
  }
  function byDateAsc(a, b) { return String(a.date) < String(b.date) ? -1 : (String(a.date) > String(b.date) ? 1 : 0); }
  function ruleOf(cfg, metric, gran) {
    var list = cfg.metrics || [], norm = function (s) {
      return String(s).replace(/[（(].*?[)）]/g, '').replace(/\s/g, '').replace(/性$/, '');
    };
    for (var i = 0; i < list.length; i++) { if (list[i].key === metric) { return list[i]; } }
    for (var j = 0; j < list.length; j++) { if (norm(list[j].key) === norm(metric)) { return list[j]; } }
    return { key: metric, freq: gran || '日', better: 'up', momWarn: -10, momBad: -20, undefined_rule: true, note: '未在口径中定义，按默认环比规则判定' };
  }

  // ================= 指标状态与趋势 =================
  function statusOf(value, prev, rule) {
    if (value === null || value === undefined) { return { status: '无数据', near: false, reason: '缺数据' }; }
    var st = '正常', near = false, reason = '';
    var absent = function (v) { return v === undefined || v === null; };
    var hasAbs = (rule.better === 'up' && (!absent(rule.goodMin) || !absent(rule.warnMin))) ||
                 (rule.better === 'down' && (!absent(rule.goodMax) || !absent(rule.warnMax)));
    if (hasAbs) {
      if (rule.better === 'up') {
        var gMin = absent(rule.goodMin) ? -Infinity : rule.goodMin;
        var wMin = absent(rule.warnMin) ? -Infinity : rule.warnMin;
        if (value >= gMin) { st = '正常'; near = Math.abs(gMin) > 0 && (value - gMin) <= Math.abs(gMin) * 0.02; }
        else if (value >= wMin) { st = '需关注'; }
        else { st = '异常'; }
        reason = '口径：正常 ≥' + gMin + '，关注 ≥' + wMin;
      } else {
        var gMax = absent(rule.goodMax) ? Infinity : rule.goodMax;
        var wMax = absent(rule.warnMax) ? Infinity : rule.warnMax;
        if (value <= gMax) { st = '正常'; near = Math.abs(gMax) > 0 && (gMax - value) <= Math.abs(gMax) * 0.02; }
        else if (value <= wMax) { st = '需关注'; }
        else { st = '异常'; }
        reason = '口径：正常 ≤' + gMax + '，关注 ≤' + wMax;
      }
    } else if (prev !== null && prev !== undefined && prev !== 0 && !absent(rule.momWarn)) {
      var ch = (value - prev) / Math.abs(prev) * 100;
      if (ch >= rule.momWarn) { st = '正常'; near = (ch - rule.momWarn) < 1.5; }
      else if (ch >= rule.momBad) { st = '需关注'; }
      else { st = '异常'; }
      reason = '口径：环比 ≥' + rule.momWarn + '% 为正常，≥' + rule.momBad + '% 为关注，低于为异常（本期 ' + signedPct(ch) + '）';
    } else {
      reason = '无对比基准，默认正常';
    }
    return { status: st, near: near, reason: reason };
  }

  function detectTrend(values) {
    var n = (values || []).length;
    if (n < 3) { return { dir: 'flat', streak: 0, startIndex: Math.max(0, n - 1), from: null, to: null }; }
    var diffs = [];
    for (var i = 1; i < n; i++) { diffs.push(values[i] - values[i - 1]); }
    var run = 1, dir = 0, start = n - 1;
    for (var k = diffs.length - 1; k >= 0; k--) {
      var d = diffs[k] > 0 ? 1 : (diffs[k] < 0 ? -1 : 0);
      if (d === 0) { break; }
      if (dir === 0) { dir = d; run = 2; start = k; }
      else if (d === dir) { run++; start = k; }
      else { break; }
    }
    return {
      dir: dir === 1 ? 'up' : (dir === -1 ? 'down' : 'flat'), streak: dir ? run : 0,
      startIndex: start, from: values[start], to: values[n - 1]
    };
  }

  var HYP = {
    '支付成功率': ['支付渠道 / 链路故障，某个渠道失败率异常升高', '近期版本改动了支付流程或回调逻辑', '风控或限额策略变化误伤正常支付'],
    '退款率': ['支付失败后的重复扣款引发集中退款', '商品或服务交付问题集中出现', '退款政策 / 统计口径发生变化'],
    '订单转化率': ['支付成功率下滑直接拖累下单转化', '活动或定价节奏变化', '流量结构变化（低意向渠道占比升高）'],
    '接口平均响应时长': ['近期发版引入性能回归', '数据量增长导致慢查询', '导出 / 报表类重接口未单独限流'],
    '核心功能使用率': ['入口改版导致用户找不到功能', '功能可用性下降（加载失败 / 卡顿）', '用户结构变化（新增用户占比升高）'],
    '次日留存率': ['新用户来源质量下降', '首次体验受阻（性能或引导问题）', '版本更新引入回归问题'],
    '负面反馈数': ['支付 / 性能等核心链路问题外显为用户情绪', '客服响应变慢导致重复反馈', '统计口径或抓取范围变化'],
    '日活跃用户数': ['外部渠道投放节奏变化', '产品可用性下降导致流失', '节假日 / 季节因素'],
    '新增注册用户': ['投放预算或渠道变化', '注册链路问题', '活动结束后的自然回落'],
    '付费订单数': ['支付链路问题导致下单失败', '价格 / 活动变化', '流量结构变化'],
    '周活跃用户数': ['整体留存下滑或获客质量下降', '产品可用性问题持续未解决', '季节性因素'],
    '默认': ['口径或数据源变化（先排除）', '产品近期变更（版本 / 策略）', '外部因素（流量 / 节假日 / 竞品）']
  };
  function hypothesesFor(metric, status, trend) {
    var key = Object.keys(HYP).find(function (k) { return metric.indexOf(k) >= 0; }) || '默认';
    var list = HYP[key].slice(0, status === '异常' ? 3 : 2);
    var verify = ['对比发版 / 配置变更时间线', '按渠道或版本拆分指标', '抽样核对原始日志与工单'];
    return list.map(function (t, i) { return { text: t, basis: metric + ' 当前处于「' + status + '」' + (trend && trend.streak >= 3 ? '，且已连续 ' + trend.streak + ' 期同向变化' : ''), verify: verify[i % verify.length] }; });
  }

  // ================= 指标分析 =================
  function analyzeMetrics(series, cfg, opts) {
    opts = opts || {};
    var gran = opts.granularity || '日';
    var byMetric = {};
    (series || []).forEach(function (r) {
      if (!r.metric || r.value === null || r.value === undefined) { return; }
      (byMetric[r.metric] = byMetric[r.metric] || []).push(r);
    });
    var rows = Object.keys(byMetric).map(function (m) {
      var arr = byMetric[m].slice().sort(byDateAsc);
      var last = arr[arr.length - 1], prev = arr.length > 1 ? arr[arr.length - 2] : null;
      var rule = ruleOf(cfg, m, gran);
      var st = statusOf(last.value, prev ? prev.value : null, rule);
      var values = arr.map(function (x) { return x.value; });
      var tr = detectTrend(values);
      var changePct = (prev && prev.value) ? round((last.value - prev.value) / Math.abs(prev.value) * 100, 1) : null;
      return {
        metric: m, freq: rule.freq || gran, date: last.date, value: last.value,
        prev: prev ? prev.value : null, prevDate: prev ? prev.date : '',
        change: prev ? round(last.value - prev.value, 2) : null, changePct: changePct,
        status: st.status, near: st.near, reason: st.reason, rule: rule, trend: tr,
        series: arr.slice(-14).map(function (x) { return { date: x.date, value: x.value }; }),
        hypothesis: st.status !== '正常' ? hypothesesFor(m, st.status, tr) : []
      };
    });
    var rank = { '异常': 0, '需关注': 1, '正常': 2, '无数据': 3 };
    var anomalies = rows.filter(function (r) { return r.status === '异常' || r.status === '需关注'; })
      .sort(function (a, b) { return rank[a.status] - rank[b.status] || Math.abs(b.changePct || 0) - Math.abs(a.changePct || 0); });
    var trends = rows.filter(function (r) { return r.trend.streak >= 3 && Math.abs((r.trend.to - r.trend.from) / (r.trend.from || 1)) >= 0.03; })
      .sort(function (a, b) { return b.trend.streak - a.trend.streak; });
    var normal = rows.filter(function (r) { return r.status === '正常'; });

    var report = [
      '### 一、核心指标概览',
      mdTable(['指标', '当期', '对比基准', '变化', '状态'], rows.slice().sort(function (a, b) { return rank[a.status] - rank[b.status]; }).map(function (r) {
        return [r.metric, r.value, (r.prevDate ? r.prevDate + ' ' : '') + (r.prev === null ? '—' : r.prev),
          (r.change === null ? '—' : (r.change > 0 ? '+' : '') + r.change) + (r.changePct === null ? '' : '（' + signedPct(r.changePct) + '）'),
          r.status + (r.near ? '（临界）' : '')];
      })),
      '',
      '### 二、趋势与拐点',
      trends.length ? trends.map(function (r) {
        return '- **' + r.metric + '**：连续 ' + r.trend.streak + ' 期' + (r.trend.dir === 'up' ? '上升' : '下降') +
          '，从 ' + r.trend.from + ' → ' + r.trend.to + '（拐点约在 ' + (r.series[0] ? r.series[Math.max(0, r.trend.startIndex)] && r.series[Math.max(0, r.trend.startIndex - (r.series.length - 1 - r.trend.startIndex))] : '') + '）';
      }).join('\n') : '- 未发现连续 3 期以上的同向趋势（或样本不足）。',
      '',
      '### 三、异常标注',
      anomalies.length ? mdTable(['指标', '当期', '异常表现', '可能原因'], anomalies.map(function (r) {
        return [r.metric, r.value, r.status + '：' + r.reason + (r.changePct === null ? '' : '；环比 ' + signedPct(r.changePct)), r.hypothesis[0] ? r.hypothesis[0].text : '—'];
      })) : '_本期无异常指标_',
      '',
      '### 四、归因假设（按可能性排序）',
      anomalies.length ? anomalies.map(function (r) {
        return r.hypothesis.map(function (h, i) { return (i + 1) + '. **' + r.metric + '** — ' + h.text + '　依据：' + h.basis + '　验证方式：' + h.verify; }).join('\n');
      }).join('\n') : '_无_',
      '',
      '### 五、下一个观察点',
      [anomalies.length ? '- 优先盯 **' + anomalies[0].metric + '**：' + (anomalies[0].rule.better === 'up' ? '回到 ' + (anomalies[0].rule.goodMin !== undefined ? '≥ ' + anomalies[0].rule.goodMin : '正常区间') : '回落到 ' + (anomalies[0].rule.goodMax !== undefined ? '≤ ' + anomalies[0].rule.goodMax : '正常区间')) + ' 视为缓解。' : '- 指标整体正常，保持现有监控频率。',
        '- 正常指标中 ' + rows.filter(function (r) { return r.status === '正常' && r.near; }).length + ' 项处于临界值附近，需一并观察。'].join('\n')
    ].join('\n');

    return { granularity: gran, rows: rows, anomalies: anomalies, trends: trends, normal: normal, report: report, updated: new Date().toISOString() };
  }

  // ================= 每日晨检 =================
  function countChars(s) { return String(s).replace(/\s/g, '').length; }
  function pickBrief(variants, limit) {
    limit = limit || 200;
    for (var i = 0; i < variants.length; i++) {
      var c = countChars(variants[i]);
      if (c <= limit) { return { text: variants[i], count: c, trimmed: i > 0, variant: i + 1 }; }
    }
    var hard = variants[variants.length - 1];
    while (countChars(hard) > limit && hard.length > 24) { hard = hard.slice(0, hard.length - 12); }
    return { text: hard, count: countChars(hard), trimmed: true, variant: variants.length, hardTrimmed: true };
  }

  function dailyCheck(input) {
    var cfg = input.cfg, date = input.date, all = input.metrics || [];
    var rows = [];
    all.filter(function (r) { return r.date === date; }).forEach(function (r) {
      var rule = ruleOf(cfg, r.metric, '日');
      var st = statusOf(r.value, r.compare, rule);
      var hist = all.filter(function (x) { return x.metric === r.metric; }).sort(byDateAsc).map(function (x) { return x.value; });
      rows.push({
        metric: r.metric, value: r.value, compare: r.compare, rule: rule,
        change: (r.compare === null || r.compare === undefined) ? null : round(r.value - r.compare, 2),
        changePct: (r.compare === null || r.compare === undefined || r.compare === 0) ? null : round((r.value - r.compare) / Math.abs(r.compare) * 100, 1),
        status: st.status, near: st.near, reason: st.reason, series: hist, trend: detectTrend(hist)
      });
    });
    var rank = { '异常': 0, '需关注': 1, '正常': 2, '无数据': 3 };
    rows.sort(function (a, b) { return rank[a.status] - rank[b.status]; });

    var fb = (input.feedback && input.feedback.length) ? analyzeFeedback(input.feedback, cfg) : null;
    var topIssue = fb && fb.issues.length ? fb.issues[0] : null;

    var todos = [];
    rows.filter(function (r) { return r.status === '异常'; }).slice(0, 2).forEach(function (r) {
      var text = '排查 ' + r.metric + ' 异常原因', short = '排查 ' + r.metric;
      if (/支付|退款|订单/.test(r.metric)) { text = '拉取失败订单明细，定位支付链路并闭环涉资金工单'; short = '拉失败明细，闭环涉资金工单'; }
      else if (/响应|时长|性能/.test(r.metric)) { text = '定位慢接口，先做限流 / 降级止损'; short = '定位慢接口并限流'; }
      else if (/反馈/.test(r.metric)) { text = '处理负面反馈集中的问题并回访'; short = '处理集中反馈问题'; }
      todos.push({ text: text, short: short, basis: r.metric + ' ' + r.value + '（' + r.status + '：' + r.reason + '）', when: /支付|退款|订单/.test(r.metric) ? '今日下班前' : '今日内' });
    });
    if (topIssue && todos.length < 3) {
      todos.push({
        text: '响应「' + topIssue.name + '」相关反馈并同步处理进度',
        short: '响应「' + topIssue.name + '」反馈',
        basis: '反馈中 ' + topIssue.count + ' 条提及、涉及 ' + topIssue.users + ' 位用户，代表原话「' + (topIssue.samples[0] || '') + '」',
        when: fb.negativeRate >= 50 ? '今日内' : '本周内'
      });
    }
    rows.filter(function (r) { return r.status === '需关注'; }).slice(0, Math.max(0, 3 - todos.length)).forEach(function (r) {
      todos.push({ text: '跟踪 ' + r.metric + ' 是否继续恶化', short: '跟踪 ' + r.metric, basis: r.metric + ' ' + r.value + '（需关注）', when: '明日晨检前' });
    });

    var abn = rows.filter(function (r) { return r.status === '异常'; });
    var headline = abn.length
      ? abn.slice(0, 2).map(function (r) { return r.metric + ' ' + r.value; }).join(' 与 ') + ' 报警' + (fb && fb.negativeRate >= 50 ? '，负面反馈占比 ' + fb.negativeRate + '%' : '')
      : (rows.some(function (r) { return r.status === '需关注'; }) ? '无破线异常，但有指标处于关注区间' : '指标整体平稳');

    var head = '【晨检简报】' + date;
    var conclusion = '- 一句话结论：' + headline + '。';
    var metricsLine = function (n) {
      return '- 指标：' + (rows.slice(0, n).map(function (r) {
        return r.metric + ' ' + r.value + '（' + (r.compare === null || r.compare === undefined ? '无对比' : r.compare + '→' + r.status) + '）';
      }).join('、') || '当日无指标数据');
    };
    var fbLine = function (full) {
      if (!fb) { return '- 反馈：当日无反馈数据'; }
      return full
        ? '- 反馈：总 ' + fb.total + ' 条，负面 ' + fb.negativeCount + ' 条，最集中在「' + (topIssue ? topIssue.name : '无明显集中问题') + '」'
        : '- 反馈：' + fb.total + ' 条，负面 ' + fb.negativeCount + ' 条';
    };
    var todoLine = function (short) {
      return '- 今日待办：' + (todos.length ? todos.map(function (t, i) { return (i + 1) + ') ' + (short ? t.short : t.text); }).join('；') : '无');
    };
    var risk = '- 风险提示：' + (topIssue && topIssue.count >= 3
      ? topIssue.name + ' 已累计 ' + topIssue.count + ' 条且存在重复反馈，可能升级为投诉'
      : (abn.length ? '优先确认异常是否影响资金链路' : '暂无'));
    var variants = [
      [head, conclusion, metricsLine(5), fbLine(true), risk, todoLine(false)].join('\n'),
      [head, conclusion, metricsLine(5), fbLine(true), todoLine(false)].join('\n'),
      [head, conclusion, metricsLine(4), fbLine(true), todoLine(true)].join('\n'),
      [head, conclusion, metricsLine(3), fbLine(true), todoLine(true)].join('\n'),
      [head, conclusion, metricsLine(3), fbLine(false), todoLine(true)].join('\n')
    ];
    var picked = pickBrief(variants, 200);

    return {
      date: date, rows: rows, feedback: fb, todos: todos, headline: headline,
      brief: picked.text, briefCount: picked.count, briefTrimmed: picked.trimmed, briefVariant: picked.variant,
      report: '```text\n' + picked.text + '\n```\n\n> 简报正文 ' + picked.count + ' 字（上限 200 字）' + (picked.trimmed ? '；已按优先级自动精简' : '') +
        '\n\n**今日待办（含依据）**\n' + (todos.length
          ? todos.map(function (t, i) { return (i + 1) + '. ' + t.text + '　｜　依据：' + t.basis + '　｜　时间：' + t.when; }).join('\n')
          : '- 无待办')
    };
  }
  // ================= 用户打标签 =================
  function tagUsers(users, cfg, ctx) {
    ctx = ctx || {};
    var t = cfg.tags, today = ctx.today || new Date().toISOString().slice(0, 10);
    var prev = {};
    (ctx.prevTags || []).forEach(function (r) { if (r['用户ID']) { prev[r['用户ID']] = r; } });
    var valueRank = { '高价值': 0, '中价值': 1, '低价值': 2, '未付费': 3 };
    var riskRank = { '流失风险': 0, '已流失': 1, '回流': 2, '沉默': 3, '新用户': 4, '活跃': 5, '待确认': 6 };

    var rows = users.map(function (u) {
      var dAct = daysBetween(u.lastActive, today), dReg = daysBetween(u.regDate, today);
      var life;
      if (dAct === null) { life = '待确认'; }
      else if (dAct <= t.lifecycle.activeDays && dReg !== null && dReg <= t.lifecycle.newUserDays) { life = '新用户'; }
      else if (dAct <= t.lifecycle.activeDays) { life = '活跃'; }
      else if (dAct <= t.lifecycle.silentDays) { life = '沉默'; }
      else if (dAct <= t.lifecycle.churnRiskDays) { life = '流失风险'; }
      else { life = '已流失'; }
      var p = prev[u.id], from = p ? (p['生命周期阶段'] || '') : '';
      var lifeBasis = '按最近活跃距今天数：' + (dAct === null ? '未知' : dAct + ' 天');
      if (dAct !== null && dAct <= t.lifecycle.activeDays && ['沉默', '流失风险', '已流失'].indexOf(from) >= 0) { life = '回流'; lifeBasis = '台账对比：' + from + ' → 回流'; }
      else if (/回流/.test(u.note || '') && dAct !== null && dAct <= t.lifecycle.activeDays) { life = '回流'; lifeBasis = '备注标注回流'; }

      var value = u.amount >= t.value.highMin ? '高价值' : u.amount >= t.value.midMin ? '中价值' : u.amount >= t.value.lowMin ? '低价值' : '未付费';
      var behavior, note = '';
      if (u.fbCount >= t.behavior.highFreqCount) { behavior = '高频反馈'; }
      else if (/正面|好评|点赞/.test(u.note || '')) { behavior = '正面反馈'; }
      else if (u.fbCount >= 1 && daysBetween(u.lastFbDate, today) !== null && daysBetween(u.lastFbDate, today) <= t.behavior.recentDays) {
        behavior = '问题反馈'; note = '按最近反馈记录推定，建议核对内容情感';
      } else { behavior = '无反馈'; }

      var changed = '';
      if (p && from && from !== life) { changed = from + ' → ' + life; }
      else if (p && p['价值标签'] && p['价值标签'] !== value) { changed = p['价值标签'] + ' → ' + value; }
      return {
        id: u.id, life: life, lifeBasis: lifeBasis, value: value, behavior: behavior, note: note, changed: changed,
        action: t.actions[life + '|' + value] || '（口径中未定义该组合，建议补充动作矩阵）',
        extra: t.behaviorAction[behavior] || '', dAct: dAct, user: u,
        followScore: (3 - (valueRank[value] === undefined ? 3 : valueRank[value])) * 3 + (5 - (riskRank[life] === undefined ? 6 : riskRank[life])) + (behavior === '高频反馈' || behavior === '问题反馈' ? 2 : 0)
      };
    });

    var dims = [['生命周期', 'life', ['新用户', '活跃', '沉默', '流失风险', '已流失', '回流']],
      ['价值', 'value', ['高价值', '中价值', '低价值', '未付费']],
      ['反馈行为', 'behavior', ['高频反馈', '问题反馈', '正面反馈', '无反馈']]];
    var overview = dims.map(function (d) {
      return d[2].filter(function (k) { return rows.some(function (r) { return r[d[1]] === k; }); }).map(function (k) {
        var c = rows.filter(function (r) { return r[d[1]] === k; }).length;
        return { dim: d[0], label: k, count: c, pct: pct(c, rows.length) };
      });
    }).reduce(function (a, b) { return a.concat(b); }, []);

    var followups = rows.slice().sort(function (a, b) { return b.followScore - a.followScore; }).slice(0, 5);
    var riskRows = rows.filter(function (r) { return ['流失风险', '已流失'].indexOf(r.life) >= 0 && (r.value === '高价值' || r.value === '中价值'); });

    var report = [
      '### 一、分层总览',
      mdTable(['维度', '标签', '人数', '占比'], overview.map(function (o) { return [o.dim, o.label, o.count, o.pct + '%']; })),
      '',
      '### 二、标签清单',
      mdTable(['用户ID', '生命周期', '价值', '反馈行为', '变化', '建议动作'], rows.map(function (r) {
        return [r.id, r.life, r.value, r.behavior + (r.note ? '（' + r.note + '）' : ''), r.changed || '—', r.action + (r.extra ? ' + ' + r.extra : '')];
      })),
      '',
      '### 三、优先跟进名单 Top5',
      mdTable(['用户ID', '分层', '建议动作', '理由'], followups.map(function (r) {
        return [r.id, r.life + ' / ' + r.value + ' / ' + r.behavior, r.action + (r.extra ? ' + ' + r.extra : ''),
          '距最近活跃 ' + (r.dAct === null ? '未知' : r.dAct + ' 天') + '，累计付费 ' + r.user.amount + ' 元'];
      })),
      '',
      '### 四、口径说明',
      ['- 数据截止：' + today + '；样本 ' + rows.length + ' 位用户。',
        '- 生命周期按「最近活跃距今天数」判定（新用户 ≤' + t.lifecycle.newUserDays + ' 天 / 活跃 ≤' + t.lifecycle.activeDays + ' 天 / 沉默 ≤' + t.lifecycle.silentDays + ' 天 / 流失风险 ≤' + t.lifecycle.churnRiskDays + ' 天 / 超出为已流失）。',
        '- 「回流」需要历史标签，首次打标不会出现，第二次起通过台账对比自动识别。',
        '- 价值按累计付费金额：高 ≥' + t.value.highMin + ' / 中 ≥' + t.value.midMin + ' / 低 >' + t.value.lowMin + ' / 未付费 = 0。',
        '- 反馈行为按近 ' + t.behavior.recentDays + ' 天：反馈 ≥' + t.behavior.highFreqCount + ' 次为高频反馈。'].join('\n')
    ].join('\n');

    return { rows: rows, overview: overview, followups: followups, riskRows: riskRows, report: report, today: today };
  }

  // ================= 整合分析（交叉验证） =================
  function findRow(rows, metric) {
    for (var i = 0; i < (rows || []).length; i++) {
      if (rows[i].metric === metric) { return rows[i]; }
      if (String(rows[i].metric).replace(/[（(].*?[)）]/g, '') === String(metric).replace(/[（(].*?[)）]/g, '')) { return rows[i]; }
    }
    return null;
  }
  function thresholdText(rule) {
    if (rule.better === 'up' && rule.goodMin !== undefined) { return '≥ ' + rule.goodMin; }
    if (rule.better === 'down' && rule.goodMax !== undefined) { return '≤ ' + rule.goodMax; }
    if (rule.momWarn !== undefined) { return '环比 ≥ ' + rule.momWarn + '%'; }
    return '保持稳定';
  }
  function verifyFor(category) {
    var map = {
      '计费问题': '下周「支付成功率 ≥ 97%、退款率 ≤ 2.0%」，且涉资金工单归零',
      '性能问题': '接口响应 P95 连续 3 天 ≤ 1500ms，导出平均耗时回到 20 秒内',
      '体验问题': '核心功能使用率回升至 ≥ 40%，入口相关反馈归零',
      '内容问题': '同类内容错误反馈不再出现',
      '功能缺失': '需求进入排期并有明确上线时间',
      '其他': '同类反馈条数下降 50% 以上'
    };
    return map[category] || '下周同类反馈条数下降 50%';
  }

  function integrated(input) {
    var cfg = input.cfg, fb = input.feedback, mt = input.metrics, tags = input.tags;
    var cvRows = [];
    var issues = (fb && fb.issues) || [];
    var metricRows = (mt && mt.rows) || [];

    issues.forEach(function (is) {
      var rel = (cfg.crossMap || {})[is.name] || [];
      var evidences = [], hit = false;
      rel.forEach(function (m) {
        var row = findRow(metricRows, m);
        if (row) {
          evidences.push(row.metric + ' ' + row.value + '（' + row.status + (row.changePct === null ? '' : '，环比 ' + signedPct(row.changePct)) + '）');
          if (row.status !== '正常') { hit = true; }
        }
      });
      cvRows.push({
        voice: is.name + '：' + is.count + ' 条 / ' + is.users + ' 位用户' + (is.samples[0] ? '，如「' + is.samples[0] + '」' : ''),
        evidence: evidences.join('；') || '口径中未映射相关指标（属需求类信号，不体现在短期指标上）',
        concl: rel.length === 0 ? '❓ 无法判断' : (hit ? '✅ 印证' : '⚠️ 背离'),
        note: rel.length === 0 ? '需求类信号，建议用需求排期跟踪而非指标' : (hit ? '用户声音在数据上有印证' : '用户说得集中，但相关指标未动 → 可能未真正影响大盘，或指标口径覆盖不到')
      });
    });

    metricRows.filter(function (r) { return r.status !== '正常'; }).forEach(function (row) {
      var mapped = Object.keys(cfg.crossMap || {}).filter(function (k) { return ((cfg.crossMap[k] || []).indexOf(row.metric) >= 0); });
      var hasVoice = mapped.some(function (k) { return issues.some(function (i) { return i.name === k; }); });
      if (!hasVoice) {
        cvRows.push({
          voice: '反馈侧无对应声音', evidence: row.metric + ' ' + row.value + '（' + row.status + '）',
          concl: '⚠️ 背离', note: '沉默的恶化：只靠反馈驱动会漏掉，需要指标兜底'
        });
      }
    });

    // 负面反馈数口径核对
    var consistency = input.consistency || [];
    consistency.forEach(function (c) {
      if (c.metricValue !== null && c.textValue !== null && c.metricValue !== c.textValue) {
        cvRows.push({
          voice: '反馈文件里判定为负面 ' + c.textValue + ' 条（' + c.date + '）',
          evidence: '指标「负面反馈数」记录 ' + c.metricValue + ' 条',
          concl: '❓ 无法判断', note: '两边口径不一致：反馈导出可能只是抽样，或判定标准不同'
        });
      }
    });

    var okCount = cvRows.filter(function (r) { return r.concl.indexOf('印证') >= 0; }).length;
    var warnCount = cvRows.filter(function (r) { return r.concl.indexOf('背离') >= 0; }).length;
    var naCount = cvRows.filter(function (r) { return r.concl.indexOf('无法判断') >= 0; }).length;

    var anomalies = metricRows.filter(function (r) { return r.status === '异常'; })
      .sort(function (a, b) { return Math.abs(b.changePct || 0) - Math.abs(a.changePct || 0); });
    var worstTrend = (mt && mt.trends && mt.trends[0]) || null;

    var findings = [];
    if (worstTrend) { findings.push('**' + worstTrend.metric + '** 连续 ' + worstTrend.trend.streak + ' 期' + (worstTrend.trend.dir === 'up' ? '上升' : '下降') + '（' + worstTrend.trend.from + ' → ' + worstTrend.trend.to + '），是本期最明确的趋势信号。'); }
    if (issues.length) { findings.push('反馈侧最集中在 **' + issues[0].name + '**（' + issues[0].count + ' 条 / ' + issues[0].users + ' 位用户），负面反馈占比 ' + (fb ? fb.negativeRate : 0) + '%。'); }
    findings.push('交叉验证结果：**印证 ' + okCount + ' 条 / 背离 ' + warnCount + ' 条 / 无法判断 ' + naCount + ' 条**。背离项通常最值得优先排查——问题可能没被用户表达出来，或指标口径覆盖不到。');
    if (tags && tags.riskRows && tags.riskRows.length) {
      findings.push('用户分层风险：**' + tags.riskRows.length + ' 位高 / 中价值用户已沉默或流失**（' + tags.riskRows.slice(0, 3).map(function (r) { return r.id; }).join('、') + '），建议进入挽回名单。');
    }
    var repeat = (input.ledger || []).filter(function (row) {
      return issues.some(function (i) { return String(row['关键问题'] || '').indexOf(i.name) >= 0; });
    });
    if (repeat.length >= 2) { findings.push('台账中「' + repeat[0]['关键问题'] + '」类问题已出现 ' + repeat.length + ' 次，属**长期未解决**，需要升级处理而不是继续观察。'); }

    var strategies = [];
    ((fb && fb.requirements) || []).filter(function (r) { return r.level === 'P0' || r.level === 'P1'; }).slice(0, 4).forEach(function (r) {
      strategies.push({
        level: r.level, action: r.action, basis: r.category + '：提及 ' + r.mentions + ' 次 / ' + r.users + ' 位用户' + (r.samples[0] ? '，如「' + r.samples[0] + '」' : ''),
        effect: r.category === '计费问题' ? '止损资金链路，减少退款与投诉' : (r.category === '性能问题' ? '恢复核心体验，避免用户流失' : '提升满意度与留存'),
        verify: verifyFor(r.category), category: r.category
      });
    });
    if (worstTrend && strategies.length < 5) {
      strategies.push({
        level: 'P1', action: '针对 ' + worstTrend.metric + ' 做专项排查与回归验证',
        basis: '连续 ' + worstTrend.trend.streak + ' 期' + (worstTrend.trend.dir === 'up' ? '上升' : '下降') + '，起点 ' + worstTrend.trend.from + ' → 当前 ' + worstTrend.trend.to,
        effect: '阻断持续恶化', verify: '下周该指标回到正常区间', category: '指标趋势'
      });
    }

    var monitoring = anomalies.slice(0, 5).map(function (r) {
      return {
        metric: r.metric, threshold: thresholdText(r.rule),
        action: /支付|退款|订单/.test(r.metric) ? '拉失败明细并排查支付链路' : (/响应|时长/.test(r.metric) ? '定位慢接口' : '按归因假设逐条验证'),
        owner: '运营 / 产品'
      };
    });

    var gaps = [];
    if (input.feedbackDates && input.metricDates) {
      var miss = input.metricDates.filter(function (d) { return input.feedbackDates.indexOf(d) < 0; });
      if (miss.length) { gaps.push('缺反馈数据的日期：' + miss.join('、') + '（共 ' + miss.length + ' 天），建议补导出或确认是否正常。'); }
    }
    if (fb && fb.smallSample) { gaps.push('反馈样本 ' + fb.total + ' 条，样本过小，结论仅作方向参考。'); }
    if (!metricRows.length) { gaps.push('未载入周指标，趋势判断受限，建议在「数据」页导入周指标 CSV。'); }
    cvRows.filter(function (r) { return r.concl.indexOf('无法判断') >= 0; }).forEach(function (r) {
      gaps.push('无法判断项：' + r.voice + ' ↔ ' + r.evidence);
    });

    var report = [
      '### 一、本期核心发现',
      findings.map(function (f, i) { return (i + 1) + '. ' + f; }).join('\n') || '_无_',
      '',
      '### 二、交叉验证表',
      mdTable(['#', '用户声音（反馈结论）', '数据证据（指标结论）', '结论', '说明'], cvRows.map(function (r, i) {
        return [i + 1, r.voice, r.evidence, r.concl, r.note];
      })),
      '',
      '### 三、产品策略建议',
      mdTable(['优先级', '动作', '依据', '预期效果', '验证方式'], strategies.map(function (s) {
        return [s.level, s.action, s.basis, s.effect, s.verify];
      })),
      '',
      '### 四、下周监控重点',
      mdTable(['指标', '阈值', '触发动作', '负责人'], monitoring.map(function (m) {
        return [m.metric, m.threshold, m.action, m.owner];
      })),
      '',
      '### 五、数据缺口与补数清单',
      gaps.length ? gaps.map(function (g) { return '- ' + g; }).join('\n') : '- 本期无数据缺口。'
    ].join('\n');

    return {
      findings: findings, cvRows: cvRows, strategies: strategies, monitoring: monitoring, gaps: gaps,
      counts: { ok: okCount, warn: warnCount, na: naCount }, report: report, granularity: (mt && mt.granularity) || '周'
    };
  }

  return {
    _internal: { num: num, round: round, pct: pct, parseCSV: parseCSV, mdTable: mdTable, extractKeywords: extractKeywords, splitCSVLine: splitCSVLine },
    parseDailyCSV: parseDailyCSV, parseWeeklyCSV: parseWeeklyCSV, parseUsersCSV: parseUsersCSV, parseFeedbackTXT: parseFeedbackTXT,
    classifySentiment: classifySentiment, classifyCategory: classifyCategory, analyzeFeedback: analyzeFeedback,
    statusOf: statusOf, detectTrend: detectTrend, ruleOf: ruleOf, analyzeMetrics: analyzeMetrics,
    dailyCheck: dailyCheck, tagUsers: tagUsers, integrated: integrated, daysBetween: daysBetween, thresholdText: thresholdText
  };
});
