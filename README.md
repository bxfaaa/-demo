# 书法作业 AI 点评 Demo

一个单页 Web Demo：上传书法作业图片，选择书法类型，后端调用 Gemini 多模态模型返回结构化点评，并用 `sharp` 在原图上绘制标注框。

## 启动

```bash
npm install
npm start
```

打开：

```text
http://localhost:3000
```

## Gemini 配置

复制 `.env.example` 为 `.env`，填入 Google AI Studio API Key：

```bash
GEMINI_API_KEY=your_google_ai_studio_api_key
GEMINI_MODEL=gemini-3.5-flash
PORT=3000
```

未配置 `GEMINI_API_KEY` 时，Demo 会自动使用本地 mock 点评数据，上传、标注图生成和下载流程仍然可用。

页面右上角会显示当前模式：

- `Gemini 已接入`: 正在调用真实 Gemini API
- `Mock 模式`: 没有读取到 `GEMINI_API_KEY`，返回的是本地演示数据

## 接口

```http
POST /api/calligraphy-review
Content-Type: multipart/form-data
```

字段：

- `image`: JPG / PNG / WEBP，最大 10MB
- `style`: `kaishu` / `xingshu` / `lishu` / `zhuanshu` / `caoshu` / `hard_pen`

返回包含原图地址、标注图地址、整体点评、标注点明细和练习建议。
