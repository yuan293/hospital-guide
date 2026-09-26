const $ = s => document.querySelector(s);
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ratio = m => m?.value == null ? '—（无样本）' : (m.value * 100).toFixed(1) + '% (' + m.numerator + '/' + m.denominator + ')';
const statusNames = { recommendation: '科室建议', emergency: '急诊分流', human: '人工协助', uncertain: '存疑弃权', question: '继续追问', skipped: '本模式不适用', error: '执行错误' };
const reasonNames = { ambiguous: '追问后证据仍并列', unlocated: '定位失败', model_conflict: '规则与模型分歧', evidence_invalid: '模型证据未过核验' };
const describe = r => (statusNames[r.status] || r.status) + (r.department ? ' / ' + r.department : '') + (r.question ? ' / ' + r.question : '') + (r.reasonCode ? ' / ' + (reasonNames[r.reasonCode] || r.reasonCode) : '');
// 带有 anyOf 的预期：主结局 + 等价安全结局（如模型老实返回空转人工 / 脑补被拦弃权）。
const describeExpected = r => describe(r) + (Array.isArray(r.anyOf) ? '（等价安全结局：' + r.anyOf.map(describe).join(' 或 ') + '）' : '');
let busy = false;
export async function renderEvaluation() {
  if (busy) return;
  busy = true;
  $('#refresh-evaluation').disabled = true;
  $('#evaluation-status').textContent = '正在读取本机评测记录…';
  $('#evaluation-content').replaceChildren();
  try {
    const response = await fetch('/api/evaluation');
    if (!response.ok) throw new Error('读取评测失败，请确认已重启新版服务。');
    const data = await response.json();
    if (!data.available) {
      $('#evaluation-status').textContent = data.reason + ' 两模型对照：npm run evaluate:models';
      return;
    }
    const r = data.report;
    $('#evaluation-status').textContent = '完成时间：' + new Date(r.completedAt).toLocaleString('zh-CN') + ' · ' + r.dataset.cases + ' 条案例 · ' + r.modes.length + ' 组实测结果';
    const metrics = [
      ['全部案例符合预期', m => ratio(m.exactMatch)],
      ['科室命中率', m => ratio(m.departmentAccuracy)],
      ['急诊识别率', m => ratio(m.emergencyRecall)],
      ['急诊漏分流数', m => m.emergencyMisses],
      ['非急诊误触发率', m => ratio(m.falseEmergencyRate)],
      ['人工转接率', m => ratio(m.humanTransferRate)],
      ['应转人工识别率', m => ratio(m.humanRecall)],
      ['存疑弃权率', m => ratio(m.abstentionRate)],
      ['规则/模型分歧弃权率', m => ratio(m.conflictRate)],
      ['模型证据失效弃权率', m => ratio(m.evidenceInvalidRate)],
      ['平均决策轮数', m => m.avgTurns ?? '—'],
      ['模型成功 / 调用次数', m => m.modelSuccesses + ' / ' + m.modelAttempts],
      ['模型失败次数', m => m.modelFailures],
      ['平均 / P95 耗时', m => m.meanMs + ' / ' + m.p95Ms + ' ms'],
    ];
    $('#evaluation-content').innerHTML =
      (data.stale ? '<div class="banner danger">代码或数据已经变化，这份结果已过期。请重新运行评测后再使用指标。</div>' : '<p class="eval-verified">✓ 结果指纹与当前代码及数据一致</p>') +
      (r.skipped.length ? '<div class="banner notice">' + r.skipped.map(s => escape(s.model + '：' + s.reason)).join('<br>') + '</div>' : '') +
      '<div class="eval-actions"><button id="download-evaluation" class="button primary">下载完整结果 JSON</button><span>重跑：<code>npm run evaluate:models</code> · 仅规则：<code>npm run evaluate</code></span></div>' +
      '<div class="eval-table-wrap" tabindex="0" aria-label="评测指标表，可横向滚动"><table class="eval-table"><caption>同一评测集的模式对照 · 分子 / 分母随指标展示</caption><thead><tr><th scope="col">指标</th>' + r.modes.map(m => '<th scope="col">' + escape(m.label) + '</th>').join('') + '</tr></thead><tbody>' +
      metrics.map(([label, fn]) => '<tr><th scope="row">' + label + '</th>' + r.modes.map(m => '<td>' + escape(fn(m.metrics)) + '</td>').join('') + '</tr>').join('') +
      '<tr><th scope="row">已知行为回归</th>' + r.modes.map(m => '<td>' + ratio(m.regression.exactMatch) + '</td>').join('') + '</tr><tr><th scope="row">扩展压力案例</th>' + r.modes.map(m => '<td>' + ratio(m.challenge.exactMatch) + '</td>').join('') + '</tr></tbody></table></div>' +
      '<p class="field-help">科室命中率的分母是预期应推荐科室的案例；急诊识别率的分母是预期急诊案例。人工转接率与存疑弃权率均以全部实测案例为分母，并非越低越好——弃权表示系统主动承认证据不足或规则/模型分歧。rules 为 legacy 固定追问消融基线，dynamic/workflow 启用信息增益追问，平均决策轮数含安全槽与动态追问。耗时包含本次加载模型的等待。</p>' +
      '<h2>逐条核验</h2><div class="eval-filters"><label>对照模式<select id="eval-mode">' + r.modes.map((m, i) => '<option value="' + i + '">' + escape(m.label) + '</option>').join('') + '</select></label><label class="eval-checkbox"><input id="eval-failures" type="checkbox" checked> 只看未符合预期的案例</label></div><div id="eval-cases"></div>' +
      '<details class="eval-details"><summary>评测方法、来源与复现信息</summary><p>' + escape(r.note) + '</p><ul>' + r.limitations.map(s => '<li>' + escape(s) + '</li>').join('') + '</ul><p>案例集：' + escape(r.dataset.id + ' / ' + r.dataset.version) + '</p><p>数据 SHA-256：<code>' + escape(r.dataset.sha256) + '</code></p><p>代码与配置 SHA-256：<code>' + escape(r.fingerprint.sha256) + '</code></p><p>环境：' + escape(r.environment.node + ' / ' + r.environment.platform + ' / ' + r.environment.cpu) + '</p><p>每组模型的版本摘要与逐轮原文映射已保存在下载的 JSON 中。文件不包含网页用户会话。</p></details>';
    const drawCases = () => {
      const mode = r.modes[Number($('#eval-mode').value)];
      const rows = mode.rows.filter(row => !$('#eval-failures').checked || !row.pass);
      $('#eval-cases').innerHTML = '<p class="field-help">显示 ' + rows.length + ' / ' + mode.metrics.total + ' 条实测（本模式未纳入 ' + mode.metrics.skipped + ' 条） · 模型失败并回退的次数：' + mode.metrics.modelFailures + '</p>' + rows.map(row =>
        '<details class="eval-case"><summary><span class="' + (row.pass ? 'eval-pass' : 'eval-fail') + '">' + (row.skipped ? '不适用' : row.pass ? '通过' : '待改进') + '</span> ' + escape(row.id + ' · ' + row.category + ' · ' + row.chief) +
        '</summary><p>预期：' + escape(describeExpected(row.expected)) + (row.labelNote ? '<br><span class="field-help">' + escape(row.labelNote) + '</span>' : '') + '<br>实际：' + escape(describe(row.actual)) + '</p><p>耗时 ' + row.elapsedMs + ' ms · 模型调用 ' + row.modelAttempts + ' 次' + (row.error ? ' · 错误：' + escape(row.error) : '') + '</p><ol>' +
        row.trace.map(t => '<li>' + escape(describe(t)) + (t.gain != null ? ' · 信息增益 ' + t.gain + ' 分（并列：' + escape((t.leaders || []).join('、')) + '）' : '') + (t.model?.used ? ' · ' + escape(t.model.matches.map(m => m.evidence + ' → ' + m.keyword).join('；') || '无额外症状') : t.model?.failed ? ' · 模型调用失败，规则回退' : t.model?.attempted ? ' · 模型未给出通过核验的证据，规则继续' : ' · 规则处理') + '</li>').join('') + '</ol></details>').join('') + (!rows.length ? '<p class="empty">这一模式没有未符合预期的案例。可取消筛选查看全部。</p>' : '');
    };
    $('#eval-mode').onchange = drawCases;
    $('#eval-failures').onchange = drawCases;
    drawCases();
    $('#download-evaluation').onclick = () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'hospital-guide-evaluation.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
  } catch (e) { $('#evaluation-status').textContent = e.message; }
  finally { busy = false; $('#refresh-evaluation').disabled = false; }
}
$('#refresh-evaluation').onclick = renderEvaluation;
