import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.js';

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
  assert.equal((await (await fetch(url + '/api/health')).json()).version, '0.9.1');
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
  const evaluation = await fetch(url + '/api/evaluation');
  assert.equal(evaluation.status, 200);
  assert.equal(typeof (await evaluation.json()).available, 'boolean');
  assert.equal((await fetch(url + '/data/evaluation/cases.json')).status, 404);
});
