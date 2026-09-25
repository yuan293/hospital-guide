// 从 data/hospital.json 的 HL7 FHIR R4 Questionnaire 导出可公开访问的 FHIR 资源：
//   Questionnaire/hospital-guide-probes        —— Questionnaire 规范 URL 对应的资源本体
//   StructureDefinition/<扩展尾名>             —— 每个扩展 canonical URL 对应的结构定义
// 设计约束：canonical URL 指向 GitHub 网页 blob 路由（含 /blob/main/ 段，与仓库内文件
// 一一对应，文件刻意不带 .json 后缀），浏览器点击即可在仓库页面看到定义；
// raw.githubusercontent.com 同名路径（去掉 /blob/main/ 段）提供机器可读 JSON。
// 脚本对“数据中出现的每个扩展 URL 都有定义文件”做 fail-closed 校验。
// 重新生成：npm run fhir:export
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const data = JSON.parse(readFileSync(join(root, 'data/hospital.json'), 'utf8'));
const q = data.questionnaire;

const REPO_BASE = 'https://github.com/yuan293/hospital-guide';
const BRANCH = 'main';
const SD_BASE = `${REPO_BASE}/blob/${BRANCH}/StructureDefinition`;
const Q_URL = `${REPO_BASE}/blob/${BRANCH}/Questionnaire/hospital-guide-probes`;
const RAW_BASE = `https://raw.githubusercontent.com/yuan293/hospital-guide/${BRANCH}`;
const SD_DIR = join(root, 'StructureDefinition');
const Q_DIR = join(root, 'Questionnaire');

if (q.resourceType !== 'Questionnaire') throw new Error('questionnaire.resourceType 不是 Questionnaire');
if (q.url !== Q_URL) throw new Error(`questionnaire.url 与导出目标不一致：${q.url}`);

// 各扩展的人类可读说明（校验依据：lib/data-validation.js 的实际用法）。
// container=true 表示只含子扩展、不含 value[x]；dynamicChildren 声明按数据动态生成的子扩展前缀。
const META = {
  'probe-kind': {
    title: '鉴别问题类型', context: 'Questionnaire.item', type: 'code', required: true,
    codes: 'location（无候选时的部位定位）/ differential（并列科室鉴别追问）/ redflag（安全确认路径内的红旗征问题）',
    description: '标识鉴别问题的工程类型：location=无候选时的部位定位；differential=在并列科室间鉴别的追问；redflag=安全确认路径内的红旗征问题。',
  },
  'probe-description': {
    title: '问题用途说明', context: 'Questionnaire.item', type: 'string', required: true,
    description: '面向患者展示的问题用途与鉴别意图说明。',
  },
  'probe-pathway': {
    title: '安全确认路径归属', context: 'Questionnaire.item', type: 'string',
    description: '该问题所属安全确认路径的 id，须能在根级 probe-pathway-definition 中找到对应路径。',
  },
  'probe-order': {
    title: '路径内提问顺序', context: 'Questionnaire.item', type: 'integer', required: true,
    description: '问题在所属路径内的提问顺序，从 1 开始，同一路径内必须唯一。',
  },
  'probe-source': {
    title: '规则来源标识', context: 'Questionnaire.item', type: 'string', required: true,
    description: '该条规则的来源标识，对应 data/sources.json 中登记的来源（如 DEMO-TRIAGE、DEMO-PATHWAY）。',
  },
  'probe-require-any': {
    title: '激活锚点症状', context: 'Questionnaire.item', type: 'string', repeats: true,
    description: '激活该问题所需的锚点症状词；患者当前肯定存在的症状命中任一值时问题才可能被选中，可重复。',
  },
  'probe-pair': {
    title: '鉴别科室对', context: 'Questionnaire.item', container: true, repeats: true,
    children: {
      'pair-dept-a': { title: '鉴别科室 A', type: 'code', required: true },
      'pair-dept-b': { title: '鉴别科室 B', type: 'code', required: true },
    },
    description: '声明该问题用于鉴别的一对科室；可重复以声明多对鉴别关系。仅含 pair-dept-a / pair-dept-b 两个子扩展，科室代码取自本科室目录 code。',
  },
  'probe-pathway-definition': {
    title: '安全确认路径定义', context: 'Questionnaire', container: true,
    children: {
      'pathway-id': { title: '路径标识', type: 'code', required: true },
      'pathway-title': { title: '路径标题', type: 'string', required: true },
      'pathway-anchor': { title: '路径触发锚点词', type: 'string', required: true, repeats: true },
    },
    description: '根级扩展，定义一条安全确认路径的 id、中文标题与触发锚点词；命中任一锚点即进入该路径。',
  },
  'option-weights': {
    title: '选项科室权重', context: 'Questionnaire.item.answerOption', container: true, dynamicChildren: 'weight',
    description: '挂在答案选项上，声明选中该选项后向各科室累加的工程权重；仅含 weight/<科室代码> 子扩展。',
  },
  'option-escalate': {
    title: '选项升级目标', context: 'Questionnaire.item.answerOption', type: 'code', required: true,
    codes: 'emergency（急症分流，与红旗征阳性同级，模型不可覆盖）/ human（转人工导诊）',
    description: '挂在答案选项上，声明该选项触发的升级处置：emergency=急症分流；human=转人工导诊。',
  },
  'option-narrative': {
    title: '选项叙述措辞', context: 'Questionnaire.item.answerOption', type: 'string', required: true,
    description: '挂在答案选项上，供会话摘要与评测轨迹使用的客观叙述措辞。',
  },
  // 仅作为其他扩展子项出现的定义（context 指向父扩展 canonical URL）。
  'pair-dept-a': { title: '鉴别科室 A', childOf: 'probe-pair', type: 'code', required: true, description: '鉴别科室对的科室 A，代码取自科室目录 code。' },
  'pair-dept-b': { title: '鉴别科室 B', childOf: 'probe-pair', type: 'code', required: true, description: '鉴别科室对的科室 B，代码取自科室目录 code。' },
  'pathway-id': { title: '路径标识', childOf: 'probe-pathway-definition', type: 'code', required: true, description: '路径唯一标识代码，如 pw_epigastric。' },
  'pathway-title': { title: '路径标题', childOf: 'probe-pathway-definition', type: 'string', required: true, description: '路径的中文显示名称。' },
  'pathway-anchor': { title: '路径触发锚点词', childOf: 'probe-pathway-definition', type: 'string', required: true, repeats: true, description: '触发路径的主诉锚点词，可重复；命中任一锚点即进入该安全确认路径。' },
};

// 扫描数据，收集所有扩展 URL（含嵌套），并记录动态子扩展（weight/<科室>）。
const topTails = new Set();
const weightDepts = new Set();
function walk(exts) {
  if (!Array.isArray(exts)) return;
  for (const e of exts) {
    if (!e.url.startsWith(`${SD_BASE}/`)) throw new Error(`发现非本项目前缀的扩展 URL：${e.url}`);
    const tail = e.url.slice(SD_BASE.length + 1);
    if (tail.startsWith('weight/')) {
      weightDepts.add(tail.slice('weight/'.length));
    } else {
      topTails.add(tail);
    }
    walk(e.extension);
  }
}
walk(q.extension);
for (const item of q.item ?? []) {
  walk(item.extension);
  for (const opt of item.answerOption ?? []) walk(opt.extension);
}

// fail-closed：每个出现的扩展都必须在 META 中有定义或属于声明过的动态子扩展。
const unknown = [...topTails].filter(t => !META[t]);
if (unknown.length) throw new Error(`以下扩展缺少 StructureDefinition 元数据，请补 META：${unknown.join(', ')}`);
for (const t of topTails) {
  const m = META[t];
  if (m.container && m.children) {
    for (const child of Object.keys(m.children)) {
      if (!META[child] || META[child].childOf !== t) {
        throw new Error(`子扩展 ${child} 的元数据缺失或 childOf 不指向 ${t}`);
      }
    }
  }
}

const pascal = tail => tail.split(/[-/]/).map(s => s[0].toUpperCase() + s.slice(1)).join('');

function contextOf(meta, parentTail) {
  if (parentTail) return [{ type: 'extension', expression: `${SD_BASE}/${parentTail}` }];
  return [{ type: 'element', expression: meta.context }];
}

function buildSD(tail, { meta, parentTail, override }) {
  const url = `${SD_BASE}/${tail}`;
  const elements = [{ id: 'Extension', path: 'Extension', short: meta.title }];
  elements.push({ id: 'Extension.url', path: 'Extension.url', fixedUri: url });
  if (meta.container) {
    elements.push({ id: 'Extension.value[x]', path: 'Extension.value[x]', max: '0' });
    const children = override?.children ?? Object.entries(meta.children ?? {}).map(([name, cm]) => [name, cm]);
    for (const [name, cm] of children) {
      const slice = name.split('/').pop();
      const childUrl = `${SD_BASE}/${name}`;
      elements.push({
        id: `Extension.extension:${slice}`, path: 'Extension.extension', sliceName: slice,
        short: cm.title, min: cm.required ? 1 : 0, max: cm.repeats ? '*' : '1', type: [{ code: 'Extension' }],
      });
      elements.push({ id: `Extension.extension:${slice}.url`, path: 'Extension.extension.url', fixedUri: childUrl });
      elements.push({
        id: `Extension.extension:${slice}.value[x]`, path: 'Extension.extension.value[x]',
        short: cm.title, min: cm.required ? 1 : 0, max: '1', type: [{ code: cm.type }],
      });
    }
  } else {
    elements.push({ id: 'Extension.extension', path: 'Extension.extension', max: '0' });
    elements.push({
      id: 'Extension.value[x]', path: 'Extension.value[x]',
      short: meta.title, min: meta.required ? 1 : 0, max: meta.repeats ? '*' : '1',
      type: [{ code: meta.type }],
      ...(meta.codes ? { binding: { strength: 'required', description: meta.codes } } : {}),
    });
  }
  return {
    resourceType: 'StructureDefinition',
    id: tail.replace(/\//g, '-'),
    url,
    version: q.version,
    name: pascal(tail),
    title: meta.title,
    status: 'draft',
    experimental: true,
    date: q.date,
    publisher: q.publisher,
    description: meta.description,
    fhirVersion: '4.0.1',
    kind: 'complex-type',
    abstract: false,
    context: contextOf(meta, parentTail),
    type: 'Extension',
    baseDefinition: 'http://hl7.org/fhir/StructureDefinition/Extension',
    derivation: 'constraint',
    differential: { element: elements },
  };
}

// 重新生成，先清空目标目录，避免残留文件与数据脱节。
for (const d of [SD_DIR, Q_DIR]) {
  if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
}

const written = [];
function writeResource(relPath, resource) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(resource, null, 2) + '\n', 'utf8');
  written.push(relPath.replaceAll('\\', '/'));
}

// 1) 顶级扩展（option-weights 的 weight/* 按数据中实际出现的科室动态生成）。
for (const tail of topTails) {
  const meta = META[tail];
  let override;
  if (tail === 'option-weights') {
    override = {
      children: [...weightDepts].sort().map(dept => [
        `weight/${dept}`,
        { title: `科室 ${dept} 的权重`, type: 'integer' },
      ]),
    };
  }
  writeResource(`StructureDefinition/${tail}`, buildSD(tail, { meta, override }));
  if (meta.container) {
    const children = override?.children ?? Object.keys(meta.children).map(c => [c, null]);
    for (const [name] of children) {
      writeResource(`StructureDefinition/${name}`, buildSD(name, { meta: META[name.split('/').pop()] ?? { title: name, type: 'integer', description: `选中所属选项时给予科室 ${name.split('/')[1]} 的权重分值（整数）。`, childOf: tail }, parentTail: tail }));
    }
  }
}

// 2) Questionnaire 资源本体。
writeResource('Questionnaire/hospital-guide-probes', q);

// 3) 生成结构定义索引页（目录访问时的落地说明）。
const rows = [...written]
  .filter(p => p.startsWith('StructureDefinition/'))
  .sort()
  .map(p => {
    const tail = p.slice('StructureDefinition/'.length);
    const resource = JSON.parse(readFileSync(join(root, p), 'utf8'));
    const kind = resource.differential.element.some(e => e.path === 'Extension.extension' && e.max !== '0')
      ? '容器扩展（含子扩展）'
      : `${resource.differential.element.find(e => e.path === 'Extension.value[x]')?.type?.[0]?.code ?? ''} 值`;
    return `| \`${tail}\` | [blob 页面](${REPO_BASE}/blob/${BRANCH}/StructureDefinition/${tail}) · [raw JSON](${RAW_BASE}/StructureDefinition/${tail}) | ${kind} | ${resource.title} |`;
  });

const index = `# StructureDefinition（院内智导自定义 FHIR 扩展）

本目录是 \`data/hospital.json\` 中鉴别追问与安全确认问题库（HL7 FHIR R4 Questionnaire）所引用的全部自定义扩展的结构定义，由 \`scripts/export-fhir-resources.js\` 从问卷资源自动生成，**不要手工编辑**；修改扩展后运行 \`npm run fhir:export\` 重新导出。

每个文件的仓库路径与其 canonical URL 一一对应（canonical 采用 GitHub 网页 blob 形式，含 \`/blob/main/\` 路由段）：在问卷里直接点击扩展 URL 即可到达本目录内的定义页面，同名 raw 链接提供机器可读 JSON。FHIR canonical URL 本身只是标识符、规范不要求可解析，本仓库额外保证其可解析、可核验。

- 问卷资源本体：[blob 页面](${Q_URL}) · [raw JSON](${RAW_BASE}/Questionnaire/hospital-guide-probes)
- 扩展 canonical 前缀：${SD_BASE}/
- 状态：draft / experimental，演示配置，未经临床审核，不是诊疗指南

| 尾名 | canonical（blob / raw） | 形态 | 说明 |
| --- | --- | --- | --- |
${rows.join('\n')}
`;
writeFileSync(join(SD_DIR, 'README.md'), index, 'utf8');
written.push('StructureDefinition/README.md');

// 4) 覆盖校验：数据中出现的每个扩展 URL 必须恰好有一个文件。
const expected = new Set();
for (const tail of topTails) {
  expected.add(`StructureDefinition/${tail}`);
  const meta = META[tail];
  if (meta.container) {
    if (tail === 'option-weights') {
      for (const dept of weightDepts) expected.add(`StructureDefinition/weight/${dept}`);
    } else {
      for (const c of Object.keys(meta.children)) expected.add(`StructureDefinition/${c}`);
    }
  }
}
expected.add('Questionnaire/hospital-guide-probes');
const missing = [...expected].filter(p => !written.includes(p));
if (missing.length) throw new Error(`以下 URL 缺少对应文件：${missing.join(', ')}`);

console.log(`已导出 ${expected.size} 个 FHIR 资源（${topTails.size} 个顶级扩展、${weightDepts.size} 个科室权重子扩展、1 个 Questionnaire）+ 1 个索引页`);
for (const p of [...expected].sort()) console.log(' ', p);
