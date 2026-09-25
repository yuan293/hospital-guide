import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateHospitalData, probesFromQuestionnaire, pathwaysFromQuestionnaire } from '../lib/data-validation.js';

const rawHospital = readFileSync(new URL('./hospital.json', import.meta.url), 'utf8');
const rawSources = readFileSync(new URL('./sources.json', import.meta.url), 'utf8');
const data = JSON.parse(rawHospital);
export const sources = JSON.parse(rawSources);
const validation = validateHospitalData(data, sources);
if (!validation.valid) throw new Error('医院资料校验失败：\n' + validation.errors.join('\n'));
export const hospital = data.hospital;
export const departments = data.departments;
export const ruleSourceIds = data.ruleSourceIds;
export const questionnaire = data.questionnaire;
export const probes = probesFromQuestionnaire(data.questionnaire);
export const pathways = pathwaysFromQuestionnaire(data.questionnaire);
export const dataInfo = {
  files: ['data/hospital.json', 'data/sources.json'],
  sha256: createHash('sha256').update(rawHospital).update(rawSources).digest('hex'),
  validation,
};
