# 医院数据使用说明

这是可替换的数据模板，全部为虚构示例；格式校验通过不表示临床有效或已获医院授权。

## 文件

- hospital.json：医院名称、版本、日期、科室、接诊范围，以及 `questionnaire` 问题库（HL7 FHIR R4 Questionnaire 结构）。问题类型由 `probe-kind` 扩展表达，共三种：必须恰好1个 `location` 定位问题、若干 `differential` 鉴别问题、若干 `redflag` 红旗征筛查问题。`redflag` 必须通过 `probe-pathway` 归属某条安全确认路径、用 `probe-order` 声明路径内顺序，选项用 `option-narrative` 写出该选项的措辞、用 `option-escalate` 声明升级目标（`emergency` 或 `human`）；安全确认路径本身在 Questionnaire 根扩展 `probe-pathway-definition` 中声明 id、标题与激活锚点。权重只能引用已配置科室，鉴别问题的锚点症状必须来自科室 keywords，权重、锚点、科室对与来源均通过扩展字段表达，扩展 URL 前缀见 questionnaire.description）。
- sources.json：来源标题、配置位置、日期、权利说明与审核状态。
- hospital.js：把 Questionnaire 适配为内部 probes 与 pathways 结构并导出，启动时校验，不在这里编辑科室内容。
- evaluation/cases.json：81条合成工程评测案例（含安全确认与红旗征案例）。
- evaluation/latest.json：最近一次实际评测，包含失败案例、模型摘要、耗时和运行环境。
- evaluation/runs/：每次评测的历史记录，不含网页用户会话。

## 替换流程

1. 备份两个 JSON 文件；以现有格式填写资料。真实医院资料需先获得适当授权，来源条目写明依据和审核情况。
2. 每个科室填写唯一 id、name、floor、room、zone、group、summary、非空 keywords 和 sourceIds。
3. 来源 ID 必须存在于 sources.json；填写 rights，不能因资料可公开访问就假定可以再分发。
4. 当前页面仅采集年龄段：adult 对应月龄 216 至不限，child 对应 12 至 215，all 对应 0 至不限。校验器拒绝其他年龄边界；真实医院有更细的接诊条件时应扩展流程和测试，不能只改数值。
5. 保留 emergency、pediatrics、general 系统科室 ID；其他科室可增删，更新日期和版本。
6. 修改问题库时保持 FHIR Questionnaire 结构完整：`linkId` 唯一、`answerOption` 的 `valueCoding.code` 唯一、权重扩展引用存在的非系统科室、`probe-require-any` 锚点来自某科室 keywords、`probe-pair` 引用存在的科室对，且鉴别问题至少能区分一个配置科室对；必须恰好保留1个 location 问题。红旗征问题还必须满足：引用已声明的安全确认路径、路径内 `probe-order` 不重复、每个选项都有 `option-narrative`、至少有一个 `option-escalate` 选项且**不得**配置科室权重（否则危险征象会被当成科室证据）。
7. 执行 `npm run data:validate`；报错时修复具体字段。服务启动也会自动校验，无效配置不能启动。
8. 执行 `npm test` 和 `npm run evaluate:models`，检查科室或 probes 变化导致的案例标签是否仍有依据。
9. 重启应用，在“资料与来源”核对文件、版本、日期和数据指纹。

对现有快照的修改不会自动刷新已经运行的服务。年龄、科室和关键词仍是演示规则，真实上线需要专业审核。来源状态必须如实填写，不能把工程校验标记为医学审核。
