/* charts.js — 轻量 SVG 图表（无第三方依赖） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.OpsCharts = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var STATUS_COLOR = { '正常': '#12a870', '需关注': '#e0a020', '异常': '#e5484d', '无数据': '#9aa0b4' };

  function escapeXml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  /** 迷你趋势线 */
  function sparkline(values, opts) {
    opts = opts || {};
    var w = opts.width || 110, h = opts.height || 28, pad = 2;
    var vals = (values || []).filter(function (v) { return typeof v === 'number' && !isNaN(v); });
    if (vals.length < 2) { return '<svg class="spark" width="' + w + '" height="' + h + '"></svg>'; }
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), span = (max - min) || 1;
    var step = (w - pad * 2) / (vals.length - 1);
    var pts = vals.map(function (v, i) { return [pad + i * step, h - pad - ((v - min) / span) * (h - pad * 2)]; });
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var color = opts.color || '#7c5cff';
    var area = d + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + (h - pad) + ' L' + pts[0][0].toFixed(1) + ' ' + (h - pad) + ' Z';
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<path d="' + area + '" fill="' + color + '" opacity="0.10"></path>' +
      '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"></path>' +
      '<circle cx="' + pts[pts.length - 1][0].toFixed(1) + '" cy="' + pts[pts.length - 1][1].toFixed(1) + '" r="2.4" fill="' + color + '"></circle></svg>';
  }

  /** 折线图：points = [{date,value}]；可传 threshold 参考线 */
  function lineChart(points, opts) {
    opts = opts || {};
    var w = opts.width || 640, h = opts.height || 220;
    var L = 46, R = 12, T = 14, B = 26;
    var pts = (points || []).filter(function (p) { return typeof p.value === 'number'; });
    if (pts.length < 2) { return '<p class="muted">数据点不足，无法绘制趋势图</p>'; }
    var vals = pts.map(function (p) { return p.value; });
    var thr = opts.threshold;
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (thr !== undefined && thr !== null) { min = Math.min(min, thr); max = Math.max(max, thr); }
    var padV = (max - min) * 0.15 || 1; min -= padV; max += padV;
    var sx = function (i) { return L + (i / (pts.length - 1)) * (w - L - R); };
    var sy = function (v) { return T + (1 - (v - min) / (max - min)) * (h - T - B); };
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + sx(i).toFixed(1) + ' ' + sy(p.value).toFixed(1); }).join(' ');
    var color = opts.color || '#7c5cff';
    var grid = [0, 1, 2, 3].map(function (k) {
      var v = min + (max - min) * (k / 3), y = sy(v);
      return '<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (w - R) + '" y2="' + y.toFixed(1) + '" stroke="#eeecf7" stroke-width="1"></line>' +
        '<text x="' + (L - 6) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="#9a97b0">' + (Math.round(v * 10) / 10) + '</text>';
    }).join('');
    var thrLine = (thr === undefined || thr === null) ? '' :
      '<line x1="' + L + '" y1="' + sy(thr).toFixed(1) + '" x2="' + (w - R) + '" y2="' + sy(thr).toFixed(1) + '" stroke="#e5484d" stroke-width="1.2" stroke-dasharray="5 4"></line>' +
      '<text x="' + (w - R) + '" y="' + (sy(thr) - 5).toFixed(1) + '" text-anchor="end" font-size="10" fill="#e5484d">阈值 ' + thr + '</text>';
    var labels = [0, Math.floor((pts.length - 1) / 2), pts.length - 1].map(function (i) {
      return '<text x="' + sx(i).toFixed(1) + '" y="' + (h - 8) + '" text-anchor="' + (i === 0 ? 'start' : (i === pts.length - 1 ? 'end' : 'middle')) + '" font-size="10" fill="#9a97b0">' + escapeXml(String(pts[i].date)) + '</text>';
    }).join('');
    var dots = pts.map(function (p, i) {
      return '<circle cx="' + sx(i).toFixed(1) + '" cy="' + sy(p.value).toFixed(1) + '" r="2.6" fill="#fff" stroke="' + color + '" stroke-width="1.6"><title>' + escapeXml(p.date + '：' + p.value) + '</title></circle>';
    }).join('');
    return '<svg class="line" viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '" preserveAspectRatio="xMidYMid meet">' +
      grid + thrLine +
      '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round"></path>' + dots + labels + '</svg>';
  }

  /** 环形图：segments = [{label,value,color}] */
  function donut(segments, opts) {
    opts = opts || {};
    var size = opts.size || 148, r = size / 2 - 12, cx = size / 2, cy = size / 2;
    var total = segments.reduce(function (a, s) { return a + s.value; }, 0);
    if (!total) { return '<p class="muted">无数据</p>'; }
    var acc = -Math.PI / 2, parts = [];
    segments.forEach(function (s) {
      var ang = (s.value / total) * Math.PI * 2, end = acc + ang;
      var large = ang > Math.PI ? 1 : 0;
      var x1 = cx + r * Math.cos(acc), y1 = cy + r * Math.sin(acc), x2 = cx + r * Math.cos(end), y2 = cy + r * Math.sin(end);
      if (s.value > 0) {
        parts.push('<path d="M' + x1.toFixed(1) + ' ' + y1.toFixed(1) + ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x2.toFixed(1) + ' ' + y2.toFixed(1) + '" fill="none" stroke="' + s.color + '" stroke-width="16"><title>' + escapeXml(s.label + '：' + s.value) + '</title></path>');
      }
      acc = end;
    });
    return '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">' + parts.join('') +
      '<text x="' + cx + '" y="' + (cy - 2) + '" text-anchor="middle" font-size="20" font-weight="700" fill="#1c1b2e">' + total + '</text>' +
      '<text x="' + cx + '" y="' + (cy + 16) + '" text-anchor="middle" font-size="11" fill="#9a97b0">' + escapeXml(opts.centerLabel || '总条数') + '</text></svg>';
  }

  function barRows(items) {
    return '<div class="bars">' + items.map(function (it) {
      return '<div class="bar-row"><span class="bar-label">' + escapeXml(it.label) + '</span>' +
        '<span class="bar-track"><i style="width:' + Math.max(2, Math.min(100, it.pct)) + '%' + (it.color ? ';background:' + it.color : '') + '"></i></span>' +
        '<span class="bar-val">' + it.value + '</span></div>';
    }).join('') + '</div>';
  }

  return { sparkline: sparkline, lineChart: lineChart, donut: donut, barRows: barRows, STATUS_COLOR: STATUS_COLOR, escapeXml: escapeXml };
});