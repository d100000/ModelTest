/**
 * 模型指纹数据库
 * 每一项代表一个模型/模型家族的识别特征。
 *
 * 字段说明:
 *  - id:        唯一 ID
 *  - name:      展示名
 *  - vendor:    厂商
 *  - aliases:   该模型在 API model 字段中常见的命名前缀（用于匹配用户声称的模型）
 *  - identity:  正则数组，命中视为强身份证据（权重高）
 *  - markers:   关键字数组（弱证据，权重低）
 *  - vendorMarkers: 厂商关键字
 *  - cutoffRange: 模型公开的训练截止时间范围 [开始 YYYY-MM, 结束 YYYY-MM]
 *
 * 注意:
 *  - 中文正则不要使用 \b（CJK 字符没有 ASCII 边界），改用文本上下文锚定
 *  - 英文正则用 \b 防止误命中
 */
const MODEL_FINGERPRINTS = [
  {
    id: 'claude',
    name: 'Claude',
    vendor: 'Anthropic',
    aliases: ['claude'],
    identity: [
      /\bI(?:'|\s+a)m\s+Claude\b/i,
      /\bI\s+am\s+Claude\b/i,
      /\bClaude\s+(?:by|made\s+by|from|created\s+by)\s+Anthropic\b/i,
      // 注：曾有 /Anthropic's?\s+(assistant|model|Claude)/ 作为强身份证据，但它会命中第三人称
      // 谈论 Anthropic 的文本（连非 Claude 模型介绍 AI 行业时都可能命中）→ 误判为 Claude，已移除。
      /我是\s*Claude/i,
      /我叫\s*Claude/i
    ],
    markers: ['Claude', 'Anthropic', 'Constitutional AI', 'claude-3', 'claude-sonnet', 'claude-opus', 'claude-haiku'],
    vendorMarkers: ['Anthropic'],
    cutoffRange: ['2023-08', '2026-05']
  },
  {
    id: 'gpt',
    name: 'GPT / ChatGPT',
    vendor: 'OpenAI',
    aliases: ['gpt-', 'chatgpt', 'o1', 'o3', 'o4'],
    identity: [
      /\bI(?:'|\s+a)m\s+(?:ChatGPT|GPT-?\d)/i,
      /\bI\s+am\s+a?\s*language\s+model\s+(?:developed|created|trained|made)\s+by\s+OpenAI/i,
      /\b(?:made|developed|created|trained)\s+by\s+OpenAI\b/i,
      /\bGPT-?\d(?:\.\d)?(?:[\s-]?(?:turbo|o|mini|preview))?\b/i,
      /我是\s*(?:ChatGPT|GPT)/i,
      /我是\s*OpenAI/i,
      /\bAs\s+an\s+AI\s+language\s+model(?:,\s+I)?\b/i
    ],
    markers: ['ChatGPT', 'OpenAI', 'GPT-4', 'GPT-3', 'GPT-4o', 'GPT-4.1', 'GPT-5', 'o3-mini', 'o4-mini', 'language model'],
    vendorMarkers: ['OpenAI'],
    cutoffRange: ['2021-09', '2025-06']
  },
  {
    id: 'gemini',
    name: 'Gemini / Bard',
    vendor: 'Google',
    aliases: ['gemini', 'bard', 'palm'],
    identity: [
      /\bI(?:'|\s+a)m\s+(?:Gemini|Bard)\b/i,
      /\b(?:Gemini|Bard),?\s+(?:a\s+)?(?:large\s+)?(?:language|AI)\s+model\s+(?:from|by|developed\s+by|made\s+by)\s+Google\b/i,
      /\b(?:Google\s+)?(?:AI|DeepMind)['s]*\s+(?:Gemini|Bard)\b/i,
      /我是\s*(?:Gemini|Bard|谷歌)/i
    ],
    markers: ['Gemini', 'Bard', 'Google', 'DeepMind', 'PaLM', 'gemini-pro', 'gemini-ultra', 'gemini-1.5', 'gemini-2', 'gemini-2.5'],
    vendorMarkers: ['Google', 'DeepMind'],
    cutoffRange: ['2023-02', '2026-01']
  },
  {
    id: 'qwen',
    name: '通义千问 (Qwen)',
    vendor: '阿里巴巴',
    aliases: ['qwen', 'tongyi', 'qwq'],
    identity: [
      /\bI(?:'|\s+a)m\s+Qwen\b/i,
      /\bI\s+am\s+(?:Qwen|Tongyi(?:\s+Qianwen)?)\b/i,
      /\bQwen\s*(?:made\s+by|developed\s+by|created\s+by|from)\s*Alibaba/i,
      /我是\s*(?:通义千问|Qwen)/i,
      /我叫\s*(?:通义千问|Qwen)/i,
      /我是\s*阿里(?:云|巴巴)(?:开发|训练|推出)/i,
      /(?:通义千问|Qwen)\s*(?:是|，是)?\s*(?:由)?\s*阿里(?:云|巴巴)/,
      /阿里(?:云|巴巴)(?:集团)?(?:旗下|开发|训练|推出)的?(?:超?大规模)?(?:语言|AI|大)?模型/
    ],
    markers: ['通义千问', 'Qwen', '阿里云', '阿里巴巴', 'Alibaba', 'Tongyi', 'qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen2', 'qwen3', 'QwQ'],
    vendorMarkers: ['阿里', 'Alibaba', '通义'],
    cutoffRange: ['2023-01', '2025-06']
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: '深度求索',
    aliases: ['deepseek'],
    identity: [
      /\bI(?:'|\s+a)m\s+DeepSeek\b/i,
      /\bI\s+am\s+DeepSeek\b/i,
      /\bDeepSeek\s*(?:made\s+by|developed\s+by|created\s+by|by)\s*(?:DeepSeek|深度求索)/i,
      /我是\s*(?:深度求索|DeepSeek)/i,
      /我叫\s*DeepSeek/i,
      /(?:DeepSeek|深度求索)(?:公司)?(?:开发|训练|推出)/
    ],
    markers: ['DeepSeek', '深度求索', 'deepseek-chat', 'deepseek-coder', 'deepseek-r1', 'deepseek-v2', 'deepseek-v3'],
    vendorMarkers: ['深度求索', 'DeepSeek'],
    cutoffRange: ['2023-06', '2025-06']
  },
  {
    id: 'glm',
    name: '智谱清言 (ChatGLM)',
    vendor: '智谱AI',
    aliases: ['glm', 'chatglm', 'zhipu'],
    identity: [
      /\bI(?:'|\s+a)m\s+(?:ChatGLM|GLM)\b/i,
      /\b(?:ChatGLM|GLM)\s*(?:made\s+by|developed\s+by|by)\s*(?:Zhipu|Tsinghua)/i,
      /我是\s*(?:ChatGLM|GLM|智谱(?:清言|AI)?)/i,
      /我叫\s*(?:智谱清言|ChatGLM)/i,
      /(?:智谱(?:AI|清言)?|清华|Zhipu|Tsinghua)(?:大学)?(?:开发|训练|推出)/
    ],
    markers: ['智谱清言', 'ChatGLM', 'GLM-4', '智谱AI', 'Zhipu', '清华', 'Tsinghua', 'glm-4'],
    vendorMarkers: ['智谱', 'Zhipu', '清华'],
    cutoffRange: ['2023-01', '2025-01']
  },
  {
    id: 'kimi',
    name: 'Kimi',
    vendor: '月之暗面',
    aliases: ['kimi', 'moonshot'],
    identity: [
      /\bI(?:'|\s+a)m\s+Kimi\b/i,
      /\bKimi\s*(?:made\s+by|developed\s+by|by)\s*Moonshot/i,
      /我是\s*(?:月之暗面|Kimi)/i,
      /我叫\s*Kimi/i,
      /(?:月之暗面|Moonshot)(?:AI)?(?:开发|训练|推出)/
    ],
    markers: ['Kimi', 'Moonshot', '月之暗面', 'moonshot-v1'],
    vendorMarkers: ['月之暗面', 'Moonshot'],
    cutoffRange: ['2023-10', '2024-10']
  },
  {
    id: 'doubao',
    name: '豆包 (Doubao)',
    vendor: '字节跳动',
    aliases: ['doubao', 'skylark', 'byte', 'volc'],
    identity: [
      /\bI(?:'|\s+a)m\s+Doubao\b/i,
      /\bDoubao\s*(?:made\s+by|developed\s+by|by)\s*ByteDance/i,
      /我是\s*(?:豆包|Doubao)/i,
      /我叫\s*豆包/i,
      /(?:字节跳动|ByteDance|火山引擎)(?:开发|训练|推出)/
    ],
    markers: ['豆包', 'Doubao', '字节跳动', 'ByteDance', '云雀', 'Skylark', '火山引擎', 'volcengine'],
    vendorMarkers: ['字节', 'ByteDance', '火山'],
    cutoffRange: ['2023-06', '2025-01']
  },
  {
    id: 'ernie',
    name: '文心一言 (ERNIE)',
    vendor: '百度',
    aliases: ['ernie', 'wenxin', 'baidu'],
    identity: [
      /\bI(?:'|\s+a)m\s+ERNIE\b/i,
      /\bERNIE\s*(?:made\s+by|developed\s+by|by)\s*Baidu/i,
      /我是\s*(?:文心(?:一言)?|ERNIE)/i,
      /我叫\s*文心一言/i,
      /(?:百度|Baidu)(?:公司)?(?:开发|训练|推出)/
    ],
    markers: ['文心一言', '文心', 'ERNIE', '百度', 'Baidu', 'ernie-4', 'ernie-bot'],
    vendorMarkers: ['百度', 'Baidu'],
    cutoffRange: ['2023-01', '2024-12']
  },
  {
    id: 'yi',
    name: 'Yi (零一万物)',
    vendor: '零一万物',
    aliases: ['yi-', 'lingyi'],
    identity: [
      /\bI(?:'|\s+a)m\s+Yi\b/i,
      /\bYi(?:-\w+)?\s*(?:made\s+by|developed\s+by|by)\s*(?:01\.AI|零一万物)/i,
      /我是\s*(?:Yi|零一万物)/i,
      /(?:零一万物|01\.AI)(?:开发|训练|推出)/
    ],
    markers: ['Yi-34B', 'Yi-Large', '零一万物', '01.AI', 'Yi-Lightning'],
    vendorMarkers: ['零一万物', '01.AI'],
    cutoffRange: ['2023-01', '2024-06']
  },
  {
    id: 'llama',
    name: 'Llama',
    vendor: 'Meta',
    aliases: ['llama', 'meta'],
    identity: [
      /\bI(?:'|\s+a)m\s+(?:Llama|LLaMA)\b/i,
      /\b(?:Llama|LLaMA)\s*(?:by|made\s+by|developed\s+by|from)\s*Meta\b/i,
      /\bMeta\s+AI['s]*\s+(?:Llama|LLaMA)\b/i,
      /我是\s*(?:Llama|LLaMA)/i
    ],
    markers: ['Llama', 'LLaMA', 'Meta AI', 'llama-3', 'llama3', 'llama-2'],
    vendorMarkers: ['Meta'],
    cutoffRange: ['2022-09', '2024-12']
  },
  {
    id: 'mistral',
    name: 'Mistral / Mixtral',
    vendor: 'Mistral AI',
    aliases: ['mistral', 'mixtral'],
    identity: [
      /\bI(?:'|\s+a)m\s+(?:Mistral|Mixtral)\b/i,
      /\b(?:Mistral|Mixtral),?\s*(?:by|made\s+by|developed\s+by|from)\s*Mistral(?:\s+AI)?\b/i,
      /我是\s*(?:Mistral|Mixtral)/i
    ],
    markers: ['Mistral', 'Mixtral', 'Mistral AI', 'mistral-large', 'mistral-small'],
    vendorMarkers: ['Mistral'],
    cutoffRange: ['2023-01', '2024-12']
  },
  {
    id: 'hunyuan',
    name: '混元 (Hunyuan)',
    vendor: '腾讯',
    aliases: ['hunyuan', 'tencent'],
    identity: [
      /\bI(?:'|\s+a)m\s+Hunyuan\b/i,
      /\bHunyuan\s*(?:by|made\s+by|developed\s+by)\s*Tencent/i,
      /我是\s*(?:混元|Hunyuan)/i,
      /(?:腾讯|Tencent)(?:公司)?(?:开发|训练|推出)/
    ],
    markers: ['混元', 'Hunyuan', '腾讯', 'Tencent'],
    vendorMarkers: ['腾讯', 'Tencent'],
    cutoffRange: ['2023-06', '2024-12']
  },
  {
    id: 'spark',
    name: '星火 (Spark)',
    vendor: '科大讯飞',
    aliases: ['spark', 'iflytek', 'xinghuo'],
    identity: [
      /\bI(?:'|\s+a)m\s+(?:Spark|Xinghuo)\b/i,
      /\bSpark\s*(?:by|made\s+by|developed\s+by)\s*iFlytek/i,
      /我是\s*(?:讯飞星火|星火|Spark)/i,
      /(?:讯飞|iFlytek|科大讯飞)(?:公司)?(?:开发|训练|推出)/
    ],
    markers: ['星火', 'Spark', '讯飞', 'iFlytek', '科大讯飞'],
    vendorMarkers: ['讯飞', 'iFlytek'],
    cutoffRange: ['2023-01', '2024-12']
  }
];

/**
 * 风格签名 - 用于次级判断
 * 某些固定短语强烈暗示某种底座
 */
const STYLE_SIGNATURES = [
  { fpId: 'gpt', pattern: /\bAs\s+an\s+AI\s+language\s+model\b/i, weight: 0.4, label: 'GPT-3.5/4 标志性开头' },
  { fpId: 'gpt', pattern: /\bI(?:'|\s+a)m\s+unable\s+to\s+provide\b/i, weight: 0.15, label: 'GPT 风格拒绝' },
  { fpId: 'claude', pattern: /\bI\s+(?:should|need\s+to|want\s+to)\s+(?:note|mention|clarify)\b/i, weight: 0.15, label: 'Claude 风格谨慎说明' },
  { fpId: 'gemini', pattern: /\bI(?:'|\s+a)m\s+a\s+large\s+language\s+model,\s+trained\s+by\s+Google\b/i, weight: 0.5, label: 'Gemini 标志性自述' }
];

/**
 * 把用户声称的 model 字段匹配到 fingerprint
 */
function matchClaimedModel(modelName) {
  if (!modelName) return null;
  const lower = modelName.toLowerCase();
  for (const fp of MODEL_FINGERPRINTS) {
    for (const alias of fp.aliases) {
      if (lower.includes(alias.toLowerCase())) return fp;
    }
  }
  return null;
}
