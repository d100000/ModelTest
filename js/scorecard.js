/**
 * 综合评分引擎 - 40 项检查 × 6 层
 *
 * 每个 check item:
 *   { id, layer, name, weight, evaluate(ctx) -> { status: 'pass'|'partial'|'fail'|'skip', detail } }
 *
 * 总分 = Σ(score × weight) / Σ(weight × ifApplicable) × 100
 *   pass:    1.0
 *   partial: 0.5
 *   fail:    0.0
 *   skip:    不计入分母
 */

const SCORECARD_LAYERS = {
  L1: { id: 'L1', name: '协议规范性', color: '#5b8def' },
  L2: { id: 'L2', name: '计量合理性', color: '#a78bfa' },
  L3: { id: 'L3', name: '能力支持度', color: '#67e8f9' },
  L4: { id: 'L4', name: '行为指纹',   color: '#fbbf24' },
  L5: { id: 'L5', name: '密码学验证', color: '#f472b6' },
  L6: { id: 'L6', name: '对抗性探针', color: '#fb923c' }
};

const SCORECARD_CHECKS = [
  // ===== L1 协议规范性 =====
  {
    id: 'l1_message_id_prefix', layer: 'L1', name: 'message id 渠道前缀', weight: 4,
    desc: '根据响应体 id 判断 Anthropic / Vertex / Bedrock / OpenAI 兼容 / OpenRouter 格式',
    evaluate(ctx) {
      let total = 0, known = 0;
      const counts = {};
      const classify = (id) => {
        if (/^msg_01/i.test(id)) return 'Anthropic';
        if (/^msg_vrtx_/i.test(id)) return 'Vertex';
        if (/^m(?:sg|sq)_bdrk_/i.test(id)) return 'Bedrock';
        if (/^(?:chatcmpl-|cmpl-|resp_)/i.test(id)) return 'OpenAI兼容';
        if (/^gen-/i.test(id)) return 'OpenRouter';
        return '未知';
      };
      for (const r of ctx.successResults) {
        const id = r.rawResponse?.id;
        if (!id) continue;
        total++;
        const type = classify(String(id));
        counts[type] = (counts[type] || 0) + 1;
        if (type !== '未知') known++;
      }
      if (!total) return { status: 'skip', detail: '无可检查 id' };
      const summary = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ');
      if (known / total >= 0.9) return { status: 'pass', detail: summary };
      if (known / total >= 0.5) return { status: 'partial', detail: summary };
      return { status: 'fail', detail: `多数 id 前缀未知: ${summary}` };
    }
  },
  {
    id: 'l1_json_schema', layer: 'L1', name: '响应 JSON Schema', weight: 3,
    desc: 'body 必须包含 id / type / role / model / content / stop_reason / usage 字段',
    evaluate(ctx) {
      const required = ['id', 'type', 'role', 'model', 'content', 'stop_reason', 'usage'];
      let totalChecked = 0, totalMissing = 0;
      for (const r of ctx.successResults) {
        const body = r.rawResponse;
        if (!body) continue;
        totalChecked++;
        for (const f of required) if (body[f] === undefined) totalMissing++;
      }
      if (totalChecked === 0) return { status: 'skip', detail: '无可解析响应' };
      const rate = 1 - totalMissing / (totalChecked * required.length);
      if (rate >= 0.98) return { status: 'pass', detail: '全部必填字段齐全' };
      if (rate >= 0.85) return { status: 'partial', detail: `${(rate * 100).toFixed(0)}% 必填字段齐全，少数缺失` };
      return { status: 'fail', detail: `仅 ${(rate * 100).toFixed(0)}% 必填字段齐全，body 协议不规范` };
    }
  },
  {
    id: 'l1_id_format', layer: 'L1', name: 'message id 已知格式', weight: 3,
    desc: 'body.id 应匹配官方 API / Vertex / Bedrock / OpenAI 兼容 / OpenRouter 的已知前缀',
    evaluate(ctx) {
      let hit = 0, total = 0;
      const known = /^(?:msg_01|msg_vrtx_|m(?:sg|sq)_bdrk_|chatcmpl-|cmpl-|resp_|gen-)[A-Za-z0-9_.:-]*/i;
      for (const r of ctx.successResults) {
        const id = r.rawResponse?.id;
        if (!id) continue;
        total++;
        if (known.test(String(id))) hit++;
      }
      if (total === 0) return { status: 'skip', detail: '无可检查 id' };
      const rate = hit / total;
      if (rate >= 0.95) return { status: 'pass', detail: `${hit}/${total} 个 id 符合已知渠道格式` };
      if (rate >= 0.5) return { status: 'partial', detail: `${hit}/${total} 个 id 符合已知渠道格式` };
      return { status: 'fail', detail: `${hit}/${total} 个 id 符合已知格式 — 多数被代理改写或隐藏` };
    }
  },
  {
    id: 'l1_model_consistency', layer: 'L1', name: 'model 字段稳定性', weight: 2,
    desc: 'body.model / returnedModel 用于观察路由稳定性；日期后缀不作为真伪依据',
    evaluate(ctx) {
      const models = ctx.successResults
        .map(r => r.rawResponse?.model || r.returnedModel || '')
        .filter(Boolean);
      if (!models.length) return { status: 'skip', detail: '无可检查 model 字段' };
      const counts = new Map();
      for (const m of models) counts.set(m, (counts.get(m) || 0) + 1);
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const top = sorted[0];
      const rate = top[1] / models.length;
      if (rate >= 0.95) return { status: 'pass', detail: `返回 model 稳定: ${top[0]}` };
      if (rate >= 0.7) return { status: 'partial', detail: `主 model 占比 ${(rate * 100).toFixed(0)}%，存在少量变化` };
      return { status: 'fail', detail: `返回 model 不稳定，疑似多模型/多渠道分流` };
    }
  },
  {
    id: 'l1_content_array', layer: 'L1', name: 'content 是数组结构', weight: 2,
    desc: 'Anthropic 协议要求 content 是 block 数组',
    evaluate(ctx) {
      let hit = 0, total = 0;
      for (const r of ctx.successResults) {
        const c = r.rawResponse?.content;
        if (c === undefined) continue;
        total++;
        if (Array.isArray(c)) hit++;
      }
      if (total === 0) return { status: 'skip', detail: '无 content 字段' };
      const rate = hit / total;
      if (rate >= 0.95) return { status: 'pass', detail: '所有 content 都是数组' };
      if (rate >= 0.5) return { status: 'partial', detail: '部分 content 不是数组' };
      return { status: 'fail', detail: 'content 不符合 Anthropic 协议（可能被 OpenAI 格式包装）' };
    }
  },
  {
    id: 'l1_stop_reason', layer: 'L1', name: 'stop_reason 在合法枚举内', weight: 2,
    desc: '应为 end_turn / max_tokens / stop_sequence / tool_use / pause_turn / refusal 之一',
    evaluate(ctx) {
      const enums = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal'];
      let hit = 0, total = 0;
      for (const r of ctx.successResults) {
        const sr = r.rawResponse?.stop_reason;
        if (sr === undefined) continue;
        total++;
        if (enums.includes(sr)) hit++;
      }
      if (total === 0) return { status: 'skip', detail: '无 stop_reason' };
      const rate = hit / total;
      if (rate >= 0.95) return { status: 'pass', detail: '全部在合法枚举内' };
      return { status: 'fail', detail: '出现非标准 stop_reason 值' };
    }
  },
  {
    id: 'l1_sse_event_sequence', layer: 'L1', name: 'SSE 事件序列合规', weight: 5,
    desc: 'Anthropic SSE 协议要求: message_start → content_block_start → delta → content_block_stop → message_delta → message_stop',
    evaluate(ctx) {
      if (!ctx.cfg.stream) return { status: 'skip', detail: '未启用流式' };
      if (ctx.cfg.format !== 'anthropic') return { status: 'skip', detail: '仅检查 Anthropic SSE 协议' };
      const streamed = ctx.successResults.filter(r => r.streamEvents && r.streamEvents.length > 0);
      if (!streamed.length) return { status: 'skip', detail: '无流式事件数据' };
      let compliant = 0, checked = 0;
      const issues = [];
      for (const r of streamed) {
        // ping 可以穿插在任意位置（官方协议允许），剔除后再校验顺序
        const evts = r.streamEvents.map(e => e.event || e.type)
          .filter(e => e && e !== 'ping' && e !== 'done');
        if (!evts.length) continue;
        checked++;
        let ok = true;
        if (evts[0] !== 'message_start') { ok = false; issues.push('首事件非 message_start'); }
        if (evts[evts.length - 1] !== 'message_stop') { ok = false; issues.push('末事件非 message_stop'); }
        const hasStart = evts.includes('content_block_start');
        const hasDelta = evts.includes('content_block_delta');
        const hasStop = evts.includes('content_block_stop');
        if (hasDelta && !hasStart) { ok = false; issues.push('有 delta 但缺 block_start'); }
        if (hasStart && !hasStop) { ok = false; issues.push('有 block_start 但缺 block_stop'); }
        if (ok) compliant++;
      }
      if (!checked) return { status: 'skip', detail: '无可校验事件序列' };
      const rate = compliant / checked;
      const uniq = [...new Set(issues)].slice(0, 3).join('; ');
      if (rate >= 0.9) return { status: 'pass', detail: `${compliant}/${checked} 条流合规` };
      if (rate >= 0.5) return { status: 'partial', detail: `${compliant}/${checked} 条合规，问题: ${uniq}` };
      return { status: 'fail', detail: `SSE 事件序列异常（${uniq}），代理可能篡改/重组了流` };
    }
  },
  {
    id: 'l1_ratelimit_headers', layer: 'L1', name: 'Rate-limit 响应头', weight: 4,
    desc: 'Anthropic 官方 API 返回 anthropic-ratelimit-* 头；缺失说明经过了代理剥离',
    evaluate(ctx) {
      if (ctx.cfg.format !== 'anthropic') return { status: 'skip', detail: '仅检查 Anthropic 协议' };
      let withHeaders = 0, total = 0;
      const found = new Set();
      for (const r of ctx.successResults) {
        const h = r.response?.headers;
        if (!h) continue;
        total++;
        const keys = Object.keys(h).filter(k => k.toLowerCase().startsWith('anthropic-ratelimit-'));
        if (keys.length >= 2) {
          withHeaders++;
          keys.forEach(k => found.add(k.toLowerCase()));
        }
      }
      if (!total) return { status: 'skip', detail: '无可检查响应头' };
      const rate = withHeaders / total;
      const list = [...found].slice(0, 4).join(', ');
      if (rate >= 0.8) return { status: 'pass', detail: `${withHeaders}/${total} 含 ratelimit 头 (${list})` };
      if (rate > 0) return { status: 'partial', detail: `仅 ${withHeaders}/${total} 含 ratelimit 头` };
      // 缺失不等于伪造：priority tier、provisioned、部分流式路径官方也可能不返回 ratelimit 头。
      // 故降为 partial（弱负面），而非 fail。
      return { status: 'partial', detail: '未观测到 anthropic-ratelimit-* 头（可能为 priority tier / 流式路径，或被代理剥离）' };
    }
  },

  {
    id: 'l1_error_format', layer: 'L1', name: '错误响应格式（如有失败）', weight: 1,
    desc: '失败响应 body 应为 {type, error: {type, message}}',
    evaluate(ctx) {
      const errResults = ctx.allResults.filter(r => r.error && r.response?.body);
      if (errResults.length === 0) return { status: 'skip', detail: '无失败响应' };
      let hit = 0;
      for (const r of errResults) {
        try {
          const parsed = JSON.parse(r.response.body);
          if (parsed?.type === 'error' && parsed?.error?.type) hit++;
        } catch (e) { /* skip */ }
      }
      const rate = hit / errResults.length;
      if (rate >= 0.8) return { status: 'pass', detail: '错误响应符合 Anthropic 错误格式' };
      if (rate > 0) return { status: 'partial', detail: '部分错误响应符合格式' };
      return { status: 'fail', detail: '错误响应不符合 Anthropic 格式' };
    }
  },

  // ===== L2 计量合理性 =====
  {
    id: 'l2_usage_fields', layer: 'L2', name: 'usage 四元组齐全', weight: 4,
    desc: 'input_tokens / output_tokens / cache_creation_input_tokens / cache_read_input_tokens 都应存在',
    evaluate(ctx) {
      const fields = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
      let totalScore = 0, totalChecked = 0;
      for (const r of ctx.successResults) {
        const u = r.rawResponse?.usage;
        if (!u) continue;
        totalChecked++;
        for (const f of fields) if (u[f] !== undefined && u[f] !== null) totalScore++;
      }
      if (totalChecked === 0) return { status: 'skip', detail: '无 usage 字段' };
      const rate = totalScore / (totalChecked * 4);
      if (rate >= 0.95) return { status: 'pass', detail: 'usage 四元组完整' };
      if (rate >= 0.5) return { status: 'partial', detail: `usage 仅 ${(rate * 100).toFixed(0)}% 字段齐全，缓存字段可能缺失` };
      return { status: 'fail', detail: 'usage 字段被代理剥离 — 上游非官方' };
    }
  },
  {
    id: 'l2_service_tier', layer: 'L2', name: 'usage 含 service_tier', weight: 3,
    desc: 'Anthropic 官方独有字段',
    evaluate(ctx) {
      let hit = 0, total = 0;
      for (const r of ctx.successResults) {
        if (!r.rawResponse?.usage) continue;
        total++;
        if (r.rawResponse.usage.service_tier !== undefined) hit++;
      }
      if (total === 0) return { status: 'skip', detail: '无 usage' };
      if (hit / total >= 0.5) return { status: 'pass', detail: `${hit}/${total} 响应含 service_tier` };
      // service_tier 并非每个账户/层级/路径都返回；存在是正面证据，缺失不足以判伪。降为 partial。
      return { status: 'partial', detail: 'service_tier 字段缺失（部分官方层级/流式路径也不返回，非决定性）' };
    }
  },
  {
    id: 'l2_token_reasonable', layer: 'L2', name: 'token 数量合理性', weight: 2,
    desc: '简单 "Hi" 请求不应回 1000+ input_tokens',
    evaluate(ctx) {
      const hi = ctx.successResults.filter(r => /^hi$/i.test(r.promptBody?.trim() || ''));
      if (!hi.length) return { status: 'skip', detail: '无 "Hi" 请求样本' };
      const avg = hi.reduce((a, r) => a + (r.inputTokens || 0), 0) / hi.length;
      if (avg <= 50) return { status: 'pass', detail: `平均 ${avg.toFixed(0)} input_tokens，合理` };
      if (avg <= 200) return { status: 'partial', detail: `平均 ${avg.toFixed(0)} input_tokens，偏高（可能有隐藏 system）` };
      return { status: 'fail', detail: `平均 ${avg.toFixed(0)} input_tokens 过高，代理可能注入了大量隐藏内容` };
    }
  },
  {
    id: 'l2_token_count_sanity', layer: 'L2', name: 'Token 计数合理性（输出端）', weight: 3,
    desc: '检查 output_tokens 与实际文本长度是否成比例。若 output_tokens=0 但有内容 → 计量造假',
    evaluate(ctx) {
      let sane = 0, suspicious = 0, total = 0;
      for (const r of ctx.successResults) {
        // output_tokens 计入 thinking token，估算长度也要把 thinking 文本算进去
        const thinkingText = (r.contentBlocks || [])
          .filter(b => b?.type === 'thinking').map(b => b.thinking || '').join('');
        const text = (r.content || '') + thinkingText;
        if (text.length < 10) continue;
        total++;
        const reported = r.outputTokens || 0;
        const estimated = Math.max(1, Math.round(text.length / 4));
        if (reported === 0) { suspicious++; continue; }
        const ratio = reported / estimated;
        // 只把"远低于文本量"（少报 token，疑似伪造计量）算可疑；
        // 偏高可能源于隐藏思考 token、tokenization 差异，不算造假。
        if (ratio >= 0.3) sane++;
        else suspicious++;
      }
      if (!total) return { status: 'skip', detail: '无可检测样本' };
      const rate = sane / total;
      if (rate >= 0.85) return { status: 'pass', detail: `${sane}/${total} 条 output_tokens 与内容长度成比例` };
      if (rate >= 0.5) return { status: 'partial', detail: `${suspicious}/${total} 条 token 计数可疑` };
      return { status: 'fail', detail: `${suspicious}/${total} 条 output_tokens 与内容不匹配，代理可能伪造计量` };
    }
  },
  {
    id: 'l2_hidden_prompt_offset', layer: 'L2', name: '隐藏提示词偏移', weight: 5,
    desc: '比较可见输入估算与服务端 usage.input_tokens/prompt_tokens',
    evaluate(ctx) {
      if (!ctx.cfg.presetEnabled) return { status: 'skip', detail: '未启用预设提示词检测' };
      const s = ctx.presetSummary;
      if (!s || !s.samples) return { status: 'skip', detail: '无预设提示词检测结果' };
      const offset = s.medianHiddenTokens || 0;
      const polluted = s.pollutedOutputs || 0;
      if (offset < 50 && polluted === 0) return { status: 'pass', detail: `中位隐藏偏移 ${offset} token` };
      if (offset < 150 && polluted <= 1) return { status: 'partial', detail: `中位隐藏偏移 ${offset} token，轻微可疑` };
      return { status: 'fail', detail: `中位隐藏偏移 ${offset} token，输出污染 ${polluted} 项` };
    }
  },
  {
    id: 'l2_cache_write', layer: 'L2', name: '缓存写入生效', weight: 3,
    desc: '启用 cache_control 后应有 cache_creation_input_tokens > 0',
    evaluate(ctx) {
      if (!ctx.cfg.cacheEnabled && !ctx.cfg.convEnabled) return { status: 'skip', detail: '未启用缓存测试' };
      // 专门的缓存测试结果在 ctx.cacheResults，必须并入，否则只勾选「缓存」而不勾「对话连续性」时看不到缓存数据
      const all = [...ctx.successResults, ...ctx.convResults, ...(ctx.cacheResults || [])];
      const totalCreate = all.reduce((a, r) => a + (r.cacheCreationTokens || 0), 0);
      const denom = all.reduce((a, r) => a + (r.inputTokens || 0) + (r.cacheCreationTokens || 0) + (r.cacheReadTokens || 0), 0);
      if (denom === 0) return { status: 'skip', detail: '无缓存 token 数据（请求可能失败）' };
      if (totalCreate > 0) return { status: 'pass', detail: `共写入 ${totalCreate} token` };
      return { status: 'fail', detail: '缓存未写入 — 渠道可能不支持' };
    }
  },
  {
    id: 'l2_cache_read', layer: 'L2', name: '缓存读取生效', weight: 4,
    desc: '后续轮应能命中缓存，cache_read_input_tokens > 0',
    evaluate(ctx) {
      if (!ctx.cfg.cacheEnabled && !ctx.cfg.convEnabled) return { status: 'skip', detail: '未启用缓存测试' };
      const all = [...ctx.successResults, ...ctx.convResults, ...(ctx.cacheResults || [])];
      const totalRead = all.reduce((a, r) => a + (r.cacheReadTokens || 0), 0);
      const denom = all.reduce((a, r) => a + (r.inputTokens || 0) + (r.cacheCreationTokens || 0) + (r.cacheReadTokens || 0), 0);
      if (denom === 0) return { status: 'skip', detail: '无缓存 token 数据（请求可能失败）' };
      if (totalRead > 0) return { status: 'pass', detail: `共读取 ${totalRead} token` };
      return { status: 'fail', detail: '缓存从未命中 — 渠道可能不实现缓存复用' };
    }
  },

  // ===== L3 能力支持度 =====
  {
    id: 'l3_prompt_caching', layer: 'L3', name: 'Prompt Caching 真实运作', weight: 8,
    desc: '命中率 ≥ 50% 视为真支持',
    evaluate(ctx) {
      if (!ctx.cfg.cacheEnabled && !ctx.cfg.convEnabled) return { status: 'skip', detail: '未启用缓存测试' };
      const all = [...ctx.successResults, ...ctx.convResults, ...(ctx.cacheResults || [])];
      const totalInput = all.reduce((a, r) => a + (r.inputTokens || 0), 0);
      const totalCreation = all.reduce((a, r) => a + (r.cacheCreationTokens || 0), 0);
      const totalRead = all.reduce((a, r) => a + (r.cacheReadTokens || 0), 0);
      const total = totalInput + totalCreation + totalRead;
      if (total === 0) return { status: 'skip', detail: '无 token 数据' };
      const rate = totalRead / total;
      if (rate >= 0.5) return { status: 'pass', detail: `缓存命中率 ${(rate * 100).toFixed(0)}%` };
      if (rate >= 0.2) return { status: 'partial', detail: `命中率仅 ${(rate * 100).toFixed(0)}%，偏低` };
      return { status: 'fail', detail: `命中率 ${(rate * 100).toFixed(0)}% — 缓存未正常运作` };
    }
  },
  {
    id: 'l3_extended_thinking', layer: 'L3', name: 'Extended Thinking 启用', weight: 8,
    desc: '响应 content 应含 type: "thinking" 块',
    evaluate(ctx) {
      if (!ctx.cfg.thinkingEnabled) return { status: 'skip', detail: '未启用思考链测试' };
      const t = ctx.thinkingResult;
      if (!t || t.skipped) return { status: 'skip', detail: '思考链测试未运行' };
      if (t.error) return { status: 'fail', detail: '请求被拒绝: ' + t.error.message };
      if (t.thinkingBlocks?.length > 0) return { status: 'pass', detail: `${t.thinkingBlocks.length} 个 thinking 块，${t.thinkingTokens} token` };
      // 现代模型可能计了 thinking token 但默认不下发思考文本块（display=omitted）；有 token 即视为思考生效
      if ((t.thinkingTokens || 0) > 0) return { status: 'pass', detail: `思考生效（${t.thinkingTokens} thinking token，文本块未下发）` };
      return { status: 'fail', detail: 'thinking 参数被静默吞掉' };
    }
  },
  {
    id: 'l3_thinking_token_ratio', layer: 'L3', name: 'Thinking token 占比', weight: 5,
    desc: '思维 token / 输出 token 比值，Opus 开启 thinking 后比值通常 > 0.3',
    evaluate(ctx) {
      if (!ctx.cfg.thinkingEnabled) return { status: 'skip', detail: '未启用思考链测试' };
      const t = ctx.thinkingResult;
      if (!t || t.skipped || t.error) return { status: 'skip', detail: '思考链未通过' };
      const thinking = t.thinkingTokens || 0;
      const output = t.outputTokens || 0;
      if (!output) return { status: 'skip', detail: '无输出 token 数据' };
      const ratio = thinking / output;
      const claimed = (ctx.cfg.model || '').toLowerCase();
      const isOpus = /opus/.test(claimed);
      const pct = (ratio * 100).toFixed(0);
      if (ratio >= 0.3) return { status: 'pass', detail: `思维占比 ${pct}%（${thinking}/${output} token）` };
      if (ratio >= 0.1) return { status: 'partial', detail: `思维占比 ${pct}% 偏低${isOpus ? '（Opus 通常较高）' : ''}` };
      // adaptive thinking 会按题目难度自行决定思考量，简单题思维占比低是正常的，不再据此判伪
      return { status: 'partial', detail: `思维占比 ${pct}%${isOpus ? '（adaptive 在简单题上思维量低属正常）' : ''}` };
    }
  },
  {
    id: 'l3_vision', layer: 'L3', name: '视觉能力 (Vision)', weight: 8,
    desc: '上传图片或内置图片测试视觉理解',
    evaluate(ctx) {
      if (!ctx.cfg.multimodalEnabled) return { status: 'skip', detail: '未启用多模态测试' };
      const r = ctx.multimodalResults?.image;
      if (!r) return { status: 'skip', detail: '图片测试未运行' };
      if (r.error) return { status: 'fail', detail: '请求失败: ' + r.error.message };
      const score = r.evalScore || 0;
      if (score >= 0.8) return { status: 'pass', detail: `图片识别 ${(score * 100).toFixed(0)}%` };
      if (score >= 0.4) return { status: 'partial', detail: `图片识别 ${(score * 100).toFixed(0)}%` };
      return { status: 'fail', detail: `图片识别 ${(score * 100).toFixed(0)}%` };
    }
  },
  {
    id: 'l3_pdf', layer: 'L3', name: 'PDF 文档识别', weight: 6,
    desc: '上传 PDF 或内置 PDF 测试文档理解',
    evaluate(ctx) {
      if (!ctx.cfg.multimodalEnabled || !ctx.cfg.pdfTestEnabled) return { status: 'skip', detail: '未启用 PDF 测试' };
      const r = ctx.multimodalResults?.pdf;
      if (!r) return { status: 'skip', detail: 'PDF 测试未运行' };
      if (r.error) return { status: 'fail', detail: '请求失败: ' + r.error.message };
      const score = r.evalScore || 0;
      if (score >= 0.8) return { status: 'pass', detail: `PDF 识别 ${(score * 100).toFixed(0)}%` };
      if (score >= 0.4) return { status: 'partial', detail: `PDF 识别 ${(score * 100).toFixed(0)}%` };
      return { status: 'fail', detail: `PDF 识别 ${(score * 100).toFixed(0)}%` };
    }
  },
  {
    id: 'l3_tool_use', layer: 'L3', name: 'Tool Use 协议', weight: 8,
    desc: '定义工具 + 验证 Anthropic tool_use / OpenAI tool_calls 格式',
    evaluate(ctx) {
      if (!ctx.cfg.paramTestEnabled) return { status: 'skip', detail: '未启用参数透传测试' };
      const r = ctx.paramResults?.toolUse;
      if (!r) return { status: 'skip', detail: 'Tool Use 未运行' };
      if (r.error) return { status: 'fail', detail: '请求失败: ' + r.error.message };
      if (r.paramPassed) return { status: 'pass', detail: `成功返回 get_weather(Tokyo) 工具调用${r.toolSchemaValid === false ? '（但 arguments schema 不合法）' : '，arguments schema 合法'}` };
      if (r.paramPartial) return { status: 'partial', detail: r.toolSchemaValid === false ? '返回了工具调用但 arguments 畸形/不符 schema（量化或降级后端常见）' : '返回了工具调用，但名称或参数不完整' };
      return { status: 'fail', detail: '模型未返回工具调用，可能参数被吞或渠道不支持' };
    }
  },
  {
    id: 'l3_web_search', layer: 'L3', name: 'Web Search 服务端工具', weight: 6,
    desc: '官方 web_search_20250305 服务端联网搜索能否真正触发（强力的官方直连判据）',
    evaluate(ctx) {
      if (!ctx.cfg.paramTestEnabled) return { status: 'skip', detail: '未启用参数透传测试' };
      if (ctx.cfg.format !== 'anthropic') return { status: 'skip', detail: '仅 Anthropic 协议支持' };
      const r = ctx.paramResults?.webSearch;
      if (!r) return { status: 'skip', detail: 'Web Search 未运行' };
      if (r.skipped) return { status: 'skip', detail: r.error?.message || '跳过' };
      if (r.webSearchStatus === 'pass') return { status: 'pass', detail: r.paramDetail };
      if (r.webSearchStatus === 'partial') return { status: 'partial', detail: r.paramDetail };
      return { status: 'fail', detail: r.paramDetail || '后端不支持 web_search 服务端工具' };
    }
  },
  {
    id: 'l3_stop_sequences', layer: 'L3', name: 'stop_sequences 透传', weight: 4,
    desc: '检测 stop_sequences / stop 参数是否被上游执行',
    evaluate(ctx) {
      if (!ctx.cfg.paramTestEnabled) return { status: 'skip', detail: '未启用参数透传测试' };
      const r = ctx.paramResults?.stopSequences;
      if (!r) return { status: 'skip', detail: 'stop_sequences 未运行' };
      if (r.error) return { status: 'fail', detail: '参数被拒绝: ' + r.error.message };
      if (r.paramPassed) return { status: 'pass', detail: '输出在 stop sequence 前停止' };
      if (r.paramPartial) return { status: 'partial', detail: '输出接近预期但 stop 效果不完整' };
      return { status: 'fail', detail: 'stop sequence 被静默吞掉或未生效' };
    }
  },
  {
    id: 'l3_output_format', layer: 'L3', name: 'output_config.format 透传', weight: 4,
    desc: '检测结构化输出参数是否被接受并约束 JSON',
    evaluate(ctx) {
      if (!ctx.cfg.paramTestEnabled || !ctx.cfg.outputFormatTestEnabled) return { status: 'skip', detail: '未启用 output_config.format 测试' };
      const r = ctx.paramResults?.outputFormat;
      if (!r) return { status: 'skip', detail: 'output_config.format 未运行' };
      if (r.error) return { status: 'fail', detail: '参数被拒绝: ' + r.error.message };
      if (r.paramPassed) return { status: 'pass', detail: '返回 JSON 且符合 schema' };
      if (r.paramPartial) return { status: 'partial', detail: '返回 JSON 但 schema 不完整' };
      return { status: 'fail', detail: '参数被吞或未约束输出' };
    }
  },

  {
    id: 'l3_beta_header', layer: 'L3', name: 'anthropic-beta header 透传', weight: 4,
    desc: '官方 API 接受 anthropic-beta header（如 output-128k）；代理可能剥离或拒绝',
    evaluate(ctx) {
      if (!ctx.cfg.paramTestEnabled || ctx.cfg.format !== 'anthropic') return { status: 'skip', detail: '未启用或非 Anthropic 协议' };
      const r = ctx.paramResults?.betaHeader;
      if (!r) return { status: 'skip', detail: 'beta header 测试未运行' };
      if (r.skipped) return { status: 'skip', detail: r.reason || '跳过' };
      if (r.accepted) return { status: 'pass', detail: `服务端接受 anthropic-beta header (HTTP 200)${r.hasBetaEchoHeader ? '，且回显了 beta header' : ''}` };
      if (r.httpStatus === 400) return { status: 'partial', detail: `服务端返回 400，可能不支持该 beta feature，但 header 被转发了` };
      // 429/500/503/529 等是限流/过载/瞬时错误，与 header 剥离无关，跳过
      if ([429, 500, 502, 503, 529].includes(r.httpStatus)) return { status: 'skip', detail: `瞬时错误 HTTP ${r.httpStatus}，无法判定 beta header 透传` };
      return { status: 'fail', detail: `服务端拒绝（HTTP ${r.httpStatus}），代理可能剥离了 anthropic-beta header` };
    }
  },
  {
    id: 'l3_temp_restriction', layer: 'L3', name: 'Temperature 限制（Opus 独有）', weight: 6,
    desc: 'Opus 4.7+ 拒绝非默认 temperature，若接受则可能是 Sonnet/Haiku',
    evaluate(ctx) {
      if (!ctx.cfg.paramTestEnabled) return { status: 'skip', detail: '未启用参数透传测试' };
      const r = ctx.paramResults?.tempRestriction;
      if (!r) return { status: 'skip', detail: 'Temperature 限制未运行' };
      if (r.skipped) return { status: 'skip', detail: r.reason || '跳过' };
      if (r.tempRejected) return { status: 'pass', detail: r.paramDetail || '服务端拒绝 temperature=0.5 → 符合 Opus 4.7+ 行为' };
      if (r.tempAccepted) return { status: 'fail', detail: r.paramDetail || '声称 Opus 4.7+ 但接受了 temperature=0.5 → 疑似 Sonnet/Haiku 或旧版本' };
      return { status: 'partial', detail: r.paramDetail || '请求未成功，无法判定 temperature 限制' };
    }
  },
  {
    id: 'l3_context_capacity', layer: 'L3', name: '上下文真实上限', weight: 7,
    desc: '阶梯式增大上下文并用 needle 召回，判断真实可接受上下文上限',
    evaluate(ctx) {
      if (!ctx.cfg.capacityEnabled || !ctx.cfg.contextTestEnabled) return { status: 'skip', detail: '未启用上下文强度测试' };
      const c = ctx.capacityResults?.context;
      if (!c) return { status: 'skip', detail: '上下文测试未运行' };
      if (c.error) return { status: 'fail', detail: '测试失败: ' + c.error };
      const k = c.maxRecalled || c.maxAccepted || 0;
      const fmt = (t) => t >= 1e6 ? (t / 1e6) + 'M' : (t / 1000) + 'K';
      if (k >= 200000) return { status: 'pass', detail: `可召回上下文上限 ≈ ${fmt(k)}，符合官方大窗口` };
      if (k >= 64000) return { status: 'partial', detail: `可召回上下文上限 ≈ ${fmt(k)}，低于官方 200K` };
      return { status: 'fail', detail: `上下文上限仅 ≈ ${fmt(Math.max(k, c.maxAccepted))}，疑似受限中转/降级` };
    }
  },
  {
    id: 'l3_context_1m', layer: 'L3', name: '1M 上下文支持', weight: 6,
    desc: '附带 anthropic-beta: context-1m，验证是否真支持百万级上下文',
    evaluate(ctx) {
      if (!ctx.cfg.capacityEnabled || !ctx.cfg.context1mEnabled) return { status: 'skip', detail: '未启用 1M 上下文测试' };
      const c = ctx.capacityResults?.context;
      if (!c || c.error || !c.tested1m) return { status: 'skip', detail: '1M 测试未运行' };
      if (c.supports1m) return { status: 'pass', detail: '1M 档 needle 成功召回，真支持百万上下文' };
      const s1m = (c.steps || []).find(s => s.tokens === 1e6);
      if (s1m?.accepted) return { status: 'partial', detail: '1M 档接受但未召回 needle，疑似静默截断' };
      return { status: 'fail', detail: '1M 档被拒绝，不支持百万上下文' };
    }
  },
  {
    id: 'l3_output_capacity', layer: 'L3', name: '最大输出长度', weight: 5,
    desc: '请求超长输出，检测是否被低位封顶（中转降级常见）',
    evaluate(ctx) {
      if (!ctx.cfg.capacityEnabled || !ctx.cfg.outputTestEnabled) return { status: 'skip', detail: '未启用输出长度测试' };
      const o = ctx.capacityResults?.output;
      if (!o) return { status: 'skip', detail: '输出长度测试未运行' };
      if (o.error) return { status: 'fail', detail: '测试失败: ' + o.error };
      const cappedLow = o.truncated && o.outTokens < o.requestedMax * 0.4 && o.outTokens < 1200;
      if (cappedLow) return { status: 'fail', detail: `输出仅 ${o.outTokens}t 即被截断，疑似低位封顶/降级` };
      if (o.outTokens >= o.requestedMax * 0.6) return { status: 'pass', detail: `产出 ${o.outTokens}t，输出容量正常` };
      return { status: 'partial', detail: `产出 ${o.outTokens}t（finish=${o.finish}）` };
    }
  },

  // ===== L4 行为指纹 =====
  {
    id: 'l4_identity_consistency', layer: 'L4', name: '身份一致性', weight: 6,
    desc: '跨提示词自报身份稳定',
    evaluate(ctx) {
      if (!ctx.report?.consistency) return { status: 'skip', detail: '无一致性数据' };
      const ic = ctx.report.consistency.identityConsistency;
      if (ic >= 0.9) return { status: 'pass', detail: `身份一致性 ${(ic * 100).toFixed(0)}%` };
      if (ic >= 0.6) return { status: 'partial', detail: `身份一致性 ${(ic * 100).toFixed(0)}%，存在分流嫌疑` };
      return { status: 'fail', detail: `身份一致性仅 ${(ic * 100).toFixed(0)}% — 多模型分流` };
    }
  },
  {
    id: 'l4_refusal_style', layer: 'L4', name: '拒答风格签名', weight: 4,
    desc: 'Claude 用 "I apologize" / GPT 用 "I\'m sorry, but"',
    evaluate(ctx) {
      let claudeStyle = 0, gptStyle = 0, total = 0;
      for (const r of ctx.successResults) {
        const c = r.content || '';
        if (/\b(?:I\s+(?:can'?t|cannot)|I\s+apologize)/i.test(c)) { claudeStyle++; total++; }
        else if (/\bI'm\s+sorry,?\s+but\b/i.test(c)) { gptStyle++; total++; }
      }
      if (total === 0) return { status: 'skip', detail: '无拒答样本' };
      const claimedFp = ctx.report?.claimedFp?.id;
      if (claimedFp === 'claude' && claudeStyle >= gptStyle) return { status: 'pass', detail: `Claude 风格拒答 ${claudeStyle}/${total}` };
      if (claimedFp === 'gpt' && gptStyle >= claudeStyle) return { status: 'pass', detail: `GPT 风格拒答 ${gptStyle}/${total}` };
      return { status: 'partial', detail: `拒答风格与声称的模型不完全一致` };
    }
  },
  {
    id: 'l4_no_split', layer: 'L4', name: '无多渠道分流', weight: 6,
    desc: '同一 API 不应表现出多种渠道指纹',
    evaluate(ctx) {
      const channels = ctx.report?.channels || [];
      if (channels.length <= 1) return { status: 'pass', detail: '单一渠道，无分流' };
      const total = channels.reduce((a, c) => a + c.count, 0);
      const secondShare = channels[1] ? channels[1].count / total : 0;
      if (secondShare < 0.1) return { status: 'pass', detail: '主渠道占比 > 90%' };
      if (secondShare < 0.3) return { status: 'partial', detail: '次渠道占比 ' + (secondShare * 100).toFixed(0) + '%' };
      return { status: 'fail', detail: `检测到 ${channels.length} 种渠道分流` };
    }
  },
  {
    id: 'l4_memory', layer: 'L4', name: '上下文记忆能力', weight: 6,
    desc: '多轮对话中能正确回引前轮信息',
    evaluate(ctx) {
      if (!ctx.cfg.convEnabled) return { status: 'skip', detail: '未启用对话测试' };
      const turns = ctx.convResults.filter(r => !r.error && r.convExpects);
      if (!turns.length) return { status: 'skip', detail: '无可检测轮次' };
      let hits = 0;
      for (const r of turns) {
        const expects = Array.isArray(r.convExpects) ? r.convExpects : [r.convExpects];
        const all = expects.every(e => r.content.toLowerCase().includes(String(e).toLowerCase()));
        if (all) hits++;
      }
      const rate = hits / turns.length;
      if (rate >= 0.8) return { status: 'pass', detail: `${hits}/${turns.length} 轮通过记忆测试` };
      if (rate >= 0.5) return { status: 'partial', detail: `${hits}/${turns.length} 轮通过` };
      return { status: 'fail', detail: `${hits}/${turns.length} 轮通过 — 上下文可能被截断` };
    }
  },
  {
    id: 'l4_knowledge_cutoff', layer: 'L4', name: '知识截止时间锚点', weight: 3,
    desc: '模型自述 cutoff 与公开宣称一致',
    evaluate(ctx) {
      const mentions = ctx.report?.cutoffMentions || [];
      if (!mentions.length) return { status: 'skip', detail: '未触发截止时间自述' };
      const claimedFp = ctx.report?.claimedFp;
      if (!claimedFp?.cutoffRange) return { status: 'skip', detail: '无可对比的官方截止时间' };
      const [from, to] = claimedFp.cutoffRange;
      const fromY = parseInt(from.split('-')[0]);
      const toY = parseInt(to.split('-')[0]);
      const years = mentions.map(m => {
        const y = m.text.match(/(20\d{2})/);
        return y ? parseInt(y[1]) : null;
      }).filter(Boolean);
      if (!years.length) return { status: 'skip', detail: '无年份' };
      // 不用 cutoffRange 上界判据（上界随模型迭代过期会误报）。只把"明显早于该模型起点"
      // 或"不可能地超前于当前年"视为冲突；其余视为一致。
      const nowY = new Date().getFullYear();
      const conflict = years.filter(y => y < fromY - 1 || y > nowY + 1);
      const rate = 1 - conflict.length / years.length;
      if (rate >= 0.8) return { status: 'pass', detail: `${years.length - conflict.length}/${years.length} 年份合理（起点 ${from}）` };
      return { status: 'fail', detail: `知识年份与声称模型不符：出现 ${conflict.join(', ')}（应 ≥ ${from} 且不超前于今年）` };
    }
  },

  {
    id: 'l4_multi_model_same_profile', layer: 'L4', name: '多模型对比（降级检测）', weight: 7,
    desc: '当用户选了多个模型（如 Opus+Sonnet），比较各自的 TTFT/TPS 是否有差异。若两个模型延迟一致，疑似同一底座伪装',
    evaluate(ctx) {
      const models = new Map();
      for (const r of ctx.successResults) {
        const m = r.model || '';
        if (!m) continue;
        if (!models.has(m)) models.set(m, { ttfts: [], tps: [] });
        const bucket = models.get(m);
        if (r.ttft > 0) bucket.ttfts.push(r.ttft);
        if (r.tps > 0) bucket.tps.push(r.tps);
      }
      if (models.size < 2) return { status: 'skip', detail: '仅测试了一个模型，需要多模型对比' };
      const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      const profiles = [...models.entries()].map(([m, d]) => ({
        model: m, avgTTFT: avg(d.ttfts), avgTPS: avg(d.tps), samples: Math.min(d.ttfts.length, d.tps.length) || (d.ttfts.length + d.tps.length)
      })).filter(p => (p.avgTTFT > 0 || p.avgTPS > 0));
      if (profiles.length < 2) return { status: 'skip', detail: '样本不足，需要每个模型至少 2 条流式结果' };
      const hasOpus = profiles.find(p => /opus/i.test(p.model));
      const hasSonnet = profiles.find(p => /sonnet/i.test(p.model));
      if (hasOpus && hasSonnet) {
        // 期望比值: Opus TTFT 应明显大于 Sonnet；Sonnet TPS 应明显大于 Opus
        const ratios = [];
        if (hasOpus.avgTTFT > 0 && hasSonnet.avgTTFT > 0) ratios.push(hasOpus.avgTTFT / hasSonnet.avgTTFT);
        if (hasOpus.avgTPS > 0 && hasSonnet.avgTPS > 0) ratios.push(hasSonnet.avgTPS / hasOpus.avgTPS);
        const detail = `Opus TTFT ${(hasOpus.avgTTFT/1000).toFixed(1)}s TPS ${hasOpus.avgTPS.toFixed(0)} / Sonnet TTFT ${(hasSonnet.avgTTFT/1000).toFixed(1)}s TPS ${hasSonnet.avgTPS.toFixed(0)}`;
        // 小样本（每模型 < 4 条）时网络抖动主导，延迟趋同不足以判"同底座"，最多给 partial
        const enough = hasOpus.samples >= 4 && hasSonnet.samples >= 4;
        if (ratios.length) {
          if (ratios.some(x => x >= 1.4)) return { status: 'pass', detail: `延迟差异明显（${detail}），符合不同模型层级` };
          if (ratios.every(x => x < 1.25)) {
            return enough
              ? { status: 'fail', detail: `Opus 和 Sonnet 延迟几乎相同（${detail}，样本充足），疑似同一底座` }
              : { status: 'partial', detail: `Opus/Sonnet 延迟接近（${detail}），但样本少、网络抖动主导，无法判定同底座` };
          }
          return { status: 'partial', detail: `延迟差异不显著（${detail}），无法排除同底座` };
        }
      }
      const summary = profiles.map(p => `${p.model}: TTFT ${(p.avgTTFT/1000).toFixed(1)}s TPS ${p.avgTPS.toFixed(0)}`).join(' / ');
      return { status: 'pass', detail: summary };
    }
  },

  {
    id: 'l4_latency_tier', layer: 'L4', name: '延迟指纹（模型层级）', weight: 8,
    desc: '通过 TTFT 和 TPS 判断实际模型层级是否匹配声称（Opus 明显慢于 Sonnet/Haiku）',
    evaluate(ctx) {
      // 多模型测试时只取声称模型自身的样本，避免跨模型延迟混入
      const claimedModel = ctx.cfg.model || '';
      const pool = ctx.successResults.filter(r => !r.model || !claimedModel || r.model === claimedModel);
      const ttfts = pool.map(r => r.ttft).filter(x => x > 0);
      const tpsValues = pool.map(r => r.tps).filter(x => x > 0);
      if (ttfts.length < 2 && tpsValues.length < 2) return { status: 'skip', detail: '需要流式模式才能采集 TTFT/TPS' };
      const avgTTFT = ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : 0;
      const avgTPS = tpsValues.length ? tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length : 0;
      const claimed = (ctx.cfg.model || '').toLowerCase();
      const isOpus = /opus/.test(claimed);
      const isSonnet = /sonnet/.test(claimed);
      const isHaiku = /haiku/.test(claimed);
      const ttftStr = avgTTFT ? `TTFT ${(avgTTFT / 1000).toFixed(1)}s` : '';
      const tpsStr = avgTPS ? `TPS ${avgTPS.toFixed(0)}` : '';
      const metrics = [ttftStr, tpsStr].filter(Boolean).join(', ');
      if (isOpus) {
        // 延迟是软信号：缓存命中、短输出、就近路由都会让真 Opus 变快。
        // 仅当 TTFT 极快"且"TPS 极高（双重佐证、像 Haiku）才判 fail；单一偏快只给 partial。
        const veryFast = (avgTTFT > 0 && avgTTFT < 400) && (avgTPS > 0 && avgTPS > 100);
        if (veryFast) return { status: 'fail', detail: `声称 Opus 但 ${metrics} — TTFT 极快且 TPS 极高，强烈疑似 Sonnet/Haiku` };
        if ((avgTTFT > 0 && avgTTFT < 800) || (avgTPS > 0 && avgTPS > 80)) {
          return { status: 'partial', detail: `声称 Opus，${metrics} 偏快（也可能缓存命中/短输出/就近路由，非决定性）` };
        }
        if (avgTTFT > 1200 || (avgTPS > 0 && avgTPS < 50)) return { status: 'pass', detail: `延迟符合 Opus 特征: ${metrics}` };
        return { status: 'partial', detail: `延迟在边界范围: ${metrics}` };
      }
      if (isHaiku) {
        if (avgTTFT > 2000 && avgTPS > 0 && avgTPS < 30) return { status: 'partial', detail: `声称 Haiku 但 ${metrics} — 延迟偏高（也可能排队/网络），非决定性` };
        return { status: 'pass', detail: `延迟符合 Haiku 特征: ${metrics}` };
      }
      return { status: 'pass', detail: `延迟指标: ${metrics || '无数据'}` };
    }
  },
  {
    id: 'l4_model_name_swap', layer: 'L4', name: '偷换模型名检测', weight: 8,
    desc: '横向对比：API 返回的 model 字段档位/家族是否与声称一致（不一致=偷换）',
    evaluate(ctx) {
      const mv = ctx.modelVerdicts;
      if (!mv || mv.models.length < 1) return { status: 'skip', detail: '无多模型对比数据' };
      const swapped = mv.models.filter(m => m.verdict === 'name_swap');
      if (swapped.length) return { status: 'fail', detail: `${swapped.length} 个模型被偷换名：${swapped.map(m => `${m.model}→${m.echoMode || '?'}`).join('；')}` };
      const haveEcho = mv.models.filter(m => m.echoMode);
      if (!haveEcho.length) return { status: 'partial', detail: '上游未回显 model 字段，无法核对偷换' };
      return { status: 'pass', detail: `${haveEcho.length} 个模型返回档位均与声称一致` };
    }
  },
  {
    id: 'l4_cross_model_collision', layer: 'L4', name: '跨模型输出碰撞', weight: 8,
    desc: '不同模型对同一问题输出高度雷同 → 疑似同一底座冒充多个模型（掺假）',
    evaluate(ctx) {
      const mv = ctx.modelVerdicts;
      if (!mv || mv.models.length < 2) return { status: 'skip', detail: '需要 ≥2 个模型对比' };
      const colliders = mv.models.filter(m => m.collisionCount >= 2);
      if (colliders.length) return { status: 'fail', detail: `${colliders.map(m => m.model).join('、')} 与其它模型输出高度雷同，疑似同一底座` };
      if (mv.collisions.length) return { status: 'partial', detail: `存在 ${mv.collisions.length} 处单次碰撞（未达 ≥2 阈值，可能巧合）` };
      return { status: 'pass', detail: '各模型输出有区分度，无同底座碰撞' };
    }
  },
  {
    id: 'l4_adulteration_summary', layer: 'L4', name: '横向对比掺假汇总', weight: 6,
    desc: '综合偷换名/碰撞/指纹/延迟，判定本批模型整体是否掺假',
    evaluate(ctx) {
      const mv = ctx.modelVerdicts;
      if (!mv || mv.models.length < 2) return { status: 'skip', detail: '需要 ≥2 个模型对比' };
      const s = mv.summary;
      const bad = s.name_swap + s.adulterated;
      if (bad > 0) return { status: 'fail', detail: `${s.total} 个模型中 ${bad} 个掺假/偷换（偷换 ${s.name_swap}·掺假 ${s.adulterated}·可疑 ${s.suspicious}）` };
      if (s.suspicious > 0) return { status: 'partial', detail: `${s.suspicious} 个模型可疑（软信号），其余真实` };
      return { status: 'pass', detail: `${s.total} 个模型横向对比均未发现掺假/偷换` };
    }
  },

  // ===== L5 密码学验证 =====
  {
    id: 'l5_thinking_signature', layer: 'L5', name: 'Thinking signature 字段存在', weight: 10,
    desc: '思考块应带 signature 字段',
    evaluate(ctx) {
      if (!ctx.cfg.thinkingEnabled) return { status: 'skip', detail: '未启用思考链测试' };
      const t = ctx.thinkingResult;
      if (!t || t.skipped || t.error) return { status: 'skip', detail: '思考链未通过' };
      const blocks = t.thinkingBlocks || [];
      if (!blocks.length) return { status: 'fail', detail: '无 thinking 块' };
      const withSig = blocks.filter(b => b.signature).length;
      if (withSig === blocks.length) return { status: 'pass', detail: `${withSig}/${blocks.length} 个 thinking 块带 signature（加密级真伪标志）` };
      if (withSig > 0) return { status: 'partial', detail: `仅 ${withSig}/${blocks.length} 个块带 signature` };
      // 流式下 signature 经 signature_delta 单独下发，偶有未随块同步采集到的情况，降为 partial 而非判伪
      if (ctx.cfg.stream) return { status: 'partial', detail: '流式下未采集到 signature（可能为 SSE 同步问题），建议关流式复测' };
      return { status: 'fail', detail: 'thinking 块缺 signature — 上游不是官方实现' };
    }
  },
  {
    id: 'l5_thinking_display', layer: 'L5', name: 'thinking.display 控制', weight: 5,
    desc: '对比 thinking.display 开关是否影响 thinking block 展示',
    evaluate(ctx) {
      if (!ctx.cfg.thinkingDisplayTestEnabled) return { status: 'skip', detail: '未启用 thinking.display 测试' };
      const r = ctx.paramResults?.thinkingDisplay;
      if (!r) return { status: 'skip', detail: 'thinking.display 未运行' };
      if (r.error) return { status: 'fail', detail: '参数被拒绝: ' + r.error.message };
      if (r.paramPassed) return { status: 'pass', detail: 'display 开关影响 thinking 展示' };
      if (r.paramPartial) return { status: 'partial', detail: '有 thinking 计量但展示控制不稳定' };
      return { status: 'fail', detail: 'display 参数被吞或无效' };
    }
  },
  {
    id: 'l5_signature_replay', layer: 'L5', name: 'Signature 多轮回传可被服务端接受', weight: 10,
    desc: '把带 signature 的 thinking 块在下一轮回传，看服务端是否接受',
    evaluate(ctx) {
      if (!ctx.cfg.thinkingEnabled || ctx.cfg.format !== 'anthropic') return { status: 'skip', detail: '未启用 Anthropic thinking 测试' };
      const t = ctx.thinkingResult;
      if (!t || t.skipped || t.error) return { status: 'skip', detail: '前置 thinking 未通过' };
      const signed = (t.thinkingBlocks || []).filter(b => b.signature && b.thinking).length;
      if (!signed) return { status: 'skip', detail: '无可回传 signature block' };
      const r = ctx.signatureReplayResult;
      if (!r) return { status: 'skip', detail: 'Signature replay 未运行' };
      if (r.skipped) return { status: 'skip', detail: r.error?.message || 'Signature replay 跳过' };
      if (r.error) return { status: 'fail', detail: '回传被拒绝: ' + r.error.message };
      if (r.answerCorrect) return { status: 'pass', detail: '服务端接受 signed thinking 回传且答案连续' };
      return { status: 'partial', detail: '服务端接受回传，但后续答案未命中预期' };
    }
  },

  // ===== L6 对抗性探针 =====
  {
    id: 'l6_self_identify', layer: 'L6', name: '自我识别准确', weight: 6,
    desc: '"Are you Claude or GPT?" 直接二选一应能稳定回答',
    evaluate(ctx) {
      const probes = ctx.successResults.filter(r =>
        r.promptId === 'p_claude_gpt'
        || /claude[\s\S]{0,120}(?:gpt|chatgpt)|(?:gpt|chatgpt)[\s\S]{0,120}claude/i.test(r.promptBody || '')
      );
      if (!probes.length) return { status: 'skip', detail: '未运行 Claude vs GPT 二选一探针' };
      const claimedFp = ctx.report?.claimedFp;
      if (!claimedFp) return { status: 'skip', detail: '未设置声称模型' };
      if (!['claude', 'gpt'].includes(claimedFp.id)) {
        return { status: 'skip', detail: 'Claude vs GPT 二选一探针不适用于当前声称模型' };
      }
      let correct = 0;
      for (const r of probes) {
        const c = (r.content || '').toLowerCase();
        const bothOrNeither = /\bboth\b|\bneither\b|两者都是|都不是/.test(c);
        const claimsClaude = /claude|anthropic/.test(c);
        const claimsGpt = /(?:gpt|chatgpt|openai)/.test(c);
        if (claimedFp.id === 'claude' && claimsClaude && !bothOrNeither) correct++;
        else if (claimedFp.id === 'gpt' && claimsGpt && !bothOrNeither) correct++;
      }
      const rate = correct / probes.length;
      if (rate >= 0.8) return { status: 'pass', detail: `${correct}/${probes.length} 次正确自我识别` };
      if (rate >= 0.5) return { status: 'partial', detail: `${correct}/${probes.length} 次正确` };
      return { status: 'fail', detail: '自我识别与声称模型不符' };
    }
  },
  {
    id: 'l6_reasoning_answer', layer: 'L6', name: '推理题答案正确', weight: 4,
    desc: '火车相遇题等多步推理应能算对',
    evaluate(ctx) {
      if (!ctx.cfg.thinkingEnabled) return { status: 'skip', detail: '未启用思考链测试' };
      const t = ctx.thinkingResult;
      if (!t || t.skipped || t.error) return { status: 'skip', detail: '推理测试未运行' };
      if (t.answerCorrect) return { status: 'pass', detail: '答案匹配期望值 (10:30)' };
      return { status: 'fail', detail: '答案错误或未匹配预期' };
    }
  },
  {
    id: 'l6_trap_probe', layer: 'L6', name: 'TRAP 对抗探针', weight: 8,
    desc: '用身份强制、伪 system/developer、泄露、编码绕过和 TRAP 后缀检查抗污染能力',
    evaluate(ctx) {
      if (!ctx.cfg.adversarialEnabled) return { status: 'skip', detail: '未启用对抗性探针' };
      const s = ctx.adversarialSummary;
      if (!s || !s.total) return { status: 'skip', detail: '对抗性探针未运行' };
      const pct = (s.score * 100).toFixed(0);
      const detail = `${s.pass}/${s.total} 通过，${s.partial} 部分，${s.fail} 失败，总分 ${pct}%`;
      if (s.score >= 0.85) return { status: 'pass', detail };
      if (s.score >= 0.5) return { status: 'partial', detail };
      return { status: 'fail', detail };
    }
  },
  {
    id: 'l6_temp0_determinism', layer: 'L6', name: 'temperature=0 重复确定性（弱信号）', weight: 2,
    desc: '弱信号：相同 prompt 多次响应的相似度。注意——研究证明同权重模型在生产 batch-variance 下贪婪解码也会发散（一致率可 <5%），故发散≠换模型，仅作参考',
    evaluate(ctx) {
      if (ctx.cfg.temperature !== 0) {
        return { status: 'skip', detail: '未以 temperature=0 运行，不能评价 temperature=0 确定性' };
      }
      if (!ctx.report?.consistency) return { status: 'skip', detail: '无一致性数据' };
      const sim = ctx.report.consistency.avgSameSim;
      if (sim === null) return { status: 'skip', detail: '无同模型同输入的重复样本' };
      // 弱信号：发散不再判 fail（生产端 batch-variance 也会致贪婪解码发散），仅 pass/partial
      if (sim >= 0.5) return { status: 'pass', detail: `相似度 ${(sim * 100).toFixed(0)}%（高度一致）` };
      if (sim >= 0.2) return { status: 'partial', detail: `相似度 ${(sim * 100).toFixed(0)}% — 弱信号：可能是后端 batch-variance（非决定性），也可能分流，需结合其它判据` };
      return { status: 'partial', detail: `相似度仅 ${(sim * 100).toFixed(0)}% — 发散较大但不单独定罪（生产端贪婪解码亦可发散）；建议看 seed/system_fingerprint 与分布检验` };
    }
  },
  {
    id: 'l1_tokenizer_family', layer: 'L1', name: '分词器家族指纹', weight: 6,
    desc: '用计费 token 数反推后端分词器家族；声称 Claude 却命中 GPT/SentencePiece 即换后端铁证',
    evaluate(ctx) {
      if (!ctx.cfg.advancedEnabled || !ctx.cfg.tokenizerEnabled) return { status: 'skip', detail: '未启用分词器指纹' };
      const t = ctx.advancedResults?.tokenizer;
      if (!t) return { status: 'skip', detail: '分词器探针未运行' };
      if (t.error) return { status: 'skip', detail: t.error };
      const claimClaude = /claude/i.test(ctx.cfg.model || '');
      if (claimClaude && /SentencePiece|cl100k/.test(t.family)) {
        return { status: 'fail', detail: `声称 Claude 但分词器=${t.family}（${t.note}）→ 后端非 Claude` };
      }
      if (claimClaude && /o200k/.test(t.family)) {
        return { status: 'partial', detail: `分词器=${t.family}：与 Claude 不可证伪也不可证实（Claude/GPT-4o 计费相近，看 glitch/分布佐证）` };
      }
      return { status: 'pass', detail: `分词器家族=${t.family}（${t.note}），与声称一致或无矛盾` };
    }
  },
  {
    id: 'l6_glitch_token', layer: 'L6', name: '欠训练(glitch) token 指纹', weight: 4,
    desc: '发已知 GPT/tiktoken glitch token，复现复读失败=GPT 系后端（软信号）',
    evaluate(ctx) {
      if (!ctx.cfg.advancedEnabled || !ctx.cfg.tokenizerEnabled) return { status: 'skip', detail: '未启用' };
      const g = ctx.advancedResults?.glitch;
      if (!g || g.error) return { status: 'skip', detail: g?.error || 'glitch 探针未运行' };
      const claimClaude = /claude/i.test(ctx.cfg.model || '');
      // glitch 为软信号：即便全部复读失败也只给 partial（现代模型复制能力差异大），不单独定罪
      if (g.suspectGPT) {
        return { status: 'partial', detail: `控制串可复读但 ${g.glitchFails}/${g.glitchTotal} 个 GPT glitch 串全部复读失败 → 复现 GPT/tiktoken 特有行为（软信号${claimClaude ? '，与声称 Claude 矛盾，建议结合分词器/分布判据' : ''}）` };
      }
      return { status: 'pass', detail: `未见 GPT-glitch 复读失败（glitch 失败 ${g.glitchFails}/${g.glitchTotal}，控制失败 ${g.controlFails}）` };
    }
  },
  {
    id: 'l1_system_fingerprint', layer: 'L1', name: 'system_fingerprint + seed（OpenAI）', weight: 4,
    desc: 'OpenAI 协议：固定 seed 下 system_fingerprint 应存在且稳定、输出应一致；中转换后端常缺失/发散',
    evaluate(ctx) {
      if (!ctx.cfg.advancedEnabled) return { status: 'skip', detail: '未启用进阶指纹' };
      if (ctx.cfg.format === 'anthropic') return { status: 'skip', detail: 'Anthropic 协议无 system_fingerprint' };
      const f = ctx.advancedResults?.fingerprint;
      if (!f || f.error) return { status: 'skip', detail: f?.error || '未运行' };
      if (f.hasFingerprint && f.fpStable && f.seedConsistent) return { status: 'pass', detail: `system_fingerprint 稳定 + seed 一致（相似 ${(f.seedSim * 100).toFixed(0)}%）` };
      if (!f.hasFingerprint) return { status: 'partial', detail: 'system_fingerprint 缺失（中转常剥离；并非所有 OpenAI 兼容端点都返回）' };
      if (!f.fpStable) return { status: 'fail', detail: 'system_fingerprint 在固定 seed 下抖动 → 后端配置不稳定/分流' };
      if (!f.seedConsistent) return { status: 'fail', detail: `固定 seed 但输出发散（相似 ${(f.seedSim * 100).toFixed(0)}%）→ 端点忽略 seed/分流` };
      return { status: 'partial', detail: '部分一致' };
    }
  },
  {
    id: 'l4_distribution_mmd', layer: 'L4', name: '输出分布检验 (MMD)', weight: 7,
    desc: '对固定问题各采多条，与可信参考端点做 MMD 置换检验，统计显著差异=量化/微调/换模型',
    evaluate(ctx) {
      if (!ctx.cfg.advancedEnabled || !ctx.cfg.distributionEnabled) return { status: 'skip', detail: '未启用分布检验' };
      const d = ctx.advancedResults?.distribution;
      if (!d || d.error) return { status: 'skip', detail: d?.error || '未运行' };
      if (d.mode === 'reference') {
        if (typeof d.different !== 'boolean') return { status: 'skip', detail: '分布检验结果异常' };
        return d.different === true
          ? { status: 'fail', detail: `与参考端点分布显著不同（MMD²=${d.observedMMD}, p=${d.pValue}）→ 疑似量化/微调/换模型` }
          : { status: 'pass', detail: `与参考端点分布无显著差异（p=${d.pValue}）` };
      }
      return { status: 'partial', detail: `仅自一致性（无参考端点）：自 MMD²=${d.selfMMD}。设可信参考端点可升级为换模型检验` };
    }
  }
];

const ScorecardEngine = {
  /**
   * @param {Object} ctx 评分上下文
   *   ctx.allResults      所有 result（含失败）
   *   ctx.successResults  成功 result
   *   ctx.convResults     对话连续性测试结果
   *   ctx.thinkingResult  思考链测试结果
   *   ctx.report          Analyzer.analyze 的报告
   *   ctx.cfg             用户配置
   */
  score(ctx) {
    const checks = SCORECARD_CHECKS.map(c => {
      let r;
      try { r = c.evaluate(ctx); } catch (e) { r = { status: 'skip', detail: '评估异常: ' + e.message }; }
      return {
        id: c.id, layer: c.layer, name: c.name, desc: c.desc, weight: c.weight,
        status: r.status, detail: r.detail
      };
    });

    // 总分计算
    let scoreSum = 0, weightSum = 0;
    const layerStats = {};
    for (const c of checks) {
      const l = c.layer;
      if (!layerStats[l]) layerStats[l] = { pass: 0, partial: 0, fail: 0, skip: 0, total: 0, weightSum: 0, scoreSum: 0 };
      layerStats[l].total++;
      if (c.status === 'skip') { layerStats[l].skip++; continue; }
      let s = 0;
      if (c.status === 'pass') s = 1;
      else if (c.status === 'partial') s = 0.5;
      else if (c.status === 'fail') s = 0;
      layerStats[l][c.status]++;
      layerStats[l].weightSum += c.weight;
      layerStats[l].scoreSum += s * c.weight;
      scoreSum += s * c.weight;
      weightSum += c.weight;
    }

    const totalScore = weightSum > 0 ? Math.round(scoreSum / weightSum * 100) : 0;
    let grade, gradeColor;
    if (totalScore >= 95) { grade = '完美匹配'; gradeColor = '#4ade80'; }
    else if (totalScore >= 80) { grade = '高度可信'; gradeColor = '#5b8def'; }
    else if (totalScore >= 60) { grade = '部分可信'; gradeColor = '#fbbf24'; }
    else if (totalScore >= 40) { grade = '可疑'; gradeColor = '#fb923c'; }
    else { grade = '强烈疑似伪造'; gradeColor = '#f87171'; }

    // 按层归总
    const layers = Object.keys(SCORECARD_LAYERS).map(id => {
      const stats = layerStats[id] || { pass: 0, partial: 0, fail: 0, skip: 0, total: 0, weightSum: 0, scoreSum: 0 };
      const applied = stats.total - stats.skip;
      const score = stats.weightSum > 0 ? Math.round(stats.scoreSum / stats.weightSum * 100) : null;
      let status;
      if (applied === 0) status = 'skip';
      else if (stats.fail === 0 && stats.partial === 0) status = 'pass';
      else if (stats.fail === 0) status = 'partial';
      else status = stats.pass > stats.fail ? 'partial' : 'fail';
      return { id, ...SCORECARD_LAYERS[id], ...stats, applied, score, status };
    });

    return {
      totalScore,
      grade,
      gradeColor,
      checks,
      layers,
      reportId: this._genReportId(),
      generatedAt: new Date().toISOString()
    };
  },

  _genReportId() {
    // 形如 806852a2-a305-41a2-85e0-cee0876c4bc5
    const r = () => Math.random().toString(16).slice(2).padEnd(12, '0');
    return [r().slice(0, 8), r().slice(0, 4), r().slice(0, 4), r().slice(0, 4), r().slice(0, 12)].join('-');
  }
};
