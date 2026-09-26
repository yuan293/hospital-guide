import { renderEvaluation } from './evaluation.js';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let config, result, chief = '', answers = {}, busy = false, selectedModel = '', filter = 'all', controller, generation = 0;
// 入口模式：'' 未选择 | 'register' 直接挂号 | 'guide' 帮我导诊
let entryMode = '';
// 直接挂号面板里当前选中的科室，用于在列表上高亮。
let selectedRegister = '';
let preferredModel = null;
try { preferredModel = localStorage.getItem('hospital-guide.model'); } catch { /* Private browsing may disable storage. */ }
const labels = { risk: '紧急表现', age: '年龄段', duration: '持续时间', severity: '日常影响' };
const answerLabels = { no: '均没有', yes: '有紧急表现', unknown: '不确定', adult: '18岁及以上', child: '1至17岁', infant: '未满1岁', short: '少于24小时', days: '1至7天', long: '超过7天', mild: '影响较小', moderate: '影响日常活动', severe: '严重或迅速加重' };
// 动态鉴别问题（probes）的选项标签随 /api/config 下发，不在前端维护全局词表。
// “65岁及以上”只是前端展示细分：提交给导诊引擎时仍按 adult（老年按成人科室适用），
// 不改变 triage 规则、数据结构与评测口径；ageDisplay 仅用于界面回显。
let ageDisplay = null;
const slotLabel = key => labels[key] || config?.probes?.find(p => p.id === key)?.title || key;
const optionLabel = (key, value) => {
  if (key === 'age' && value === 'adult') {
    if (ageDisplay === 'senior') return '65岁及以上';
    if (ageDisplay === 'middle') return '41–64岁';
    if (ageDisplay === 'young') return '18–40岁';
  }
  return answerLabels[value] || config?.probes?.find(p => p.id === key)?.options.find(([id]) => id === value)?.[1] || value;
};

// ---- 关怀模式（适老化展示层）：大字号 / 高对比 / 宽触控，只作用于界面，不参与导诊逻辑 ----
const CARE_KEY = 'hospital-guide.care';
const CARE_SEEN_KEY = 'hospital-guide.care-seen';
const storageGet = key => { try { return localStorage.getItem(key); } catch { return null; } };
const storageSet = (key, value) => { try { localStorage.setItem(key, value); } catch { /* 隐私模式下禁用存储时，本次会话设置仍然生效。 */ } };
let careMode = storageGet(CARE_KEY) === '1';
function applyCareMode(on) {
  careMode = on;
  document.body.classList.toggle('care-mode', on);
  const toggle = $('#care-toggle');
  if (toggle) {
    toggle.setAttribute('aria-pressed', String(on));
    toggle.textContent = on ? '关怀模式：开' : '关怀模式';
  }
}
function setCareMode(on) { storageSet(CARE_KEY, on ? '1' : '0'); applyCareMode(on); }
// 用户主动操作过开关，或在知情同意弹窗里做过选择后，不再自动询问。
function markCareSeen() { storageSet(CARE_SEEN_KEY, '1'); }
function maybeOfferCareMode() {
  if (careMode || storageGet(CARE_SEEN_KEY) === '1') return;
  $('#care-dialog').showModal();
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败。');
  return data;
}

function setBusy(value) {
  busy = value;
  $('#loading').hidden = !value;
  $('#submit-chief').disabled = value;
  $$('.options button').forEach(button => { button.disabled = value; });
  $$('#samples button').forEach(button => { button.disabled = value; });
}

function showError(message) {
  $('#request-error').innerHTML = escape(message);
  $('#request-error').hidden = false;
}

// ---- 入口：直接挂号 / 帮我导诊 ----
function showEntry() {
  entryMode = '';
  $('#entry-cards').hidden = false;
  $('#register-panel').hidden = true;
  $('#guide-panel').hidden = true;
  $('#reset').hidden = true;
  $('#guide-title').textContent = '今天想怎么开始？';
  $('#guide-subtitle').textContent = '知道挂哪个科就直接挂号；不确定的话，我帮你判断。';
}

function showGuide() {
  entryMode = 'guide';
  $('#entry-cards').hidden = true;
  $('#register-panel').hidden = true;
  $('#guide-panel').hidden = false;
  $('#reset').hidden = false;
  $('#guide-title').textContent = '今天，哪里不舒服？';
  $('#guide-subtitle').textContent = '先说说你的情况，我们一起确认就诊方向。';
}

// 直接挂号：让用户自己选科室。原型没有号源，因此只给位置与就诊提示，
// 并明确说明挂号要走医院官方渠道——不假装这里能完成挂号。
// 房间号是纯数字时补上“诊室”，像“急诊入口”这类就按原文展示。
const locationText = department => (/^\d+$/.test(department.room) ? `${department.floor} · ${department.room} 诊室` : `${department.floor} · ${department.room}`);
const roomText = department => (/^\d+$/.test(department.room) ? `${department.room} 诊室` : department.room);

function renderRegisterList() {
  if (!config) return;
  const text = $('#register-search').value.trim().toLowerCase();
  const list = config.departments.filter(department => `${department.name}${department.summary}${department.keywords.join(' ')}${department.group}`.toLowerCase().includes(text));
  if (!list.length) {
    $('#register-list').innerHTML = '<p class="empty">没有匹配的科室。换个关键词试试，或者返回让导诊帮你判断。</p>';
    return;
  }
  // 按内科/外科/专科/急诊分组，在门诊大厅里能一眼扫到目标科室。
  const preferred = ['内科', '外科', '专科', '急诊'];
  const groups = [
    ...preferred.filter(group => list.some(department => department.group === group)),
    ...new Set(list.map(department => department.group).filter(group => !preferred.includes(group))),
  ];
  $('#register-list').innerHTML = groups.map(group => {
    const members = list.filter(department => department.group === group);
    const rows = members.map(department => `<button type="button" class="register-row" data-register="${escape(department.id)}"${selectedRegister === department.id ? ' aria-pressed="true"' : ''}><span class="register-floor">${escape(department.floor)}</span><span class="register-body"><span class="register-name">${escape(department.name)}</span><span class="register-summary">${escape(department.summary)}</span><span class="register-meta">${escape(roomText(department))} · ${escape(department.zone)} 区</span></span></button>`).join('');
    return `<section class="register-group"><h3>${escape(group)}<span>${members.length} 个科室</span></h3><div class="register-rows">${rows}</div></section>`;
  }).join('');
}

function showRegisterResult(department) {
  selectedRegister = department.id;
  renderRegisterList();
  const ageText = department.age === 'child' ? '1 至 17 岁' : department.age === 'all' ? '所有年龄' : '18 岁及以上';
  $('#register-result').innerHTML = `<div class="register-card"><div class="register-card-head"><span class="register-tag">挂号指引</span><h2>${escape(department.name)}</h2></div><p class="register-path">${escape(locationText(department))} · ${escape(department.zone)} 区</p><p class="register-line">${escape(department.summary)}</p><dl class="register-facts"><div><dt>接诊范围</dt><dd>${escape(ageText)}</dd></div><div><dt>相关症状</dt><dd>${escape(department.keywords.join('、'))}</dd></div><div><dt>怎么挂号</dt><dd>本原型没有接入真实号源，请通过医院官方渠道挂号</dd></div></dl><div class="banner notice"><span class="notice-mark" aria-hidden="true">i</span><div>科室与位置均为虚构示例；真实挂号与就诊安排请以医院官方渠道为准。</div></div><div class="register-actions"><button type="button" class="button secondary" id="register-again">再看其他科室</button><button type="button" class="button secondary" id="register-to-guide">不确定，帮我导诊</button><button type="button" class="button primary" id="register-book">确认挂该科室</button></div></div>`;
  $('#register-result').hidden = false;
  $('#register-again').onclick = () => { selectedRegister = ''; $('#register-result').hidden = true; renderRegisterList(); $('#register-search').focus(); };
  $('#register-to-guide').onclick = () => { showGuide(); $('#chief').focus(); };
  $('#register-book').onclick = () => openBooking(department);
  $('#register-result').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function showRegister() {
  entryMode = 'register';
  $('#entry-cards').hidden = true;
  $('#guide-panel').hidden = true;
  $('#register-panel').hidden = false;
  $('#reset').hidden = false;
  $('#guide-title').textContent = '我要直接挂号';
  $('#guide-subtitle').textContent = '选好科室，这里告诉你位置和就诊提示。';
  $('#register-result').hidden = true;
  $('#register-search').value = '';
  selectedRegister = '';
  renderRegisterList();
  $('#register-search').focus();
}

// 自动演示脚本：用规则流程（避免模型冷加载等待）脚本化走完流程，任何人工操作立即接管。
// 展示安全确认（红旗征）→ 信息增益鉴别追问 → 科室建议的完整链路。
const DEMO = {
  chief: '上腹痛，还尿频',
  picks: {
    risk: 'no', age: 'adult', duration: 'days', severity: 'mild',
    rf_gi_bleed: 'no', rf_epigastric_cardiac: 'no', rf_epigastric_acute: 'no',
    p_abdomen_urine: 'no',
  },
};
let demoActive = false;
// 一次性“程序化事件”标志：只在演示脚本同步派发 submit/click 的瞬间为 true。
// 不使用 event.isTrusted 区分人工与脚本——实测内嵌 webview 中合成事件的
// isTrusted 取值与标准浏览器不一致，会导致演示刚启动就被自己的事件掐停。
let programmaticSubmit = false;
let programmaticClick = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitIdle = async () => { while (busy) await sleep(80); };
// 演示横幅演示期间固定在视口顶部：消息流会不断自动滚动，普通内嵌位置会被滚出视野。
function setDemoBanner(show) {
  const banner = $('#demo-banner');
  banner.hidden = !show;
  banner.classList.toggle('demo-stuck', show);
}
function stopDemo() { demoActive = false; setDemoBanner(false); }
async function runDemo() {
  if (busy || demoActive) return;
  resetSession(); showGuide();
  demoActive = true; setDemoBanner(true);
  const previousModel = selectedModel;
  selectedModel = ''; $('#model-select').value = ''; updateMode();
  try {
    $('#chief').value = DEMO.chief;
    $('#chief').dispatchEvent(new Event('input'));
    programmaticSubmit = true;
    $('#chief-form').requestSubmit();
    programmaticSubmit = false;
    await waitIdle();
    // 上腹痛路径包含 3 项红旗征 + 3 项现病史，加上安全槽与可能的鉴别追问，
    // 轮次上限需要覆盖完整路径，否则演示会在路径中途停住。
    for (let guard = 0; guard < 14 && demoActive; guard++) {
      if (!result || result.status !== 'question') break;
      const pick = DEMO.picks[result.question.id];
      await sleep(1300);
      if (!demoActive) break;
      const card = $('#messages .assistant-message:last-child');
      const button = card?.querySelector(`button[data-answer="${pick}"]`);
      if (!button) break;
      programmaticClick = true;
      button.click();
      programmaticClick = false;
      await waitIdle();
    }
  } finally {
    stopDemo();
    selectedModel = previousModel; $('#model-select').value = selectedModel; updateMode();
  }
}

function facts() {
  const probeIds = (config?.probes || []).map(p => p.id);
  const rows = [['主要不适', chief || '待填写']];
  for (const key of ['age', 'duration', 'severity', ...probeIds]) {
    if (answers[key] !== undefined) rows.push([slotLabel(key), optionLabel(key, answers[key])]);
  }
  $('#patient-facts').innerHTML = rows.map(([k, v]) => `<div><dt>${escape(k)}</dt><dd>${escape(v)}</dd></div>`).join('');
}

function updateStep(step) {
  $$('.steps li').forEach(li => li.classList.toggle('current', Number(li.dataset.step) === step));
  $('#step-label').textContent = ['尚未开始', `已补充 ${Object.keys(answers).length} 项信息`, '本次导诊已结束'][step];
}

// 清空本次会话（不动入口选择）。演示脚本与“重新开始”共用。
function resetSession() {
  demoActive = false; programmaticSubmit = false; programmaticClick = false; setDemoBanner(false);
  generation++; controller?.abort(); chief = ''; answers = {}; ageDisplay = null; result = null;
  $('#messages').replaceChildren(); $('#request-error').hidden = true; $('#samples').hidden = false;
  $('#chief-form').hidden = false; $('#result-actions').hidden = true; $('#chief').value = ''; $('#char-count').textContent = '0 / 1200';
  setBusy(false); updateStep(0); facts();
}

// “重新开始”回到入口，让用户重新选直接挂号还是导诊。
function reset() {
  resetSession();
  showEntry();
}

function showResult(data) {
  const department = config.departments.find(d => d.id === data.department);
  const names = { recommendation: '就诊参考', emergency: '优先处理', human: '人工协助', uncertain: '存疑弃权' };
  const block = document.createElement('article'); block.className = `result ${data.status}`; block.tabIndex = -1;
  block.innerHTML = `<div class="result-title"><h3>${escape(data.title)}</h3><span class="result-badge">${names[data.status]}</span></div><p class="result-reason">${escape(data.reason)}</p>${department ? `<div class="result-location"><strong>${escape(department.name)}</strong><span>示例位置：${escape(department.floor)} · ${escape(department.room)}</span></div>` : ''}<h4>判断依据</h4><ul>${data.evidence.map(x => `<li>${escape(x)}</li>`).join('')}</ul><p class="result-next">${escape(data.next)}</p>${data.status === 'recommendation' && department ? '<div class="result-book"><button type="button" class="button primary" id="result-book">确认挂该科室</button></div>' : ''}<div class="sources-links">${data.sources.map(id => `<a href="#sources">${escape(config.sources.find(s => s.id === id)?.title || id)} ↗</a>`).join('')}</div>${data.model.note ? `<p class="model-note">${escape(data.model.note)}</p>` : ''}`;
  if (data.model.used) {
    const trace = document.createElement('p'); trace.className = 'model-note';
    trace.textContent = `本次模型调用：${data.model.name} · ${(data.model.elapsedMs / 1000).toFixed(1)}秒` + (data.model.matches.length ? ` · ${data.model.matches.map(m => `“${m.evidence}” → ${m.keyword}`).join('；')}` : ' · 未提取到额外症状');
    block.append(trace);
  }
  const bookButton = block.querySelector('#result-book');
  if (bookButton) bookButton.onclick = () => openBooking(department);
  $('#messages').append(block); $('#result-actions').hidden = false; updateStep(2); block.focus({ preventScroll: true });
}

// 动态追问的可解释说明：让“为什么问这个问题”可见，而不是只呈现问题本身。
function probeRationale(q) {
  const meta = q.meta;
  if (!meta) return '';
  if (meta.kind === 'location') return '<p class="probe-rationale">当前描述还没有定位到任何身体部位，先确定部位比直接猜测科室更可靠。</p>';
  if (meta.kind === 'differential' && Array.isArray(meta.leaders)) {
    const names = meta.leaders.map(id => config?.departments?.find(d => d.id === id)?.name || id).join(' 与 ');
    return `<p class="probe-rationale">为什么问这个：目前 <strong>${escape(names)}</strong> 的证据相同（并列领先），该问题的回答最多能拉开 <strong>${escape(String(meta.gain))}</strong> 分鉴别差距，是当前信息增益最大的问题。</p>`;
  }
  if (meta.kind === 'redflag') {
    return `<p class="probe-rationale">为什么问这个：这是<strong>${escape(meta.pathwayTitle || '本次主诉')}</strong>的红旗征筛查。需要先排除必须尽快处理的征象，再谈去哪个科，所以它排在所有科室相关问题之前。</p>`;
  }
  return '';
}

function showQuestion(data) {
  const q = data.question;
  const message = document.createElement('div'); message.className = 'message assistant-message'; message.dataset.question = q.id;
  // 年龄问题在展示层把“18岁及以上”细分为 18–40 岁 / 41–64 岁 / 65 岁及以上；
  // 三档提交给导诊引擎的值都是 adult，65+ 额外携带 data-age-display 供界面回显与关怀提示。
  const optionsHtml = q.id === 'age'
    ? q.options.map(([value, label]) => value === 'adult'
      ? `<button type="button" data-answer="adult" data-age-display="young" data-question="age">18–40岁</button><button type="button" data-answer="adult" data-age-display="middle" data-question="age">41–64岁</button><button type="button" data-answer="adult" data-age-display="senior" data-question="age">65岁及以上</button>`
      : `<button type="button" data-answer="${escape(value)}" data-question="age">${escape(label)}</button>`).join('')
    : q.options.map(([value, label]) => `<button type="button" data-answer="${escape(value)}" data-question="${q.id}">${escape(label)}</button>`).join('');
  message.innerHTML = `<div class="message-label">导诊助手</div><h3>${escape(q.title)}</h3><p>${escape(q.description)}</p>${probeRationale(q)}<div class="options">${optionsHtml}</div>`;
  $('#messages').append(message);
  updateStep(1);
}

async function request() {
  if (busy) return;
  const id = generation;
  controller = new AbortController();
  $('#request-error').hidden = true; setBusy(true);
  try {
    const data = await api('/api/triage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chief, answers, model: selectedModel }), signal: controller.signal });
    if (id !== generation) return;
    result = data;
    $$('.options').forEach(group => {
      const key = group.closest('[data-question]').dataset.question;
      if (answers[key]) group.innerHTML = `<div class="answer-note">已选择：${escape(optionLabel(key, answers[key]))}</div>`;
    });
    $('#chief-form').hidden = true;
    data.status === 'question' ? showQuestion(data) : showResult(data);
    facts();
  } catch (error) {
    if (id !== generation || error.name === 'AbortError') return;
    $('#request-error').innerHTML = `${escape(error.message)} <button class="button secondary" id="retry">重试</button>`;
    $('#request-error').hidden = false;
    $('#retry').onclick = request;
  } finally {
    if (id === generation) {
      setBusy(false);
      const question = $('#messages .assistant-message:last-child');
      if (question && result?.status === 'question') {
        question.querySelector('button')?.focus({ preventScroll: true });
        question.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else if (result && result.status !== 'question') {
        $('#messages .result:last-child')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }
}

$('#chief-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return;
  if (!programmaticSubmit) stopDemo();
  const text = $('#chief').value.trim(); if (text.length < 2) return;
  chief = text; $('#samples').hidden = true;
  if (!$('#messages .user-message')) {
    const user = document.createElement('div'); user.className = 'message user-message'; user.textContent = chief; $('#messages').append(user);
  } else $('#messages .user-message').textContent = chief;
  facts(); request();
});
$('#chief').addEventListener('input', () => { $('#char-count').textContent = `${$('#chief').value.length} / 1200`; });
$('#samples').addEventListener('click', event => {
  const button = event.target.closest('[data-sample]'); if (!button || busy) return;
  stopDemo();
  $('#chief').value = button.dataset.sample; $('#chief').dispatchEvent(new Event('input')); $('#chief').focus();
});
$('#messages').addEventListener('click', event => {
  const button = event.target.closest('[data-answer]'); if (!button || busy) return;
  if (!programmaticClick) stopDemo();
  const question = button.dataset.question;
  if (question === 'age') ageDisplay = button.dataset.ageDisplay || null;
  answers[question] = button.dataset.answer;
  if (question === 'age' && ageDisplay === 'senior') maybeOfferCareMode();
  request();
});
$('#entry-cards').onclick = event => {
  const card = event.target.closest('[data-entry]');
  if (!card) return;
  if (card.dataset.entry === 'register') showRegister();
  else { showGuide(); $('#chief').focus(); }
};
$('#register-back').onclick = () => { resetSession(); showEntry(); };
$('#register-search').oninput = renderRegisterList;
$('#register-list').onclick = event => {
  const button = event.target.closest('[data-register]');
  if (!button) return;
  const department = config?.departments.find(item => item.id === button.dataset.register);
  if (department) showRegisterResult(department);
};
$('#demo-30s').onclick = runDemo;
$('#demo-stop').onclick = stopDemo;
// 关怀模式：顶部手动开关始终可用；用户手动操作过即视为已知晓，不再弹知情同意提示。
$('#care-toggle').addEventListener('click', () => { markCareSeen(); setCareMode(!careMode); });
$('#care-accept').onclick = () => { markCareSeen(); setCareMode(true); $('#care-dialog').close(); };
$('#care-decline').onclick = () => { markCareSeen(); $('#care-dialog').close(); };
$('#care-dialog-close').onclick = () => { markCareSeen(); $('#care-dialog').close(); };
// Esc 关闭等同拒绝：记住选择，不再重复打扰。
$('#care-dialog').addEventListener('cancel', markCareSeen);
applyCareMode(careMode);

// ---- 模拟挂号流程（纯前端演示：确认科室 → 号别 → 60秒支付 → 成功/超时/取消） ----
// 明确不接入真实支付、不产生真实订单；急诊与弃权结局没有挂号入口。
const BOOKING_LEVELS = {
  general: { label: '普通号', fee: 10, desc: '普通门诊诊查费（模拟）' },
  expert: { label: '专家号', fee: 30, desc: '专家门诊诊查费（模拟）' },
};
const BOOKING_COUNTDOWN = 60;
let booking = null;
let bookingTimer = null;
const bookingLocation = d => `${d.floor} · ${roomText(d)} · ${d.zone} 区`;
function clearBookingTimer() {
  if (bookingTimer !== null) { clearInterval(bookingTimer); bookingTimer = null; }
}
function bookingMockOrderNo() {
  const tail = String(Date.now()).slice(-8);
  const rand = String(Math.floor(Math.random() * 90) + 10);
  return `HG${tail}${rand}（模拟单号）`;
}
function openBooking(department) {
  booking = { department, level: null, remain: BOOKING_COUNTDOWN, orderNo: null };
  $('#booking-dialog').showModal();
  renderBookingConfirm();
}
function bookingMockBanner() {
  return '<div class="banner notice"><span class="notice-mark" aria-hidden="true">i</span><div><strong>模拟挂号流程</strong> 不产生真实订单与支付，科室和费用均为虚构演示；真实挂号请通过医院官方渠道。</div></div>';
}
function renderBookingConfirm() {
  clearBookingTimer();
  const d = booking.department;
  $('#booking-title').textContent = '确认挂号科室';
  $('#booking-body').innerHTML = `${bookingMockBanner()}
    <div class="booking-dept"><h3>${escape(d.name)}</h3><p>示例位置：${escape(bookingLocation(d))}</p><p class="booking-ask">是否确认挂该科室的号？</p></div>
    <div class="booking-actions"><button type="button" class="button secondary" id="booking-confirm-no">再想想</button><button type="button" class="button primary" id="booking-confirm-yes">确认挂该科室</button></div>`;
  $('#booking-confirm-no').onclick = () => $('#booking-dialog').close();
  $('#booking-confirm-yes').onclick = renderBookingLevel;
}
function renderBookingLevel() {
  clearBookingTimer();
  $('#booking-title').textContent = '选择号别';
  $('#booking-body').innerHTML = `${bookingMockBanner()}
    <p class="booking-ask">请选择本次要挂的号别：</p>
    <div class="booking-options">
      <button type="button" class="booking-option" data-level="general"><strong>普通号</strong><span>${escape(BOOKING_LEVELS.general.desc)}</span><span class="booking-fee">¥${BOOKING_LEVELS.general.fee}</span></button>
      <button type="button" class="booking-option" data-level="expert"><strong>专家号</strong><span>${escape(BOOKING_LEVELS.expert.desc)}</span><span class="booking-fee">¥${BOOKING_LEVELS.expert.fee}</span></button>
    </div>
    <div class="booking-actions"><button type="button" class="button secondary" id="booking-level-back">返回上一步</button></div>`;
  $$('#booking-body .booking-option').forEach(button => {
    button.onclick = () => { booking.level = button.dataset.level; renderBookingPayment(); };
  });
  $('#booking-level-back').onclick = renderBookingConfirm;
}
function renderBookingPayment() {
  const d = booking.department;
  const level = BOOKING_LEVELS[booking.level];
  booking.remain = BOOKING_COUNTDOWN;
  $('#booking-title').textContent = '模拟支付';
  $('#booking-body').innerHTML = `${bookingMockBanner()}
    <div class="booking-pay-head"><h3>${escape(d.name)} · ${escape(level.label)}</h3><p>应付诊查费（模拟）：<strong class="booking-fee">¥${level.fee}</strong></p></div>
    <div class="booking-pay-box"><div class="booking-pay-amount">¥${level.fee}</div><p>模拟支付通道，不会产生真实扣费</p><p class="booking-countdown-line">请在 <strong id="booking-countdown">${BOOKING_COUNTDOWN}</strong> 秒内完成支付，超时需重新挂号</p></div>
    <div class="booking-actions"><button type="button" class="button secondary" id="booking-unpaid">未付款</button><button type="button" class="button primary" id="booking-paid">我已付款成功</button></div>`;
  const countdown = $('#booking-countdown');
  $('#booking-paid').onclick = () => { booking.orderNo = bookingMockOrderNo(); renderBookingSuccess(); };
  $('#booking-unpaid').onclick = renderBookingCancelled;
  clearBookingTimer();
  bookingTimer = setInterval(() => {
    booking.remain -= 1;
    if (booking.remain <= 0) { clearBookingTimer(); renderBookingTimeout(); return; }
    countdown.textContent = String(booking.remain);
  }, 1000);
}
function renderBookingSuccess() {
  clearBookingTimer();
  const d = booking.department;
  const level = BOOKING_LEVELS[booking.level];
  $('#booking-title').textContent = '挂号成功';
  $('#booking-body').innerHTML = `<div class="booking-result booking-ok"><div class="booking-result-icon" aria-hidden="true">✓</div><h3>模拟挂号成功</h3>
    <dl class="booking-facts">
      <div><dt>就诊科室</dt><dd>${escape(d.name)}</dd></div>
      <div><dt>就诊位置</dt><dd>${escape(bookingLocation(d))}</dd></div>
      <div><dt>号别</dt><dd>${escape(level.label)}</dd></div>
      <div><dt>诊查费</dt><dd>¥${level.fee}（模拟）</dd></div>
      <div><dt>挂号单号</dt><dd>${escape(booking.orderNo)}</dd></div>
    </dl>
    <p>请按医院官方渠道的实际叫号安排就诊；以上信息均为虚构演示，不能用于真实就诊。</p>
    <div class="booking-actions"><button type="button" class="button primary" id="booking-done">完成</button></div></div>`;
  $('#booking-done').onclick = () => $('#booking-dialog').close();
}
function renderBookingTimeout() {
  $('#booking-title').textContent = '挂号失败';
  $('#booking-body').innerHTML = `<div class="booking-result booking-fail"><div class="booking-result-icon" aria-hidden="true">!</div><h3>支付超时，本次挂号失败</h3>
    <p>超过 60 秒未完成支付，号源已释放。如需就诊请重新挂号。</p>
    <div class="booking-actions"><button type="button" class="button secondary" id="booking-fail-close">关闭</button><button type="button" class="button primary" id="booking-retry">重新挂号</button></div></div>`;
  $('#booking-fail-close').onclick = () => $('#booking-dialog').close();
  $('#booking-retry').onclick = renderBookingConfirm;
}
function renderBookingCancelled() {
  clearBookingTimer();
  $('#booking-title').textContent = '已取消支付';
  $('#booking-body').innerHTML = `<div class="booking-result booking-fail"><div class="booking-result-icon" aria-hidden="true">!</div><h3>未完成支付，挂号未成功</h3>
    <p>你选择了“未付款”，本次模拟挂号已取消。</p>
    <div class="booking-actions"><button type="button" class="button secondary" id="booking-cancel-close">关闭</button><button type="button" class="button primary" id="booking-cancel-retry">重新挂号</button></div></div>`;
  $('#booking-cancel-close').onclick = () => $('#booking-dialog').close();
  $('#booking-cancel-retry').onclick = renderBookingConfirm;
}
$('#booking-close').onclick = () => $('#booking-dialog').close();
$('#booking-dialog').addEventListener('close', clearBookingTimer);
$('#reset').onclick = reset; $('#new-session').onclick = reset;
$('#download').onclick = () => {
  if (!result || result.status === 'question') return;
  const text = ['院内智导 - 演示导诊摘要', '仅供项目演示；不是疾病诊断，不用于真实诊疗。', `导出时间：${new Date().toLocaleString('zh-CN')}`, `模型参与：${result.model.used ? result.model.name : '本次使用规则流程'}`, '', `描述：${chief}`, ...Object.entries(answers).map(([k, v]) => `${slotLabel(k)}：${optionLabel(k, v)}`), '', result.title, result.reason, ...result.evidence, result.next, '', '资料：虚构示例配置，未经临床验证。'].join('\n');
  const url = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = 'hospital-guide-summary.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};

function renderDepartments() {
  if (!config) return;
  const text = $('#department-search').value.trim().toLowerCase();
  const list = config.departments.filter(d => (filter === 'all' || d.group === filter) && `${d.name}${d.summary}${d.keywords.join(' ')}`.toLowerCase().includes(text));
  $('#department-count').textContent = `共 ${list.length} 个科室 · 虚构示例`;
  $('#department-list').innerHTML = list.length ? list.map(d => `<article class="department-row"><div class="floor-tag">${escape(d.floor)}</div><div class="department-copy"><h3>${escape(d.name)}</h3><p>${escape(d.summary)}</p><small>${escape(d.zone)}区 · ${escape(d.room)} · ${d.age === 'child' ? '1至17岁' : d.age === 'all' ? '所有年龄' : '18岁及以上'}</small></div><button type="button" data-department="${d.id}" aria-label="查看${escape(d.name)}详情" title="查看科室详情">→</button></article>`).join('') : '<p class="empty">没有匹配的科室，请尝试其他关键词。</p>';
}
$('#department-search').oninput = renderDepartments;
$('#department-filters').onclick = event => {
  const button = event.target.closest('[data-filter]'); if (!button) return;
  filter = button.dataset.filter; $$('#department-filters button').forEach(b => b.setAttribute('aria-pressed', b === button)); renderDepartments();
};
$('#department-list').onclick = event => {
  const button = event.target.closest('[data-department]'); if (!button) return;
  const d = config.departments.find(x => x.id === button.dataset.department);
  $('#dialog-title').textContent = d.name;
  $('#dialog-content').innerHTML = `<p class="dialog-location">示例位置：${escape(d.floor)} · ${escape(d.room)}</p><p>${escape(d.summary)}</p><p>关联条目：${escape(d.keywords.join('、'))}</p><p>资料更新：${escape(config.hospital.updatedAt)}</p><div class="banner notice">这是虚构配置。真实就诊请向实际医院核实位置与接诊要求。</div><a href="#sources" id="dialog-source">查看资料来源 →</a>`;
  $('#dialog-source').onclick = () => $('#department-dialog').close(); $('#department-dialog').showModal();
};
$('#close-dialog').onclick = () => $('#department-dialog').close();
$('#department-dialog').addEventListener('click', e => { if (e.target === $('#department-dialog')) $('#department-dialog').close(); });

async function refreshModels() {
  $('#refresh-models').disabled = true; $('#model-status').textContent = '正在检查本机 Ollama 服务…';
  try {
    const health = await api('/api/health');
    const { available, models, endpoint } = health.ollama;
    $('#model-endpoint').textContent = endpoint;
    $('#model-status').textContent = !available ? '未连接 Ollama。当前可以继续使用规则演示模式。' : models.length ? `已连接 Ollama，可用模型 ${models.length} 个。` : '已连接 Ollama，但尚未安装模型。';
    const roles = { 'qwen2.5:7b': 'Qwen2.5 7B · 主模型', 'qwen2.5:1.5b': 'Qwen2.5 1.5B · 轻量模型' };
    const triageModels = models;
    $('#model-select').innerHTML = '<option value="">规则演示模式</option>' + triageModels.map(name => `<option value="${escape(name)}">${escape(roles[name] || name)}</option>`).join('');
    selectedModel = preferredModel === null ? (health.ollama.recommended || '') : triageModels.includes(preferredModel) ? preferredModel : '';
    $('#model-select').value = selectedModel; updateMode();
    $('#model-status').textContent += selectedModel ? ` 当前使用 ${selectedModel}。` : '';
  } catch { $('#model-status').textContent = '无法连接应用服务，请确认启动窗口仍在运行。'; }
  finally { $('#refresh-models').disabled = false; }
}
function updateMode() {
  $('#mode-label').textContent = selectedModel ? `${selectedModel} · 本地` : '规则演示模式';
  $('#model-warning').hidden = !selectedModel;
  $('#model-warning').textContent = '本地模型的输出仍可能不准确。此版本仅用于工程演示，未完成医疗专业审核。';
}
$('#model-select').onchange = () => {
  selectedModel = $('#model-select').value; preferredModel = selectedModel;
  try { localStorage.setItem('hospital-guide.model', selectedModel); } catch { /* Selection still applies to this page. */ }
  updateMode();
};
$('#refresh-models').onclick = refreshModels;
function navigate() {
  const allowed = ['guide', 'departments', 'sources', 'evaluation', 'settings'];
  const view = allowed.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'guide';
  $$('.view').forEach(section => { section.hidden = section.id !== `view-${view}`; });
  $$('.nav-link').forEach(link => { link.classList.toggle('active', link.dataset.view === view); if (link.dataset.view === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  $('#breadcrumb').textContent = `就诊服务 / ${{ guide: '挂号与导诊', departments: '科室目录', sources: '资料与来源', evaluation: '效果评测', settings: '运行设置' }[view]}`;
  if (view === 'guide' && !entryMode) showEntry();
  if (view === 'settings') refreshModels();
  if (view === 'evaluation') renderEvaluation();
}
window.addEventListener('hashchange', navigate);
try {
  config = await api('/api/config');
  renderDepartments();
  showEntry();
  $('#data-status').innerHTML = `<h2>数据版本与校验</h2><p>${escape(config.hospital.version)} · 更新于 ${escape(config.hospital.updatedAt)} · ${config.dataInfo.validation.departmentCount} 个科室 / ${config.dataInfo.validation.sourceCount} 条来源</p><p>文件：${config.dataInfo.files.map(f => '<code>' + escape(f) + '</code>').join('、')}</p><p>启动时格式校验通过。替换数据后运行 <code>npm run data:validate</code> 并重启服务。</p><p>数据指纹：<code>${escape(config.dataInfo.sha256)}</code></p><p>${config.dataInfo.validation.warnings.map(escape).join(' ')}</p>`;
  $('#source-list').innerHTML = config.sources.map(s => `<article class="source-row"><div><span class="source-id">${escape(s.id)}</span><p>${escape(s.kind)}</p></div><div><h3>${escape(s.title)}</h3><p>${escape(s.description)}</p><p class="source-meta">配置位置：<code>${escape(s.location)}</code> · 更新：${escape(s.date)}</p></div></article>`).join('');
  navigate();
  if (location.hash !== '#settings') await refreshModels();
} catch {
  $('#global-error').textContent = '应用资料加载失败。请确认服务正在运行后刷新页面。'; $('#global-error').hidden = false;
  $('#submit-chief').disabled = true;
}
