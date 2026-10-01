import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// 锚点表逐词核验用例：[keyword, evidence, 期望]。在主测试内执行以共享同一模块实例，
// 避免动态 import 的模块缓存把 endpoint 固化在默认端口上。
const ANCHOR_CASES = [
  // ① 字面
  ['咳嗽', '咳嗽三天', true],
  // ② 形态锚点：X疼/X痛=词干+疼痛；X出血=词干+血
  ['腰痛', '腰部疼痛', true],
  ['胸痛', '胸口疼', true],
  ['鼻出血', '鼻子老是出血', true],
  ['咽痛', '嗓子痛', true],
  // ③ 双语素同现：两字都在证据中；缺任一字即不成立
  ['血尿', '尿里带血', true],
  ['耳鸣', '耳朵疼', false],
  ['耳痛', '耳朵有点闷', false],
  // ④ 登记同义形（含"疼/痛须同现"约束）
  ['腹痛', '肚子疼', true],
  ['腹痛', '肚疼', true],
  ['头痛', '脑袋疼', true],
  ['咽痛', '嗓子疼', true],
  ['腹泻', '拉肚子', true],
  ['发热', '发烧', true],
  ['心悸', '心慌', true],
  ['失眠', '睡不着', true],
  ['尿痛', '小便的时候疼', true],
  ['胸痛', '心口疼', true],
  ['心悸', '心口疼', true],
  ['胃痛', '心口疼', false],
  ['皮肤痒', '皮肤很痒', true],
  ['瘙痒', '身上很痒', true],
  // 同义形不得跨症状泛化：无疼/痛/痒同现即拒绝
  ['腹痛', '肚子胀', false],
  ['腹痛', '肚子不舒服', false],
  ['尿痛', '小便发黄', false],
  // 三类真实出现过的错配在结构上不可表达
  ['腹痛', '肾疼', false],
  ['腹痛', '身上哪儿都别扭', false],
  ['鼻塞', '鼻子老是出血', false],
  ['心慌', '浑身不得劲', false],
  // 出血证据不得接非出血词；无登记的意译型口语被拒走弃权
  ['咳嗽', '咳血', false],
  ['胃痛', '胃部不适', false],
];

test('Ollama adapter lists models, validates evidence, rejects malformed output and handles offline service', async () => {
  let output = { matches: [{ keyword: '腹痛', evidence: '肚子疼' }] };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body);
      assert.equal(request.format.type, 'object');
      assert.equal(request.options.num_ctx, 2048);
      assert.equal(request.options.temperature, 0);
      assert.ok(request.format.properties.matches.items.properties.keyword.enum.includes('腹痛'));
      res.end(JSON.stringify({ message: { content: JSON.stringify(output) } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
  const { modelStatus, normalize, evidenceMatchesKeyword } = await import('../lib/model.js');
  try {
    assert.deepEqual((await modelStatus()).models, ['test-model']);
    // 映射锚点表：字面/形态锚点/双语素/登记同义形四类接受，三类历史错配结构性拒绝
    for (const [keyword, evidence, expected] of ANCHOR_CASES) {
      assert.equal(evidenceMatchesKeyword(keyword, evidence), expected, `锚点判定：${keyword} ← "${evidence}" 应为 ${expected}`);
    }
    const single = await normalize('肚子疼', 'test-model');
    assert.equal(single.matches[0].keyword, '腹痛');
    assert.equal(single.rawCount, 1);
    output = { matches: [null, { keyword: '乱编科室', evidence: '肚子疼' }, { keyword: '咳嗽', evidence: '没有咳嗽' }, { keyword: '腹痛', evidence: '虚构原文' }] };
    const filtered = await normalize('没有咳嗽，肚子疼', 'test-model');
    assert.deepEqual(filtered.matches, []);
    assert.equal(filtered.rawCount, 4);
    // 整句原文不得作为短症状证据通过核验（堵幻觉绕过口）
    output = { matches: [{ keyword: '咽痛', evidence: '说不清楚哪里不舒服' }] };
    const wholeSentence = await normalize('说不清楚哪里不舒服', 'test-model');
    assert.deepEqual(wholeSentence.matches, []);
    assert.equal(wholeSentence.rawCount, 1);
    // 短主诉允许引用整句（如"肚子疼"本身就是合法症状片段）
    output = { matches: [{ keyword: '腹痛', evidence: '肚子疼' }] };
    const shortChief = await normalize('肚子疼', 'test-model');
    assert.equal(shortChief.matches[0].keyword, '腹痛');
    // 病史/否定/未然上下文的短片段同样不能作为证据
    output = { matches: [
      { keyword: '腹泻', evidence: '之前拉肚子' },
      { keyword: '气喘', evidence: '不喘' },
      { keyword: '关节痛', evidence: '关节又该疼了' },
      { keyword: '气喘', evidence: '我爸心脏病住院' },
      { keyword: '咳嗽', evidence: '咳嗽' },
    ] };
    const contextual = await normalize('之前拉肚子，今天好了，不喘，关节又该疼了，我爸心脏病住院，就是有点咳嗽', 'test-model');
    assert.deepEqual(contextual.matches.map(m => m.keyword), ['咳嗽']);
    // 锚点表：词素不相交的错配被结构性拒绝；出血证据只放行出血词；
    // 登记同义形（肚子疼→腹痛）正常放行
    output = { matches: [
      { keyword: '心慌', evidence: '浑身不得劲' },
      { keyword: '腹痛', evidence: '身上哪儿都别扭' },
      { keyword: '鼻塞', evidence: '鼻子老是出血' },
      { keyword: '鼻出血', evidence: '鼻子老是出血' },
      { keyword: '腹痛', evidence: '肚子疼' },
    ] };
    const anchored = await normalize('浑身不得劲，身上哪儿都别扭，鼻子老是出血，肚子疼', 'test-model');
    assert.deepEqual(anchored.matches.map(m => m.keyword), ['鼻出血', '腹痛']);
    // 口语主诉经登记同义形逐条映射
    output = { matches: [
      { keyword: '腹痛', evidence: '肚子疼' },
      { keyword: '头痛', evidence: '脑袋疼' },
      { keyword: '咽痛', evidence: '嗓子疼' },
      { keyword: '腹泻', evidence: '拉肚子' },
      { keyword: '尿痛', evidence: '小便的时候疼' },
      { keyword: '皮肤痒', evidence: '皮肤很痒' },
    ] };
    const colloquial = await normalize('肚子疼，脑袋疼，嗓子疼，拉肚子，小便的时候疼，皮肤很痒', 'test-model');
    assert.deepEqual(colloquial.matches.map(m => m.keyword), ['腹痛', '头痛', '咽痛', '腹泻', '尿痛', '皮肤痒']);
    output = { invalid: true };
    await assert.rejects(normalize('肚子疼', 'test-model'));
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal((await modelStatus()).available, false);
});
