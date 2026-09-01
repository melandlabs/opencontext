# BEAM 128k 第一次完整测试报告

- 报告版本：v1
- 测试状态：诊断基线，暂不作为正式性能基线
- 数据规格：BEAM `128k`
- 完成时间：2026-09-01 06:22
- 原始结果：[beam-128k-v1_1-full-20260831.json](../results/beam-128k-v1_1-full-20260831.json)
- 完整链路：[beam-128k-v1_1-full-20260831.trace.jsonl](../results/beam-128k-v1_1-full-20260831.trace.jsonl)
- 分块记录：[beam-128k-v1_1-full-20260831.chunks.jsonl](../results/beam-128k-v1_1-full-20260831.chunks.jsonl)

> `results/`、checkpoint 和数据库文件默认被 `.gitignore` 排除。本报告记录可提交的结果摘要；原始文件需要单独保留。

## 1. 测试目的

本次测试用于验证 OpenContext 在 BEAM 128k 长对话上的端到端记忆问答表现，并通过完整链路区分以下问题：

1. 数据集是否提供了可用的 gold source；
2. 对话是否正确进入 OpenContext；
3. Top-K 是否召回 gold source；
4. Answerer 是否利用已召回证据正确作答；
5. Judge 是否按 nugget atoms 完成评分。

本报告不会把端到端分数直接解释为纯检索能力，也不会把 Answerer、Judge 或 benchmark adapter 的问题直接归因于 OpenContext 核心 memory 实现。

## 2. 测试配置

| 项目 | 配置 |
|---|---|
| 数据集 | `dataset/beam_128k.json` |
| 数据集大小 | 13,441,553 bytes |
| 数据集 SHA-256 | `8cc3374c9f258bfa91df3f7a0d5d7c9ade64dd704a723829c2095dbeabb43d7e` |
| 上游数据 | `Mohammadta/BEAM`, config `default`, split `100K` |
| 上游 revision | `3205395e897e7318c7b094ef4e6047b9b82dbb03` |
| 会话数 | 20 |
| 问题数 | 400，每类 40 题 |
| Answerer | `openrouter:deepseek/deepseek-v4-flash-0731` |
| Judge | `openrouter:qwen/qwen3.7-flash` |
| 检索 | `memory-search`, Top-K=8 |
| 对话分块 | 每 20 turns 一个 memory message |
| trace schema | `1.1` |
| manifest commit | `d722484d759f176c269523fe9958ce75a8f78956` |
| resume | `true` |

结果 manifest 没有记录 daemon 的 memory backend、embedding provider/model、embedding token limit、merge strategy、数据库路径或 Git dirty state。因此，仅凭 manifest 还不能完整重建本次 daemon 和实际工作树配置。这是本次结果的复现限制之一。

## 3. 执行完整性与成本规模

| 指标 | 结果 |
|---|---:|
| 已完成问题 | 400 / 400 |
| execution error | 0 |
| wall-clock | 942,760 ms，约 15 分 43 秒 |
| prompt tokens | 30,046,468 |
| completion tokens | 1,409,917 |
| total tokens | 31,456,385 |
| 平均每题 total tokens | 约 78,641 |

Provider token usage 已完整返回，但本报告不估算货币成本，因为实际费用取决于 OpenRouter 当时的模型定价和账户路由。

## 4. 总体结果

| 指标 | 结果 |
|---|---:|
| Nugget Mean | 0.5305 |
| Pass Count | 227 / 400 |
| Pass Rate | 56.75% |
| 未通过 | 173 / 400 |

本次 400 题全部获得 Answerer 和 Judge 结果，因此结果足以用于问题定位。但由于检索通道、分块和复现信息仍存在下述问题，当前分数只作为第一次诊断基线。

## 5. 分类结果

| 分类 | Nugget Mean | Pass Rate | 通过数 |
|---|---:|---:|---:|
| abstention | 0.8250 | 82.50% | 33 / 40 |
| preference_following | 0.7146 | 80.00% | 32 / 40 |
| information_extraction | 0.6292 | 65.00% | 26 / 40 |
| contradiction_resolution | 0.4906 | 60.00% | 24 / 40 |
| instruction_following | 0.5563 | 57.50% | 23 / 40 |
| multi_session_reasoning | 0.4855 | 52.50% | 21 / 40 |
| summarization | 0.4341 | 52.50% | 21 / 40 |
| temporal_reasoning | 0.4500 | 50.00% | 20 / 40 |
| knowledge_update | 0.4750 | 47.50% | 19 / 40 |
| event_ordering | 0.2444 | 20.00% | 8 / 40 |

表现较好的类型是 abstention、preference following 和 information extraction。最弱的是 event ordering，其次是 summarization、temporal reasoning 和 knowledge update。总体趋势表明：单点事实和拒答相对稳定，多证据组合、时间顺序和新旧信息更新明显较弱。

## 6. 检索链路结果

以下指标只统计具有 upstream gold source IDs 的 355 题：

| 指标 | 结果 | 含义 |
|---|---:|---|
| Hit@8 | 92.11% | Top-8 中至少出现一个 gold source |
| Mean Source Recall@8 | 0.8027 | 平均召回约 80.27% 的必要 source turns |
| All Required Sources Retrieved | 65.35% | 所有必要 source 都进入 Top-8 |
| Precision@8 | 0.2011 | Top-8 中真正覆盖 gold source 的块比例较低 |
| MRR | 0.2958 | 第一个相关块通常排序不够靠前 |
| Dataset Source Coverage | 1.0000 | 有 source ID 的题目，其 ID 均能在数据集中找到 |

这说明检索通常能找到至少一条相关证据，但在需要多个事件或多个会话证据的题目上，经常只召回部分证据；同时 Top-8 中包含较多无关内容。

### 6.1 最终结果几乎只有 lexical 信号

400 题共返回 3,200 个 Top-K hits：

- `lexical-only`：3,199；
- `lexical + semantic`：1；
- `semantic-only`：0。

因此，本次实际送入 Answerer 的最终证据几乎完全由 lexical 通道提供。现有 trace 只记录合并后的 Top-K，没有记录 semantic 和 lexical 的合并前候选列表，所以暂时无法判断：

1. semantic ANN 没有返回候选；还是
2. semantic 候选存在，但被 merge/ranking 阶段全部淘汰。

在查清这一点之前，不能将本次结果视为对 OpenContext semantic memory 的有效测量。

### 6.2 分块明显大于本地 embedding 输入范围

当前 [evaluator.ts](../src/evaluator.ts) 固定每 20 turns 生成一个 memory message。本次共有 296 个块：

| chunk 字符数 | 结果 |
|---|---:|
| 平均 | 41,712 |
| P50 | 40,834 |
| P95 | 58,259 |
| 最大 | 376,965 |

仓库当前 [local-transformers-embedding-provider.ts](../../../packages/ai/rag/src/local-transformers-embedding-provider.ts) 的默认 `maxTokens` 是 512，并显式启用 tokenizer truncation。如果 daemon 使用该本地 embedding 路径，一个数万字符块不可能被完整表示，后半部分信息不会参与该块的 embedding。

由于本次 manifest 没有记录实际 embedding provider 和 token limit，这一点应视为高风险配置问题，而不是已经由 artifact 完全证明的唯一根因。

## 7. Answerer 链路结果

Answerer 每题收到 8 个完整 memory chunks：

| Answerer 输入 | 结果 |
|---|---:|
| 平均 context 字符数 | 343,439 |
| 平均 prompt tokens | 74,191 |
| P50 prompt tokens | 71,928 |
| P95 prompt tokens | 100,504 |
| 最大 prompt tokens | 105,620 |

输入虽然没有触发 execution error，但上下文非常大、无关证据比例较高。模型需要在约 7 万至 10 万 tokens 中寻找少量关键事实，既增加费用，也会降低时间顺序、冲突更新和多证据综合的稳定性。

### 7.1 失败阶段

| Failure Stage | 数量 | 解释 |
|---|---:|---|
| `context_present_answer_failed` | 94 | 全部 gold sources 已进入 Top-K，但最终答案未通过 |
| `retrieval_partial` | 64 | 只召回部分必要 sources |
| `retrieval_miss` | 14 | 没有召回任何 gold source |
| `dataset_reference_missing` | 1 | 上游题目没有提供 source IDs |
| `none` | 227 | 通过 |

`context_present_answer_failed` 的 94 题不等于“OpenContext 检索正确、只有模型错误”。它只表示 gold source 所在的大块进入了 prompt；在超大块和超大 prompt 下，关键内容仍可能被噪声掩盖。此类失败主要集中在：

- knowledge update：18；
- contradiction resolution：13；
- temporal reasoning：13；
- instruction following：12；
- multi-session reasoning：10。

这部分需要用更小的证据单元或 gold-evidence 对照实验，才能继续区分上下文构建与 Answerer 能力。

## 8. 引用与评判链路问题

在 355 个需要 source evidence 的问题中：

| Attribution | 数量 | 比例 |
|---|---:|---:|
| supported | 153 | 43.10% |
| unsupported | 110 | 30.99% |
| uncited | 92 | 25.92% |

当前 [diagnostics.ts](../src/diagnostics.ts) 只识别 `Excerpt 3`、`Memory excerpt 3` 或 `[3]` 形式。Answerer 如果直接输出 `beam_9__chunk_1` 等真实 chunk ID，仍可能被标记为 `uncited`。因此 attribution 结果可以用于发现问题，但暂时不能作为精确的引用正确率。

此外至少确认了两类数据质量问题：

1. `128k_18_q_16` 没有 upstream source IDs，无法计算检索归因；
2. `128k_1_q_18` 的 gold answer 写的是 `4 weeks`，nugget atom 要求 `8 weeks`。Judge 按 atom 打分，因此该题的失败不能直接归因于 Answerer 或 memory。

Answerer 与 Judge 使用不同模型本身不是问题。当前主要风险是 Answerer 的输入组织，以及原始 atoms/source references 的一致性。Judge 模型的稳定性仍应通过抽样复核验证。

## 9. 当前结论

本次测试可以得出以下结论：

1. 128k 的 400 题端到端流程已经完整执行，没有 provider 或执行错误；
2. 当前路径擅长拒答、偏好和单点事实提取；
3. event ordering、多会话综合、时间推理和知识更新是主要弱项；
4. 多证据完整召回和排序质量不足；
5. 最终 Top-K 几乎为 lexical-only，semantic retrieval 是否有效仍未得到证明；
6. 20-turn 大块和平均约 74k tokens 的 Answerer prompt 是明显的效率与质量风险；
7. 部分失败来自 benchmark 数据引用或 atom 不一致，不能全部计入 OpenContext 缺陷。

因此，本次结果应保留为“BEAM 128k diagnostic baseline v1”，不应直接用于对外宣称 OpenContext 的正式 BEAM 成绩，也不适合与其他 agent 的公开成绩直接比较。

## 10. 改善建议

按优先级执行最小修复：

### P0：确认 semantic 检索真实生效

1. benchmark 请求显式指定并记录 merge strategy；
2. trace 记录 semantic、lexical 合并前候选数量及最终通道占比；
3. manifest 记录 daemon backend、embedding provider/model/max tokens、reasoning 配置和数据库身份；
4. 正式运行前使用已知事实校准，要求 semantic 通道产生可验证候选，否则停止运行并报告。

### P1：缩小检索单元和 Answerer 上下文

1. 优先按单个 source turn 建立检索单元；
2. 超长 turn 再按 token 切分，并保留同一 source ID；
3. 让 embedding 输入稳定落在实际 token limit 内；
4. Top-K 后去重、轻量 rerank，只向 Answerer 提供相关片段和必要相邻 turns；
5. 保留时间戳和 source ID，对时间及事件顺序问题按时间组织证据；
6. 为 Answerer prompt 设置明确预算，避免继续发送 7 万至 10 万 tokens 的原始块。

### P2：完善诊断可靠性

1. Answerer 使用结构化 citations，或让解析器支持实际 chunk ID；
2. 运行前检查 source IDs、gold answer 和 nugget atoms 的数字、日期一致性；
3. 对弱项分类抽取固定样本，分别运行实际检索上下文和 gold evidence，对比定位 retrieval/context/answerer；
4. 对分层样本进行人工或更强 Judge 复核，但不修改原始 nugget 评分规则。

## 11. 下一版 128k 的最低验收条件

重新完整运行 128k 前，至少满足：

- semantic 通道在校准查询和 trace 中可见，不再静默退化为近乎纯 lexical；
- 检索单元不超过实际 embedding token limit；
- manifest 能重建 daemon、embedding、merge strategy、数据库和工作树状态；
- Answerer prompt 有明确预算，并报告平均值与 P95；
- 使用新的空数据库和 `--no-resume`；
- 保持原始 nugget scoring 不变，新增诊断字段不参与分数；
- 完整运行仍需达到 400 / 400 completed、0 execution errors；
- 原始总分、数据异常和链路指标分别报告，不能把无效 source/atom 问题计为 OpenContext 缺陷。

