import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateHospitalData } from '../lib/data-validation.js';

const FHIR_EXT = 'https://github.com/yuan293/hospital-guide/blob/main/StructureDefinition';
const KIND_URL = `${FHIR_EXT}/probe-kind`;
const REQ_URL = `${FHIR_EXT}/probe-require-any`;
const PAIR_URL = `${FHIR_EXT}/probe-pair`;
const WEIGHT_URL = `${FHIR_EXT}/option-weights`;
const PAIR_A = `${FHIR_EXT}/pair-dept-a`;
const PAIR_B = `${FHIR_EXT}/pair-dept-b`;

const original = JSON.parse(readFileSync(new URL('../data/hospital.json', import.meta.url)));
const sources = JSON.parse(readFileSync(new URL('../data/sources.json', import.meta.url)));

test('hospital JSON and source references validate', () => {
  const result = validateHospitalData(original, sources);
  assert.equal(result.valid, true);
  assert.equal(result.departmentCount, 18);
  assert.equal(result.probeCount, 10);
  assert.equal(result.pathwayCount, 1);
});

test('probe library fails closed on structural errors', () => {
  for (const mutate of [
    d => { delete d.questionnaire; },
    d => { d.questionnaire = { resourceType: 'Questionnaire', url: 'x', version: '1', status: 'draft', item: [] }; },
    d => { d.questionnaire.item.push({ ...d.questionnaire.item[0], linkId: d.questionnaire.item[1].linkId }); },
    d => { d.questionnaire.item[1].extension.find(e => e.url === KIND_URL).valueCode = 'guess'; },
    d => { d.questionnaire.item[1].answerOption = []; },
    d => {
      const opt = d.questionnaire.item[1].answerOption.find(o => o.valueCoding.code === 'yes');
      const weightExt = opt.extension.find(e => e.url === WEIGHT_URL);
      weightExt.extension.push({ url: `${FHIR_EXT}/weight/missingDept`, valueInteger: 2 });
    },
    d => {
      const opt = d.questionnaire.item[1].answerOption[0];
      const weightExt = opt.extension.find(e => e.url === WEIGHT_URL);
      weightExt.extension.push({ url: `${FHIR_EXT}/weight/forged`, valueInteger: 1 });
    },
    d => {
      d.questionnaire.item[1].extension = d.questionnaire.item[1].extension.filter(e => e.url !== REQ_URL);
      d.questionnaire.item[1].extension.push({ url: REQ_URL, valueString: '不存在的症状词' });
    },
    d => {
      d.questionnaire.item[1].extension = d.questionnaire.item[1].extension.filter(e => e.url !== PAIR_URL);
      d.questionnaire.item[1].extension.push({
        url: PAIR_URL,
        extension: [
          { url: PAIR_A, valueCode: 'digestive' },
          { url: PAIR_B, valueCode: 'missingDept' },
        ],
      });
    },
    d => { d.questionnaire.item[1].extension = d.questionnaire.item[1].extension.filter(e => e.url !== PAIR_URL); },
    d => {
      d.questionnaire.item = d.questionnaire.item.filter(
        i => i.extension?.find(e => e.url === KIND_URL)?.valueCode !== 'location'
      );
    },
    d => {
      d.questionnaire.item.push({ ...d.questionnaire.item[0], linkId: 'p_second_location' });
    },
  ]) {
    const data = structuredClone(original); mutate(data);
    assert.equal(validateHospitalData(data, sources).valid, false);
  }
});

test('invalid fields fail closed, including unsupported age boundaries', () => {
  for (const mutate of [
    d => { d.departments[0].id = d.departments[1].id; },
    d => { d.departments[0].sourceIds = ['MISSING']; },
    d => { d.departments[0].keywords = []; },
    d => { d.departments[0].room = ''; },
    d => { d.departments[0].ageRangeMonths = { min: 400, max: 200 }; },
    d => { d.departments[0].ageRangeMonths = { min: 240, max: null }; },
    d => { d.departments = d.departments.filter(d => d.id !== 'emergency'); },
    d => { d.hospital.updatedAt = '2026-02-31'; },
    d => { d.ruleSourceIds = ['MISSING']; },
  ]) {
    const data = structuredClone(original); mutate(data);
    assert.equal(validateHospitalData(data, sources).valid, false);
  }
  assert.equal(validateHospitalData(null, null).valid, false);
  assert.equal(validateHospitalData(original, [...sources, sources[0]]).valid, false);
});
