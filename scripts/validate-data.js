import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateHospitalData } from '../lib/data-validation.js';
try {
  const hospitalFile = process.argv[2] ? resolve(process.argv[2]) : new URL('../data/hospital.json', import.meta.url);
  const sourcesFile = process.argv[3] ? resolve(process.argv[3]) : new URL('../data/sources.json', import.meta.url);
  const check = validateHospitalData(JSON.parse(await readFile(hospitalFile, 'utf8')), JSON.parse(await readFile(sourcesFile, 'utf8')));
  console.log(JSON.stringify(check, null, 2));
  if (!check.valid) process.exitCode = 1;
} catch (error) { console.error('数据校验失败：' + error.message); process.exitCode = 1; }
