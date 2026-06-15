/**
 * 分析引擎
 *
 * 输入: 一组测试结果 [{ promptId, promptTag, content, latency, tokens, error, ... }]
 * 输出: 完整的分析报告
 *
 * 评分思路：
 *  1. 身份证据 identity: 命中模型自述正则 (强)
 *  2. 标记词命中 markers: 命中模型相关关键词 (中)
 *  3. 厂商命中 vendorMarkers: 命中开发商 (中)
 *  4. 风格签名 STYLE_SIGNATURES: 命中风格特征 (弱-中)
 *  5. 模型自述与用户声称是否一致
 *  6. 多轮一致性
 *  7. 拒答比例（拒绝身份问题异常高 = 可疑）
 */

const Analyzer = {

  /**
   * 主入口
   * @param {Object} ctx
   * @param {Array} ctx.results 全部成功结果
   * @param {Array} ctx.errors  失败结果
   * @param {string} ctx.claimedModel 用户声称的模型名
   * @returns {Object} 分析报告
   */
  analyze(ctx) {
    const successResults = ctx.results.filter(r => !r.error);
    const errorResults = ctx.errors || ctx.results.filter(r => r.error);
    const claimedModel = (ctx.claimedModel || '').trim();
    const claimedFp = matchClaimedModel(claimedModel);

    // 1. 计算每个模型指纹的得分
    const fpScores = this._scoreAllFingerprints(successResults);

    // 2. 提取关键词热度
    const keywords = this._extractKeywords(successResults);

    // 3. 一致性指标
    const consistency = this._analyzeConsistency(successResults);

    // 4. 拒答分析
    const refusalAnalysis = this._analyzeRefusals(successResults);

    // 5. 知识截止时间提取
    const cutoffMentions = this._extractCutoffMentions(successResults);

    // 6. 性能指标（perf 为全量展示用；perfClaimed 仅含声称模型自身样本，供 verdict 判延迟，
    //    多模型测试时避免 Sonnet 的快速样本污染 Opus 的延迟判定）
    const perf = this._performanceMetrics(successResults, errorResults);
    const claimedOnly = successResults.filter(r => !r.model || !claimedModel || r.model === claimedModel);
    const perfClaimed = claimedOnly.length === successResults.length
      ? perf : this._performanceMetrics(claimedOnly, []);

    // 7. 渠道判定（如可用）
    let channelInfo = null;
    if (typeof ChannelDetector !== 'undefined') {
      const channels = ChannelDetector.aggregate(ctx.results);
      const perResp = ctx.results.map(r => {
        if (r.error || !r.response) return null;
        return ChannelDetector.summarize(r);
      });
      channelInfo = { aggregated: channels, perResponse: perResp };
    }

    // 8. 最终判定
    const verdict = this._verdict({
      claimedFp,
      claimedModel,
      fpScores,
      consistency,
      refusalAnalysis,
      cutoffMentions,
      sampleSize: successResults.length,
      channelInfo,
      thinkingResult: ctx.thinkingResult,
      signatureReplayResult: ctx.signatureReplayResult,
      perf: perfClaimed,
      // 用户故意一次测多个模型时，跨模型的身份/渠道差异是预期的，不应据此判"分流"
      multiModel: (ctx.modelsCount || 1) > 1
    });

    return {
      claimedModel,
      claimedFp,
      fpScores,
      keywords,
      consistency,
      refusalAnalysis,
      cutoffMentions,
      perf,
      channelInfo,
      verdict
    };
  },

  /**
   * 对每个指纹打分（0~100）
   */
  _scoreAllFingerprints(results) {
    if (!results.length) return [];

    const scores = MODEL_FINGERPRINTS.map(fp => {
      let identityHits = 0;
      let markerHits = 0;
      let vendorHits = 0;
      let styleHits = 0;
      const hitDetails = [];

      for (const r of results) {
        const content = r.content || '';

        // identity 正则（强证据）
        for (const re of fp.identity) {
          if (re.test(content)) {
            identityHits++;
            hitDetails.push({ type: 'identity', sample: this._snippet(content, re) });
          }
        }

        // markers 关键词（弱证据）
        for (const m of fp.markers) {
          if (this._containsKeyword(content, m)) {
            markerHits++;
          }
        }

        // vendor 关键词
        for (const v of fp.vendorMarkers) {
          if (this._containsKeyword(content, v)) {
            vendorHits++;
          }
        }
      }

      // 风格签名
      for (const sig of STYLE_SIGNATURES) {
        if (sig.fpId !== fp.id) continue;
        for (const r of results) {
          if (sig.pattern.test(r.content || '')) {
            styleHits += sig.weight;
            hitDetails.push({ type: 'style', sample: sig.label });
          }
        }
      }

      // 综合得分（0~100）
      // identity: 每命中一次 +25
      // marker: 每命中 +3
      // vendor: 每命中 +5
      // style: 加权累加 * 15
      let raw =
        identityHits * 25 +
        markerHits * 3 +
        vendorHits * 5 +
        styleHits * 15;

      // 按样本量归一（避免长测试结果优势过大）
      // 同时压缩极值
      const sampleNorm = Math.min(1, results.length / 6);
      const score = Math.min(100, Math.round(raw / Math.max(1, sampleNorm * 1.2)));

      return {
        id: fp.id,
        name: fp.name,
        vendor: fp.vendor,
        score,
        identityHits,
        markerHits,
        vendorHits,
        styleHits: +styleHits.toFixed(2),
        hitDetails: hitDetails.slice(0, 5)
      };
    });

    scores.sort((a, b) => b.score - a.score);
    return scores;
  },

  /**
   * 跨语言友好的关键词包含判断
   * 对纯中文/混合内容用 indexOf，对纯英文加单词边界
   */
  _containsKeyword(content, keyword) {
    if (!content || !keyword) return false;
    const hasCJK = /[一-龥]/.test(keyword);
    if (hasCJK) {
      return content.includes(keyword);
    }
    // 英文：忽略大小写 + 单词边界
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\b' + escaped + '\\b', 'i');
    return re.test(content);
  },

  _snippet(content, regex) {
    const m = content.match(regex);
    if (!m) return '';
    const idx = m.index || 0;
    const start = Math.max(0, idx - 20);
    const end = Math.min(content.length, idx + (m[0].length) + 30);
    return (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
  },

  /**
   * 关键词热度统计
   */
  _extractKeywords(results) {
    const counter = new Map();
    const allKeywords = new Set();
    for (const fp of MODEL_FINGERPRINTS) {
      for (const m of fp.markers) allKeywords.add(m);
      for (const v of fp.vendorMarkers) allKeywords.add(v);
    }

    for (const r of results) {
      const c = r.content || '';
      for (const k of allKeywords) {
        if (this._containsKeyword(c, k)) {
          counter.set(k, (counter.get(k) || 0) + 1);
        }
      }
    }

    return [...counter.entries()]
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25);
  },

  /**
   * 一致性分析
   *  - 同一提示词下，回答的相似度（jaccard）
   *  - 不同提示词，自报家门是否一致
   */
  _analyzeConsistency(results) {
    // 按「同模型 + 同 promptId + 同实际用户输入」分组。
    // 旧逻辑只按 promptId 分组，会把多模型结果、followup 轮次也混在一起，
    // 导致“同提示词相似度”被严重低估。
    const groups = new Map();
    for (const r of results) {
      const key = [r.model || '', r.promptId || '', r.promptBody || ''].join('::');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    // 同 prompt 内相似度
    const sameSimilarities = [];
    for (const [pid, list] of groups) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          sameSimilarities.push(this._jaccard(list[i].content, list[j].content));
        }
      }
    }

    const avgSameSim = sameSimilarities.length
      ? sameSimilarities.reduce((a, b) => a + b, 0) / sameSimilarities.length
      : null;

    // 跨 prompt 是否报同一身份
    const identityPerPrompt = new Map(); // promptId -> top fp id
    for (const [pid, list] of groups) {
      const fpScores = this._scoreAllFingerprints(list);
      identityPerPrompt.set(pid, fpScores[0] && fpScores[0].score > 0 ? fpScores[0].id : null);
    }

    const identityVotes = new Map();
    for (const v of identityPerPrompt.values()) {
      if (!v) continue;
      identityVotes.set(v, (identityVotes.get(v) || 0) + 1);
    }

    const totalVotes = [...identityVotes.values()].reduce((a, b) => a + b, 0) || 1;
    const topVote = [...identityVotes.entries()].sort((a, b) => b[1] - a[1])[0];
    const identityConsistency = topVote ? topVote[1] / totalVotes : 0;

    return {
      avgSameSim,                 // 0~1，同提示词下回答相似度
      sameSimilaritySamples: sameSimilarities.length,
      identityConsistency,        // 0~1，跨提示词自报身份的一致性
      identityVotes: [...identityVotes.entries()].map(([id, count]) => ({
        id,
        count,
        name: MODEL_FINGERPRINTS.find(f => f.id === id)?.name || id
      }))
    };
  },

  /**
   * Jaccard 文本相似度（基于 trigram）
   */
  _jaccard(a, b) {
    const sa = this._trigrams(a);
    const sb = this._trigrams(b);
    if (sa.size === 0 && sb.size === 0) return 1;
    let inter = 0;
    for (const t of sa) if (sb.has(t)) inter++;
    const uni = sa.size + sb.size - inter;
    return uni === 0 ? 0 : inter / uni;
  },

  _trigrams(s) {
    const set = new Set();
    const text = (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    for (let i = 0; i < text.length - 2; i++) {
      set.add(text.slice(i, i + 3));
    }
    return set;
  },

  /**
   * 拒答分析
   */
  _analyzeRefusals(results) {
    const patterns = [
      /\bI\s+(?:can'?t|cannot|won'?t|am\s+unable\s+to)\b/i,
      /\bI(?:'|\s+a)m\s+(?:not\s+able|sorry|afraid)\b/i,
      /\bI\s+don'?t\s+(?:have|know|share|disclose|reveal)\b/i,
      /\bI(?:'|\s+a)m\s+not\s+at\s+liberty\b/i,
      /(?:抱歉|对不起|不好意思).*?(?:不能|无法|不便|无法回答|不便透露)/,
      /(?:作为(?:一个)?(?:AI|人工智能))?.*?(?:不能|无法|无权)(?:透露|回答|提供|分享|说明)/,
      /我(?:无法|不能|不便|不方便|没有权限)(?:透露|回答|提供|分享|说明|告诉你)/
    ];

    let refusals = 0;
    let identityRefusals = 0;
    const identityTags = ['identity', 'language', 'foundation', 'origin'];

    for (const r of results) {
      const c = r.content || '';
      const isRefusal = patterns.some(p => p.test(c));
      if (isRefusal) {
        refusals++;
        if (identityTags.includes(r.promptTag)) identityRefusals++;
      }
    }

    const identityProbes = results.filter(r => identityTags.includes(r.promptTag)).length;

    return {
      total: results.length,
      refusals,
      refusalRate: results.length ? refusals / results.length : 0,
      identityProbes,
      identityRefusals,
      identityRefusalRate: identityProbes ? identityRefusals / identityProbes : 0
    };
  },

  /**
   * 截止时间提取
   */
  _extractCutoffMentions(results) {
    const mentions = [];
    const patterns = [
      // 英文: October 2023, Oct 2023, 2023-10
      /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s,]+(\d{4})\b/g,
      // YYYY-MM 或 YYYY/MM
      /\b(20\d{2})[-\/.](\d{1,2})\b/g,
      // 中文: 2023年10月 / 2023年
      /(20\d{2})\s*年\s*(\d{1,2})?\s*月?/g
    ];

    for (const r of results) {
      const c = r.content || '';
      for (const re of patterns) {
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(c)) !== null) {
          const text = m[0];
          // 只关注关于训练截止 / 知识截止的提及
          const context = c.slice(Math.max(0, m.index - 80), Math.min(c.length, m.index + text.length + 30));
          if (/cutoff|knowledge|trained|training|data|更新|截止|知识|训练|数据/i.test(context)) {
            mentions.push({ text, context: context.trim(), promptId: r.promptId });
          }
        }
      }
    }
    return mentions.slice(0, 8);
  },

  /**
   * 性能指标
   */
  _performanceMetrics(success, errors) {
    const latencies = success.map(r => r.latency).filter(x => x > 0).sort((a, b) => a - b);
    const tokens = success.map(r => r.outputTokens || 0);
    const totalTokens = tokens.reduce((a, b) => a + b, 0);
    const totalLatency = latencies.reduce((a, b) => a + b, 0);

    const p = (arr, q) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : 0;
    const avgLat = latencies.length ? totalLatency / latencies.length : 0;

    const ttfts = success.map(r => r.ttft).filter(x => x > 0).sort((a, b) => a - b);
    const tpsValues = success.map(r => r.tps).filter(x => x > 0).sort((a, b) => a - b);
    const avgTTFT = ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : 0;
    const avgTPS = tpsValues.length ? +(tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length).toFixed(1) : 0;

    return {
      success: success.length,
      failed: errors.length,
      total: success.length + errors.length,
      avgLatency: Math.round(avgLat),
      p50: Math.round(p(latencies, 0.5)),
      p95: Math.round(p(latencies, 0.95)),
      min: latencies[0] || 0,
      max: latencies[latencies.length - 1] || 0,
      totalTokens,
      avgTokensPerSec: totalLatency ? +((totalTokens / (totalLatency / 1000)).toFixed(2)) : 0,
      requestsPerSec: totalLatency ? +(success.length / (totalLatency / 1000)).toFixed(2) : 0,
      avgTTFT,
      p50TTFT: Math.round(p(ttfts, 0.5)),
      avgTPS,
      p50TPS: +(p(tpsValues, 0.5)).toFixed(1),
      ttftSamples: ttfts.length,
      tpsSamples: tpsValues.length
    };
  },

  /**
   * 最终判定
   * 输出:
   *  - level: real | suspicious | fake | unknown
   *  - confidence: 0~1
   *  - title: 一句话结论
   *  - reasons: 详细依据列表
   *  - detectedModel: 最可能的实际模型 (fpId | null)
   */
  _verdict({ claimedFp, claimedModel, fpScores, consistency, refusalAnalysis, cutoffMentions, sampleSize, channelInfo, thinkingResult, signatureReplayResult, perf, multiModel }) {
    const reasons = [];
    let level = 'unknown';
    let confidence = 0;
    let detectedModel = null;

    if (!sampleSize) {
      return {
        level: 'unknown',
        confidence: 0,
        title: '无可用样本',
        reasons: [{ type: 'warn', title: '无成功响应', detail: '所有请求均失败，无法进行分析' }],
        detectedModel: null
      };
    }

    const topFp = fpScores[0];
    const secondFp = fpScores[1];

    // 检测到的最可能模型
    if (topFp && topFp.score >= 30) {
      detectedModel = topFp;
    }

    // 1. 没有任何身份证据
    if (!topFp || topFp.score < 15) {
      reasons.push({
        type: 'warn',
        title: '未发现强身份证据',
        detail: '响应中未出现任何模型/厂商的自述关键词或风格签名。可能模型被强制定制 persona，或样本太少。'
      });
      level = 'unknown';
      confidence = 0.2;
    }

    // 2. 用户声称 vs 实际 命中
    if (claimedFp && topFp) {
      if (topFp.id === claimedFp.id && topFp.score >= 30) {
        reasons.push({
          type: 'pos',
          title: `自报身份与声称一致：${topFp.name}`,
          detail: `身份命中 ${topFp.identityHits} 次，标记词 ${topFp.markerHits} 次，厂商词 ${topFp.vendorHits} 次。`
        });
        level = 'real';
        confidence = Math.min(0.95, 0.4 + topFp.score / 200 + topFp.identityHits * 0.1);
      } else if (topFp.id !== claimedFp.id && topFp.score >= 30) {
        // 实际模型与声称模型不一致 - 关键的"伪"信号
        reasons.push({
          type: 'neg',
          title: `自报身份与声称不一致`,
          detail: `声称 "${claimedModel}" (${claimedFp.name})，但响应中强烈匹配 ${topFp.name} (${topFp.vendor})。`
        });
        level = 'fake';
        confidence = Math.min(0.95, 0.5 + topFp.score / 200 + topFp.identityHits * 0.08);
        detectedModel = topFp;
      } else if (topFp.id !== claimedFp.id && topFp.score >= 15) {
        reasons.push({
          type: 'warn',
          title: `可疑：实际匹配 ${topFp.name}`,
          detail: `用户声称 ${claimedFp.name}，实际响应弱命中 ${topFp.name}（${topFp.score} 分），证据不够充分但已构成可疑。`
        });
        level = 'suspicious';
        confidence = 0.55;
      } else if (topFp.id === claimedFp.id && topFp.score >= 15) {
        reasons.push({
          type: 'pos',
          title: `弱证据支持声称的 ${claimedFp.name}`,
          detail: `匹配分 ${topFp.score}，识别证据较弱，建议增加测试轮次。`
        });
        level = 'suspicious';
        confidence = 0.45;
      }
    } else if (!claimedFp && topFp && topFp.score >= 30) {
      reasons.push({
        type: 'warn',
        title: `用户声称的模型 "${claimedModel}" 未在指纹库中`,
        detail: `但响应强烈匹配 ${topFp.name}，请人工核对。`
      });
      level = 'suspicious';
      confidence = 0.5;
      detectedModel = topFp;
    }

    // 3. 一致性
    if (consistency.identityConsistency !== null) {
      if (consistency.identityConsistency >= 0.8 && [...consistency.identityVotes].length > 1) {
        reasons.push({
          type: 'pos',
          title: `跨提示词身份一致性高 (${(consistency.identityConsistency * 100).toFixed(0)}%)`,
          detail: '大多数响应指向同一模型家族，说明背后是稳定的同一模型。'
        });
        confidence = Math.min(0.95, confidence + 0.05);
      } else if (!multiModel && consistency.identityVotes.length >= 2 && consistency.identityConsistency < 0.75) {
        // 仅在单模型测试时，身份信号分裂才算"分流"嫌疑；多模型测试本就会出现多种身份
        reasons.push({
          type: 'neg',
          title: '不同提示词指向不同模型',
          detail: `存在 ${consistency.identityVotes.length} 种身份信号: ${consistency.identityVotes.map(v => `${v.name}(${v.count})`).join(', ')}，疑似 API 在多个模型之间分流，或被注入了混淆 persona。`
        });
        level = level === 'real' ? 'suspicious' : (level === 'unknown' ? 'suspicious' : level);
        confidence = Math.max(confidence, 0.55);
      }
    }

    // 4. 拒答率
    if (refusalAnalysis.identityProbes >= 2 && refusalAnalysis.identityRefusalRate >= 0.6) {
      reasons.push({
        type: 'warn',
        title: `身份探测拒答率过高 (${(refusalAnalysis.identityRefusalRate * 100).toFixed(0)}%)`,
        detail: '模型可能被注入了"不要透露身份"的系统提示，掩盖真实底座。无法可靠判定。'
      });
      if (level === 'unknown') level = 'suspicious';
      confidence = Math.max(confidence, 0.4);
    }

    // 5. 截止时间冲突
    // 注意：不再用 cutoffRange 的"上界"判据 —— 上界会随模型迭代过期，导致真模型自述近期年份被误判。
    // 只把"明显早于该模型应有的起点"或"不可能地超前于当前年"视为冲突，与厂商无关。
    if (cutoffMentions.length && claimedFp && claimedFp.cutoffRange) {
      const [from] = claimedFp.cutoffRange;
      const fromY = parseInt(from.split('-')[0]);
      const nowY = new Date().getFullYear();
      const yearsFound = cutoffMentions.map(m => {
        const yMatch = m.text.match(/(20\d{2})/);
        return yMatch ? parseInt(yMatch[1]) : null;
      }).filter(Boolean);
      const out = yearsFound.filter(y => y < fromY - 1 || y > nowY + 1);
      if (yearsFound.length && out.length / yearsFound.length > 0.5) {
        reasons.push({
          type: 'neg',
          title: '知识截止时间与声称模型不符',
          detail: `${claimedFp.name} 训练数据起点约 ${from}，但模型自述的知识年份为 ${yearsFound.join(', ')}，存在明显矛盾。`
        });
        level = level === 'real' ? 'suspicious' : level;
        confidence = Math.max(confidence, 0.55);
      }
    }

    // 6. 第二名分数接近第一名 - 信号不清晰
    if (topFp && secondFp && topFp.score > 0 && (secondFp.score / topFp.score) > 0.7 && topFp.score < 50) {
      reasons.push({
        type: 'warn',
        title: '候选模型分数接近',
        detail: `${topFp.name} (${topFp.score}) 与 ${secondFp.name} (${secondFp.score}) 分数接近，判定置信度有限。`
      });
      confidence = Math.min(confidence, 0.6);
    }

    // 7. 样本量提示
    if (sampleSize < 5) {
      reasons.push({
        type: 'warn',
        title: '样本量偏少',
        detail: `仅 ${sampleSize} 个有效响应，建议提高轮次或并发以提升判定可靠性。`
      });
      confidence = Math.min(confidence, 0.7);
    }

    // 8. 渠道相关观察
    if (channelInfo && channelInfo.aggregated && channelInfo.aggregated.length) {
      const ch = channelInfo.aggregated;
      const total = ch.reduce((a, c) => a + c.count, 0);
      const top = ch[0];

      // 渠道明确 & 高分
      if (top.avgScore >= 50) {
        const officialLikes = ['anthropic_official', 'claude_code_cli', 'aws_bedrock', 'vertex_ai'];
        if (officialLikes.includes(top.id)) {
          reasons.push({
            type: 'pos',
            title: `API 渠道：${top.name}（高置信）`,
            detail: `批次中 ${top.count}/${total} 条响应符合该渠道指纹特征（均分 ${top.avgScore}），来自该官方/云厂商通道。`
          });
        } else if (top.id === 'claude_ai_reverse') {
          reasons.push({
            type: 'neg',
            title: `API 渠道：${top.name}（Claude.ai 逆向）`,
            detail: '后端疑似抓取 Claude.ai 网页端 sessionKey 转发。Claude 真实但来源为非授权 Web 通道，存在被封禁/数据风险。'
          });
          confidence = Math.max(confidence, 0.6);
        } else if (top.id === 'openrouter' || top.id === 'aihubmix' || top.id === 'deepinfra') {
          reasons.push({
            type: 'warn',
            title: `API 渠道：${top.name}（第三方聚合）`,
            detail: `请求经过第三方聚合平台 ${top.name}，模型字段可由平台改写，建议结合自报身份对照确认。`
          });
        } else if (top.id === 'aggregator_proxy') {
          reasons.push({
            type: 'warn',
            title: 'API 渠道：未知聚合代理',
            detail: '响应体 ID、model、usage 或 schema 特征指向通用反代（one-api / new-api 等），上游不可知。模型声称的真实性需结合身份探测加权判断。'
          });
          confidence = Math.max(confidence, 0.5);
        }
      }

      // 多渠道分流（强可疑信号）—— 仅单模型测试时成立；多模型测试本就可能出现不同渠道特征
      if (!multiModel && ch.length >= 2 && ch[1].count >= Math.max(2, total * 0.2)) {
        reasons.push({
          type: 'neg',
          title: `检测到多渠道分流：${ch.length} 种`,
          detail: `同一 URL 在不同请求中表现出 ${ch.map(c => `${c.short}×${c.count}`).join(' / ')} 的混合特征，疑似负载均衡或多源代理拼接。`
        });
        level = level === 'real' ? 'suspicious' : (level === 'unknown' ? 'suspicious' : level);
        confidence = Math.max(confidence, 0.6);
      } else if (multiModel && ch.length >= 2 && ch[1].count >= Math.max(2, total * 0.2)) {
        reasons.push({
          type: 'warn',
          title: `多模型测试中出现 ${ch.length} 种渠道特征`,
          detail: `因本次测试了多个模型，渠道特征差异可能源于模型差异而非分流，仅供参考：${ch.map(c => `${c.short}×${c.count}`).join(' / ')}。`
        });
      }

      // 极低分 + 是 Claude → 渠道未知
      if (top.avgScore < 20 && fpScores[0]?.id === 'claude' && fpScores[0].score >= 30) {
        reasons.push({
          type: 'warn',
          title: 'API 渠道：无法识别',
          detail: '响应内容符合 Claude，但 Body / ID / URL 缺少任何已知供应链特征，可能是定制代理或新型托管平台。'
        });
      }
    }

    // 9. 密码学验证（最强信号）
    if (signatureReplayResult && !signatureReplayResult.skipped) {
      if (signatureReplayResult.replayAccepted && signatureReplayResult.answerCorrect) {
        reasons.push({
          type: 'pos',
          title: 'Thinking Signature 密码学验证通过',
          detail: '服务端接受了 signed thinking block 回传且答案连续正确 — 这是数学级别的官方证明。'
        });
        if (level === 'unknown' || level === 'suspicious') level = 'real';
        confidence = Math.max(confidence, 0.92);
      } else if (signatureReplayResult.replayAccepted) {
        reasons.push({
          type: 'pos',
          title: 'Thinking Signature 回传被接受',
          detail: '服务端接受了 signed thinking block，但后续答案未完全匹配预期。'
        });
        confidence = Math.max(confidence, 0.8);
      } else if (signatureReplayResult.error) {
        reasons.push({
          type: 'warn',
          title: 'Thinking Signature 回传被拒绝',
          detail: '服务端拒绝了 signed thinking block: ' + (signatureReplayResult.error.message || '').slice(0, 100)
        });
      }
    } else if (thinkingResult && !thinkingResult.skipped && !thinkingResult.error) {
      const blocks = thinkingResult.thinkingBlocks || [];
      const hasSig = blocks.some(b => b.signature);
      if (hasSig) {
        reasons.push({
          type: 'pos',
          title: 'Thinking 块携带 signature 字段',
          detail: `${blocks.filter(b => b.signature).length} 个 thinking 块带有加密签名，说明走的是官方实现。`
        });
        confidence = Math.max(confidence, 0.75);
      } else if (blocks.length > 0) {
        reasons.push({
          type: 'warn',
          title: 'Thinking 块缺少 signature',
          detail: '返回了 thinking 块但无加密签名，上游可能不是 Anthropic 官方。'
        });
      }
    }

    // 10. 延迟异常（模型降级检测）—— 延迟受缓存命中、短输出、就近路由、网络抖动影响极大，
    //     是软信号。仅当 TTFT 极快"且"TPS 极高（双重佐证、像 Haiku）且样本≥3 时才降级 real→suspicious；
    //     单一偏快只作为提示，不动结论。
    if (perf && claimedFp) {
      const claimed = (claimedModel || '').toLowerCase();
      const isOpus = /opus/.test(claimed);
      const veryFast = isOpus && perf.avgTTFT > 0 && perf.avgTTFT < 400
        && perf.avgTPS > 100 && perf.ttftSamples >= 3 && perf.tpsSamples >= 3;
      if (veryFast) {
        reasons.push({
          type: 'neg',
          title: `延迟异常：声称 Opus 但 TTFT ${(perf.avgTTFT / 1000).toFixed(1)}s + TPS ${perf.avgTPS.toFixed(0)}`,
          detail: `首 Token 极快且吞吐极高（${perf.ttftSamples} 样本），明显快于 Opus 典型表现，疑似 Sonnet/Haiku 冒充。`
        });
        if (level === 'real') level = 'suspicious';
        confidence = Math.max(confidence, 0.6);
      } else if (isOpus && ((perf.avgTTFT > 0 && perf.avgTTFT < 800) || perf.avgTPS > 80) && perf.ttftSamples >= 2) {
        reasons.push({
          type: 'warn',
          title: '延迟偏快（非决定性）',
          detail: `声称 Opus，实测 TTFT ${(perf.avgTTFT / 1000).toFixed(1)}s / TPS ${perf.avgTPS}。可能源于缓存命中、短输出或就近路由，不单独作为降级依据。`
        });
      }
    }

    // Title
    let title;
    switch (level) {
      case 'real':
        title = `✅ 真实：声称的 ${claimedFp?.name || claimedModel} 与响应特征一致`;
        break;
      case 'fake':
        title = `❌ 伪造：API 声称 ${claimedModel}，实际底座疑似 ${detectedModel?.name || '其他模型'}`;
        break;
      case 'suspicious':
        title = `⚠️ 可疑：证据不足或存在矛盾，无法确认真实性`;
        break;
      default:
        title = `❓ 未知：无足够身份信号可供判定`;
    }

    return {
      level,
      confidence: +confidence.toFixed(2),
      title,
      reasons,
      detectedModel
    };
  }
};
