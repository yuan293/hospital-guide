import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

test('Ollama adapter lists models, validates evidence, rejects malformed output and handles offline service', async () => {
  let output = { matches: [{ keyword: '胃痛', evidence: '肚子疼' }] };
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
  const { modelStatus, normalize } = await import('../lib/model.js');
  try {
    assert.deepEqual((await modelStatus()).models, ['test-model']);
    const single = await normalize('肚子疼', 'test-model');
    assert.equal(single.matches[0].keyword, '胃痛');
    assert.equal(single.rawCount, 1);
    output = { matches: [null, { keyword: '乱编科室', evidence: '肚子疼' }, { keyword: '咳嗽', evidence: '没有咳嗽' }, { keyword: '胃痛', evidence: '虚构原文' }] };
    const filtered = await normalize('没有咳嗽，肚子疼', 'test-model');
    assert.deepEqual(filtered.matches, []);
    assert.equal(filtered.rawCount, 4);
    // 整句原文不得作为短症状证据通过核验（堵幻觉绕过口）
    output = { matches: [{ keyword: '咽痛', evidence: '说不清楚哪里不舒服' }] };
    const wholeSentence = await normalize('说不清楚哪里不舒服', 'test-model');
    assert.deepEqual(wholeSentence.matches, []);
    assert.equal(wholeSentence.rawCount, 1);
    // 短主诉允许引用整句（如"肚子疼"本身就是合法症状片段）
    output = { matches: [{ keyword: '胃痛', evidence: '肚子疼' }] };
    const shortChief = await normalize('肚子疼', 'test-model');
    assert.equal(shortChief.matches[0].keyword, '胃痛');
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
    output = { invalid: true };
    await assert.rejects(normalize('肚子疼', 'test-model'));
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal((await modelStatus()).available, false);
});
