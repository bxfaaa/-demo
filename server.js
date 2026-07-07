import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3000);
const uploadRoot = path.join(__dirname, 'public', 'uploads');
const originalDir = path.join(uploadRoot, 'original');
const annotatedDir = path.join(uploadRoot, 'annotated');
const tempDir = path.join(uploadRoot, 'tmp');
const maxImageSize = 10 * 1024 * 1024;

const styleLabels = {
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

const geminiModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

await Promise.all([
  fs.mkdir(originalDir, { recursive: true }),
  fs.mkdir(annotatedDir, { recursive: true }),
  fs.mkdir(tempDir, { recursive: true })
]);

const upload = multer({
  dest: tempDir,
  limits: { fileSize: maxImageSize },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error('UNSUPPORTED_IMAGE_TYPE'));
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (_req, res) => {
  res.json({
    success: true,
    data: {
      provider: hasGeminiApiKey() ? 'gemini' : 'mock',
      model: hasGeminiApiKey() ? geminiModel : 'local-mock',
      gemini_configured: hasGeminiApiKey()
    }
  });
});

app.post('/api/calligraphy-review', upload.single('image'), async (req, res) => {
  const tempPath = req.file?.path;

  try {
    const style = String(req.body.style || '');
    if (!req.file) {
      return sendError(res, 'IMAGE_REQUIRED', '请先上传一张书法作业图片');
    }
    if (!styleLabels[style]) {
      return sendError(res, 'STYLE_REQUIRED', '请选择正在学习的书法类型');
    }

    const reviewId = `demo_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}_${uuidv4().slice(0, 8)}`;
    const ext = extensionForMime(req.file.mimetype);
    const originalPath = path.join(originalDir, `${reviewId}${ext}`);
    const annotatedPath = path.join(annotatedDir, `${reviewId}.png`);

    await fs.rename(req.file.path, originalPath);
    const analysis = await analyzeWithGeminiOrMock(originalPath, req.file.mimetype, styleLabels[style]);
    const normalizedReview = normalizeReview(analysis.review, styleLabels[style]);
    await createAnnotatedImage(originalPath, annotatedPath, normalizedReview.annotations);

    res.json({
      success: true,
      data: {
        review_id: reviewId,
        analysis_source: analysis.source,
        analysis_model: analysis.model,
        original_image_url: `/uploads/original/${reviewId}${ext}`,
        annotated_image_url: `/uploads/annotated/${reviewId}.png`,
        ...normalizedReview
      }
    });
  } catch (error) {
    console.error(error);
    const code = error.message === 'UNSUPPORTED_IMAGE_TYPE' ? 'UNSUPPORTED_IMAGE_TYPE' : 'AI_REVIEW_FAILED';
    const message = code === 'UNSUPPORTED_IMAGE_TYPE'
      ? '图片格式不支持，请上传 JPG、PNG 或 WEBP'
      : `AI 点评暂时失败：${getPublicErrorMessage(error)}`;
    sendError(res, code, message, 400);
  } finally {
    if (tempPath) {
      await fs.unlink(tempPath).catch(() => {});
    }
  }
});

app.use((error, _req, res, _next) => {
  if (error.code === 'LIMIT_FILE_SIZE') {
    sendError(res, 'IMAGE_TOO_LARGE', '图片过大，请上传 10MB 以内的图片', 413);
    return;
  }
  if (error.message === 'UNSUPPORTED_IMAGE_TYPE') {
    sendError(res, 'UNSUPPORTED_IMAGE_TYPE', '图片格式不支持，请上传 JPG、PNG 或 WEBP', 400);
    return;
  }
  sendError(res, 'SERVER_ERROR', '服务暂时不可用，请稍后再试', 500);
});

app.listen(port, () => {
  console.log(`Calligraphy review demo running at http://localhost:${port}`);
  if (!hasGeminiApiKey()) {
    console.log('GEMINI_API_KEY is not set. The demo will use local mock review data.');
  } else {
    console.log(`Gemini API is configured. Using model: ${geminiModel}`);
  }
});

function sendError(res, errorCode, message, status = 400) {
  return res.status(status).json({ success: false, error_code: errorCode, message });
}

function extensionForMime(mimeType) {
  return {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp'
  }[mimeType] || '.jpg';
}

async function analyzeWithGeminiOrMock(imagePath, mimeType, styleLabel) {
  if (!hasGeminiApiKey()) {
    return {
      source: 'mock',
      model: 'local-mock',
      review: createMockReview(styleLabel)
    };
  }

  const imageData = await fs.readFile(imagePath, 'base64');
  const prompt = buildPrompt(styleLabel);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY.trim())}`;
  console.log(`Calling Gemini model ${geminiModel} for ${path.basename(imagePath)}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
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
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GEMINI_REQUEST_FAILED: ${payload.error?.message || response.statusText}`);
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
    model: geminiModel,
    review: JSON.parse(stripJsonFence(text))
  };
}

function hasGeminiApiKey() {
  const key = process.env.GEMINI_API_KEY?.trim();
  return Boolean(key) && !/^(your_|你的|replace_me|test)/i.test(key);
}

function getPublicErrorMessage(error) {
  const message = String(error.message || '');
  if (message.includes('API key not valid')) return 'Gemini API Key 无效，请检查 .env 中的 GEMINI_API_KEY';
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

async function createAnnotatedImage(originalPath, outputPath, annotations) {
  const image = sharp(originalPath).rotate();
  const metadata = await image.metadata();
  const width = metadata.width || 1000;
  const height = metadata.height || 1000;
  const svg = createAnnotationSvg(width, height, annotations);
  await image
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(outputPath);
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
