import { getModelStatus } from '../lib/review.js';

export default function handler(_req, res) {
  res.status(200).json({
    success: true,
    data: getModelStatus()
  });
}
