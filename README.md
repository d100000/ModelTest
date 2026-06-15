# 模型保真测试 · Model Fidelity Tester

> 一个纯浏览器、零依赖的工具，用来回答一个简单但很难回答的问题：
> **「这个号称是 Claude 的 API，到底是不是真的 Claude？又是从哪条供应链流出来的？」**

打开 `index.html` 就能用，无需构建、无需 npm、无需后端框架。全部逻辑是原生 HTML/CSS/JS（仅一个可选的 `server.py` 充当跨域代理）。

---

## 目录

- [一、为什么需要它（背景）](#一为什么需要它背景)
- [二、核心原理：为什么不能只信模型「自报家门」](#二核心原理为什么不能只信模型自报家门)
- [三、它能识别哪些「来源 / 渠道」](#三它能识别哪些来源--渠道)
- [四、它能识别哪些「模型 / 底座」](#四它能识别哪些模型--底座)
- [五、六层评分卡 · 40 项检查（覆盖面）](#五六层评分卡--40-项检查覆盖面)
- [六、几个「无法伪造」的关键验证（深入原理）](#六几个无法伪造的关键验证深入原理)
- [七、最终结论是如何得出的](#七最终结论是如何得出的)
- [八、如何运行](#八如何运行)
- [九、技术架构](#九技术架构)
- [十、隐私与免责声明](#十隐私与免责声明)

---

## 一、为什么需要它（背景）

如今市面上能买到的「Claude API」鱼龙混杂。同样是 `claude-opus-4` 这个模型名，背后可能是：

- **官方直连**：真的 `api.anthropic.com`；
- **云厂商托管**：AWS Bedrock、Google Vertex AI（仍是真 Claude，但计费/合规/可用特性不同）；
- **第三方聚合 / 中转**：one-api、new-api、OpenRouter、各类国产聚合平台——它们可能转发真 Claude，也可能**偷偷把请求降级到更便宜的模型**（如用 Sonnet 冒充 Opus，甚至用国产模型套壳）；
- **逆向 / 灰产通道**：抓取 Claude.ai 网页端 `sessionKey` 转发的「Max 镜像」、逆向 AWS Kiro / CodeWhisperer 的通道——**模型是真的，但来源未授权**，随时可能被封、存在数据泄露风险。

对使用者来说，这些差异直接关系到 **成本是否被克扣、数据是否安全、服务是否稳定、是否违反供应商条款**。但 API 提供方给你的只有一个 `model` 字段和一段模型自己说的话——这两样**都可以随便伪造**。

这个工具的目标，就是绕过「自报家门」，用**协议层、计量层、密码学层、行为层、时序层**的多重客观证据，给出一个带置信度的判断。

---

## 二、核心原理：为什么不能只信模型「自报家门」

直接问模型「你是谁」是最弱的证据：

- 中转商可以在 system prompt 里注入「你是 Claude」，让任何模型都自称 Claude；
- 也可以注入「不要透露你的真实身份」，让真 Claude 拒绝回答；
- 模型名 `model` 字段由服务端任意填写，毫无约束力。

因此本工具采用**「多维交叉验证 + 加权投票」**的思路。核心洞察是：

> **一个中转/套壳服务可以伪造「文本内容」，但很难同时伪造协议细节、计量字段、响应头、加密签名和时序特征——这些是它在转发链路上控制不到、或伪造成本极高的东西。**

具体分成 6 个维度（详见[第五节](#五六层评分卡--40-项检查覆盖面)）：

| 维度 | 它在验证什么 | 为什么难伪造 |
|---|---|---|
| **L1 协议规范性** | 响应体结构、`id` 前缀、SSE 事件序列、限流头 | 官方协议有大量隐性细节，套壳代理往往「形似神不似」 |
| **L2 计量合理性** | `usage` 四元组、`service_tier`、隐藏提示词偏移、缓存计费 | 计费字段是官方独有的，伪造会露馅 |
| **L3 能力支持度** | Prompt Caching、Extended Thinking、Vision、PDF、Tool Use 是否**真的能用** | 不是「字段在不在」，而是「功能跑不跑得通」 |
| **L4 行为指纹** | 身份一致性、拒答风格、是否多渠道分流、**延迟层级** | 不同模型的「人格」和「速度」骗不了人 |
| **L5 密码学验证** | Extended Thinking 的 **服务端签名** 能否被回传接受 | 签名由 Anthropic 私钥生成，**第三方无法伪造** |
| **L6 对抗性探针** | 身份强制、伪造 system、编码绕过、`temperature=0` 确定性 | 直接攻击「persona 注入」这一伪装手段 |

每一项检查输出 `pass / partial / fail / skip` 与权重，最终汇总成 0–100 分的总分和一个明确结论。

---

## 三、它能识别哪些「来源 / 渠道」

渠道识别（`js/channels.js`）通过 **响应体字段、`id` 前缀、URL host/path、请求/响应头** 的加权指纹，判断 Claude 是从哪条供应链来的。目前覆盖 **11 类来源**：

| 渠道 | 说明 | 决定性指纹（举例） |
|---|---|---|
| 🟢 **Anthropic 官方 API** | 直连 `api.anthropic.com` | `id` 为 `msg_01...` base58 格式；`usage` 含 `cache_creation_input_tokens` / `service_tier`；`anthropic-ratelimit-*` 响应头 |
| 🟡 **AWS Bedrock** | Claude on Bedrock | `id` 前缀 `msg_bdrk_`；`model` 形如 `anthropic.claude-...`；host 为 `bedrock-runtime.<region>.amazonaws.com` |
| 🔵 **Google Vertex AI** | Claude on Vertex | `id` 前缀 `msg_vrtx_`；URL 含 `/publishers/anthropic/models/`；请求体 `anthropic_version: vertex-2023-10-16` |
| 🟡 **Kiro 逆向** | 逆向 AWS Kiro IDE（后端是 CodeWhisperer / Q Developer，**不是 Bedrock**） | `model` 为内部大写命名 `CLAUDE_SONNET_4_5`；泄露 `profileArn`(CodeWhisperer ARN)、`conversationId` 等私有字段；host 为 `q.<region>.amazonaws.com` |
| 🔴 **Claude.ai 逆向（Max 镜像）** | 抓取 Claude.ai `sessionKey` / Max OAuth 转发的反代（如 clove、claude2api） | host 命中 `claude.ai` 或已知逆向/镜像项目域名；`id` 非任何公开 API 前缀 |
| 🟣 **OpenRouter** | OpenRouter 聚合平台 | `model` 含 `anthropic/` vendor 前缀；`id` 形如 `gen-...`；含 `provider` 字段 |
| 🟡 **OpenAI 格式封装的 Claude** | 代理把 Claude 包装成 OpenAI Chat Completions 协议 | `object` 为 `chat.completion`；`choices` 数组；`id` 为 `chatcmpl-` |
| 🟠 **AIHubMix** | 国产聚合平台 | host 含 `aihubmix.com` |
| 🟦 **DeepInfra** | 推理托管平台 | host 为 `*.deepinfra.com` |
| 🟪 **Azure / 自定义代理** | Azure OpenAI 风格或自建反代 | host 为 `*.openai.azure.com`；路径含 `/openai/deployments/` |
| ⚪ **聚合代理（one-api / new-api / 其他）** | 通用 OpenAI 兼容反代 | `id` 不属于任何已知格式；`usage` 缺官方计费字段；无 `anthropic-ratelimit-*` 头 |

> **关键技巧：** 浏览器直连大多数中转 API 会被 CORS 拦掉响应头，看不到 `anthropic-ratelimit-*`、`request-id`、`cf-ray` 这些渠道线索。本工具用 `server.py` 同源代理转发，**完整保留上游响应头**，这正是很多渠道指纹（尤其官方 vs 聚合代理的区分）能成立的前提。

每条渠道指纹是**加权信号**：命中加分、反向命中减分。最后对整批请求**投票汇总**，给出 top1 渠道 + 置信度（`confident / guess / unknown`）。带 `requiresClaude` 标记的渠道只有在响应「看起来像 Claude」时才参与竞争，避免把真正的 OpenAI 请求误判成「Claude 代理」。

---

## 四、它能识别哪些「模型 / 底座」

模型指纹（`js/fingerprints.js`）用于判断**实际底座**是否与声称一致，覆盖 **14 个模型家族**，中英文身份正则 + 关键字 + 训练截止时间锚点：

| 家族 | 厂商 | 家族 | 厂商 |
|---|---|---|---|
| **Claude** | Anthropic | **豆包 Doubao** | 字节跳动 |
| **GPT / ChatGPT** | OpenAI | **文心一言 ERNIE** | 百度 |
| **Gemini / Bard** | Google | **Yi 零一万物** | 零一万物 |
| **通义千问 Qwen** | 阿里巴巴 | **Llama** | Meta |
| **DeepSeek** | 深度求索 | **Mistral / Mixtral** | Mistral AI |
| **智谱清言 GLM** | 智谱 AI | **混元 Hunyuan** | 腾讯 |
| **Kimi** | 月之暗面 | **星火 Spark** | 科大讯飞 |

每个家族包含：
- **`identity`**：强身份证据正则（如 `我是 Claude`、`Claude by Anthropic`），命中权重高；
- **`markers`**：弱关键字证据（模型名、厂商名等）；
- **`cutoffRange`**：公开的训练知识截止时间范围——用于**反向证伪**：如果声称是 Claude 却谈论 Claude 不可能知道的时间，或截止时间对不上，就是疑点；
- **`STYLE_SIGNATURES`**：风格签名（如 GPT 标志性的「As an AI language model」开头、Gemini 的「a large language model, trained by Google」自述），作为次级旁证。

> 中文正则刻意不使用 `\b`（CJK 字符没有 ASCII 词边界），改用上下文锚定，避免中文身份误判/漏判。

工具会把**「声称的模型」**（来自 `model` 字段）与**「实际识别出的模型」**（来自多轮回答投票）做对比，二者矛盾即触发「伪造」判定。

---

## 五、六层评分卡 · 40 项检查（覆盖面）

评分卡（`js/scorecard.js`）是结论的量化骨架。每项检查返回 `pass/partial/fail/skip`，总分 = Σ(得分 × 权重) / Σ(权重，跳过项不计) × 100。

### L1 · 协议规范性（9 项）
| 检查 | 在看什么 |
|---|---|
| message id 渠道前缀 | `id` 前缀归类到 Anthropic/Vertex/Bedrock/OpenAI 兼容/OpenRouter |
| 响应 JSON Schema | 响应体结构是否符合协议 |
| message id 已知格式 | `id` 是否为已知合法格式 |
| model 字段稳定性 | 多次请求 `model` 是否一致 |
| content 是数组结构 | Anthropic 协议 `content` 为数组 |
| stop_reason 在合法枚举内 | 是否落在官方枚举 |
| **SSE 事件序列合规** | 流式事件顺序是否符合官方（`message_start`→`content_block_*`→`message_stop`） |
| Rate-limit 响应头 | 是否返回 `anthropic-ratelimit-*` |
| 错误响应格式 | 失败时错误体是否规范 |

### L2 · 计量合理性（7 项）
| 检查 | 在看什么 |
|---|---|
| usage 四元组齐全 | `input/output/cache_creation/cache_read` 是否齐全 |
| usage 含 service_tier | 官方独有计费字段 |
| token 数量合理性 | token 计数是否在合理范围 |
| Token 计数合理性（输出端） | 输出 token 与实际文本是否匹配 |
| **隐藏提示词偏移** | 对比可见输入估算 vs 服务端 `input_tokens`，**检测被注入的隐藏 system prompt** |
| 缓存写入生效 | `cache_creation_input_tokens` 是否真的增长 |
| 缓存读取生效 | `cache_read_input_tokens` 是否真的命中 |

### L3 · 能力支持度（10 项）
| 检查 | 在看什么 |
|---|---|
| **Prompt Caching 真实运作** | 不是字段在不在，而是缓存**真的命中省钱** |
| **Extended Thinking 启用** | 思考链是否真能开启 |
| Thinking token 占比 | 思考 token 占比是否合理 |
| **视觉能力 Vision** | 传图能否真正识别 |
| PDF 文档识别 | 传 PDF 能否真正识别 |
| **Tool Use 协议** | 工具调用协议是否完整 |
| stop_sequences 透传 | 参数是否被代理透传 |
| output_config.format 透传 | 结构化输出参数是否透传 |
| anthropic-beta header 透传 | beta 头是否透传 |
| Temperature 限制（Opus 独有） | Opus 对 temperature 的特有限制是否存在 |

### L4 · 行为指纹（7 项）
| 检查 | 在看什么 |
|---|---|
| 身份一致性 | 多轮自述身份是否前后一致 |
| 拒答风格签名 | 拒绝回答的措辞风格是否匹配该模型 |
| **无多渠道分流** | 多次请求是否被路由到不同后端（多源代理拼接的破绽） |
| 上下文记忆能力 | 多轮对话是否真的记住上文 |
| 知识截止时间锚点 | 截止时间是否与声称模型吻合 |
| **多模型对比（降级检测）** | 同时选 Opus+Sonnet，若两者延迟完全一致，疑似同底座伪装 |
| **延迟指纹（模型层级）** | 用 TTFT/TPS 推断真实层级（Opus 明显慢于 Sonnet/Haiku） |

### L5 · 密码学验证（3 项）— 最强证据
| 检查 | 在看什么 |
|---|---|
| **Thinking signature 字段存在** | 思考块是否带服务端签名 |
| thinking.display 控制 | 思考展示控制是否生效 |
| **Signature 多轮回传可被服务端接受** | 把带签名的思考块回传，**只有真 Anthropic 后端会接受** |

### L6 · 对抗性探针（4 项）
| 检查 | 在看什么 |
|---|---|
| 自我识别准确 | 在干扰下能否准确自我识别 |
| 推理题答案正确 | 推理能力是否达标 |
| **TRAP 对抗探针** | 身份强制、伪 system/developer、泄露、编码绕过、TRAP 后缀——测抗污染能力 |
| temperature=0 重复确定性 | `temperature=0` 时重复请求是否确定性输出 |

---

## 六、几个「无法伪造」的关键验证（深入原理）

这几项是本工具区别于「问问模型你是谁」的核心，也是覆盖面最有价值的部分：

### 1. 🔐 Thinking Signature 回传（L5，密码学级）
Claude 的 Extended Thinking 思考块带有一个 **由 Anthropic 服务端私钥生成的 `signature`**。本工具：
1. 第一轮开启思考，拿到带 `signature` 的思考块；
2. 第二轮把这个**原样签名的思考块回传**给服务端继续对话。

只有**真正的 Anthropic 后端**能验证并接受这个签名继续推理；任何伪造思考链、或把请求转发到别的模型的中转，要么生成不出合法签名，要么无法接受回传——**这是整套体系里伪造成本最高、最接近「密码学证明」的一环。**

### 2. ⏱️ 延迟指纹 / 模型降级检测（L4）
不同档位的 Claude 速度差异显著：Opus 明显慢于 Sonnet，Sonnet 慢于 Haiku。工具测量每次响应的 **TTFT（首 token 延迟）** 和 **TPS（吞吐）**：
- 如果声称 Opus 却跑出 Haiku 级的飞快速度（且多样本佐证），就会把「真实」降级为「可疑」——**这是抓「用便宜模型冒充贵模型」最直接的物理证据**；
- 若同时选了多个档位的模型而它们延迟**完全一致**，说明背后可能是同一个底座在套不同的名字。

### 3. 🧮 隐藏提示词偏移（L2）
工具估算「可见输入」应该消耗多少 token，再与服务端返回的 `input_tokens` 对比。如果服务端报告的输入明显偏大，说明请求里**被中转商悄悄塞了隐藏的 system prompt**（常用于注入「你是 Claude」「不要透露身份」之类的伪装指令）。

### 4. 🎭 多渠道分流检测（L4）
中转商常把请求负载均衡到多个上游。工具用**连续多轮对话强迫模型反复确认身份**（见 `FOLLOWUP_QUESTIONS`），如果同一个会话在不同轮被分流到不同后端，身份/渠道特征就会前后矛盾而暴露。

### 5. 🪤 TRAP 对抗探针（L6）
直接攻击「persona 注入」这一伪装手段：用身份强制指令、伪造的 system/developer 消息、系统提示泄露、编码绕过、以及一个 TRAP 后缀，检验模型在被污染时还能否稳定暴露真实底座。

### 6. 💾 Prompt Caching 真实性（L2/L3）
不只看 `usage` 里有没有缓存字段，而是**连续多轮发送带缓存标记的请求，观察 `cache_read_input_tokens` 是否真的随轮次命中增长**——套壳代理通常伪造不出真实的缓存计费曲线。

---

## 七、最终结论是如何得出的

`js/analyzer.js` 汇总所有维度（模型指纹投票、一致性、拒答分析、渠道识别、延迟、思考签名、多模型对比……），输出四种结论之一，并附带置信度（0–1）与逐条依据：

| 结论 | 含义 |
|---|---|
| ✅ **真实** | 声称的模型与全部响应特征一致 |
| ❌ **伪造** | 声称 A，实际底座指向 B（如声称 Opus 实为其他模型） |
| ⚠️ **可疑** | 证据不足或存在矛盾（如多渠道分流、被注入「不要透露身份」、延迟异常），无法确认 |
| ❓ **未知** | 没有足够身份信号可供判定 |

特别地，对于「**模型是真的，但来源有问题**」的情况（如 Claude.ai sessionKey 逆向、one-api 通用反代、负载均衡多源拼接），analyzer 会单独给出风险说明——因为这类通道虽然模型为真，但**存在被封禁、数据泄露、违反供应商条款的风险**。

报告可通过界面「下载报告」按钮导出为 JSON。

---

## 八、如何运行

### 推荐：带同源代理（能看到完整响应头，渠道识别最准）
```bash
python3 server.py --port 8000
# 浏览器打开 http://127.0.0.1:8000/index.html
```
`server.py` 提供 `/api/proxy?target=<url>` 同源代理：转发鉴权头、解压 gzip/br、对瞬时 429/502/503/504/529 自动重试、保留 SSE 流式，并把上游响应头完整带回前端供渠道识别使用。

可调环境变量：`MFT_PROXY_RETRIES`、`MFT_UPSTREAM_CONCURRENCY`、`MFT_UPSTREAM_MIN_INTERVAL_MS`、`MFT_UPSTREAM_TIMEOUT_SECONDS`。

### 备选：纯静态预览（仅看 UI，真实请求会撞 CORS）
```bash
python3 -m http.server 8765
```

### 使用步骤
1. **① API 连接**：填入 API 地址、密钥、模型名，选择协议格式（Anthropic / OpenAI 兼容）、并发数、对话轮数；按需开启 思考链 / 缓存 / 多模态 / PDF / 参数透传 / 对抗探针 等测试开关。
2. **② 探测提示词**：内置招呼语、身份询问（中/英）、底座探测、知识截止、创造者、风格签名、Claude-vs-GPT 判别等提示词，可自由增删（用户改动存 `localStorage`）。
3. 点击开始，工具按「每个提示词 = 一个多轮对话任务」调度（总请求数 = 启用提示词数 × 轮数），实时渲染各分析面板与评分卡。

> 🔑 **API Key 永不持久化**，仅存在于内存中；`localStorage` 只保存提示词改动和不含密钥的配置。

---

## 九、技术架构

纯全局脚本，无打包、无框架，加载顺序即依赖顺序：

```
prompts.js       → 探测提示词、followup 序列
fingerprints.js  → 14 个模型家族指纹 + 风格签名
channels.js     → 11 类渠道指纹 + ChannelDetector（打分/投票）
scorecard.js    → 6 层 / 40 项检查 + ScorecardEngine
analyzer.js     → Analyzer.analyze() 出最终结论
api.js          → 协议封装、SSE 消费、多轮对话任务调度
charts.js       → canvas 直方图 / 散点图（无第三方库）
app.js          → App.state 控制器 + 所有 _render* / _run* 面板
server.py       → 同源代理（保留上游响应头是渠道识别的关键）
```

> ⚠️ 改任何 `js/*.js` 或 `styles.css` 后，**必须** bump `index.html` 里 `?v=NN` 缓存版本号，否则浏览器会用旧代码。详见 `CLAUDE.md`。

---

## 十、隐私与免责声明

- **API Key 全程只在浏览器内存中使用，不写入磁盘、不上传**；同源代理仅在本机转发，请求直达你填写的目标地址。
- 本工具用于**帮助使用者核验自己有权访问的 API 服务质量与供应链来源**，请仅对你拥有合法访问权限的端点使用。
- 渠道/模型指纹基于公开可观察的协议特征，会随各家 API 演进而变化；结论以**带置信度的概率判断**形式给出，**不构成绝对鉴定**。请结合多次测试与实际业务表现综合判断。

---

*该工具的指纹库（模型、渠道、检查项）会持续更新。欢迎在 Issue 中反馈新的中转特征或误判样本。*
