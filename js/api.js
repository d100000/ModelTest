/**
 * API 客户端
 *
 * 支持两种协议:
 *   - openai:    POST {base}/v1/chat/completions   兼容 OpenAI / Azure / 国产 OpenAI-like
 *   - anthropic: POST {base}/v1/messages           Anthropic Messages API
 *
 * 单条响应结构 (Response):
 *   {
 *     id, promptId, promptTag, promptTitle, promptBody,
 *     round, concurrencyIndex,
 *     model,              // 用户声称的模型
 *     content,            // 模型返回的文本
 *     rawResponse,        // 原始 JSON 响应（成功时）
 *     latency,            // 总耗时 ms
 *     inputTokens, outputTokens, totalTokens,
 *     finishReason,       // OpenAI: finish_reason / Anthropic: stop_reason
 *     returnedModel,      // 服务端返回的 model 字段（关键信号！）
 *     startedAt, completedAt,
 *     error               // { message, code }
 *   }
 */

const DEFAULT_URLS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages'
};

const ApiClient = {

  defaultUrl(format) {
    return DEFAULT_URLS[format] || DEFAULT_URLS.openai;
  },

  /**
   * 智能补全 API 路径
   * 接受多种输入形式，统一返回完整的请求 URL：
   *   anthropic:
   *     "https://api.anthropic.com"            -> + /v1/messages
   *     "https://api.anthropic.com/"           -> + v1/messages
   *     "https://api.anthropic.com/v1"         -> + /messages
   *     "https://api.anthropic.com/v1/"        -> + messages
   *     "https://api.anthropic.com/v1/messages"-> 原样
   *     "https://proxy/anthropic/v1/messages"  -> 原样
   *   openai:
   *     "https://api.openai.com"               -> + /v1/chat/completions
   *     "https://api.openai.com/v1"            -> + /chat/completions
   *     "https://api.openai.com/v1/chat/completions" -> 原样
   *     Azure 形式 (含 /deployments/.../chat/completions) -> 原样
   *
   * 不会自动修正协议不匹配的路径（避免破坏 transparent proxy），
   * 这种情况由 detectUrlFormatMismatch() 返回警告，让 UI 提示。
   */
  normalizeUrl(rawUrl, format) {
    if (!rawUrl) return rawUrl;
    let url = String(rawUrl).trim();
    if (!url) return url;

    // 去掉尾部 ? 与 # 后再处理（保留 query 留待最后）
    const hashIdx = url.indexOf('#');
    if (hashIdx >= 0) url = url.slice(0, hashIdx);
    let query = '';
    const qIdx = url.indexOf('?');
    if (qIdx >= 0) {
      query = url.slice(qIdx);
      url = url.slice(0, qIdx);
    }

    // 去掉尾部多余的 /
    url = url.replace(/\/+$/, '');

    // 如果路径里已经存在常见 API 端点段，就完全信任用户输入
    if (/\/(?:messages|chat\/completions|completions)(?:\/|$)/.test(url)) {
      return url + query;
    }

    // 以 /v1 结尾：补 endpoint 即可
    if (/\/v1$/.test(url)) {
      url += (format === 'anthropic' ? '/messages' : '/chat/completions');
      return url + query;
    }

    // 否则当作 base URL，补完整路径
    url += (format === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
    return url + query;
  },

  /**
   * 检测协议与 URL 路径是否不匹配
   * 返回:
   *   null:                 OK
   *   { type, message }:    有警告（不阻止请求）
   */
  detectUrlFormatMismatch(rawUrl, format) {
    if (!rawUrl) return null;
    const url = String(rawUrl).trim().toLowerCase();
    if (!url) return null;

    const hasMessages = /\/messages(?:\/|\?|$)/.test(url);
    const hasChatCompletions = /\/chat\/completions(?:\/|\?|$)/.test(url);

    if (format === 'anthropic' && hasChatCompletions && !hasMessages) {
      return {
        type: 'warn',
        message: '已选 Anthropic 协议，但 URL 路径是 OpenAI 的 /chat/completions。请确认或重置 URL。'
      };
    }
    if (format === 'openai' && hasMessages && !hasChatCompletions) {
      return {
        type: 'warn',
        message: '已选 OpenAI 协议，但 URL 路径是 Anthropic 的 /messages。请确认或重置 URL。'
      };
    }
    return null;
  },

  /**
   * 从当前聊天端点推导模型列表 URL。
   * OpenAI / Anthropic 官方和大多数中转站都使用 GET /v1/models。
   */
  normalizeModelsUrl(rawUrl, format) {
    const endpoint = this.normalizeUrl(rawUrl, format);
    if (!endpoint) return endpoint;
    try {
      const u = new URL(endpoint);
      u.search = '';
      u.hash = '';
      if (format === 'anthropic') {
        u.pathname = u.pathname
          .replace(/\/v1\/messages\/?$/i, '/v1/models')
          .replace(/\/messages\/?$/i, '/models');
      } else {
        u.pathname = u.pathname
          .replace(/\/v1\/chat\/completions\/?$/i, '/v1/models')
          .replace(/\/chat\/completions\/?$/i, '/models')
          .replace(/\/v1\/completions\/?$/i, '/v1/models')
          .replace(/\/completions\/?$/i, '/models');
      }
      if (!/\/models\/?$/i.test(u.pathname)) {
        u.pathname = u.pathname.replace(/\/+$/, '') + '/models';
      }
      return u.toString();
    } catch (e) {
      return endpoint.replace(/\/(?:chat\/completions|messages|completions)(?:\?.*)?$/i, '/models');
    }
  },

  _shouldUseLocalProxy(opts) {
    return true;
  },

  _proxyUrl(targetUrl) {
    const path = `/api/proxy?target=${encodeURIComponent(targetUrl)}`;
    if (typeof window !== 'undefined' && window.location?.origin) {
      return new URL(path, window.location.origin).toString();
    }
    return path;
  },

  _requestUrl(rawUrl, format, opts) {
    const targetUrl = this.normalizeUrl(rawUrl, format);
    return this._proxyUrl(targetUrl);
  },

  _modelsRequestUrl(rawUrl, format, opts) {
    const targetUrl = this.normalizeModelsUrl(rawUrl, format);
    return this._proxyUrl(targetUrl);
  },

  async fetchModels(opts, signal) {
    const targetUrl = this.normalizeModelsUrl(opts.url, opts.format);
    const url = this._modelsRequestUrl(opts.url, opts.format, opts);
    const headers = this._buildHeaders(opts);
    let res;
    try {
      res = await fetch(url, { method: 'GET', headers, signal });
    } catch (err) {
      const msg = err?.message || String(err);
      if (/failed to fetch|networkerror|load failed/i.test(msg)) {
        throw new Error('本地 Python 后端不可达，请确认 http://127.0.0.1:8000/api/health 可访问后重试');
      }
      throw err;
    }
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) {}
    if (!res.ok) {
      const msg = parsed?.error?.message || parsed?.message || text.slice(0, 200);
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    const models = this._parseModelsList(parsed);
    return { url: targetUrl, requestUrl: url, raw: parsed, models };
  },

  _parseModelsList(parsed) {
    const arr = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed?.data) ? parsed.data
      : Array.isArray(parsed?.models) ? parsed.models
      : Array.isArray(parsed?.items) ? parsed.items
      : [];
    return arr.map(x => {
      if (typeof x === 'string') return { id: x, name: x };
      const id = x.id || x.name || x.model || x.model_name;
      if (!id) return null;
      return {
        id,
        name: x.display_name || x.name || id,
        created: x.created || x.created_at || null,
        ownedBy: x.owned_by || x.owner || null
      };
    }).filter(Boolean);
  },

  /**
   * 构造请求体 - OpenAI 协议
   * skipParams: 一组要省略的参数名（例如 ['temperature']），用于被模型拒绝后重试
   */
  _buildOpenAIBody(model, prompt, opts, skipParams = []) {
    const messages = [{ role: 'user', content: prompt }];
    const body = {
      model,
      messages,
      stream: !!opts.stream
    };
    if (opts.stream) {
      body.stream_options = { include_usage: true };  // 让 OpenAI 在流末尾返回 usage
    }
    if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
    if (opts.temperature != null && !skipParams.includes('temperature')) {
      body.temperature = opts.temperature;
    }
    return JSON.stringify(body);
  },

  /**
   * 构造请求体 - Anthropic Messages API
   * 注意：max_tokens 是 Anthropic 必填字段；temperature 在部分新模型（reasoning/thinking）已被弃用
   *
   * 缓存模式: 在 system 字段中带 cache_control marker
   *   system: [{ type: "text", text: "<long prompt>", cache_control: { type: "ephemeral" } }]
   *   ↑ 这是 Anthropic Prompt Caching 的标准用法
   */
  _buildAnthropicBody(model, prompt, opts, skipParams = []) {
    const body = {
      model,
      max_tokens: opts.maxTokens || 1024,
      messages: [{ role: 'user', content: prompt }]
    };
    if (opts.stream) body.stream = true;
    if (opts.temperature != null && !skipParams.includes('temperature')) {
      body.temperature = opts.temperature;
    }
    return JSON.stringify(body);
  },

  /**
   * 构造多轮对话请求体 - Anthropic
   * messages: [{role, content: string | [{type:"text", text, cache_control?}]}, ...]
   * 在最后一条 assistant 消息上打 cache_control (滚动断点)
   */
  _buildConversationBody(model, messages, opts) {
    const body = { model, max_tokens: opts.maxTokens || 1024 };
    if (opts.stream) body.stream = true;
    if (opts.temperature != null) body.temperature = opts.temperature;
    const msgs = messages.map(m => ({ role: m.role, content: m.content }));
    // 部分中转站会把 Anthropic 的 system block 数组转成上游 502。
    // 缓存探测只需要稳定的长前缀，因此把缓存断点放在第一条 user content block 上。
    if (opts.cacheSystem) {
      const firstUserIdx = msgs.findIndex(m => m.role === 'user');
      if (firstUserIdx >= 0) {
        const current = msgs[firstUserIdx].content;
        const blocks = [{
          type: 'text',
          text: opts.cacheSystem,
          cache_control: { type: 'ephemeral' }
        }];
        if (Array.isArray(current)) {
          blocks.push(...current);
        } else {
          blocks.push({ type: 'text', text: String(current || '') });
        }
        msgs[firstUserIdx] = { role: 'user', content: blocks };
      }
    }
    // 把 messages 复制并在最后一条 assistant 消息上加 cache_control
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== 'assistant') continue;
      const c = msgs[i].content;
      const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.map(x => x.text || '').join('') : '');
      msgs[i] = {
        role: 'assistant',
        content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
      };
      break;
    }
    body.messages = msgs;
    return JSON.stringify(body);
  },

  /**
   * 构造思考配置块（合并进请求体）
   *
   * 两种协议规制：
   *   - adaptive（现代 Claude：Opus 4.6+/4.7/4.8、Fable 5、Sonnet 4.6）：
   *       thinking: { type:'adaptive', display }  +  output_config: { effort }
   *       旧的 { type:'enabled', budget_tokens } 在这些模型上返回 400
   *   - enabled（Sonnet 4.5 及更早）：thinking: { type:'enabled', budget_tokens }
   *
   * display 默认 'summarized'，否则现代模型默认 'omitted'，思考文本为空，
   * 会导致 signature replay 拿不到 thinking 内容、思维占比检查失真。
   *
   * 模型真伪未知时先发 adaptive，被 400 拒绝后由调用方回退 enabled
   * （见 _detectThinkingModeSwitch / app.js 的重试逻辑）。
   */
  _buildThinkingConfig(opts, mode = 'adaptive', display = 'summarized') {
    if (mode === 'enabled') {
      // 旧模型（Sonnet 4.5 及更早）默认返回完整思考文本，
      // 且没有 thinking.display 字段 —— 带上反而可能 400。
      return { thinking: { type: 'enabled', budget_tokens: opts.thinkingBudget || 2048 } };
    }
    const thinking = { type: 'adaptive' };
    if (display) thinking.display = display;
    return { thinking, output_config: { effort: opts.effort || 'high' } };
  },

  /**
   * 构造思考链请求体 - Anthropic Extended Thinking
   * mode: 'adaptive'（默认）| 'enabled'
   * 注: 启用 thinking 后不要发送 temperature（adaptive 模型禁 temperature）
   */
  _buildThinkingBody(model, prompt, opts, mode = 'adaptive') {
    const floor = mode === 'enabled'
      ? Math.max(opts.maxTokens || 4096, (opts.thinkingBudget || 2048) + 1024)
      : Math.max(opts.maxTokens || 4096, 8192);
    const body = {
      model,
      max_tokens: floor,
      messages: [{ role: 'user', content: prompt }],
      ...this._buildThinkingConfig(opts, mode, 'summarized')
    };
    if (opts.stream) body.stream = true;
    return JSON.stringify(body);
  },

  /**
   * 检测思考模式 400 错误，返回应切换到的模式（'adaptive' | 'enabled' | null）
   * 现代模型拒绝 enabled → 让用 adaptive + output_config.effort；
   * 旧模型拒绝 adaptive → 让用 enabled + budget_tokens。
   * 注意 "thinking" 字段名在部分中转的报错里会被脱敏，故不依赖该词。
   */
  _detectThinkingModeSwitch(status, errMsg, currentMode) {
    if (status !== 400 || !errMsg) return null;
    const m = String(errMsg).toLowerCase();
    // 服务端建议 adaptive（提到 adaptive 且 effort/output_config）
    if (currentMode !== 'adaptive' && /adaptive/.test(m) && /(effort|output_config)/.test(m)) {
      return 'adaptive';
    }
    // 发了 adaptive 但服务端要 budget_tokens，或拒绝 adaptive/effort/output_config
    if (currentMode === 'adaptive') {
      const rejects = /budget_tokens/.test(m)
        || /(adaptive|output_config|effort)[^.]{0,40}(not\s+support|unsupport|unrecogni|unexpected|invalid|not\s+allow)/.test(m);
      if (rejects) return 'enabled';
    }
    return null;
  },

  /**
   * 构造图片输入请求体
   * image: { dataUrl, mediaType, base64 }
   */
  _buildImageBody(model, image, prompt, opts) {
    const mediaType = image.mediaType || this._mediaTypeFromDataUrl(image.dataUrl) || 'image/png';
    const base64 = image.base64 || this._base64FromDataUrl(image.dataUrl);
    if (opts.format === 'anthropic') {
      return JSON.stringify({
        model,
        max_tokens: opts.maxTokens || 512,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: prompt }
          ]
        }]
      });
    }
    return JSON.stringify({
      model,
      max_tokens: opts.maxTokens || 512,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: image.dataUrl || `data:${mediaType};base64,${base64}` } }
        ]
      }]
    });
  },

  /**
   * 构造 PDF / document 输入请求体。OpenAI 兼容渠道对 PDF 支持差异很大，
   * 这里仍按 content part 探测，让失败成为兼容性结果。
   */
  _buildPdfBody(model, doc, prompt, opts) {
    const mediaType = doc.mediaType || this._mediaTypeFromDataUrl(doc.dataUrl) || 'application/pdf';
    const base64 = doc.base64 || this._base64FromDataUrl(doc.dataUrl);
    if (opts.format === 'anthropic') {
      return JSON.stringify({
        model,
        max_tokens: opts.maxTokens || 512,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: prompt }
          ]
        }]
      });
    }
    return JSON.stringify({
      model,
      max_tokens: opts.maxTokens || 512,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'file', file: { filename: doc.filename || 'mft-test.pdf', file_data: doc.dataUrl || `data:${mediaType};base64,${base64}` } }
        ]
      }]
    });
  },

  _buildStopSequencesBody(model, prompt, stopSequences, opts) {
    if (opts.format === 'anthropic') {
      const body = {
        model,
        max_tokens: opts.maxTokens || 256,
        messages: [{ role: 'user', content: prompt }],
        stop_sequences: stopSequences
      };
      return JSON.stringify(body);
    }
    const body = {
      model,
      max_tokens: opts.maxTokens || 256,
      messages: [{ role: 'user', content: prompt }],
      stop: stopSequences
    };
    return JSON.stringify(body);
  },

  _buildOutputFormatBody(model, prompt, opts) {
    const schema = {
      type: 'object',
      properties: {
        code: { type: 'string' },
        ok: { type: 'boolean' }
      },
      required: ['code', 'ok'],
      additionalProperties: false
    };
    if (opts.format === 'anthropic') {
      return JSON.stringify({
        model,
        max_tokens: opts.maxTokens || 256,
        messages: [{ role: 'user', content: prompt }],
        output_config: {
          format: {
            type: 'json_schema',
            schema
          }
        }
      });
    }
    return JSON.stringify({
      model,
      max_tokens: opts.maxTokens || 256,
      messages: [{ role: 'user', content: prompt }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'mft_format_test', schema, strict: true }
      }
    });
  },

  _buildThinkingDisplayBody(model, prompt, display, opts, mode = 'adaptive') {
    // 该字段使用字符串枚举 summarized / omitted
    const displayVal = display === true ? 'summarized'
      : display === false ? 'omitted'
      : (display ?? null);
    const floor = mode === 'enabled'
      ? Math.max(opts.maxTokens || 4096, (opts.thinkingBudget || 2048) + 1024)
      : Math.max(opts.maxTokens || 4096, 8192);
    const body = {
      model,
      max_tokens: floor,
      messages: [{ role: 'user', content: prompt }],
      ...this._buildThinkingConfig(opts, mode, displayVal)
    };
    if (opts.stream) body.stream = true;
    return JSON.stringify(body);
  },

  _buildToolUseBody(model, prompt, opts) {
    if (opts.format === 'anthropic') {
      return JSON.stringify({
        model,
        max_tokens: opts.maxTokens || 512,
        messages: [{ role: 'user', content: prompt }],
        tools: [{
          name: 'get_weather',
          description: 'Get current weather for a city.',
          input_schema: {
            type: 'object',
            properties: {
              city: { type: 'string', description: 'City name' }
            },
            required: ['city']
          }
        }]
      });
    }
    return JSON.stringify({
      model,
      max_tokens: opts.maxTokens || 512,
      messages: [{ role: 'user', content: prompt }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather for a city.',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string', description: 'City name' }
            },
            required: ['city']
          }
        }
      }],
      tool_choice: 'auto'
    });
  },

  /**
   * 服务端 web_search 工具测试体（Anthropic 专属服务端工具）。
   * 官方 API 支持 type:"web_search_20250305"；Bedrock/Vertex/Kiro/网页逆向 多数不支持，
   * 因此能否真正触发 server_tool_use / web_search_tool_result 是强力的"是否官方直连"判据。
   */
  _buildWebSearchBody(model, prompt, opts) {
    return JSON.stringify({
      model,
      max_tokens: opts.maxTokens || 1024,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]
    });
  },

  _buildThinkingReplayBody(model, originalPrompt, previousBlocks, followupPrompt, opts, mode = 'adaptive') {
    const safeBlocks = (previousBlocks || [])
      .filter(b => b && (b.type === 'thinking' || b.type === 'redacted_thinking' || b.type === 'text'))
      .map(b => {
        if (b.type === 'thinking') {
          return {
            type: 'thinking',
            thinking: b.thinking || '',
            signature: b.signature || ''
          };
        }
        if (b.type === 'redacted_thinking') {
          return {
            type: 'redacted_thinking',
            data: b.data || ''
          };
        }
        return { type: 'text', text: b.text || '' };
      })
      .filter(b => b.type !== 'thinking' || (b.thinking && b.signature));
    return JSON.stringify({
      model,
      max_tokens: Math.max(opts.maxTokens || 512, 4096),
      messages: [
        { role: 'user', content: originalPrompt },
        { role: 'assistant', content: safeBlocks },
        { role: 'user', content: followupPrompt }
      ],
      // 现代模型在历史里带 thinking 块时需 thinking 配置，否则可能 400
      ...this._buildThinkingConfig(opts, mode, 'summarized')
    });
  },

  _buildPlainTextBody(model, prompt, opts) {
    if (opts.format === 'anthropic') {
      return this._buildAnthropicBody(model, prompt, Object.assign({}, opts, { stream: false }));
    }
    return this._buildOpenAIBody(model, prompt, Object.assign({}, opts, { stream: false }));
  },

  _mediaTypeFromDataUrl(dataUrl) {
    const m = String(dataUrl || '').match(/^data:([^;,]+)[;,]/);
    return m ? m[1] : '';
  },

  _base64FromDataUrl(dataUrl) {
    const s = String(dataUrl || '');
    const idx = s.indexOf(',');
    return idx >= 0 ? s.slice(idx + 1) : s;
  },

  /**
   * 发送一个自定义 body 的请求 - 用于 advanced 测试
   * 返回与 sendOne 相同结构的 result，但 promptId / round / concurrencyIndex 由调用方填
   */
  async sendCustom(meta, bodyStr, opts, signal) {
    const startedAt = Date.now();
    const result = {
      id: meta.id || 'custom_' + Math.random().toString(36).slice(2, 9),
      promptId: meta.promptId || 'custom',
      promptTag: meta.promptTag || 'custom',
      promptTitle: meta.promptTitle || '自定义',
      promptBody: meta.promptBody || '',
      round: meta.round || 1,
      concurrencyIndex: meta.concurrencyIndex || 0,
      model: opts.model,
      content: '',
      contentBlocks: [],  // 保留原始 content 数组（用于思考链分析）
      rawResponse: null,
      latency: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      finishReason: '',
      returnedModel: '',
      ttft: 0,
      tps: 0,
      startedAt,
      completedAt: 0,
      error: null,
      request: null,
      response: null,
      attempts: [],
      testType: meta.testType || 'custom'
    };

    const headers = this._buildHeaders(opts);
    const targetUrl = this.normalizeUrl(opts.url, opts.format);
    const requestUrl = this._requestUrl(opts.url, opts.format, opts);
    const timeoutCtrl = new AbortController();
    const timeoutId = setTimeout(() => timeoutCtrl.abort(), opts.timeoutMs);
    // FIX: 保存 abort listener 引用，finally 时移除（避免多次复用 signal 时 listener 堆积导致内存泄漏 / 假死）
    const onSignalAbort = () => timeoutCtrl.abort();
    if (signal) {
      if (signal.aborted) timeoutCtrl.abort();
      else signal.addEventListener('abort', onSignalAbort);
    }

    const attempt = {
      attemptIndex: 0, sentAt: Date.now(), skipParams: [],
      request: { url: requestUrl, targetUrl, method: 'POST', headers: Object.assign({}, headers), body: bodyStr },
      response: null, error: null
    };
    result.attempts.push(attempt);

    let res = null;
    try {
      res = await fetch(requestUrl, { method: 'POST', headers, body: bodyStr, signal: timeoutCtrl.signal });
      const ct = res.headers.get('content-type') || '';
      const isSSE = res.ok && opts.stream && /event-stream/i.test(ct);
      let text;
      if (isSSE) {
        // FIX: 把 signal 传给 SSE 读取器，让它能在 abort 时及时退出 + cancel reader
        text = await this._consumeSSEStream(res, opts.format, result, opts.onStreamChunk, timeoutCtrl.signal);
      } else {
        text = await res.text();
      }
      attempt.response = {
        status: res.status, statusText: res.statusText, ok: res.ok,
        headers: this._headersToObject(res.headers),
        body: text, receivedAt: Date.now(),
        streamed: isSSE
      };
      let parsed = null;
      if (!isSSE) {
        try { parsed = JSON.parse(text); } catch (e) { /* ignore */ }
      }
      result.request = attempt.request;
      result.response = attempt.response;

      if (!res.ok) {
        const errMsg = parsed?.error?.message || parsed?.error?.type || parsed?.message || (text || '').slice(0, 200);
        result.error = { message: `HTTP ${res.status}: ${errMsg}`, code: res.status };
      } else if (isSSE) {
        result.thinkingTokens = result.contentBlocks
          .filter(b => b?.type === 'thinking')
          .reduce((a, b) => a + this._estimateTokenLength(b.thinking || ''), 0);
        result.totalTokens = result.inputTokens + result.outputTokens + result.cacheCreationTokens + result.cacheReadTokens;
      } else if (parsed) {
        result.rawResponse = parsed;
        this._extractAll(parsed, result, opts.format);
        if (Array.isArray(parsed.content)) {
          result.contentBlocks = parsed.content.slice();
        }
        const u = parsed.usage || {};
        result.thinkingTokens = u.output_tokens_details?.thinking_tokens || u.thinking_tokens || u.cache_creation_input_tokens_thinking || 0;
      }
    } catch (err) {
      if (err.name === 'AbortError') result.error = { message: '请求超时或被取消', code: -1 };
      else result.error = { message: err.message || String(err), code: -2 };
      // FIX: 出错时主动 cancel body reader，防止半读连接挂着
      if (res && res.body && !res.bodyUsed) {
        try { await res.body.cancel(); } catch (e) { /* ignore */ }
      }
    } finally {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', onSignalAbort);
      result.completedAt = Date.now();
      result.latency = result.completedAt - startedAt;
    }
    return result;
  },

  /**
   * 探测响应中"参数已废弃/不支持"类错误，返回应该剔除的参数名（小写）
   * 返回 null 表示不是这类错误
   */
  _detectDeprecatedParam(httpStatus, errorMsg) {
    if (httpStatus !== 400 || !errorMsg) return null;
    const lower = String(errorMsg).toLowerCase();
    const candidates = ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'stream'];
    // 关键词：deprecated / not supported / unrecognized / unsupported / unexpected
    if (!/deprecat|not\s+support|unsupport|unrecognized|unexpected|invalid|not\s+allowed/.test(lower)) {
      return null;
    }
    for (const p of candidates) {
      if (lower.includes(p)) return p;
    }
    return null;
  },

  /**
   * 构造请求头
   * opts.extraHeaders: 额外 header（如 anthropic-beta 探测），仅本次请求附带
   */
  _buildHeaders(opts) {
    let headers;
    if (opts.format === 'anthropic') {
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01'
      };
    } else {
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${opts.apiKey}`
      };
    }
    if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);
    // 设备指纹（仅本地后端消费，用于限流/会话；不在 FORWARD_PREFIXES 中，不会转发到上游）
    if (this.clientFingerprint) headers['X-MFT-Fingerprint'] = this.clientFingerprint;
    return headers;
  },

  _estimateTokenLength(text) {
    if (!text) return 0;
    // 简单估算
    let n = 0;
    for (const c of text) n += /[一-龥]/.test(c) ? 0.5 : 0.25;
    return Math.round(n);
  },

  /**
   * 流式 SSE 解析
   * 读取响应流，累积事件，更新 result，同时回调 onChunk 让 UI 实时刷新
   *
   * Anthropic SSE 协议:
   *   event: message_start    → 携带 message 元数据 + usage 部分字段（包括 cache_*）
   *   event: content_block_start → 开始一个 block (text / thinking / tool_use)
   *   event: content_block_delta → 增量 (text_delta / thinking_delta / signature_delta / input_json_delta)
   *   event: content_block_stop
   *   event: message_delta    → 最终 stop_reason + 累积 output_tokens
   *   event: message_stop
   *   偶发: ping / overloaded_error
   *
   * OpenAI SSE:
   *   data: {choices: [{delta: {content: "..."}}]}
   *   data: [DONE]
   */
  async _consumeSSEStream(res, format, result, onChunk, signal) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let raw = '';
    const streamEvents = [];     // 记录事件序列用于协议规范性检查
    result.contentBlocks = result.contentBlocks || [];
    let ttftRecorded = false;

    // FIX: 单次 read 超时上限 + abort 主动 cancel reader，防止上游卡住时浏览器永久挂起
    const PER_READ_TIMEOUT_MS = 180000;  // 单次 read 最长等 180 秒
    const onAbort = () => { try { reader.cancel('aborted'); } catch (e) {} };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort);
    }

    const processEvent = (rawBlock) => {
      const lines = rawBlock.split('\n');
      let eventName = null;
      let dataLines = [];
      for (const ln of lines) {
        if (ln.startsWith(':')) continue;
        if (ln.startsWith('event:')) eventName = ln.slice(6).trim();
        else if (ln.startsWith('data:')) dataLines.push(ln.slice(5).trim());
      }
      const dataStr = dataLines.join('\n');
      if (!dataStr) return;
      if (dataStr === '[DONE]') { streamEvents.push({ event: 'done' }); return; }

      let parsed;
      try { parsed = JSON.parse(dataStr); } catch (e) { return; }

      streamEvents.push({ event: eventName || parsed?.type || 'data', type: parsed?.type });

      // TTFT: 在首个内容 delta 事件时记录首 Token 延迟
      if (!ttftRecorded && parsed?.type === 'content_block_delta') {
        const dt = parsed.delta?.type;
        if (dt === 'text_delta' || dt === 'thinking_delta') {
          result.ttft = Date.now() - result.startedAt;
          ttftRecorded = true;
        }
      }
      if (!ttftRecorded && parsed?.choices?.[0]?.delta?.content) {
        result.ttft = Date.now() - result.startedAt;
        ttftRecorded = true;
      }

      if (format === 'anthropic') {
        this._applyAnthropicSSE(parsed, result, onChunk);
      } else {
        this._applyOpenAISSE(parsed, result, onChunk);
      }
    };

    try {
      while (true) {
        if (signal && signal.aborted) break;
        // 单次 read 加 60s 上限，防止上游静默挂起
        const readP = reader.read();
        const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error('SSE read 单次超时')), PER_READ_TIMEOUT_MS));
        let chunkResult;
        try { chunkResult = await Promise.race([readP, timeoutP]); }
        catch (e) { try { await reader.cancel(); } catch (_) {} throw e; }
        const { value, done } = chunkResult;
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        raw += chunk;
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const evBlock = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (evBlock.trim()) processEvent(evBlock);
        }
      }
      if (buffer.trim()) processEvent(buffer);
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      try { reader.releaseLock(); } catch (e) { /* already released */ }
    }

    // 把 contentBlocks 中的文本累积成最终 content
    result.content = (result.contentBlocks || [])
      .filter(b => b && b.type === 'text')
      .map(b => b.text || '').join('');
    result.streamEvents = streamEvents;

    // TPS: 输出 token 数 / 生成耗时（排除 TTFT）
    if (result.ttft > 0 && result.outputTokens > 0) {
      const genMs = Date.now() - result.startedAt - result.ttft;
      result.tps = genMs > 0 ? +(result.outputTokens / (genMs / 1000)).toFixed(2) : 0;
    }

    return raw;
  },

  _applyAnthropicSSE(parsed, result, onChunk) {
    const t = parsed.type;
    if (t === 'message_start') {
      const m = parsed.message || {};
      result.returnedModel = m.model || result.returnedModel;
      const u = m.usage || {};
      result.inputTokens = u.input_tokens || result.inputTokens || 0;
      result.outputTokens = u.output_tokens || 0;
      result.cacheCreationTokens = u.cache_creation_input_tokens || 0;
      result.cacheReadTokens = u.cache_read_input_tokens || 0;
      result.rawResponse = { id: m.id, type: m.type, role: m.role, model: m.model, content: [], stop_reason: null, usage: u };
    } else if (t === 'content_block_start') {
      const idx = parsed.index || 0;
      const block = Object.assign({}, parsed.content_block || {});
      if (block.type === 'text' && block.text === undefined) block.text = '';
      if (block.type === 'thinking' && block.thinking === undefined) block.thinking = '';
      result.contentBlocks[idx] = block;
    } else if (t === 'content_block_delta') {
      const idx = parsed.index || 0;
      const delta = parsed.delta || {};
      if (!result.contentBlocks[idx]) result.contentBlocks[idx] = { type: 'text', text: '' };
      const b = result.contentBlocks[idx];
      if (delta.type === 'text_delta') {
        b.text = (b.text || '') + delta.text;
        if (onChunk) onChunk({ type: 'text', text: delta.text, blockIndex: idx });
      } else if (delta.type === 'thinking_delta') {
        b.thinking = (b.thinking || '') + delta.thinking;
        if (onChunk) onChunk({ type: 'thinking', text: delta.thinking, blockIndex: idx });
      } else if (delta.type === 'signature_delta') {
        b.signature = (b.signature || '') + delta.signature;
      } else if (delta.type === 'input_json_delta') {
        b.partial_input = (b.partial_input || '') + delta.partial_json;
      }
    } else if (t === 'content_block_stop') {
      // nothing
    } else if (t === 'message_delta') {
      const d = parsed.delta || {};
      const u = parsed.usage || {};
      if (d.stop_reason) result.finishReason = d.stop_reason;
      if (u.output_tokens !== undefined) result.outputTokens = u.output_tokens;
      if (u.cache_creation_input_tokens !== undefined) result.cacheCreationTokens = u.cache_creation_input_tokens;
      if (u.cache_read_input_tokens !== undefined) result.cacheReadTokens = u.cache_read_input_tokens;
      if (u.output_tokens_details?.thinking_tokens !== undefined) result.thinkingTokens = u.output_tokens_details.thinking_tokens;
      if (result.rawResponse) {
        // 累积完整 usage，保留 service_tier / output_tokens_details / cache_miss_reason 等官方字段
        result.rawResponse.usage = Object.assign({}, result.rawResponse.usage, u);
        // stop_details (2026.6) 在流式下经 message_delta.delta 下发
        if (d.stop_details) result.rawResponse.stop_details = d.stop_details;
      }
    } else if (t === 'message_stop') {
      // 完成 - 整理 rawResponse
      if (result.rawResponse) {
        result.rawResponse.content = result.contentBlocks.filter(Boolean);
        result.rawResponse.stop_reason = result.finishReason;
        // 合并而非覆盖：message_start/message_delta 带来的 service_tier 等字段不能丢
        result.rawResponse.usage = Object.assign({}, result.rawResponse.usage, {
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          cache_creation_input_tokens: result.cacheCreationTokens,
          cache_read_input_tokens: result.cacheReadTokens
        });
      }
    } else if (t === 'ping') {
      // 心跳
    } else if (t === 'error') {
      result.error = { message: parsed.error?.message || 'stream error', code: 0 };
    }
  },

  _applyOpenAISSE(parsed, result, onChunk) {
    if (parsed.choices && parsed.choices[0]) {
      const ch = parsed.choices[0];
      const delta = ch.delta || {};
      if (delta.content) {
        if (!result.contentBlocks[0]) result.contentBlocks[0] = { type: 'text', text: '' };
        result.contentBlocks[0].text += delta.content;
        if (onChunk) onChunk({ type: 'text', text: delta.content, blockIndex: 0 });
      }
      if (ch.finish_reason) result.finishReason = ch.finish_reason;
    }
    if (parsed.model) result.returnedModel = parsed.model;
    if (parsed.usage) {
      result.inputTokens = parsed.usage.prompt_tokens || result.inputTokens;
      result.outputTokens = parsed.usage.completion_tokens || result.outputTokens;
      result.cacheReadTokens = parsed.usage.prompt_tokens_details?.cached_tokens || result.cacheReadTokens;
    }
  },

  /**
   * 把 Headers 对象转成普通对象
   */
  _headersToObject(headers) {
    const obj = {};
    if (!headers) return obj;
    if (typeof headers.forEach === 'function') {
      headers.forEach((v, k) => { obj[k] = v; });
    } else if (typeof headers === 'object') {
      for (const k of Object.keys(headers)) obj[k] = headers[k];
    }
    return obj;
  },

  /**
   * 发送单条请求
   * 完整记录:
   *   result.request  = { url, method, headers, body }    // headers 中敏感字段已脱敏副本另存
   *   result.response = { status, statusText, headers, body }  // body 是原始文本（解析前）
   *   result.attempts = [...]   // 重试时的所有尝试快照
   */
  async sendOne(task, opts, signal) {
    const startedAt = Date.now();
    const id = task.id;
    const result = {
      id,
      promptId: task.prompt.id,
      promptTag: task.prompt.tag,
      promptTitle: task.prompt.title,
      promptBody: task.prompt.body,
      round: task.round,
      concurrencyIndex: task.concurrencyIndex,
      model: opts.model,
      content: '',
      rawResponse: null,
      latency: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      finishReason: '',
      returnedModel: '',
      ttft: 0,
      tps: 0,
      startedAt,
      completedAt: 0,
      error: null,
      request: null,
      response: null,
      attempts: []
    };

    const reqHeaders = this._buildHeaders(opts);
    const targetUrl = this.normalizeUrl(opts.url, opts.format);
    const requestUrl = this._requestUrl(opts.url, opts.format, opts);

    const skipParams = (opts.skipParams && Array.isArray(opts.skipParams)) ? opts.skipParams.slice() : [];

    const buildBody = (skips) => opts.format === 'anthropic'
      ? this._buildAnthropicBody(opts.model, task.prompt.body, opts, skips)
      : this._buildOpenAIBody(opts.model, task.prompt.body, opts, skips);

    const timeoutCtrl = new AbortController();
    const timeoutId = setTimeout(() => timeoutCtrl.abort(), opts.timeoutMs);
    const onAbort = () => timeoutCtrl.abort();
    if (signal) {
      if (signal.aborted) timeoutCtrl.abort();
      else signal.addEventListener('abort', onAbort);
    }

    /**
     * 执行一次 HTTP 请求并完整记录
     */
    const doAttempt = async (skips) => {
      const reqBody = buildBody(skips);
      const attempt = {
        attemptIndex: result.attempts.length,
        sentAt: Date.now(),
        skipParams: skips.slice(),
        request: {
          url: requestUrl,
          targetUrl,
          method: 'POST',
          headers: Object.assign({}, reqHeaders),
          body: reqBody
        },
        response: null,
        error: null
      };
      let res = null;
      try {
        res = await fetch(requestUrl, {
          method: 'POST',
          headers: reqHeaders,
          body: reqBody,
          signal: timeoutCtrl.signal
        });
        const ct = res.headers.get('content-type') || '';
        const isSSE = res.ok && opts.stream && /event-stream/i.test(ct);
        let bodyText;
        if (isSSE) {
          bodyText = await this._consumeSSEStream(res, opts.format, result, opts.onStreamChunk, timeoutCtrl.signal);
        } else {
          bodyText = await res.text();
        }
        attempt.response = {
          status: res.status,
          statusText: res.statusText,
          ok: res.ok,
          headers: this._headersToObject(res.headers),
          body: bodyText,
          receivedAt: Date.now(),
          streamed: isSSE
        };
      } catch (err) {
        attempt.error = { message: err.message || String(err), name: err.name };
        // FIX: 出错时主动 cancel response body，防止半读连接挂着导致后续请求阻塞
        if (res && res.body && !res.bodyUsed) {
          try { await res.body.cancel(); } catch (e) {}
        }
      }
      result.attempts.push(attempt);
      return attempt;
    };

    try {
      let attempt = await doAttempt(skipParams);
      let parsed = null;
      if (attempt.response && !attempt.response.streamed) {
        try { parsed = JSON.parse(attempt.response.body); } catch (e) { /* ignore */ }
      }

      // 自动重试：参数被废弃/不支持
      if (attempt.response && !attempt.response.ok) {
        const errMsg = parsed?.error?.message || parsed?.error?.type || parsed?.message || (attempt.response.body || '').slice(0, 400);
        const dep = this._detectDeprecatedParam(attempt.response.status, errMsg);
        if (dep && !skipParams.includes(dep)) {
          skipParams.push(dep);
          if (opts.onSkipParam) opts.onSkipParam(dep, errMsg);
          // 重试前清掉流式累积的状态
          result.contentBlocks = [];
          result.content = '';
          attempt = await doAttempt(skipParams);
          parsed = null;
          if (attempt.response && !attempt.response.streamed) {
            try { parsed = JSON.parse(attempt.response.body); } catch (e) { /* ignore */ }
          }
          result.retriedSkipped = skipParams.slice();
        }
      }

      result.request = attempt.request;
      result.response = attempt.response;

      if (attempt.error) {
        if (attempt.error.name === 'AbortError') {
          result.error = { message: '请求超时或被取消', code: -1 };
        } else {
          result.error = { message: attempt.error.message || '网络错误', code: -2 };
        }
      } else if (!attempt.response.ok) {
        const errMsg = parsed?.error?.message
          || parsed?.error?.type
          || parsed?.message
          || (attempt.response.body || '').slice(0, 200);
        result.error = { message: `HTTP ${attempt.response.status}: ${errMsg}`, code: attempt.response.status };
      } else if (attempt.response.streamed) {
        // 流式已经在 _consumeSSEStream 里累积完毕，直接验证
        if (!result.content && !result.contentBlocks.length) {
          result.error = { message: '流式响应未产生 content', code: 0 };
        }
        result.totalTokens = result.inputTokens + result.outputTokens + result.cacheCreationTokens + result.cacheReadTokens;
      } else if (!parsed) {
        result.error = { message: '响应非合法 JSON: ' + (attempt.response.body || '').slice(0, 200), code: 0 };
      } else {
        result.rawResponse = parsed;
        this._extractAll(parsed, result, opts.format);
        if (!result.content && !(result.toolUseBlocks && result.toolUseBlocks.length) && !(result.toolCalls && result.toolCalls.length)) {
          result.error = { message: '响应中未找到 content 字段', code: 0 };
        }
      }

    } catch (err) {
      // 兜底（理论不会走到，doAttempt 已经吃掉异常）
      result.error = { message: err.message || String(err), code: -2 };
    } finally {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', onAbort);
      result.completedAt = Date.now();
      result.latency = result.completedAt - startedAt;
    }

    return result;
  },

  /**
   * 脱敏一份请求头副本（用于展示/导出，不修改原对象）
   * Authorization: Bearer XXXX → Bearer sk-***...***xyz
   * x-api-key:    sk-XXXX     → sk-***...***xyz
   */
  maskHeaders(headers) {
    if (!headers) return {};
    const out = {};
    for (const k of Object.keys(headers)) {
      const lower = k.toLowerCase();
      const v = String(headers[k] || '');
      if (lower === 'authorization' || lower === 'x-api-key' || lower === 'api-key') {
        out[k] = this._maskSecret(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  },

  _maskSecret(v) {
    if (!v) return v;
    // Bearer xxx 形式
    const bearerMatch = v.match(/^(Bearer\s+)(.+)$/i);
    if (bearerMatch) {
      return bearerMatch[1] + this._maskToken(bearerMatch[2]);
    }
    return this._maskToken(v);
  },

  _maskToken(t) {
    if (t.length <= 8) return '***';
    return t.slice(0, 4) + '*'.repeat(Math.max(3, t.length - 8)) + t.slice(-4);
  },

  /**
   * 从响应中提取所有需要的字段
   * 同时兼容 OpenAI 和 Anthropic 格式（即使 format 配错也尽量解析）
   */
  _extractAll(parsed, result, format) {
    // Anthropic 格式
    if (format === 'anthropic' || (Array.isArray(parsed.content) && parsed.type === 'message')) {
      result.content = Array.isArray(parsed.content)
        ? parsed.content.map(c => c.text || '').join('')
        : '';
      result.contentBlocks = Array.isArray(parsed.content) ? parsed.content.slice() : [];
      result.toolUseBlocks = result.contentBlocks.filter(c => c?.type === 'tool_use');
      result.returnedModel = parsed.model || '';
      result.finishReason = parsed.stop_reason || '';
      const u = parsed.usage || {};
      result.inputTokens = u.input_tokens || 0;
      result.outputTokens = u.output_tokens || 0;
      result.cacheCreationTokens = u.cache_creation_input_tokens || 0;
      result.cacheReadTokens = u.cache_read_input_tokens || 0;
      result.totalTokens = result.inputTokens + result.outputTokens
                         + result.cacheCreationTokens + result.cacheReadTokens;
      return;
    }

    // OpenAI 标准
    if (parsed.choices && parsed.choices[0]) {
      const ch = parsed.choices[0];
      if (ch.message) {
        if (typeof ch.message.content === 'string') {
          result.content = ch.message.content;
        } else if (Array.isArray(ch.message.content)) {
          result.content = ch.message.content.map(c => c.text || c.content || '').join('');
        }
        result.toolCalls = Array.isArray(ch.message.tool_calls) ? ch.message.tool_calls.slice() : [];
      }
      if (!result.content && ch.text) result.content = ch.text;
      result.finishReason = ch.finish_reason || '';
    }
    result.returnedModel = parsed.model || '';
    const u = parsed.usage || {};
    result.inputTokens = u.prompt_tokens || u.input_tokens || 0;
    result.outputTokens = u.completion_tokens || u.output_tokens || 0;
    // OpenAI 协议的 prompt caching 信息一般在 usage.prompt_tokens_details.cached_tokens
    result.cacheReadTokens = u.cache_read_input_tokens || u.prompt_tokens_details?.cached_tokens || 0;
    result.cacheCreationTokens = u.cache_creation_input_tokens || 0;
    result.totalTokens = u.total_tokens || (result.inputTokens + result.outputTokens);

    // 兜底: Gemini-like
    if (!result.content && parsed.candidates && parsed.candidates[0]) {
      const cand = parsed.candidates[0];
      if (cand.content && cand.content.parts) {
        result.content = cand.content.parts.map(p => p.text || '').join('');
      }
    }
  },

  /**
   * 并发执行
   * 在整批请求中共享 skipParams 状态：
   *   - 某条请求发现 temperature 被废弃后，会通过 onSkipParam 通知
   *   - 后续请求自动跳过该参数，不再重复触发同一个 400
   */
  async runAll(tasks, opts, onProgress, signal, onSkip) {
    const results = [];
    const concurrency = Math.max(1, opts.concurrency);
    let cursor = 0;
    const sharedSkip = (opts.skipParams || []).slice();

    const worker = async () => {
      while (cursor < tasks.length) {
        if (signal && signal.aborted) return;
        const myIdx = cursor++;
        const task = tasks[myIdx];
        if (!task) break;
        const reqOpts = Object.assign({}, opts, {
          model: task.model || opts.model,
          skipParams: sharedSkip.slice(),
          onSkipParam: (param, errMsg) => {
            if (!sharedSkip.includes(param)) {
              sharedSkip.push(param);
              if (onSkip) onSkip(param, errMsg);
            }
          }
        });
        const r = await this.sendOne(task, reqOpts, signal);
        results.push(r);
        if (onProgress) onProgress(r, results.length, tasks.length);
        if (signal && signal.aborted) return;
      }
    };

    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);
    return results;
  },

  /**
   * 构造连续对话任务 — 每个 prompt = 一个独立对话，跑 rounds 轮
   * task 结构:
   *   {
   *     id, prompt, turns: [{ index, userMessage }],
   *     // 运行时填充:
   *     messages: [],
   *     turnResults: [],
   *     status: 'pending' | 'running' | 'done' | 'failed'
   *   }
   */
  buildConversationTasks(prompts, rounds, followups) {
    const tasks = [];
    for (const p of prompts) {
      if (!p.enabled || !p.body.trim()) continue;
      const turns = [];
      for (let t = 0; t < rounds; t++) {
        const followup = t === 0 ? null : (followups && followups[t]) || null;
        turns.push({
          index: t,
          userMessage: followup || p.body
        });
      }
      tasks.push({
        id: 'ct_' + p.id,
        prompt: p,
        turns,
        messages: [],
        turnResults: [],
        status: 'pending',
        startedAt: 0,
        completedAt: 0
      });
    }
    return tasks;
  },

  /**
   * 并发执行连续对话任务
   * - task 内部 sequential（每一轮等上一轮完成 + 累积上下文）
   * - task 之间用 worker pool 并发（concurrency 个 worker）
   * - 一个 worker 拿一个完整 task 跑完所有轮，才取下一个 task
   */
  async runConversationTasks(tasks, opts, callbacks = {}) {
    const concurrency = Math.max(1, opts.concurrency || 1);
    const signal = callbacks.signal;
    const sharedSkip = (opts.skipParams || []).slice();
    let cursor = 0;

    const runOneTask = async (task) => {
      task.status = 'running';
      task.startedAt = Date.now();
      if (callbacks.onTaskStart) callbacks.onTaskStart(task);

      for (const turn of task.turns) {
        if (signal && signal.aborted) { task.status = 'aborted'; return; }
        task.messages.push({ role: 'user', content: turn.userMessage });

        const reqOpts = Object.assign({}, opts, {
          model: task.model || opts.model,
          skipParams: sharedSkip.slice(),
          onSkipParam: (param, msg) => {
            if (!sharedSkip.includes(param)) {
              sharedSkip.push(param);
              if (callbacks.onSkipParam) callbacks.onSkipParam(param, msg);
            }
          },
          onStreamChunk: callbacks.onStreamChunk
            ? (chunk) => callbacks.onStreamChunk(task, turn, chunk) : null
        });

        const bodyStr = this._buildConversationBody(reqOpts.model, task.messages, reqOpts);
        const result = await this.sendCustom(
          {
            id: `${task.id}_t${turn.index}`,
            promptId: task.prompt.id,
            promptTag: task.prompt.tag,
            promptTitle: task.model ? `${task.prompt.title} @ ${task.model}` : task.prompt.title,
            promptBody: turn.userMessage,
            round: turn.index + 1,
            concurrencyIndex: 0,
            testType: 'probe_conversation'
          },
          bodyStr,
          reqOpts,
          signal
        );

        task.turnResults.push(result);
        if (callbacks.onTurnComplete) callbacks.onTurnComplete(task, turn, result);

        if (!result.error && result.content) {
          task.messages.push({ role: 'assistant', content: result.content });
        } else {
          task.status = 'failed';
          break;
        }
      }

      if (task.status === 'running') task.status = 'done';
      task.completedAt = Date.now();
      if (callbacks.onTaskComplete) callbacks.onTaskComplete(task);
    };

    const worker = async (workerIdx) => {
      while (cursor < tasks.length) {
        if (signal && signal.aborted) return;
        const idx = cursor++;
        const task = tasks[idx];
        if (!task) break;
        task.workerIdx = workerIdx;
        await runOneTask(task);
      }
    };

    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker(i));
    await Promise.all(workers);
  },

  /**
   * 任务列表（旧）
   */
  buildTasks(prompts, concurrency, rounds) {
    const tasks = [];
    for (let round = 1; round <= rounds; round++) {
      for (let c = 0; c < concurrency; c++) {
        for (const p of prompts) {
          if (!p.enabled || !p.body.trim()) continue;
          tasks.push({
            id: `r${round}_c${c}_${p.id}_${Math.random().toString(36).slice(2, 6)}`,
            prompt: p,
            round,
            concurrencyIndex: c
          });
        }
      }
    }
    return tasks;
  }
};
