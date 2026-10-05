// 词表与路由全景页的渲染（0.9.9 新增）。数据全部来自服务端 /api/panorama，
// 前端不重算任何匹配——口径只在 lib/panorama.js 一处，避免「页面说的能力」与
// 「实际跑出来的能力」再次分叉。
const $ = s => document.querySelector(s);
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LAYER_LABEL = { literal: '字面', morphology: '形态', synonym: '同义' };
let busy = false;

function statCard(label, value, hint) {
  return `<div class="pn-stat"><strong>${escape(value)}</strong><span>${escape(label)}</span>${hint ? `<small>${escape(hint)}</small>` : ''}</div>`;
}

export async function renderPanorama() {
  if (busy) return;
  busy = true;
  $('#refresh-panorama').disabled = true;
  $('#panorama-status').textContent = '正在盘点词表与路由…';
  $('#panorama-content').replaceChildren();
  try {
    const response = await fetch('/api/panorama');
    if (!response.ok) throw new Error('读取失败');
    const p = await response.json();
    const s = p.stats;
    $('#panorama-status').textContent = `已盘点 ${s.departments} 个科室 · ${s.keywordEntries} 条关键词 · ${s.synonymGroups} 组口语同义 · ${s.locationOptions} 个部位选项`;

    $('#panorama-content').innerHTML = `
      <div class="pn-stats">
        ${statCard('科室', s.departments, `可自助挂号 ${s.bookableDepartments}`)}
        ${statCard('关键词条目', s.keywordEntries, `去重后 ${s.uniqueKeywords}`)}
        ${statCard('口语同义组', s.synonymGroups, '与模型路径共用')}
        ${statCard('疼痛词', s.painTerms, `单方向登记 ${s.singleDirectionPain}`)}
        ${statCard('部位选项', s.locationOptions, s.locationAnomalies ? `异常 ${s.locationAnomalies}` : '每项恰好 1 科室')}
        ${statCard('词表偏薄科室', s.thinDepartments, `另有 ${s.vocabIndependentDepartments} 个不走词表入口`)}
      </div>

      <section class="pn-section">
        <h2>① 单方向疼痛词（${p.pain.singleDirection.length}）</h2>
        <p class="pn-lead">词表只登记了 <code>X痛</code> 或 <code>X疼</code> 的一个方向，另一方向由形态锚点兜底。下表逐条给出「另一方向能否被识别」的实测结果——这是患者真实体验到的能力，不是登记数量。</p>
        ${p.pain.singleDirection.length ? `<div class="pn-table-wrap"><table class="pn-table"><caption>形态锚点的实际覆盖情况</caption><thead><tr><th scope="col">已登记</th><th scope="col">所属科室</th><th scope="col">口语变体</th><th scope="col">形态可覆盖</th></tr></thead><tbody>${p.pain.singleDirection.map(x => `<tr><td><code>${escape(x.term)}</code></td><td>${escape(x.deptName)}</td><td><code>${escape(x.variant)}</code></td><td>${x.variantCovered ? '<span class="pn-ok">✓ 可识别</span>' : '<span class="pn-gap">✗ 缺口</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="field-help">无单方向登记项。</p>'}
      </section>

      <section class="pn-section">
        <h2>② 部位路由（location 探针）</h2>
        <p class="pn-lead">不确定挂哪科时先问部位，每个选项应恰好落到一个科室。<code>说不清</code> 项刻意不指向任何科室，交由后续追问。</p>
        <div class="pn-table-wrap"><table class="pn-table"><caption>12 个选项 → 目标科室</caption><thead><tr><th scope="col">选项</th><th scope="col">患者看到的文案</th><th scope="col">目标科室</th></tr></thead><tbody>${p.location.options.map(o => `<tr${o.targetCount !== 1 && o.value !== 'unknown' ? ' class="pn-row-warn"' : ''}><td><code>${escape(o.value)}</code></td><td>${escape(o.label)}</td><td>${o.targets.length ? o.targets.map(t => `<code>${escape(t.id)}</code>`).join('、') : '<span class="pn-muted">（不直接定位）</span>'}</td></tr>`).join('')}</tbody></table></div>
      </section>

      <section class="pn-section">
        <h2>③ 安全路径锚点（${p.pathways.length}）</h2>
        <p class="pn-lead">这些说法必须先走红旗征安全确认，不得被词表命中「抄近路」直接推荐科室。<code>与词表重叠</code> 一列列出同时存在于科室关键词的锚点，由 <code>spanAllowed</code> 护栏兜底。</p>
        ${p.pathways.map(pw => `<article class="pn-pathway"><h3>${escape(pw.title)}</h3><p class="pn-anchors">锚点：${pw.anchors.map(a => `<code>${escape(a)}</code>`).join('、')}</p>${pw.overlappingKeywords.length ? `<p class="pn-overlap">与词表重叠：${pw.overlappingKeywords.map(o => `<code>${escape(o.term)}</code>→${escape(o.dept)}`).join('、')}</p>` : '<p class="field-help">与词表无重叠。</p>'}</article>`).join('')}
      </section>

      <section class="pn-section">
        <h2>④ 口语同义表（${p.synonyms.groups.length} 组）</h2>
        <p class="pn-lead">与模型证据核验共用同一份登记表。标 <code>约束</code> 的组，核心词后必须紧跟限定窗口（如 <code>脑袋</code>+疼/痛），覆盖面比无约束窄。</p>
        <div class="pn-table-wrap"><table class="pn-table"><caption>canonical → 口语说法</caption><thead><tr><th scope="col">规范词</th><th scope="col">对应科室</th><th scope="col">口语说法</th></tr></thead><tbody>${p.synonyms.groups.map(g => `<tr><td><code>${escape(g.canonical)}</code></td><td>${g.dept ? escape(g.dept) : '<span class="pn-muted">未挂科室词</span>'}</td><td>${g.cores.map(c => `<code${g.constrained.includes(c) ? ' class="pn-constrained"' : ''}>${escape(c)}</code>`).join('、')}</td></tr>`).join('')}</tbody></table></div>
      </section>

      <section class="pn-section">
        <h2>⑤ 科室词表密度</h2>
        <p class="pn-lead">关键词少的科室，路由主要靠追问与形态锚点而非词表命中。标 <span class="pn-thin">词表偏薄</span> 的科室建议优先补充口语说法；标 <span class="pn-muted">不入词表入口</span> 的科室（急诊靠红旗征闸门、医技科室不参与导诊评分）本就不依赖词表密度，不计入偏薄。</p>
        <div class="pn-table-wrap"><table class="pn-table"><caption>45 个科室 → 关键词条数</caption><thead><tr><th scope="col">科室</th><th scope="col">分组</th><th scope="col">条数</th><th scope="col">识别层分布</th></tr></thead><tbody>${[...p.departments].sort((a, b) => a.keywordCount - b.keywordCount).map(d => {
          const counts = { literal: 0, morphology: 0, synonym: 0 };
          for (const k of d.keywords) for (const l of k.layers) counts[l]++;
          const dist = ['literal', 'morphology', 'synonym'].filter(l => counts[l]).map(l => `${LAYER_LABEL[l]} ${counts[l]}`).join(' · ') || '—';
          const tag = d.thin ? ' <span class="pn-thin">词表偏薄</span>' : d.vocabIndependent ? ' <span class="pn-muted">不入词表入口</span>' : '';
          return `<tr${d.thin ? ' class="pn-row-thin"' : ''}><td>${escape(d.name)}${d.bookable ? '' : ' <span class="pn-muted">（不可自助挂号）</span>'}${tag}</td><td>${escape(d.group)}</td><td>${d.keywordCount}</td><td class="pn-dist">${escape(dist)}</td></tr>`;
        }).join('')}</tbody></table></div>
      </section>`;
  } catch {
    $('#panorama-status').textContent = '无法读取词表盘点，请确认应用服务仍在运行后重试。';
  } finally {
    busy = false;
    $('#refresh-panorama').disabled = false;
  }
}
