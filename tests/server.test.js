import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createApp } from '../server.js';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('HTTP routes, input validation, emergency precedence and origin protection', async t => {
  const server = createApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = await fetch(url + '/api/config');
  assert.equal(get.status, 200);
  const config = await get.json();
  assert.equal(config.departments.length, 45);
  assert.equal(config.probes.length, 11);
  // 版本号以 package.json 为单一事实来源，避免每次发版都要手改测试
  assert.equal((await (await fetch(url + '/api/health')).json()).version, pkg.version);
  // 不可自助挂号科室：医技辅助 5 个 + 重症医学科、放射治疗科，共 7 个
  assert.equal(config.departments.filter(d => d.bookable === false).length, 7);
  assert.ok(!config.departments.find(d => d.id === 'emergency').expertRoom);
  assert.ok(config.departments.filter(d => d.bookable !== false && d.id !== 'emergency').every(d => d.expertRoom));
  assert.equal(config.dataInfo.validation.valid, true);
  assert.deepEqual(config.dataInfo.files, ['data/hospital.json', 'data/sources.json']);
  assert.match(get.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const page = await fetch(url);
  assert.match(await page.text(), /诊途/);
  const asset = await fetch(url + '/assets/campus.png');
  assert.equal(asset.headers.get('content-type'), 'image/png');
  assert.ok((await asset.arrayBuffer()).byteLength > 1000);
  const post = (body, headers = {}) => fetch(url + '/api/triage', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ chief: '' })).status, 400);
  assert.equal((await post({ chief: 'a'.repeat(9000) })).status, 413);
  assert.equal((await post({ chief: '咳嗽' }, { Origin: 'https://example.com' })).status, 403);
  const invalidHost = await new Promise((resolve, reject) => {
    const req = http.get(url + '/api/config', { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(invalidHost, 403);
  const urgent = await post({ chief: '现在胸痛', model: 'missing-model', answers: {} });
  assert.equal((await urgent.json()).status, 'emergency');
  // 医技科室不可挂号守卫：CT 检查需求不得推荐放射科（bookable:false 不参与导诊评分）
  const ct = await (await post({ chief: '想做个CT检查', answers: { risk: 'no', age: 'adult', severity: 'mild' } })).json();
  assert.notEqual(ct.department, 'radiology');
  assert.ok(['question', 'human', 'uncertain'].includes(ct.status));
  // 器官口语“肾疼”：肾内科/泌尿外科并列时先鉴别追问，不得跨器官错配到消化内科
  const slots = { risk: 'no', age: 'adult', severity: 'mild' };
  const kidneyAsk = await (await post({ chief: '肾疼', answers: slots })).json();
  assert.equal(kidneyAsk.status, 'question');
  assert.equal(kidneyAsk.question?.id, 'p_kidney_pain');
  const kidneyUro = await (await post({ chief: '肾疼', answers: { ...slots, p_kidney_pain: 'urinary' } })).json();
  assert.equal(kidneyUro.status, 'recommendation');
  assert.equal(kidneyUro.department, 'urology');
  const kidneyNeph = await (await post({ chief: '肾疼', answers: { ...slots, p_kidney_pain: 'edema' } })).json();
  assert.equal(kidneyNeph.status, 'recommendation');
  assert.equal(kidneyNeph.department, 'nephrology');
  // 心口疼进入上腹安全确认，不直接推荐科室
  const heartMouth = await (await post({ chief: '心口疼', answers: slots })).json();
  assert.ok(['question', 'human', 'uncertain'].includes(heartMouth.status));
  assert.notEqual(heartMouth.department, 'digestive');
  assert.equal((await fetch(url + '/lib/triage.js')).status, 404);
  assert.equal((await fetch(url + '/evaluation.js')).status, 200);
  assert.equal((await fetch(url + '/evaluation.css')).status, 200);
  assert.equal((await fetch(url + '/panorama.js')).status, 200);
  assert.equal((await fetch(url + '/panorama.css')).status, 200);
  // 词表与路由全景：只读盘点，覆盖数与科室/探针数据同源
  const panorama = await fetch(url + '/api/panorama');
  assert.equal(panorama.status, 200);
  const pn = await panorama.json();
  assert.equal(pn.stats.departments, 45);
  assert.equal(pn.departments.reduce((n, d) => n + d.keywordCount, 0), 406);
  assert.equal(pn.synonyms.groups.length, 47);
  assert.equal(pn.location.options.length, 12);
  // 每个部位选项（除「说不清」）必须恰好落到一个科室；有异常时盘点页会标红
  assert.deepEqual(pn.location.anomalies, []);
  assert.equal(pn.location.options.find(o => o.value === 'unknown').targets.length, 0);
  // 单方向疼痛词是「形态锚点兜底」的可视化证据，且每一条都应实测可覆盖
  assert.ok(pn.pain.singleDirection.length > 0);
  assert.ok(pn.pain.singleDirection.every(x => x.variantCovered));
  // 安全检查路径锚点必须存在，避免词表「抄近路」直接推荐科室
  assert.ok(pn.pathways.length >= 1 && pn.pathways[0].anchors.includes('心口疼'));
  // 急诊与医技科室不走词表入口，不得被误标为「词表偏薄」
  assert.ok(pn.departments.find(d => d.id === 'emergency').vocabIndependent);
  assert.ok(!pn.departments.find(d => d.id === 'emergency').thin);
  assert.ok(pn.departments.filter(d => d.bookable === false).every(d => d.vocabIndependent));
  const evaluation = await fetch(url + '/api/evaluation');
  assert.equal(evaluation.status, 200);
  assert.equal(typeof (await evaluation.json()).available, 'boolean');
  assert.equal((await fetch(url + '/data/evaluation/cases.json')).status, 404);
});
