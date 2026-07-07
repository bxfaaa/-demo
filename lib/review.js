import sharp from 'sharp';

export const styleLabels = {
  kaishu: '楷书',
  xingshu: '行书',
  lishu: '隶书',
  zhuanshu: '篆书',
  caoshu: '草书',
  hard_pen: '硬笔书法'
};

const annotationColors = {
  praise: '#22C55E',
  issue: '#EF4444',
  suggestion: '#3B82F6',
  warning: '#F59E0B'
};

export function getModelStatus() {
  const model = getGeminiModels()[0];
  return {
    provider: hasGeminiApiKey() ? 'gemini' : 'mock',
    model: hasGeminiApiKey() ? model : 'local-mock',
    fallback_models: hasGeminiApiKey() ? getGeminiModels().slice(1) : [],
    gemini_configured: hasGeminiApiKey()
  };
}

export async function reviewImage({ imageBuffer, mimeType, styleLabel }) {
  const analysis = await analyzeWithGeminiOrMock(imageBuffer, mimeType, styleLabel);
  const normalizedReview = normalizeReview(analysis.review, styleLabel);
  const annotatedBuffer = await createAnnotatedImageBuffer(imageBuffer, normalizedReview.annotations);

  return {
    analysis,
    normalizedReview,
    annotatedImageDataUrl: `data:image/png;base64,${annotatedBuffer.toString('base64')}`
  };
}

async function analyzeWithGeminiOrMock(imageBuffer, mimeType, styleLabel) {
  if (!hasGeminiApiKey()) {
    return {
      source: 'mock',
      model: 'local-mock',
      review: createMockReview(styleLabel)
    };
  }

  const imageData = imageBuffer.toString('base64');
  const prompt = buildPrompt(styleLabel);
  const requestBody = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: imageData } }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.25,
      responseMimeType: 'application/json',
      responseSchema: reviewSchema()
    }
  });

  const errors = [];
  for (const model of getGeminiModels()) {
    try {
      return await requestGeminiReview({ model, requestBody });
    } catch (error) {
      errors.push(`${model}: ${error.message}`);
      if (!isRetryableGeminiError(error)) {
        break;
      }
    }
  }

  throw new Error(`GEMINI_REQUEST_FAILED: ${errors.join(' | ')}`);
}

async function requestGeminiReview({ model, requestBody }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY.trim())}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: requestBody
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || response.statusText);
  }

  const text = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || '')
    .join('')
    .trim();

  if (!text) {
    throw new Error('EMPTY_GEMINI_RESPONSE');
  }

  return {
    source: 'gemini',
    model,
    review: JSON.parse(stripJsonFence(text))
  };
}

function getGeminiModels() {
  const configured = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-2.5-flash,gemini-2.5-flash-lite')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);

  return [...new Set([configured, ...fallbacks])];
}

function isRetryableGeminiError(error) {
  const message = String(error.message || '').toLowerCase();
  return [
    'high demand',
    'temporarily unavailable',
    'unavailable',
    'overloaded',
    'quota',
    'rate limit',
    '429',
    '503',
    '504',
    'fetch failed',
    'network'
  ].some((keyword) => message.includes(keyword));
}

export function hasGeminiApiKey() {
  const key = process.env.GEMINI_API_KEY?.trim();
  return Boolean(key) && !/^(your_|你的|replace_me|test)/i.test(key);
}

export function getPublicErrorMessage(error) {
  const message = String(error.message || '');
  if (message.includes('API key not valid')) return 'Gemini API Key 无效，请检查 GEMINI_API_KEY';
  if (message.includes('models/') && message.includes('not found')) return '当前 GEMINI_MODEL 不可用，请换成账号可用的 Gemini 模型';
  if (message.includes('fetch failed')) return '无法连接 Gemini API，请检查网络或代理';
  if (message.includes('EMPTY_GEMINI_RESPONSE')) return 'Gemini 没有返回可解析内容，请换一张更清晰的图片再试';
  if (message.includes('GEMINI_REQUEST_FAILED')) return message.replace('GEMINI_REQUEST_FAILED: ', '');
  return '请稍后重试，或换一张更清晰的图片';
}

function buildPrompt(styleLabel) {
  return `你是一名专业的书法作业 AI 点评老师，主要服务 50 岁以上的中老年书法学习用户。用户会上传一张自己的书法作业图片，并选择自己正在学习的书法类型。请你根据图片内容和用户选择的书法类型，对作业进行点评，并返回可用于前端在图片上绘制标注的数据。

用户选择的书法类型是：${styleLabel}

请完成：识别主要文字；判断整体书写情况；从笔画、结构、章法、墨色、书体特征点评；找出 3-6 个最值得标注的点评点；每个点评点定位到具体区域；bbox 使用 0-1 归一化坐标；语言温和、鼓励、具体，适合中老年用户理解；如果图片模糊或遮挡，也给出可识别范围内点评并提示重新上传更清晰图片；不要编造无法判断的内容。

标注类型：praise 写得好的地方；issue 存在问题；suggestion 重点修改建议；warning 图片质量或识别风险。

请严格输出 JSON，不要输出 JSON 以外的内容。`;
}

function reviewSchema() {
  return {
    type: 'OBJECT',
    properties: {
      image_quality: {
        type: 'OBJECT',
        properties: {
          is_clear: { type: 'BOOLEAN' },
          quality_level: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          issues: { type: 'ARRAY', items: { type: 'STRING' } }
        },
        required: ['is_clear', 'quality_level', 'issues']
      },
      calligraphy_info: {
        type: 'OBJECT',
        properties: {
          selected_style: { type: 'STRING' },
          recognized_text: { type: 'STRING' },
          estimated_level: { type: 'STRING' },
          overall_score: { type: 'NUMBER' }
        },
        required: ['selected_style', 'recognized_text', 'estimated_level', 'overall_score']
      },
      overall_comment: {
        type: 'OBJECT',
        properties: {
          summary: { type: 'STRING' },
          strengths: { type: 'ARRAY', items: { type: 'STRING' } },
          main_problems: { type: 'ARRAY', items: { type: 'STRING' } },
          next_focus: { type: 'ARRAY', items: { type: 'STRING' } }
        },
        required: ['summary', 'strengths', 'main_problems', 'next_focus']
      },
      annotations: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            id: { type: 'STRING' },
            type: { type: 'STRING', enum: ['praise', 'issue', 'suggestion', 'warning'] },
            target_text: { type: 'STRING' },
            bbox: {
              type: 'OBJECT',
              properties: {
                x: { type: 'NUMBER' },
                y: { type: 'NUMBER' },
                width: { type: 'NUMBER' },
                height: { type: 'NUMBER' }
              },
              required: ['x', 'y', 'width', 'height']
            },
            title: { type: 'STRING' },
            comment: { type: 'STRING' },
            suggestion: { type: 'STRING' },
            severity: { type: 'STRING', enum: ['low', 'medium', 'high'] },
            display_style: { type: 'STRING' }
          },
          required: ['id', 'type', 'target_text', 'bbox', 'title', 'comment', 'suggestion', 'severity', 'display_style']
        }
      },
      practice_advice: {
        type: 'OBJECT',
        properties: {
          today_focus: { type: 'STRING' },
          practice_method: { type: 'STRING' },
          estimated_practice_time: { type: 'STRING' }
        },
        required: ['today_focus', 'practice_method', 'estimated_practice_time']
      },
      user_friendly_feedback: { type: 'STRING' }
    },
    required: ['image_quality', 'calligraphy_info', 'overall_comment', 'annotations', 'practice_advice', 'user_friendly_feedback']
  };
}

function stripJsonFence(text) {
  return text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
}

function normalizeReview(review, styleLabel) {
  const annotations = Array.isArray(review.annotations) ? review.annotations : [];
  return {
    image_quality: {
      is_clear: Boolean(review.image_quality?.is_clear ?? true),
      quality_level: ['high', 'medium', 'low'].includes(review.image_quality?.quality_level) ? review.image_quality.quality_level : 'medium',
      issues: Array.isArray(review.image_quality?.issues) ? review.image_quality.issues : []
    },
    calligraphy_info: {
      selected_style: styleLabel,
      recognized_text: String(review.calligraphy_info?.recognized_text || '根据图片大致判断'),
      estimated_level: String(review.calligraphy_info?.estimated_level || '入门'),
      overall_score: clampNumber(review.calligraphy_info?.overall_score, 0, 100, 75)
    },
    overall_comment: {
      summary: String(review.overall_comment?.summary || '整体书写比较认真，字形和排布已有基础，后续可继续加强结构稳定性。'),
      strengths: normalizeStringList(review.overall_comment?.strengths, ['态度认真，整体排布较整齐']),
      main_problems: normalizeStringList(review.overall_comment?.main_problems, ['个别字的重心和笔画间距还可以更稳定']),
      next_focus: normalizeStringList(review.overall_comment?.next_focus, ['练习重心', '练习横画间距'])
    },
    annotations: annotations.slice(0, 6).map((item, index) => normalizeAnnotation(item, index)),
    practice_advice: {
      today_focus: String(review.practice_advice?.today_focus || '今天建议重点练习字的重心和横画间距。'),
      practice_method: String(review.practice_advice?.practice_method || '选择 3 个常用字，先观察中轴线，再每个字连续练习 5 遍。'),
      estimated_practice_time: String(review.practice_advice?.estimated_practice_time || '15 分钟')
    },
    user_friendly_feedback: String(review.user_friendly_feedback || '这次作业完成得很认真，已经能看出你在控制字形结构。接下来把重心写稳，进步会更明显。')
  };
}

function normalizeAnnotation(item, index) {
  const type = ['praise', 'issue', 'suggestion', 'warning'].includes(item?.type) ? item.type : 'issue';
  const bbox = item?.bbox || {};
  return {
    id: item?.id || `A${String(index + 1).padStart(3, '0')}`,
    type,
    target_text: String(item?.target_text || '局部'),
    bbox: {
      x: clampNumber(bbox.x, 0, 0.98, 0.1),
      y: clampNumber(bbox.y, 0, 0.98, 0.1),
      width: clampNumber(bbox.width, 0.04, 1, 0.2),
      height: clampNumber(bbox.height, 0.04, 1, 0.16)
    },
    title: String(item?.title || '结构可再调整'),
    comment: String(item?.comment || '这个位置可以继续观察笔画之间的关系。'),
    suggestion: String(item?.suggestion || '下次书写前先慢慢观察位置，再落笔练习。'),
    severity: ['low', 'medium', 'high'].includes(item?.severity) ? item.severity : 'medium',
    display_style: item?.display_style || 'box'
  };
}

function normalizeStringList(value, fallback) {
  return Array.isArray(value) && value.length > 0 ? value.map(String).slice(0, 4) : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

async function createAnnotatedImageBuffer(imageBuffer, annotations) {
  const image = sharp(imageBuffer).rotate();
  const metadata = await image.metadata();
  const width = metadata.width || 1000;
  const height = metadata.height || 1000;
  const svg = createAnnotationSvg(width, height, annotations);
  return image
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

function createAnnotationSvg(width, height, annotations) {
  const boxes = annotations.map((annotation, index) => {
    const color = annotationColors[annotation.type] || annotationColors.issue;
    const x = Math.round(annotation.bbox.x * width);
    const y = Math.round(annotation.bbox.y * height);
    const boxWidth = Math.round(annotation.bbox.width * width);
    const boxHeight = Math.round(annotation.bbox.height * height);
    const label = escapeXml(annotation.id || `A${String(index + 1).padStart(3, '0')}`);
    const labelWidth = Math.max(54, label.length * 11 + 18);

    return `
      <rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" rx="8" fill="none" stroke="${color}" stroke-width="5"/>
      <rect x="${x}" y="${Math.max(0, y - 30)}" width="${labelWidth}" height="30" rx="8" fill="${color}"/>
      <text x="${x + 10}" y="${Math.max(22, y - 9)}" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#ffffff">${label}</text>
    `;
  }).join('');

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${boxes}</svg>`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function createMockReview(styleLabel) {
  return {
    image_quality: {
      is_clear: true,
      quality_level: 'medium',
      issues: []
    },
    calligraphy_info: {
      selected_style: styleLabel,
      recognized_text: '根据图片大致判断为书法练习内容',
      estimated_level: '入门',
      overall_score: 78
    },
    overall_comment: {
      summary: '整体书写态度认真，字形基本端正，局部笔画起收和结构重心还可以继续加强。',
      strengths: ['整体排布比较整齐', '部分字的重心较稳定'],
      main_problems: ['个别字左右比例不够均衡', '部分横画间距不够稳定'],
      next_focus: ['练习字的重心', '练习横画间距']
    },
    annotations: [
      {
        id: 'A001',
        type: 'praise',
        target_text: '中间字形',
        bbox: { x: 0.18, y: 0.18, width: 0.24, height: 0.22 },
        title: '重心较稳',
        comment: '这一处整体站得比较稳，笔画之间有一定呼应。',
        suggestion: '可以保留这种慢写和观察中轴线的习惯。',
        severity: 'low',
        display_style: 'box'
      },
      {
        id: 'A002',
        type: 'issue',
        target_text: '右侧局部',
        bbox: { x: 0.54, y: 0.22, width: 0.25, height: 0.24 },
        title: '结构略紧',
        comment: '这里外框收得稍紧，内部空间显得有些局促。',
        suggestion: '下次可先看清左右比例，再适当放开外框。',
        severity: 'medium',
        display_style: 'box'
      },
      {
        id: 'A003',
        type: 'suggestion',
        target_text: '下方笔画',
        bbox: { x: 0.24, y: 0.58, width: 0.42, height: 0.18 },
        title: '横画间距',
        comment: '几处横向笔画间距还不够一致，视觉节奏略有变化。',
        suggestion: '建议单独练习横画平行和间距，每次写慢一点。',
        severity: 'medium',
        display_style: 'box'
      }
    ],
    practice_advice: {
      today_focus: '今天建议重点练习字的重心和横画间距。',
      practice_method: '选择 3 个左右结构或上下结构的字，先观察中轴线，再每个字连续练习 5 遍。',
      estimated_practice_time: '15 分钟'
    },
    user_friendly_feedback: '这次作业整体完成得很认真，已经能看出你在控制字形结构。接下来重点把每个字的重心写稳，进步会更明显。'
  };
}
