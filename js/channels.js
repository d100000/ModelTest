/**
 * Claude API 渠道指纹数据库
 *
 * 通过 HTTP 请求/响应的多维特征，判断 Claude 来自哪条供应链：
 *   - anthropic_official:  Anthropic 官方 API (api.anthropic.com)
 *   - aws_bedrock:         AWS Bedrock
 *   - vertex_ai:           Google Cloud Vertex AI
 *   - claude_ai_reverse:   Claude.ai / Max 订阅 反向代理（如 clove/claude2api）
 *   - claude_code_cli:     官方 Claude Code CLI 直连
 *   - openrouter:          OpenRouter
 *   - aggregator_proxy:    one-api / new-api / 通用 OpenAI 兼容代理
 *
 * 每条规则是一个加权信号，命中 → 加分；未命中或反向命中 → 减分。
 * 最后返回得分排名，给前端展示置信度。
 */

const CHANNEL_FINGERPRINTS = [
  {
    id: 'anthropic_official',
    name: 'Anthropic 官方 API',
    short: '官方直连',
    color: '#4ade80',
    description: '直接调用 api.anthropic.com',
    docs: 'https://docs.anthropic.com',
    rules: [
      // === Body 指纹（高权重，不依赖 header）===
      { weight: 35, type: 'body_field',   path: 'id', regex: /^msg_01[A-Za-z0-9]{20,}$/, label: 'body.id 符合官方 base58 格式 (msg_01...)' },
      { weight: 12, type: 'body_field_exists', path: 'usage.cache_creation_input_tokens', label: 'body.usage 含 cache_creation_input_tokens（官方独有）' },
      { weight: 12, type: 'body_field_exists', path: 'usage.cache_read_input_tokens', label: 'body.usage 含 cache_read_input_tokens（官方独有）' },
      { weight: 10, type: 'body_field_exists', path: 'usage.service_tier', label: 'body.usage 含 service_tier（官方独有）' },
      { weight: 8,  type: 'body_field_type', path: 'content', expected: 'array', label: 'body.content 是数组（Anthropic 协议）' },
      { weight: 6,  type: 'body_field',   path: 'type', regex: /^message$/, label: 'body.type === "message"' },
      { weight: 6,  type: 'body_field',   path: 'role', regex: /^assistant$/, label: 'body.role === "assistant"' },
      { weight: 4,  type: 'body_field_in', path: 'stop_reason', values: ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal'], label: 'body.stop_reason 在官方枚举内' },
      { weight: 8,  type: 'body_field_exists', path: 'stop_details', label: 'body.stop_details 存在（2026.6 官方新增）' },
      { weight: 6,  type: 'body_field_exists', path: 'usage.cache_miss_reason', label: 'body.usage.cache_miss_reason 存在（2026.5 官方新增）' },
      { weight: 6,  type: 'body_field_exists', path: 'usage.output_tokens_details', label: 'body.usage.output_tokens_details 存在（2026.5 官方新增）' },
      // Header 指纹（通过 proxy 保留的响应头）
      { weight: 8,  type: 'response_header_exists', key: 'anthropic-ratelimit-requests-limit', label: '响应含 anthropic-ratelimit-requests-limit（官方独有）' },
      { weight: 6,  type: 'response_header_exists', key: 'request-id', label: '响应含 request-id（官方标准头）' },
      // URL
      { weight: 10, type: 'url_host',     regex: /^api\.anthropic\.com$/i, label: 'URL host = api.anthropic.com' }
    ]
  },
  {
    id: 'aws_bedrock',
    name: 'AWS Bedrock',
    short: 'Bedrock',
    color: '#fbbf24',
    description: 'Anthropic Claude on AWS Bedrock',
    docs: 'https://docs.aws.amazon.com/bedrock/',
    rules: [
      // === Body 指纹（高权重，强标志）===
      // model 形如 anthropic.claude-... 是 Bedrock 独有的命名空间，本身就是决定性证据
      { weight: 70, type: 'body_field',   path: 'model', regex: /^(?:us\.|eu\.|apac\.)?anthropic\.claude/i, label: 'body.model 形如 anthropic.claude-...（Bedrock 命名）' },
      { weight: 80, type: 'body_field',   path: 'id', regex: /^m(?:sg|sq)_bdrk_[A-Za-z0-9_.:-]{3,}$/i, label: 'body.id 使用 Bedrock 前缀 msg_bdrk_ / msq_bdrk_...' },
      { weight: 40, type: 'body_array_field', arrayPath: 'content', path: 'id', regex: /^toolu_bdrk_/i, label: 'tool_use id 使用 Bedrock 前缀 toolu_bdrk_...' },
      { weight: 15, type: 'body_field',   path: 'model', regex: /-v\d+:\d+$/i, label: 'body.model 含 Bedrock 版本后缀 -vN:N' },
      // === URL ===
      { weight: 18, type: 'url_host',     regex: /bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/i, label: 'URL host 是 bedrock-runtime.<region>.amazonaws.com' },
      { weight: 8,  type: 'url_path',     regex: /\/model\/.+\/invoke/i, label: 'URL 含 /model/.../invoke' }
    ]
  },
  {
    id: 'vertex_ai',
    name: 'Google Vertex AI',
    short: 'Vertex',
    color: '#67e8f9',
    description: 'Anthropic Claude on Vertex AI',
    docs: 'https://docs.anthropic.com/en/build-with-claude/claude-on-vertex-ai',
    rules: [
      { weight: 90, type: 'body_field',   path: 'id', regex: /^msg_vrtx_[A-Za-z0-9_.:-]{3,}$/i, label: 'body.id 使用 Vertex 前缀 msg_vrtx_...' },
      { weight: 30, type: 'url_host',     regex: /aiplatform\.googleapis\.com$/i, label: 'URL host 是 *-aiplatform.googleapis.com' },
      { weight: 20, type: 'url_path',     regex: /\/publishers\/anthropic\/models\//i, label: 'URL 含 /publishers/anthropic/models/' },
      { weight: 15, type: 'request_body_field', path: 'anthropic_version', regex: /^vertex-2023-10-16$/, label: '请求体含 anthropic_version: "vertex-2023-10-16"' }
    ]
  },
  {
    id: 'kiro_reverse',
    name: 'Kiro 逆向 (AWS CodeWhisperer 后端)',
    short: 'Kiro 逆向',
    color: '#fde047',
    description: 'AWS Kiro IDE 的 refresh_token 逆向（背后是 CodeWhisperer / Q Developer，非 Bedrock）',
    docs: 'https://github.com/caidaoli/kiro2api',
    rules: [
      // === Body 决定性指纹 ===
      // 1) model 字段保留 Kiro 内部大写命名（绝对独特，Anthropic/Bedrock/Vertex 都不用这种）
      { weight: 90, type: 'body_field', path: 'model', regex: /^CLAUDE_(?:SONNET|OPUS|HAIKU)(?:_\d)+$/i, label: 'body.model 是 Kiro 内部大写命名（CLAUDE_SONNET_4_5 风格）' },
      // 2) CodeWhisperer 私有字段泄露（如果 kiro2api 没规整化干净）
      { weight: 70, type: 'body_field', path: 'profileArn', regex: /^arn:aws:codewhisperer:/i, label: 'body.profileArn 是 CodeWhisperer ARN' },
      { weight: 55, type: 'body_field_exists', path: 'conversationId', label: 'body 含 conversationId（CodeWhisperer schema）' },
      { weight: 50, type: 'body_field_exists', path: 'agentContinuationID', label: 'body 含 agentContinuationID' },
      { weight: 50, type: 'body_field_exists', path: 'assistantResponseMessage', label: 'body 含 assistantResponseMessage（CodeWhisperer）' },
      { weight: 35, type: 'body_field_exists', path: 'chatTriggerType', label: 'body 含 chatTriggerType（CodeWhisperer）' },
      // 注：曾有一条"body.model 是 claude-xxx-4-6+ 即判 Kiro"的规则，前提是"4-6+ 版本号官方公共 API 不存在"。
      //     该前提已失效——claude-sonnet-4-6 / claude-opus-4-6/4-7/4-8 均为 Anthropic 官方公共模型，
      //     该规则会把每个当前 Claude 模型误判成 Kiro，故移除。Kiro 的真实指纹是大写下划线命名
      //     （CLAUDE_SONNET_4_5）、CodeWhisperer schema 字段、q.<region>.amazonaws.com 等，见上下文规则。
      // === URL 决定性指纹 ===
      { weight: 80, type: 'url_host', regex: /^q\.[a-z0-9-]+\.amazonaws\.com$/i, label: 'URL host 是 q.<region>.amazonaws.com（Kiro/CodeWhisperer 后端）' },
      { weight: 70, type: 'url_host', regex: /codewhisperer\.[a-z0-9-]+\.amazonaws\.com$/i, label: 'URL host 是 codewhisperer.<region>.amazonaws.com' },
      { weight: 50, type: 'url_host', regex: /kiro\.dev$/i, label: 'URL host 含 kiro.dev' },
      { weight: 40, type: 'url_host', regex: /(?:^|[.\-_])kiro(?:2?api)?(?:[.\-_]|$)/i, label: 'URL host 命中 kiro / kiro2api 反代命名' },
      { weight: 20, type: 'body_field', path: 'id', regex: /^m(?:sg|sq)_bdrk_/i, label: 'body.id 使用 AWS 风格前缀' },
      // === AWS 后端头泄露（即便 kiro2api 把响应体规整成 Anthropic 格式，AWS 网关头常仍透传）===
      // 这些头 Bedrock 也会带，但 Bedrock 有 msg_bdrk_ id 强指纹会胜出；规整化的 Kiro 没有该 id，
      // 于是「claude 模型 + AWS 网关头 + 无 msg_bdrk_/msg_vrtx_ id」就成了 Kiro/CodeWhisperer 的弱-中信号。
      { weight: 28, type: 'response_header_exists', key: 'x-amzn-requestid', label: '响应含 x-amzn-RequestId（AWS 网关后端）' },
      { weight: 22, type: 'response_header_exists', key: 'x-amzn-trace-id', label: '响应含 x-amzn-trace-id（AWS 网关后端）' },
      { weight: 18, type: 'response_header_exists', key: 'x-amzn-sessionid', label: '响应含 x-amzn-SessionId（CodeWhisperer 会话）' }
    ],
    requiresClaude: true
  },
  {
    id: 'claude_ai_reverse',
    name: 'Claude.ai 逆向（Max 镜像）',
    short: 'Max 逆向',
    color: '#f87171',
    description: '抓 Claude.ai sessionKey / Max OAuth 转发的反向代理',
    docs: 'https://github.com/mirrorange/clove',
    rules: [
      // === URL host 命中 Claude.ai 或已知 Max 镜像/逆向项目 ===
      // 关键：用域名标签边界锚定，避免旧版 `.*clove.*` 这类裸子串误命中（如 clover-ai.com）。
      // 权重也从 100 下调，使单一 host 模糊命中不会无脑压过官方 body 指纹（官方满命中约 115）。
      { weight: 70, type: 'url_host', regex: /(?:^|\.)claude\.ai$/i, label: 'URL host 是 claude.ai 或其子域（Claude.ai 网页端）' },
      { weight: 55, type: 'url_host', regex: /(?:^|[.\-_])(?:claude2api|clove|claude-relay|claude-mirror)(?:[.\-_]|$)/i, label: 'URL host 命中已知 Claude 逆向/镜像项目（按域名标签边界匹配）' },
      { weight: 15, type: 'body_field', path: 'id', regex: /^(?!msg_01|msg_vrtx_|msg_bdrk_|msq_bdrk_).+/, label: 'body.id 不是公开 API/Vertex/Bedrock 前缀' }
    ],
    requiresClaude: true
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    short: 'OpenRouter',
    color: '#f472b6',
    description: 'OpenRouter 聚合平台',
    docs: 'https://openrouter.ai/docs',
    rules: [
      // === body 指纹（一旦 model 含斜杠 vendor 前缀 = 决定性信号）===
      // model `anthropic/claude-...` 仅 OpenRouter 使用，给最高权重压过通用 OpenAI 封装
      { weight: 80, type: 'body_field',   path: 'model', regex: /^(?:anthropic|claude)\//i, label: 'body.model 含 vendor/ 前缀（OpenRouter 命名）' },
      { weight: 35, type: 'body_field',   path: 'id', regex: /^gen-[A-Za-z0-9]/i, label: 'body.id 形如 gen-...（OpenRouter 生成）' },
      { weight: 18, type: 'body_field_exists', path: 'provider', label: 'body.provider 存在（OpenRouter 特有）' },
      // === body / url ===
      { weight: 25, type: 'url_host',     regex: /openrouter\.ai$/i, label: 'URL host = openrouter.ai' },
      { weight: 10, type: 'body_field_exists', path: 'usage.cost', label: 'usage.cost 存在（OpenRouter 常见扩展）' }
    ]
  },
  {
    id: 'openai_wrapped',
    name: 'OpenAI 格式封装的 Claude',
    short: 'OpenAI 封装',
    color: '#fbbf24',
    description: '代理把 Claude 包装成 OpenAI Chat Completions 协议返回',
    docs: '',
    rules: [
      // body 必有 choices/object 字段（OpenAI 协议特征）
      { weight: 35, type: 'body_field',   path: 'object', regex: /^chat\.completion/, label: 'body.object 是 chat.completion（OpenAI 协议）' },
      { weight: 30, type: 'body_field_type', path: 'choices', expected: 'array', label: 'body.choices 是数组（OpenAI 协议）' },
      { weight: 20, type: 'body_field',   path: 'id', regex: /^(?:chatcmpl-|cmpl-|resp_)/i, label: 'body.id 形如 chatcmpl- / cmpl- / resp_（OpenAI 风格）' },
      { weight: 15, type: 'body_field_exists', path: 'usage.prompt_tokens', label: 'usage.prompt_tokens 存在（OpenAI 命名）' },
      { weight: 15, type: 'body_field_exists', path: 'usage.completion_tokens', label: 'usage.completion_tokens 存在（OpenAI 命名）' },
      // 反向：不应有 anthropic 原生字段
      { weight: 10, type: 'body_field_missing', path: 'content', label: '缺失 body.content（Anthropic 原生字段）' },
      // 反向：若 model 含 vendor 前缀（vendor/...）应让 OpenRouter 胜出
      { weight: -55, type: 'body_field', path: 'model', regex: /^[a-z]+\//i, label: '减分: model 含 vendor/ 前缀（让 OpenRouter 优先）' },
      { weight: -25, type: 'body_field_exists', path: 'provider', label: '减分: 存在 provider 字段（OpenRouter 特征）' }
    ],
    requiresClaude: true
  },
  {
    id: 'aihubmix',
    name: 'AIHubMix',
    short: 'AIHubMix',
    color: '#fb923c',
    description: '国产聚合平台（AIHubMix）',
    docs: 'https://aihubmix.com',
    rules: [
      { weight: 80, type: 'url_host', regex: /aihubmix\.com$/i, label: 'URL host 含 aihubmix.com（决定性）' }
    ],
    requiresClaude: true
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    short: 'DeepInfra',
    color: '#22d3ee',
    description: 'DeepInfra 推理托管平台',
    docs: 'https://deepinfra.com',
    rules: [
      { weight: 80, type: 'url_host', regex: /deepinfra\.com$/i, label: 'URL host 是 *.deepinfra.com（决定性）' }
    ]
  },
  {
    id: 'azure_proxy',
    name: 'Azure / 自定义代理',
    short: 'Azure/反代',
    color: '#818cf8',
    description: 'Azure OpenAI 风格或自建反代',
    docs: '',
    rules: [
      { weight: 70, type: 'url_host', regex: /openai\.azure\.com$/i, label: 'URL host 为 *.openai.azure.com（决定性）' },
      { weight: 30, type: 'url_path', regex: /\/openai\/deployments\//i, label: 'URL 含 /openai/deployments/' }
    ]
  },
  {
    id: 'aggregator_proxy',
    name: '聚合代理 (one-api / new-api / 其他)',
    short: '聚合代理',
    color: '#94a3b8',
    description: '国产/通用 OpenAI 兼容反代',
    docs: 'https://github.com/songquanpeng/one-api',
    rules: [
      // === Body 指纹：id / schema 非已知格式 ===
      { weight: 15, type: 'body_field',   path: 'id', regex: /^(?!msg_01|msg_vrtx_|msg_bdrk_|msq_bdrk_|chatcmpl-|cmpl-|resp_|gen-).+/, label: 'body.id 不是已知官方/云厂商/兼容格式' },
      // cache 字段缺失（弱信号 - Bedrock/Vertex 也缺，所以权重不能高）
      { weight: 8,  type: 'body_field_missing', path: 'usage.cache_creation_input_tokens', label: 'usage 缺 cache_creation_input_tokens' },
      { weight: 6,  type: 'body_field_missing', path: 'usage.cache_read_input_tokens', label: 'usage 缺 cache_read_input_tokens' },
      { weight: 6,  type: 'body_field_missing', path: 'usage.service_tier', label: 'usage 缺 service_tier' },
      { weight: 10, type: 'body_field_missing', path: 'model', label: 'body.model 缺失或被代理隐藏' },
      { weight: 6,  type: 'response_header_missing', key: 'anthropic-ratelimit-requests-limit', label: '响应缺 anthropic-ratelimit-* 头（官方会返回）' }
    ],
    requiresClaude: true
  }
];

const ChannelDetector = {

  /**
   * 主入口：对一条 result 计算各渠道得分
   * @param {Object} result  api.js 产出的 result（含 request/response/attempts）
   * @returns {Array<{ id, name, short, color, score, hits: Array<{label,weight}> }>}
   */
  detect(result) {
    if (!result || !result.response) return [];
    const url = result.request?.url || '';
    // 流式响应的 response.body 是原始 SSE 文本，JSON 解析失败时回退到
    // _consumeSSEStream 重建的 rawResponse（含 id/model/usage 等完整结构）
    const respBody = this._safeParseJSON(result.response?.body) || result.rawResponse || null;
    const reqBody = this._safeParseJSON(result.request?.body);
    const respHeaders = result.response?.headers || {};

    // 是否像 Claude 响应（用于 requiresClaude 规则的前置条件）
    const looksLikeClaude = this._looksLikeClaude(respBody, result.content || '');

    const out = [];
    for (const fp of CHANNEL_FINGERPRINTS) {
      if (fp.requiresClaude && !looksLikeClaude) continue;
      let score = 0;
      const hits = [];
      for (const rule of fp.rules) {
        const matched = this._evalRule(rule, { url, respBody, reqBody, respHeaders });
        if (matched) {
          score += rule.weight;
          // matched 是描述命中位置/取值的对象，用于前端「判断依据 → 跳转到具体请求字段」
          hits.push({
            label: rule.label,
            weight: rule.weight,
            type: rule.type,
            where: matched.where || null,          // url | reqBody | respBody | respHeader
            path: matched.path || rule.path || rule.arrayPath || null,
            key: matched.key || rule.key || null,
            value: matched.value != null ? String(matched.value).slice(0, 200) : null
          });
        }
      }
      out.push({
        id: fp.id,
        name: fp.name,
        short: fp.short,
        color: fp.color,
        description: fp.description,
        docs: fp.docs,
        score: Math.max(0, score),
        hits
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  },

  /**
   * 一条 result 的总判定（取 top1 + 置信度）
   */
  summarize(result) {
    const scores = this.detect(result);
    if (!scores.length) {
      return { level: 'unknown', top: null, confidence: 0, scores: [] };
    }
    const top = scores[0];
    const second = scores[1];
    // 置信度: 跟第二名的差距 + top 自身分数
    const gap = top.score - (second?.score || 0);
    const confidence = Math.min(1, (top.score / 100) * 0.7 + (gap / 60) * 0.3);
    return {
      level: top.score >= 30 ? 'confident' : top.score >= 12 ? 'guess' : 'unknown',
      top,
      confidence: +confidence.toFixed(2),
      scores
    };
  },

  /**
   * 对一批 result 做汇总
   */
  aggregate(results) {
    const counter = new Map();
    const totals = new Map();
    for (const r of results) {
      if (r.error || !r.response) continue;
      const s = this.summarize(r);
      if (!s.top) continue;
      counter.set(s.top.id, (counter.get(s.top.id) || 0) + 1);
      totals.set(s.top.id, (totals.get(s.top.id) || 0) + s.top.score);
    }
    const list = [...counter.entries()].map(([id, count]) => {
      const fp = CHANNEL_FINGERPRINTS.find(f => f.id === id);
      return {
        id,
        name: fp?.name || id,
        short: fp?.short || id,
        color: fp?.color || '#94a3b8',
        count,
        avgScore: Math.round((totals.get(id) || 0) / count)
      };
    });
    list.sort((a, b) => b.count - a.count);
    return list;
  },

  // ===== 规则求值 =====

  /**
   * 求值单条规则。
   * 命中返回一个描述对象 { where, path?, key?, value }（恒为真值），未命中返回 false。
   * where 用于前端定位：url=请求行 / reqBody=请求体 / respBody=响应体 / respHeader=响应头。
   */
  _evalRule(rule, ctx) {
    const { url, respBody, reqBody, respHeaders } = ctx;
    const headerValue = (key) => {
      if (!respHeaders) return null;
      const target = key.toLowerCase();
      for (const k of Object.keys(respHeaders)) {
        if (k.toLowerCase() === target) return respHeaders[k];
      }
      return null;
    };
    switch (rule.type) {
      case 'url_host': {
        try {
          const u = new URL(url);
          return rule.regex.test(u.host) ? { where: 'url', path: 'host', value: u.host } : false;
        } catch (e) { return false; }
      }
      case 'url_path': {
        try {
          const u = new URL(url);
          return rule.regex.test(u.pathname) ? { where: 'url', path: 'path', value: u.pathname } : false;
        } catch (e) { return false; }
      }
      case 'body_field': {
        const v = this._getPath(respBody, rule.path);
        if (v == null) return false;
        return rule.regex.test(String(v)) ? { where: 'respBody', path: rule.path, value: v } : false;
      }
      case 'body_field_missing': {
        const v = this._getPath(respBody, rule.path);
        return v == null ? { where: 'respBody', path: rule.path, value: '(字段缺失)' } : false;
      }
      case 'request_body_field': {
        const v = this._getPath(reqBody, rule.path);
        if (v == null) return false;
        return rule.regex.test(String(v)) ? { where: 'reqBody', path: rule.path, value: v } : false;
      }
      case 'body_array_field': {
        const arr = this._getPath(respBody, rule.arrayPath);
        if (!Array.isArray(arr)) return false;
        let hitVal = null;
        const ok = arr.some(item => {
          const v = this._getPath(item, rule.path);
          if (v != null && rule.regex.test(String(v))) { hitVal = v; return true; }
          return false;
        });
        return ok ? { where: 'respBody', path: `${rule.arrayPath}[].${rule.path}`, value: hitVal } : false;
      }
      case 'body_field_exists': {
        const v = this._getPath(respBody, rule.path);
        return (v !== null && v !== undefined)
          ? { where: 'respBody', path: rule.path, value: typeof v === 'object' ? JSON.stringify(v) : v }
          : false;
      }
      case 'body_field_type': {
        const v = this._getPath(respBody, rule.path);
        if (v === null || v === undefined) return false;
        const t = Array.isArray(v) ? 'array' : typeof v;
        return t === rule.expected ? { where: 'respBody', path: rule.path, value: `${t}` } : false;
      }
      case 'body_field_in': {
        const v = this._getPath(respBody, rule.path);
        if (v === null || v === undefined) return false;
        return rule.values.includes(String(v)) ? { where: 'respBody', path: rule.path, value: v } : false;
      }
      case 'response_header_exists': {
        const v = headerValue(rule.key);
        return v != null ? { where: 'respHeader', key: rule.key, value: v } : false;
      }
      case 'response_header_missing': {
        if (!respHeaders || !Object.keys(respHeaders).length) return false;
        const v = headerValue(rule.key);
        return v == null ? { where: 'respHeader', key: rule.key, value: '(响应头缺失)' } : false;
      }
      default:
        return false;
    }
  },

  _lowerHeaders(h) {
    const out = {};
    if (!h) return out;
    for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
    return out;
  },

  _safeParseJSON(text) {
    if (!text) return null;
    if (typeof text === 'object') return text;
    try { return JSON.parse(text); } catch (e) { return null; }
  },

  _getPath(obj, path) {
    if (!obj || !path) return null;
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return null;
      cur = cur[p];
    }
    return cur;
  },

  _looksLikeClaude(respBody, content) {
    if (respBody) {
      if (typeof respBody.model === 'string' && /claude/i.test(respBody.model)) return true;
      if (respBody.type === 'message' && Array.isArray(respBody.content)) return true;
    }
    if (content && /claude/i.test(content)) return true;
    return false;
  }
};
