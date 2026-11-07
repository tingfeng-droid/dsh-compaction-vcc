# dsh-compaction-vcc

> **本项目由 [tingfeng-droid](https://github.com/tingfeng-droid) 维护。** 基于 [TsFreddie/dsh-compaction-instant](https://github.com/TsFreddie/dsh-compaction-instant)（MIT）——"对话编译"这一设计出自原作者，在此致谢。
> 主要改动：修复 host 0.2.2 下 `toolCallId` 字段位置变化导致 `-> result N` 指针静默丢失的兼容性问题（见 `src/compiler.js` / `src/session-compat.js`），并补齐 100 项测试。

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造的**即时、近无损上下文压缩**引擎——**装上就能直接替换官方引擎 `@deepseek-ai/dsh-compaction-basic`**，用 [lllyasviel/VCC](https://github.com/lllyasviel/VCC) 的"对话编译"思路取代原来的 LLM 摘要。

对话太长了怎么办？普通方案是让模型把旧内容"总结"一遍（慢、花钱、还会丢细节）。本引擎不总结，而是把旧内容**重新整理成一份紧凑的存档**（后面统称"检查点"）：毫秒级完成、不调用模型、只使用原来的原文，不改写、不编造。被收进存档的内容随时可以原样找回来。

## 为什么"保留原文"能避免幻觉

这是本项目最重要的设计取舍，值得单独说清楚。

**LLM 摘要式压缩会制造幻觉。** 让模型总结历史，它会把"我记不清的细节"用合理的措辞补上——**这些补出来的内容是模型编的，不是事实**。更麻烦的是它很难被发现：摘要读起来通顺、看起来合理，模型随后会**把自己的摘要当成事实依据**继续推理。一个被改写的数字、一句被"洗"过的话、一处被省略的前置条件，都可能让后续整段推理建立在错误前提上。

**保留原文从根上断掉了这条路径。** 本引擎压缩时**只搬运原文，一个字都不改写**：

- 每处省略都带 `(seq N)` 指针，指回持久日志里的原始事件；
- 模型可以随时用 `recall` 把被压掉的完整原文**逐字取回**；
- 所以模型看到的永远只有两种东西：**原文**，或**明确标注"这里省略了，去 seq N 拿"的指针**——不存在第三种。

换句话说，**摘要式压缩 = 原文被模型改写；本引擎 = 原文被原样归档，只是排版变紧凑了。** 前者会安静地产生编造，后者在结构上就没有编造的空间。

这对长会话尤其关键：上下文越长，摘要要覆盖的内容越多，改写和丢失的机会就越多；而指针式归档的成本是**每处省略几个字节**，与历史长度几乎无关。

## 主要特性

- **免 LLM**——压缩过程完全不调用模型：没有摘要请求、没有推理等待、不花 token。它只是确定性的文本处理，哪怕一百万个 token 的历史也是毫秒级搞定。
- **近无损**——存档里只有原文；每处被省略的内容都有标记并注明出处（`seq` 序号），之前的存档会原封不动地保留。
- **即时**——把旧内容扫描一遍就完成；不联网、不调模型、不占 KV 缓存。
- **完全兼容的替换**——对外接口、事件、计费和报错方式都和官方引擎一致；内置预设不用改任何东西就能用（见"别名安装"）。

## 示例

一段包含用户提问、助手回答 + 工具调用及其结果的历史，压缩后长这样：

```
[user]
please fix the bug
[assistant]
on it
* read "a.js" (seq 2 -> result 3)
[user]
next question
```

每个工具调用只占**一行**：白名单里的工具（`toolArgTools`）显示关键参数，其他工具只显示名字（`* job_kill (seq 9 -> result 10)`），`hideTools` 里列的工具完全不出现。工具结果不占位置——通过 `-> result N` 指针，用一次 `recall(type:"result")` 就能取回。较长的用户/助手文本按预算截断，并在末尾标注 `...(truncated from seq N)`；每处省略都写明了完整内容存在哪个事件里。

## Recall：把丢掉的内容找回来

本包还配套了"找回"能力——**同一会话内的回读**，模型和人都能用。因为会话日志只增不改，编译器省略过的每一个字都还在，随时可取：

| 入口 | 模块 | 作用 |
|---|---|---|
| `recall` **工具**（给模型用） | `dsh-compaction-vcc/tool` | 按类型恢复原文：`type:"seq"` 配合 `(seq N)`/`(seqs A-B)` 标记，`type:"result"` 配合 `result N` 指针，`type:"checkpoint"` 配合 `[checkpoint N]` 序号——把原始内容一字不差地恢复到当前工具结果里 |
| `search` **工具**（给模型用，grep） | `dsh-compaction-vcc/tool` | 在整个持久日志里按关键词/正则搜索——包括被压缩掉的内容——返回带 `(seq N)` 指针的匹配事件，可直接交给 `recall` 取回 |
| `/recall` **命令**（给人用，grep） | `dsh-compaction-vcc/command` | `/recall <关键词|正则>` 追加一条持久的用户消息，内含匹配事件和 seq 指针，下一轮模型就能看到 |
| 共享核心 | `dsh-compaction-vcc/recall` + `dsh-compaction-vcc/search` | seq 解析（`12`、`3-7`、`seq 12` / `seqs 3-7`）、日志展开、预算、字段筛选；正则编译与命中展示 |

Recall 能取回**一切**：文本、推理过程、工具调用的完整参数、嵌套的工具结果；只在日志里出现过的事件会以带标签的原始数据展示；找不到的 seq 会明确报错。`maxRecallTokens` 预算（默认 **16000**）超限时会截断并标注来源、统计跳过多少；搜索限制展示条数（`maxSearchHits`，默认 **50**）。这两个插件是独立的一行，可以挂在**任何**压缩引擎旁边——它们只读日志，不依赖本引擎。

每个检查点开头还附了一段简短的 **RECALL 使用指南**，告诉模型怎么用 `recall` / `search` 找回被省略的内容。如果更早的检查点因为空间不够被省略，它不会无声消失：会留下一行 `[checkpoint N]`（N 是压缩序号，1 = 最早），用 `recall(type:"checkpoint", id:"N")` 就能完整恢复。

## 配置

所有配置项都可选，括号里是默认值。

| 键 | 默认 | 含义 |
|---|---|---|
| `thresholdRatio` | `0.5` | 上下文用到多大比例时自动触发压缩（0.5 = 用到一半） |
| `retainTurns` | `1` | 优先保留的完整回合数（自动压缩和手动 `/compact` 都按此规则；不突破上限） |
| `retainTokens` | `20480` | 保留区 token **硬上限**：向前补足完整回合时总量永不超出；若最近回合本身就超过它，只保留该回合内能装下的部分 |
| `auto` | `true` | 开启自动压缩：监听 `agent/pre-step` 压力事件和 `agent/request-error` 溢出恢复 |
| `checkpointCap` | `393216` | 单个检查点的编译预算（估算 token）：更小的会话近乎无损地保留，更大的内容则省略到该上限 |
| `maxTokens` / `checkpointScale` | `8192` / `0.1` | **已弃用**——仅为兼容旧配置而接受，**不再起作用**：预算就是 cap 本身（无保底、无比例缩放） |
| `textTokens` | `8192` | 每条助手文本的预算 |
| `userTextTokens` | `16384` | 每条用户文本的预算 |
| `toolCallTokens` | `128` | 每个工具调用单行的预算（这个永远不缩放——见下面的省略规则） |
| `toolResultExcerptTokens` | `256` | 仅为兼容官方配置而接受；**不起作用**——工具结果本来就不占位置 |
| `includeReasoning` | `false` | 是否在检查点里保留推理过程 |
| `stripNoiseXml` | `true` | 是否去掉用户文本里配置的噪音标签 |
| `noisePatterns` | 见 compiler | 噪音标签的正则来源，按 `s` 模式匹配 |
| `toolKeyFields` | 内置 | 额外的"工具名 → 参数里的关键字段"映射，用于单行展示 |
| `toolArgTools` | 见 compiler | 白名单：这些工具的关键参数会显示在单行里（`read`/`write`/`edit`/`glob`/`grep`/`bash`/`shell`/`web_search`/`skill`/`subagent`/…）；其余工具只显示名字 |
| `hideTools` | — | 完全从检查点里去掉的内部管理工具 |
| `modelPolicies` | — | 按 provider/model 单独覆盖 `thresholdRatio`/`retainTurns`/`retainTokens` |
| `compactionRetries` / `maxOverflowRetries` | `1` / `1` | 重试次数，含义和官方引擎一样 |
| `summarizationProvider` / `summarizationModel` | — | 仅为兼容官方配置而接受；**不起作用**——本引擎从不调用模型 |

recall 工具和命令插件各自接受 `{ maxRecallTokens?: 16000, maxSearchHits?: 50 }` 配置。

> **Cordis 配置坑：** 插件行的配置要经过 schemastery schema 校验，它的 `~standard` 适配器会给**每个没写的数组项注入 `[]`**（`toolArgTools`、`hideTools`、`noisePatterns`、`toolKeyFields`、`modelPolicies`）。本引擎把空数组当作"没设置"，会回退到默认值——所以不写 `toolArgTools` 就自动用内置白名单（千万别用 `toolArgTools: []` 想关掉它；空 = 默认）。`debug: true` 会把每次压缩的诊断写进 `debugLogPath` 指定的文件（默认 `$DSH_HOME/compaction-debug.log`）。

预算有两道保险：按 token 数限制，再按"预算 × 4"的字符数限制——所以再长的连续字符串（base64 大块、压缩过的文件）也绕不过去。工具调用**永远是单行**：不会缩放，预算不够时只压缩对话文本（每条最少留 **32 token**）。如果压缩结果还是超过预算，先删最旧的**工具行**（`[N tool/result entries elided: seqs a-b]`），再删其余最旧的条目（`[N earlier entries elided: seqs a-b]`）——工具调用永远挤不掉对话。最新的内容总能保住。

### 设置命名空间（无界面）

引擎在**任何装配了 settings 域**的部署（标准 web/desktop profile 都有）上暴露一个用户设置命名空间（`compaction-vcc`）。可编辑子集持久化到 `settings.yaml`，**叠加在**插件行的 cordis 配置之上：

| 字段 | 含义 |
|---|---|
| `checkpointCap` | 单个检查点的编译预算（默认 393216） |
| `auto` | 注册步骤间自动压缩 |
| `thresholdRatio` | 触发自动压缩的上下文窗口占比（默认 `0.5`） |
| `retainTurns` | 优先保留的完整回合数（默认 `1`；不突破上限） |
| `retainTokens` | 保留区 token **硬上限**，补足回合或截取最近回合时永不超出（默认 `20480`） |

其余字段（`modelPolicies`、`toolArgTools`、`debug`、`debugLogPath`、已弃用的 `maxTokens`/`checkpointScale` 等）仍只由 cordis 配置管理。设置层永远弄不坏引擎：每次设置写入都会先经过完整配置解析器的重新校验才会持久化；未暴露的配置字段保持组合层的值。没有 settings 服务时引擎行为与之前完全一致（只看组合配置）。

> **⚠️ 没有图形设置卡片。** 0.2.0 起 `dsh.client` 声明已被整个删掉（原因见下方版本表）。上面的命名空间仍然存在、仍可通过 settings API 读写，但**不会被渲染成界面控件**——改这些值请直接编辑 `cordis.patch.yml` 的 `compaction-vcc.config`。

### 分词与多语言

分词器是简单的字符规则：连续的英文字母算一个 token，连续数字算一个，标点一个字符一个，空格免费，其他每个字符算一个。具体：

| 内容 | Tokens |
|---|---|
| 中文（`你好，世界！`） | 每个字 1（共 6） |
| 西里尔 / 阿拉伯文 | 每个字符 1 |
| 带重音拉丁文（`café`） | 英文部分成组（`caf` + `é`） |
| Emoji（`😀`） | 2（一个 emoji 占两个 UTF-16 单元） |

所有截断都发生在**字符边界**——绝不会把一个 emoji 从中间切开（有 `test/multilang.test.js` 保证）。字符密度上限按 DeepSeek 官方换算（token_usage 文档）：约每个非中日韩字符 0.3 token、每个中日韩字符 0.6 token。

另外，Harness 自带的 token 计量器（用于"压缩后必须变小"的检查、`/compact` 的用量报告）用的是另一套 `字符数 / 4 + 固定开销` 的估算，两套算法故意并存——详见设计说明。

## 保证

- **即时**——把旧内容扫描一遍就完成；不联网、不调模型、不占 KV 缓存。
- **近无损**——输出里只有原文；每处省略都有标记并注明出处 `seq`；之前的检查点原封不动保留。
- **完全兼容的替换**——接口、事件、计费（走同一个 `ctx.tokenMeter`）和报错方式与官方引擎一致，包括"压缩后必须变小"的检查（如果压缩完反而没变小，会被拒绝）。
- **可选 pruner 兼容**——和官方引擎一样会使用可选的 `toolResultPruner` 服务（它负责整理*保留部分*；被压缩的旧内容由本引擎自己处理）。

## 实测压缩率（真实会话、一条不丢）

数据来自真实会话日志（本项目的开发会话），编译时**不丢弃任何一条**——每条都保留，只做条目级截断和工具调用单行化。百分比是相对原文 token 数的比例。

| 负载 | 原文 tokens | 编译后 | 保留 | 压缩 |
|---|---|---|---|---|
| 工具密集会话全量（3,181 节点：1,438 个工具调用 + 1,540 个工具结果） | 2,523,012 | 226,205 | **9.0%** | 91.0% |
| 另一个会话全量（864 节点） | 685,088 | 62,705 | **9.2%** | 90.8% |
| 同一个工具密集会话，最近 800 条消息 | 625,927 | 45,031 | **7.2%** | 92.8% |
| 纯文本（同一会话去掉全部工具行） | 160,963 | 109,945 | **68.3%** | 31.7% |

压缩主要来自哪里（不丢条目的情况下）：

- **工具结果零成本**——结果不产生条目，靠 `-> result N` 指针一个 `recall` 就能取回，这是最大的来源。
- **工具调用一行化**——每个调用压成一行（≤ 128 tokens，平均约 100）。
- **思考过程不保留**——reasoning 增量整体省略（有标记，不是悄悄丢）。
- **对话文本近乎无损**——纯文本对照组保留了 68.3%；文本上那约 1.5 倍压缩基本是剥掉 JSON 包装，外加只截断最长的几段。

预算扫描（同一个 252 万 tokens 的工具密集会话）：默认 64K 上限下，编译视图约 5.6 万 tokens（原文的 2.2%）。只有把上限压到约 22.6 万 tokens 的"完全不丢"阈值以下才开始丢条目——代价是**悬崖不是斜坡**：

| Cap | 编译后 | 保留 | 条目数 | 被丢 |
|---|---|---|---|---|
| 8,192 | 8,243 | 0.33% | 111 | 2,090 |
| 32,768 | 22,263 | 0.88% | 232 | 1,969 |
| 65,536（部署默认） | 55,737 | 2.2% | 325 | 1,876 |
| 65,536 | 55,737 | 2.2% | 325 | 1,876 |
| 131,072 | 131,047 | 5.2% | 1,142 | 1,058 |
| 226,205（一条不丢的临界值） | 226,205 | 9.0% | 2,199 | 0 |

## 安装

下面三种方法都用 Harness 自带的插件管理器安装（包发布在 npm，名字 `dsh-compaction-vcc`；插件管理器会在 profile 目录里跑 pnpm，装完后宿主配置和每个 agent preset 都能找到它）：

```bash
dsh plugin --profile web add <spec>
```

`/compact` 命令（`dsh-command-compact`）和用哪个引擎无关，任何安装方式下都照常工作。

### ⚠️ 先读这一段：装不对会「静默失效」

**如果你的宿主挂载了 agent preset（`standard` / `ptc` / `minimal` / `cordis` 任何一个），
直接 `dsh plugin add dsh-compaction-vcc` 是不够的。**

原因：每个 preset 用 `isolate` 挂在自己独立的 realm 里，preset 内那条
`compaction-basic` 会在**它自己的 realm 内**实例化一个引擎。本包插在宿主层的那一行
**进不去 preset 的 realm**（上游 `leakedServices` 强制要求压缩服务待在 isolate
realm 里，从外部注入会直接报错）。

结果就是**静默失效**：

| | 状态 |
|---|---|
| `recall` / `search` 工具 | ✅ 能用（工具注册是全局的） |
| `/recall` 命令 | ✅ 能用 |
| **实际压缩** | ❌ **还是官方 basic 在跑（调模型、出摘要）** |

**判断依据只有一个**——看 `compaction/summary` 事件的 `provider` 字段：

```bash
zstd -dc <session>.jsonl.zstd | python3 -c "
import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    o=json.loads(line)
    if o.get('type')=='compaction/summary':
        d=o['data']
        print(o['seq'], d.get('provider'), d.get('model'), 'llm=',d.get('llmStreamCall'))
"
```

- `provider = dsh-compaction-vcc` / `model = vcc-compiler` → ✅ 正常
- `provider` 是聊天模型（如 `zlwb-pool-vision`）、`llmStreamCall: true` → ❌ **还走的是 basic**

**0.3.0 起本引擎会自己在启动后做这项检查，发现 preset 没接管就在日志里打一条
明确的 `warn`**，不再让你靠猜。开关是 `warnOnPresetTakeover`（默认 `true`）。

挂载了 preset 时，请用**方法 1**（推荐），或方法 2 / 3（要改动预设）。
没有挂载 preset 的宿主，直接装即可。

> 怎么知道自己有没有挂 preset？看 profile 的 `dsh.profile.bundles` 里有没有
> `@deepseek-ai/dsh-web-app`（它插入了 `agent-preset-registry`，`config.default: standard`），
> 或运行 `dsh --profile <name> --dump-config | grep -c "preset-"`。

### ⚠️ 第二种静默失效：两份副本，一份新一份旧

**只在你「换过安装方式」或「同一台机器试过多种装法」时会遇到，但它比上一条更难查。**

两种装法用的是**两个不同的包名**：

| 装法 | 包名（`node_modules/` 下的目录） |
|---|---|
| bundle 装法（`dsh plugin add dsh-compaction-vcc`） | `dsh-compaction-vcc` |
| 别名装法（`add "@deepseek-ai/dsh-compaction-basic@npm:dsh-compaction-vcc"`） | `@deepseek-ai/dsh-compaction-basic` |

**关键：这两个名字都可能真的在被使用，但它们不是一回事。**

- **别名**（`@deepseek-ai/dsh-compaction-basic`）——宿主内置的每个预设
  （`preset-standard` 等）都在自己的 `isolate` realm 里声明一行
  `{ id: compaction-basic, name: "@deepseek-ai/dsh-compaction-basic" }`。
  **预设只认这个名字。** 别名装法就是用我们这份顶替官方那份。
- **真名**（`dsh-compaction-vcc`）——只是宿主层的 `- id: compaction-vcc` 条目在用它，
  另外 `recall` / `search` 工具也从这里来。

⇒ **别名不是可有可无的残留。删掉别名 = 所有预设都退回官方 LLM 摘要。**
而 `recall` / `search` 工具照样能用，所以**看起来一切正常**。

**升级只覆盖你当前用的那个名字**，于是出现一旧一新：

```
node_modules/dsh-compaction-vcc/                 ← 每次升级都更新
node_modules/@deepseek-ai/dsh-compaction-basic/  ← 停在第一次装进去的版本
```

**2026-11-07 实证（一）：两份副本，版本不同。** 机器上
`dsh-compaction-vcc/` 已是 0.7.0，`@deepseek-ai/dsh-compaction-basic/` 还停在同一晚
19:59 装的 **0.4.0**。宿主加载的是 0.4.0，压缩产出与 0.4.0 离线编译逐字吻合
（129 条目），而 0.7.0 应产出 185 条目。排查时静态检查全绿（版本号、入口、
`role === "tool"` 分支都在），只有实际产出对不上。

**2026-11-07 实证（二）：矫枉过正，把别名删了。**
同一台机器上「按实证（一）的办法删掉别名」之后，下一次压缩的
`compaction/summary` 事件里 `provider` 从 `dsh-compaction-vcc` 变成了
**一个聊天模型**（`zlwb-pool-vision` / `deepseek-v4.1-flash`），正文从
8 万字符的原文搬运缩成 5 千字符的 LLM 摘要——**8.3 万 token 的对话被概括成一段话**。
这就是上面那条：别名没了，预设回落到官方摘要引擎。

**⇒ 正确做法不是删别名，而是让两份都更新到同一版本。**

#### 怎么查

**第 1 步：看有多少份、各是什么版本。**

```bash
find ~/.dsh/profiles/<profile>/node_modules -maxdepth 3 \
  -path "*compaction*" -name package.json 2>/dev/null \
  | while read f; do
      python3 -c "import json;d=json.load(open('$f'));print('$(dirname $f)', '→', d['name'], d['version'])"
    done
```

两行、版本相同 = 健康。两行、版本不同 = 有一份旧（**不是删掉，是更新**）。
只有一行 = 看你有没有挂预设（见下一节）。

**第 2 步：看预设到底解析到谁。**

```bash
cd ~/.dsh/profiles/<profile> && node -e '
const {createRequire}=require("module");
const r=createRequire("file://" + process.cwd() + "/");
try{
  const m=r("@deepseek-ai/dsh-compaction-basic/package.json");
  console.log("别名解析到:", m.name, m.version);
  console.log(m.name==="dsh-compaction-vcc" ? "✅ 预设会用本引擎" : "❌ 预设会用官方摘要引擎");
}catch(e){ console.log("❌ 别名解析不到 —— 所有预设都会退回官方摘要引擎"); }
'
```

**第 3 步（最硬的判据）：看下一次压缩的 `provider`。**

```bash
zstd -dc ~/.dsh/sessions/<工作区>/session-<id>/session.v4.jsonl.zstd 2>/dev/null \
  | python3 -c '
import sys,json
for line in sys.stdin:
    try: o=json.loads(line)
    except: continue
    if o.get("type")=="compaction/summary":
        d=o["data"]
        kind="LLM摘要(NG)" if "llmStreamCall" in d else "VCC确定性编译(OK)"
        print(o["seq"], d["provider"], "|", kind)
'
```

`provider` 必须是 `dsh-compaction-vcc`。**出现任何聊天模型名 = 跑的是官方摘要引擎。**

#### 怎么修

两份都更新到同一版本。**别删别名。**

```bash
TGZ=~/dsh-compaction-vcc/dsh-compaction-vcc-X.Y.Z.tgz
for D in dsh-compaction-vcc @deepseek-ai/dsh-compaction-basic; do
  T=~/.dsh/profiles/web/node_modules/$D
  mkdir -p "$T" && tar xzf "$TGZ" -C "$T" --strip-components=1
done
```

`package.json` 里两条 `file:` 依赖都指向同一个 tgz 即可：

```json
"dsh-compaction-vcc": "file:.../dsh-compaction-vcc-X.Y.Z.tgz",
"@deepseek-ai/dsh-compaction-basic": "file:.../dsh-compaction-vcc-X.Y.Z.tgz"
```

**别名那条不要写进 `dsh.profile.bundles`**——它只是个顶替用的名字，
进去会让宿主把它当独立 bundle 再挂一次。

**0.7.2 起本引擎会在启动时自检**，发现同一台机器上还有另一份同名包时打印
`warn`；自检按**包清单里的 `name` 字段**判断，不按目录名——目录名和包名不一致
正是别名装法的常态。（0.7.1 的自检按路径字符串判断，会把健康的别名装法误报成
「没接管」，0.7.2 已修。）

> **一句话记忆**：升级这个包之后如果「没变化」，先数 `node_modules` 里有几份、
> 各是什么版本，**并且看下一次压缩的 `provider`**。版本号对但行为是旧的，
> 多半是加载了另一份；`provider` 变成聊天模型，则是别名没了、预设退回了官方摘要。

### 方法 1 —— 顶替内置引擎（别名安装）

```bash
dsh plugin --profile web add "@deepseek-ai/dsh-compaction-basic@npm:dsh-compaction-vcc"
```

**dsh 目前没法让你选压缩引擎**，内置预设（`standard`、`code`、`cordis`）在配置里写死了包名 `@deepseek-ai/dsh-compaction-basic`。要让这些内置预设用上本引擎，就**顶替**内置插件：预设配置里的包名是从 profile 的 `node_modules` 解析的（优先级高于 Harness 自带的安装），所以把本包装到内置这个名字下面，所有内置预设就会自动加载本引擎——不动任何预设文件，预设以后升级也不受影响。

这样顶替是天然安全的：本引擎和官方引擎对外完全兼容——同一个 `ctx.compaction` 接口、**完全相同的依赖注入列表**（`llm`、`tokenMeter`、`sessions`）、相同的事件和报错方式，官方配置里的每一个键也都接受。把别名依赖删掉就恢复官方的引擎。

这种安装方式**不会被识别成 bundle**（Harness 会从自己的安装目录解析 `@deepseek-ai/dsh-compaction-basic` 这个名字，那里是官方包，没有 `dsh.bundle` 声明），所以没有任何自动化——需要把 recall 工具和 `/recall` 命令自己加进 profile 的 `cordis.patch.yml`（新行必须放在 `insert` 列表里；这个文件热重载，不用重启）。行名必须用**别名包名**（这种安装方式下只有它能解析）；引擎行可选，只在需要给"没有压缩配置的预设"（如 `minimal`）提供宿主兜底时才加：

```yaml
- id: compaction-basic
  disabled: true                     # 宿主层替换（可选兜底）
- insert:
    - id: compaction-instant
      name: '@deepseek-ai/dsh-compaction-basic'   # 给没有压缩配置的预设兜底
    - id: tool-recall
      name: '@deepseek-ai/dsh-compaction-basic/tool'
    - id: command-recall
      name: '@deepseek-ai/dsh-compaction-basic/command'
```

### 方法 2 —— 直接安装 + 让 AI 复制一份预设（dsh 创作模式）

```bash
dsh plugin --profile web add dsh-compaction-vcc
```

然后用"预设创作"预设（内置的 `cordis` 预设，即「创造模式」）开一个会话，让 AI 执行：

> 复制 `standard` 预设，把它的压缩引擎行换成 `dsh-compaction-vcc`。

AI 会用 `agentPresets.copy('standard', '<id>')` 创建一份本地预设，在副本里改掉压缩行的 `name`，用 `standingKeyFor('<id>')` 校验能不能正常挂载，还可以通过改 `agent-presets` 行（`config.default: <id>`）把它设为默认。新预设会出现在 UI 选择器里；内置预设不受影响。

本包声明了 `dsh.bundle`，所以直接安装会自动注册成 profile 的配置层：自动禁掉内置的摘要引擎行、自动插入本引擎和 recall 工具（见包内 `cordis.patch.yml`）。宿主这边不用手动配置，只需复制预设。

### 方法 3 —— 直接安装 + 手动配置预设

```bash
dsh plugin --profile web add dsh-compaction-vcc
mkdir -p "$DSH_HOME/.agent-presets/<id>"
# 从你想作为基础的内置预设复制配置和元数据
# （预设列表里能看到每个预设的真实路径）：
cp <built-in-preset>/agent.cordis.yml "$DSH_HOME/.agent-presets/<id>/agent.cordis.yml"
# 在旁边写 preset.yml，包含 name + description
```

然后手工编辑副本里的压缩组——只改一行 name，仍在同一个隔离域（realm）里：

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true      # pruner 必须和引擎在同一隔离域
  config:
    - id: compaction-instant
      name: dsh-compaction-vcc   # 原来是 '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    # ... 保留 pruner 行
```

规则：绝不改内置预设的安装文件；保留 isolate 隔离域；真正的检验是 `standingKeyFor` 挂载成功（或直接在预设上开一个会话）——预设列表里的 `broken` 标记只能发现解析错误。

方法 2 和 3 **不需要任何宿主配置行**：上面提到的 `dsh.bundle` 会自动注册好一切。

| 方法 | 内置预设里的引擎 | 要改预设文件吗 | 选择器里多出预设 | 安装成本 |
|---|---|---|---|---|
| **1. 别名替换** | ✅ 自动（standard/code/cordis） | 否 | 否 | 一条命令 + 手动 patch |
| **2. AI 复制副本** | 只有新预设 | 副本 | 是 | 一句提示 |
| **3. 手动预设** | 只有新预设 | 副本 | 是 | 手动编辑 |

> 每个上下文只能挂载一个 `ctx.compaction` 实现（接口文档写明"每个上下文加载一个实现"）；预设挂载各自有独立的隔离域，所以宿主和预设的实例永远不会冲突。

## 开发

```bash
npm test        # node --test（编译器单元测试、配置校验、会话集成、引擎）
npm run check   # 对所有源码做 node --check
```

本包依赖很少：`@deepseek-ai/schemastery` 用于配置校验；其余依赖都是 Harness 自己提供的。`src/compiler.js` 刻意零依赖，没有运行中的 Harness 也能单独跑单元测试。

## 和官方引擎的区别

- 不调摘要模型 → 压缩从几秒变成几毫秒；不花摘要的 token。
- 不改写 → 事实、文件路径、命令、变量名都一字不差；模型继续用自己的话接着聊。
- 确定性 → 同样的内容永远压缩出同样的检查点。
- 之前的检查点原样保留，而不是重新摘要一遍（又快又无损）。
- 手动 `/compact` 和自动压力压缩都会保留最近的一段原文（优先整回合，`retainTokens` 为**硬上限**：补足整回合时总量永不超出；若最近回合本身就超过上限，只保留该回合内能装下的部分）而不是压缩全部历史，正在聊的内容永远不会被收走；只有更早的部分进检查点。
- `compaction/summary` 事件携带**压缩后的条目本身**——UI 里可展开的检查点行显示的就是模型实际看到的内容，外面包一层**能自动变长的代码框**（框线永远比内容里的 ``` 长，所以含 markdown 的消息也能整齐地显示成一个代码块），检查点开头还有一段简短的使用指南，告诉模型怎么用 `recall` / `search` 找回被省略的内容。
- 权衡：对以长对话、叙述为主的历史，检查点的信息密度可能不如 LLM 摘要（长句是截断而不是合并）。正在进行的对话有逐字保留的尾部（`retainTurns`/`retainTokens`）兜底，其余内容都能通过 `(seq N)` 指针 + recall 找回来。

MIT 许可证。

## 版本历史

| 版本 | 状态 | 说明 |
|---|---|---|
| **0.7.2** | ✅ 当前 | **纠 0.7.1 的错误结论 + 修自检误报。** ① 0.7.1 的 README 说「两份副本并存就删掉别名」，**这个结论是错的**：别名不是残留，宿主每个预设都声明 `{ id: compaction-basic, name: "@deepseek-ai/dsh-compaction-basic" }`，**预设只认这个名字**。删掉别名后，实测 `compaction/summary` 的 `provider` 从 `dsh-compaction-vcc` 变成一个聊天模型（`llmStreamCall` 字段出现），8.3 万 token 的对话被摘要成 5 千字符。正确做法是**两份都更新到同一版本，别删别名**。README 整节重写。 ② `preset-check` 的 `isEnginePath()` 按**路径字符串**找 `dsh-compaction-vcc`，而别名装法把包放在 `@deepseek-ai/dsh-compaction-basic/` 下，目录名里根本没这串 ⇒ **所有健康的别名装法都被误报成「没接管」**。改为读包清单的 `name` 字段判断。 ③ 原测试 `assert.equal(isVccRow(row, baseUrl), false, "basic does not resolve to vcc")` **把 bug 写成了预期结果**——测试环境没有别名目录，旧的路径判据压根没被执行。改为真造一个别名布局再断言，另补一条「官方真的会走到摘要引擎」的反向用例。测试 162→163。 |
| 0.7.1 | ⚠️ 已被 0.7.2 取代 | **修「两份副本并存导致升级静默不生效」。** 同一台机器上先用过别名装法、后来改用 bundle 装法时，`node_modules/` 下会留下两份同名包（`dsh-compaction-vcc` 与 `@deepseek-ai/dsh-compaction-basic`），**升级只覆盖其中一份**，宿主可能加载旧的，表现为「版本号是新的、行为是旧的」，无任何报错。实证：0.7.0 与 0.4.0 并存，加载的是 0.4.0。新增 `src/shadow-check.js` 启动自检，发现另一份同名包且版本不同就 `warn`（同版本重复不报）。README 增「第二种静默失效」一节。⚠️ **两处错**：清理步骤写「删掉别名」，而别名是预设唯一认得的名字，删了会让压缩整体退回 LLM 摘要；`preset-check` 自检按路径字符串判断，把健康的别名装法误报成「没接管」。**请用 0.7.2。** 测试 157→162。 |
| 0.7.0 | ✅ 可用 | **审计后清理。** 删掉 0.2.0 起就已失灵的 `src/client.js`（621 行 / 28.4 kB 死代码，`dsh.client` 声明既已删除，这个浏览器端就再无入口），包体 83.5 → 79.0 kB。README 里「浏览器设置卡片」那段与 0.2.0「前端已删」自相矛盾，已改为「设置命名空间（无界面）」。版本表补回 0.4.0–0.6.1 的缺档。另：`package.json` 的 `exports["./client"]` 与 `check` 脚本同步摘除。 |
| 0.6.1 | ✅ 可用 | **两处修复，都会让宿主静默失效或冻结。** ① `isCheckpointSource` 认错了宿主的 source 形状：宿主 0.2.x 发的是 `{kind:"compact-checkpoint"}`，代码判的是宿主旧版的 `{kind:"plugin", plugin:"compact"}`，条件**永远不成立** ⇒ 检查点处理分支从未进入，连带 `recall(type:"checkpoint")` 一直取不到检查点（修复前认得 0 个，修复后 5 个）。② `parseSeqSpec` 缺 `Number.isSafeInteger` 上界校验：`recall(type:"seq", id:"9007199254740992")` 会在 `expandSelections` 的 `seq += 1` 循环里**同步死循环**（2^53 上 `+1` 不改变数值），工具永不返回、定时器不触发、宿主必须重启。parser 与 expander 两层都已加防护，顺带拒绝 `seq 0`。另修三处「单个畸形节点炸掉整次编译」：`content` 为 null、数组含 null 块、`content` 非数组，原本都抛 `TypeError` 而整次压缩作废（宿主把错误吞成 warning，症状是「压缩就是不发生」）。测试 137→149。 |
| 0.6.0 | ✅ 可用 | 检查点内注入正文清理（`elideCheckpointInjectedBodies`，默认关）。旧检查点里带着它编译时那份记忆快照与规则块，而每次压缩都会重新注入一遍 —— 那份副本就是纯重复。开启后把它换成一行指针，原文仍在 append-only 日志里可 `recall`。实测 90,877 → 46,290 字符（−44,737）。另加 `elideSourceKinds`（按 source.kind 丢弃注入型行）。 |
| 0.5.0 | ✅ 可用 | 补齐 0.2.2 兼容面：tool-result 的 `toolCallId` 从 `content[0]` 移到 message 层后，`-> result N` 指针的映射预扫描一直没命中（**静默**丢失全部 result 指针，`recall(type:"result")` 因此失效）。同时整理 `session-compat`，两种 session 形状统一走一对访问器。 |
| 0.4.0 | ✅ 可用 | **默认值改为「尽量保留原文」**：`userTextTokens` 1024→**16384**、`textTokens` 512→**8192**、`checkpointCap` 65536→**393216**、`retainTokens` 5120→**20480**。实测（3524 节点 / 269 万 token 真实会话）：50 万 shadowed 区间下对话正文保留率 **22.0% → 98.4%**，80 万区间 98.6%。**关键**：默认值改动同时修好了 preset 隔离场景——preset 的 `compaction-basic` 行本身不写 `config`，因此直接吃到新默认值，不必再改 preset。单条预算按实测最长条目（用户 4745 / 助手 4043 token）留 3.4x / 2x 余量，不再触发单条截断。`checkpointCap` 建议不超过模型上下文窗口的 40%（393216 ≈ 1M 窗口的 39%）。 |
| 0.3.0 | ✅ 可用 | **修「预设场景静默失效」**：宿主挂了 agent preset 时，preset 在自己的 isolate realm 里另有引擎实例，本包插在宿主层的那行进不去，压缩**静默回落到官方 basic**（工具却照常可用）。本版启动后自检 preset 接管情况并打 `warn`，开关 `warnOnPresetTakeover`。补 19 条 preset 场景测试。**引擎行为未变，只是不再静默。** |
| 0.2.1 | ⚠️ 已弃用 | 首次尝试加自检，但**读错了字段名**：`compositionInventory()` 返回的是 `{entryId, moduleName, enabled}`，我按 `{id, name, disabled}` 读，结果**永远判定「健康」**——比不检查更糟，因为它假装检查过。另有四处上下文缺字段时抛 `TypeError` 的路径。请用 0.3.0。 |
| 0.2.0 | ✅ 可用 | **把 `dsh.client` 声明整个删掉。** 那张可选设置卡片会让宿主建一条永远激活不了的前端行，而激活失败会**中止整个 web boot**。这个引擎本来就不需要前端，所以前端没了。 |
| 0.1.9 | ⚠️ 已弃用 | 想靠修正 `dsh.client.inject` 解决激活失败。import 通了，行还是没激活。**bundle 装法起不来。** |
| 0.1.8 | ⚠️ 已弃用 | 去掉了对宿主里不存在的包的 `require`。仍然是坏的。 |
| 0.1.7 | ⚠️ 已弃用 | 第一个清单正确的版本，但 `client.js` 里 `require` 了宿主根本不带的 `@deepseek-ai/dsh-client-runtime`。**bundle 装法起不来。** |
| 0.1.6 | ⚠️ 已弃用 | 真实发布过，但清单是旧的：没有 `engines.dsh`、peer 写 `^0.1.0-rc.6`，宿主会**静默跳过**。 |
| 0.1.5 | ⚠️ 已弃用 | 清单问题同 0.1.6。 |
| 0.0.0-stage | 调试残留 | 排查发布流程时产生的占位，不含代码，没人会装它。 |

上面记录的是**两种完全不同的失效方式**，表现天差地别：

- **清单写错是静默的。** 宿主把插件丢进 `skippedBundles` 然后继续跑，所以它看起来和正常安装一模一样，除非你去确认压缩真的跑了。
- **`dsh.client` 坏掉是响的、但也是致命的。** 只要 `package.json` 声明了 `dsh.client` 且 `platform: "web"`，宿主就**必须**为它建一条前端行，并且这条行**必须**能激活。没有降级路径：激活失败 = 整个 web boot 中止，应用起不来：

  ```
  web boot: 1 entry did not activate
  dsh-compaction-vcc: import failed | loading | pending (waiting for services: ...)
  ```

  而且它**只在 bundle 装法（`dsh plugin add`）下触发**。别名装法从不加载 `dsh.client`，所以那台机器上完全看不到这个毛病——0.1.7 到 0.1.9 就是这么发出去的。

**如果你在 0.2.0 以下的任何版本，请升级。** 三个坏版本已在 npm 上标记弃用。