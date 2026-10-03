/* llm.js — 可选的 AI 解读（OpenAI 兼容接口；Key 只存本机浏览器） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.OpsLLM = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var RULE = '你只能基于给定事实作答：不要编造事实中没有的数字、用户或结论；事实不足时直接说明。';
  var TASK_PROMPT = {
    check: RULE + '你是运营分析师。下面是按固定规则算好的「每日晨检」事实，请用不超过 120 字写一段解读：先给一句话结论，再指出今天最该先处理的一件事。',
    feedback: RULE + '你是运营分析师。下面是按固定规则算好的「反馈分析」结果，请输出 3 条解读（每行以「- 」开头）：用户情绪与核心诉求、最值得先做的需求、一个容易被忽略的风险。',
    metrics: RULE + '你是运营分析师。下面是按固定规则算好的「指标分析」结果，请输出 3–4 条解读：拐点判断、最可能的归因（标明是假设）、下一步该验证什么。',
    tags: RULE + '你是运营分析师。下面是按固定规则算好的「用户分层」结果，请输出 3 条解读：该优先运营哪一层、哪一层在流失、建议的本周动作。',
    integrated: RULE + '你是运营分析师。下面是按固定规则算好的「整合分析（交叉验证）」结果，请输出 4 条解读：最关键的发现、印证与背离各说明了什么、策略建议里最该先做的一条及理由。'
  };
  function endpoint(baseUrl) {
    var b = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!b) { return ''; }
    if (/\/chat\/completions$/.test(b)) { return b; }
    return b + '/chat/completions';
  }
  function enhance(opts) {
    opts = opts || {};
    var llm = opts.llm || {};
    if (!llm.enabled) { return Promise.reject(new Error('未启用 AI 解读（到「口径设置」开启）')); }
    if (!llm.apiKey) { return Promise.reject(new Error('未填写 API Key')); }
    var url = endpoint(llm.baseUrl);
    if (!url) { return Promise.reject(new Error('未填写接口地址')); }
    var body = {
      model: llm.model || 'gpt-4o-mini',
      temperature: 0.3,
      messages: [
        { role: 'system', content: TASK_PROMPT[opts.task] || (RULE + '你是运营分析师，请基于给定事实写解读。') },
        { role: 'user', content: String(opts.facts || '').slice(0, 12000) }
      ]
    };
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + llm.apiKey },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { throw new Error('HTTP ' + res.status + '：' + String(t).slice(0, 140)); });
      }
      return res.json();
    }).then(function (data) {
      var txt = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!txt) { throw new Error('接口返回内容为空'); }
      return String(txt).trim();
    });
  }
  return { enhance: enhance, endpoint: endpoint, TASK_PROMPT: TASK_PROMPT };
});