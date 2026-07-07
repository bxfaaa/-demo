import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import formidable from 'formidable';
import {
  getPublicErrorMessage,
  reviewImage,
  styleLabels
} from '../lib/review.js';

export const config = {
  api: {
    bodyParser: false
  },
  maxDuration: 60
};

const maxImageSize = 10 * 1024 * 1024;
const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendError(res, 'METHOD_NOT_ALLOWED', '仅支持 POST 请求', 405);
  }

  try {
    const { fields, files } = await parseMultipart(req);
    const style = getFieldValue(fields.style);
    const image = getFileValue(files.image);

    if (!image) {
      return sendError(res, 'IMAGE_REQUIRED', '请先上传一张书法作业图片');
    }
    if (!styleLabels[style]) {
      return sendError(res, 'STYLE_REQUIRED', '请选择正在学习的书法类型');
    }
    if (!allowedTypes.includes(image.mimetype)) {
      return sendError(res, 'UNSUPPORTED_IMAGE_TYPE', '图片格式不支持，请上传 JPG、PNG 或 WEBP');
    }
    if (image.size > maxImageSize) {
      return sendError(res, 'IMAGE_TOO_LARGE', '图片过大，请上传 10MB 以内的图片', 413);
    }

    const imageBuffer = await fs.readFile(image.filepath);
    const result = await reviewImage({
      imageBuffer,
      mimeType: image.mimetype,
      styleLabel: styleLabels[style]
    });
    const reviewId = `demo_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}_${randomUUID().slice(0, 8)}`;

    return res.status(200).json({
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
    return sendError(res, 'AI_REVIEW_FAILED', `AI 点评暂时失败：${getPublicErrorMessage(error)}`);
  }
}

function parseMultipart(req) {
  const form = formidable({
    maxFileSize: maxImageSize,
    multiples: false,
    uploadDir: '/tmp',
    keepExtensions: true
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (error, fields, files) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ fields, files });
    });
  });
}

function getFieldValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function getFileValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function sendError(res, errorCode, message, status = 400) {
  return res.status(status).json({ success: false, error_code: errorCode, message });
}
