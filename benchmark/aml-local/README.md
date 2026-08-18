# aml-local — AML（Agent Memory Leaderboard）本地预评测

在本地复现 [Agent Memory Leaderboard](https://github.com/AML-memory/agent-memory-leaderboard) 的评测管线，
记忆后端为 **OpenContext daemon**（`http://127.0.0.1:7421`）：

```
数据集 → retrieve.py → OpenContext（POST /v1/raw-messages 灌入，样本级 userId 隔离）
                     → 每题 POST /v1/search → AML 格式 input.jsonl
       → AML 官方 pipeline.py answer（生成回答）
       → AML 官方 pipeline.py evaluate（判分）
       → judged.jsonl + 汇总分数
```

## 前置

- OpenContext daemon 运行中（见仓库根目录 benchmark 说明；`curl http://127.0.0.1:7421/health`）
- AML pipeline 环境（已克隆到 `benchmark/AML-agent-memory-leaderboard/`）：

```powershell
cd benchmark\AML-agent-memory-leaderboard
uv venv .venv
uv pip install --python .venv\Scripts\python.exe -r requirements.txt
```

- `.env`：`OPENROUTER_API_KEY=...`（答题和判分都走 OpenRouter；答题模型默认 `qwen/qwen3-14b` 与 AML 公开 pipeline 默认对齐，judge 默认 `qwen/qwen3.7-plus`）

## 运行

```powershell
.\run_aml_local.ps1 -Bench longmemeval -Limit 5          # LongMemEval-S 前 5 题
.\run_aml_local.ps1 -Bench locomo -Samples conv-26       # LoCoMo 指定会话（150 题/会话）
.\run_aml_local.ps1 -Bench clbench -Limit 2              # CL-bench-Life 前 2 条
.\run_aml_local.ps1 -Bench beam -Limit 1                 # BEAM 示例会话
```

常用参数：`-Limit N`（样本数）、`-MaxQuestions N`（每样本题数上限）、`-SkipIngest`（复用已灌入记忆，仅重检索）、`-Dataset beam_1m.json`（BEAM 换数据集）。

产物在 `outputs/<bench>/`：`input.jsonl`（检索结果）、`answers.jsonl`（生成回答）、`judged.jsonl`（判分明细）。

## 本地冒烟基线（2026-08-18，daemon: sqlite-vec + 本地 embedding）

| Benchmark | 样本 | 分数 |
|---|---|---|
| longmemeval-s | 前 5 题 | accuracy 80% (4/5) |
| locomo | conv-26 全量 150 题 | accuracy 54% (81/150) |
| clbench | CL-bench-Life 前 2 条 | solving rate 0/2（要求满足率 0.925，评分全或无） |
| beam | sample 1 题 | llm_judge_score 1.0000 |

注意：本地用的是公开数据集（locomo_v2 / CL-bench-Life / beam sample），与 AML 榜单上的 refined 私有数据集不同，
分数仅供开发迭代参考，不等于榜单成绩。正式成绩需在 agentmemories.ai 申请评测后由平台运行。

## 对 AML 克隆仓库的本地补丁

AML 公开 pipeline 在 `answer`/`evaluate` 里把普通 `open()` 文件对象传进 `async with`（CPython 不支持），
已在 `api_config.py` 增加 `_afile()` 包装并替换 4 个 pipeline 中的 6 处调用——只改文件句柄写法，未动任何评分/答题逻辑。
