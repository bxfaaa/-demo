import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  getModelStatus,
  getPublicErrorMessage,
  reviewImage,
  styleLabels
} from './lib/review.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3000);
const publicDir = path.join(process.cwd(), 'public');
const tempDir = process.env.VERCEL ? '/tmp/calligraphy-review-demo' : path.join(publicDir, 'uploads', 'tmp');
const maxImageSize = 10 * 1024 * 1024;

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

await fs.mkdir(tempDir, { recursive: true });

app.use(express.static(publicDir));

app.get('/api/status', (_req, res) => {
  res.json({
    success: true,
    data: getModelStatus()
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

    const reviewId = `demo_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}_${randomUUID().slice(0, 8)}`;
    const imageBuffer = await fs.readFile(req.file.path);
    const result = await reviewImage({
      imageBuffer,
      mimeType: req.file.mimetype,
      styleLabel: styleLabels[style]
    });

    res.json({
      success: true,
      data: {
        review_id: reviewId,
        analysis_source: result.analysis.source,
        analysis_model: result.analysis.model,
        original_image_url: '',
        annotated_image_url: result.annotatedImageDataUrl,
        ...result.normalizedReview
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
  const status = getModelStatus();
  if (status.provider !== 'gemini') {
    console.log('GEMINI_API_KEY is not set. The demo will use local mock review data.');
  } else {
    console.log(`Gemini API is configured. Using model: ${status.model}`);
  }
});

function sendError(res, errorCode, message, status = 400) {
  return res.status(status).json({ success: false, error_code: errorCode, message });
}
