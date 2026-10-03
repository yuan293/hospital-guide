import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceMatchesKeyword, isShortEvidenceFragment } from '../src/anchors.js';
import { REFERENCE_SYNONYMS } from '../src/synonyms.js';
import { acceptPolish, DEFAULT_FORBIDDEN, DEFAULT_QUESTIONISH } from '../src/polish.js';

// ---------- evidenceMatchesKeyword：规则 ① 字面 ----------
test('① 字面包含', () => {
  assert.equal(evidenceMatchesKeyword('咳嗽', '咳嗽三天'), true);
  assert.equal(evidenceMatchesKeyword('咳嗽', '有点咳'), false); // 不是字面包含
});

// ---------- 规则 ② 形态锚点：X疼 / X痛 ----------
test('② 形态锚点 X疼/X痛', () => {
  assert.equal(evidenceMatchesKeyword('腰痛', '腰部疼痛'), true);
  assert.equal(evidenceMatchesKeyword('胸痛', '胸口疼'), true);
  // 词干出现但证据无「疼/痛」→ 不通过
  assert.equal(evidenceMatchesKeyword('腰痛', '腰部酸胀'), false);
  // 证据含「疼」但词干不在 → 不通过
  assert.equal(evidenceMatchesKeyword('腰痛', '腿疼'), false);
});

// ---------- 规则 ② 形态锚点：X出血 ----------
test('② 形态锚点 X出血', () => {
  assert.equal(evidenceMatchesKeyword('鼻出血', '鼻子老是出血'), true);
  assert.equal(evidenceMatchesKeyword('鼻出血', '鼻子不通气'), false); // 无「血」
});

// ---------- 规则 ③ 双语素同现 ----------
test('③ 双语素同现（仅二字词）', () => {
  assert.equal(evidenceMatchesKeyword('血尿', '尿里带血'), true); // 血 + 尿
  assert.equal(evidenceMatchesKeyword('耳鸣', '耳朵疼'), false); // 缺「鸣」
  assert.equal(evidenceMatchesKeyword('耳鸣', '耳朵嗡嗡响'), false); // 缺「鸣」，需靠同义表
  // 三字词不走双语素规则
  assert.equal(evidenceMatchesKeyword('结膜炎', '眼睛红'), false);
});

// ---------- 规则 ④ 登记同义形 ----------
test('④ 登记同义形', () => {
  assert.equal(evidenceMatchesKeyword('腹痛', '肚子疼', REFERENCE_SYNONYMS), true);
  assert.equal(evidenceMatchesKeyword('发热', '发烧', REFERENCE_SYNONYMS), true);
  // 无正则约束的登记项（如 腹泻←拉肚子）应命中
  assert.equal(evidenceMatchesKeyword('腹泻', '拉肚子', REFERENCE_SYNONYMS), true);
  // 正则约束必须同时满足
  assert.equal(evidenceMatchesKeyword('脚气', '脚很痒', REFERENCE_SYNONYMS), true);
  assert.equal(evidenceMatchesKeyword('脚气', '脚很酸', REFERENCE_SYNONYMS), false);
  // 眼科干涩类口语（0.8.1 补登记）
  assert.equal(evidenceMatchesKeyword('眼干', '眼睛发干', REFERENCE_SYNONYMS), true);
  assert.equal(evidenceMatchesKeyword('眼干', '眼睛发涩', REFERENCE_SYNONYMS), true);
  assert.equal(evidenceMatchesKeyword('眼干', '眼睛发红', REFERENCE_SYNONYMS), false);
  // 不传同义表时，口语无法通过
  assert.equal(evidenceMatchesKeyword('腹痛', '肚子疼'), false);
});

// ---------- 关键：三类真实错配必须结构性不可表达 ----------
test('三类真实错配在结构上不可表达', () => {
  const s = REFERENCE_SYNONYMS;
  assert.equal(evidenceMatchesKeyword('腹痛', '肾疼', s), false); // 肾疼 ≠ 腹痛
  assert.equal(evidenceMatchesKeyword('鼻塞', '鼻子老是出血', s), false); // 出血 ≠ 鼻塞
  assert.equal(evidenceMatchesKeyword('心悸', '浑身不得劲', s), false); // 笼统感受 ≠ 心慌
});

// ---------- 边界与健壮性 ----------
test('非字符串输入安全返回 false', () => {
  assert.equal(evidenceMatchesKeyword(null, 'x'), false);
  assert.equal(evidenceMatchesKeyword('咳嗽', null), false);
  assert.equal(evidenceMatchesKeyword('', '咳嗽'), false);
  assert.equal(evidenceMatchesKeyword('咳嗽', ''), false);
});

// ---------- isShortEvidenceFragment ----------
test('isShortEvidenceFragment 阻止整句当证据', () => {
  assert.equal(isShortEvidenceFragment('咳嗽三天', '我咳嗽三天了有点发烧'), true);
  assert.equal(isShortEvidenceFragment('我咳嗽三天了有点发烧', '我咳嗽三天了有点发烧'), false); // 引用整句
  assert.equal(isShortEvidenceFragment('咳', '我咳嗽三天了'), false); // 过短
  assert.equal(isShortEvidenceFragment('不存在的片段', '我咳嗽三天了'), false); // 非子串
});

// ---------- acceptPolish ----------
test('acceptPolish 接受合规问句', () => {
  const r = acceptPolish({ title: '肚子不舒服时，排尿是否有异常？' });
  assert.ok(r);
  assert.equal(r.title, '肚子不舒服时，排尿是否有异常？');
});

test('acceptPolish 拒收诊断性措辞', () => {
  assert.equal(acceptPolish({ title: '你是否已经确诊为胃炎？' }), null);
  assert.equal(acceptPolish({ title: '建议服用止痛药吗？' }), null);
});

test('acceptPolish 拒收淡化风险的措辞', () => {
  assert.equal(acceptPolish({ title: '这不用担心，是否继续？' }), null);
  assert.equal(acceptPolish({ title: '无需就医，要不要先观察？' }), null);
});

test('acceptPolish 拒收陈述句（改成结论）', () => {
  assert.equal(acceptPolish({ title: '你的肚子疼是肠胃问题' }), null); // 无疑问特征
});

test('acceptPolish 长度受控', () => {
  assert.equal(acceptPolish({ title: '疼吗' }), null); // 过短
  assert.equal(acceptPolish({ title: '？'.repeat(61) }), null); // 超默认上限 60
  assert.ok(acceptPolish({ title: '？'.repeat(60) })); // 恰在上限内
});

test('acceptPolish 非对象/无 title 返回 null', () => {
  assert.equal(acceptPolish(null), null);
  assert.equal(acceptPolish({}), null);
  assert.equal(acceptPolish({ title: 123 }), null);
});

test('acceptPolish 可自定义禁止词与长度', () => {
  assert.equal(acceptPolish({ title: '要不要去医院呢？' }, { forbidden: /医院/ }), null);
  const r = acceptPolish({ title: '疼不疼呢？' }, { minLen: 2 });
  assert.ok(r);
});

// ---------- 导出常量可用 ----------
test('导出的默认规则可用且不匹配良性文本', () => {
  assert.equal(DEFAULT_FORBIDDEN.test('肚子不舒服时，排尿是否正常？'), false);
  assert.equal(DEFAULT_QUESTIONISH.test('排尿是否有异常？'), true);
});
