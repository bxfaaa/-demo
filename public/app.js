const styleOptions = [
  { label: '楷书', value: 'kaishu' },
  { label: '行书', value: 'xingshu' },
  { label: '隶书', value: 'lishu' },
  { label: '篆书', value: 'zhuanshu' },
  { label: '草书', value: 'caoshu' },
  { label: '硬笔书法', value: 'hard_pen' }
];

const typeLabels = {
  praise: '优点',
  issue: '问题',
  suggestion: '建议',
  warning: '提醒'
};

const typeColors = {
  praise: '#22C55E',
  issue: '#EF4444',
  suggestion: '#3B82F6',
  warning: '#F59E0B'
};

const state = {
  file: null,
  style: ''
};

const els = {
  imageInput: document.querySelector('#imageInput'),
  dropZone: document.querySelector('#dropZone'),
  previewWrap: document.querySelector('#previewWrap'),
  previewImage: document.querySelector('#previewImage'),
  changeImageBtn: document.querySelector('#changeImageBtn'),
  styleOptions: document.querySelector('#styleOptions'),
  modelBadge: document.querySelector('#modelBadge'),
  submitBtn: document.querySelector('#submitBtn'),
  formError: document.querySelector('#formError'),
  uploadPanel: document.querySelector('#uploadPanel'),
  loadingPanel: document.querySelector('#loadingPanel'),
  resultPanel: document.querySelector('#resultPanel'),
  annotatedImage: document.querySelector('#annotatedImage'),
  downloadBtn: document.querySelector('#downloadBtn'),
  resetBtn: document.querySelector('#resetBtn'),
  scoreValue: document.querySelector('#scoreValue'),
  sourceText: document.querySelector('#sourceText'),
  levelText: document.querySelector('#levelText'),
  summaryText: document.querySelector('#summaryText'),
  friendlyFeedback: document.querySelector('#friendlyFeedback'),
  strengthList: document.querySelector('#strengthList'),
  focusList: document.querySelector('#focusList'),
  annotationList: document.querySelector('#annotationList'),
  todayFocus: document.querySelector('#todayFocus'),
  practiceMethod: document.querySelector('#practiceMethod'),
  practiceTime: document.querySelector('#practiceTime')
};

renderStyleOptions();
loadStatus();

els.imageInput.addEventListener('change', () => {
  const file = els.imageInput.files?.[0];
  if (file) setImage(file);
});

els.changeImageBtn.addEventListener('click', () => els.imageInput.click());
els.submitBtn.addEventListener('click', submitReview);
els.resetBtn.addEventListener('click', resetDemo);

['dragenter', 'dragover'].forEach((eventName) => {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropZone.classList.add('dragging');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropZone.classList.remove('dragging');
  });
});

els.dropZone.addEventListener('drop', (event) => {
  const file = event.dataTransfer.files?.[0];
  if (file) setImage(file);
});

function renderStyleOptions() {
  els.styleOptions.innerHTML = '';
  styleOptions.forEach((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'style-option';
    button.textContent = option.label;
    button.addEventListener('click', () => {
      state.style = option.value;
      document.querySelectorAll('.style-option').forEach((item) => item.classList.remove('selected'));
      button.classList.add('selected');
      updateSubmitState();
    });
    els.styleOptions.appendChild(button);
  });
}

function setImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    showError('请上传 JPG、PNG 或 WEBP 格式图片');
    return;
  }

  if (file.size > 10 * 1024 * 1024) {
    showError('图片过大，请上传 10MB 以内的图片');
    return;
  }

  state.file = file;
  els.previewImage.src = URL.createObjectURL(file);
  els.dropZone.classList.add('hidden');
  els.previewWrap.classList.remove('hidden');
  showError('');
  updateSubmitState();
}

function updateSubmitState() {
  els.submitBtn.disabled = !state.file || !state.style;
}

function showError(message) {
  els.formError.textContent = message;
}

async function loadStatus() {
  try {
    const response = await fetch('/api/status');
    const payload = await response.json();
    const data = payload.data;
    if (data?.provider === 'gemini') {
      els.modelBadge.textContent = `Gemini 已接入 · ${data.model}`;
      els.modelBadge.classList.remove('mock');
    } else {
      els.modelBadge.textContent = 'Mock 模式 · 未配置 Gemini Key';
      els.modelBadge.classList.add('mock');
    }
  } catch {
    els.modelBadge.textContent = '模型状态未知';
    els.modelBadge.classList.add('mock');
  }
}

async function submitReview() {
  if (!state.file || !state.style) {
    showError('请先上传图片并选择书法类型');
    return;
  }

  setMode('loading');
  const formData = new FormData();
  formData.append('image', state.file);
  formData.append('style', state.style);

  try {
    const response = await fetch('/api/calligraphy-review', {
      method: 'POST',
      body: formData
    });
    const payload = await response.json();
    if (!payload.success) {
      throw new Error(payload.message || '点评失败');
    }
    renderResult(payload.data);
    setMode('result');
  } catch (error) {
    setMode('upload');
    showError(error.message || 'AI 点评失败，请稍后重试');
  }
}

function renderResult(data) {
  els.annotatedImage.src = data.annotated_image_url;
  els.downloadBtn.href = data.annotated_image_url;
  els.downloadBtn.download = `${data.review_id}_annotated.png`;
  els.scoreValue.textContent = Math.round(data.calligraphy_info.overall_score);
  els.sourceText.textContent = data.analysis_source === 'gemini'
    ? `本次由 Gemini 实时分析 · ${data.analysis_model}`
    : '本次为 Mock 演示数据，需配置 GEMINI_API_KEY 后才会调用 Gemini';
  els.levelText.textContent = `${data.calligraphy_info.selected_style} · ${data.calligraphy_info.estimated_level}`;
  els.summaryText.textContent = data.overall_comment.summary;
  els.friendlyFeedback.textContent = data.user_friendly_feedback;
  renderList(els.strengthList, data.overall_comment.strengths);
  renderList(els.focusList, data.overall_comment.next_focus);
  renderAnnotations(data.annotations);
  els.todayFocus.textContent = data.practice_advice.today_focus;
  els.practiceMethod.textContent = data.practice_advice.practice_method;
  els.practiceTime.textContent = data.practice_advice.estimated_practice_time;
}

function renderList(element, items) {
  element.innerHTML = '';
  items.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item;
    element.appendChild(li);
  });
}

function renderAnnotations(annotations) {
  els.annotationList.innerHTML = '';
  annotations.forEach((annotation) => {
    const card = document.createElement('article');
    card.className = 'annotation-card';
    card.style.borderLeftColor = typeColors[annotation.type] || typeColors.issue;
    card.innerHTML = `
      <div class="annotation-title">
        <span>${escapeHtml(annotation.id)} · ${escapeHtml(annotation.title)}</span>
        <span class="tag">${typeLabels[annotation.type] || '点评'}</span>
      </div>
      <p><strong>对应位置：</strong>${escapeHtml(annotation.target_text)}</p>
      <p>${escapeHtml(annotation.comment)}</p>
      <p><strong>建议：</strong>${escapeHtml(annotation.suggestion)}</p>
    `;
    els.annotationList.appendChild(card);
  });
}

function setMode(mode) {
  els.uploadPanel.classList.toggle('hidden', mode !== 'upload');
  els.loadingPanel.classList.toggle('hidden', mode !== 'loading');
  els.resultPanel.classList.toggle('hidden', mode !== 'result');
}

function resetDemo() {
  state.file = null;
  state.style = '';
  els.imageInput.value = '';
  els.previewImage.src = '';
  els.dropZone.classList.remove('hidden');
  els.previewWrap.classList.add('hidden');
  document.querySelectorAll('.style-option').forEach((item) => item.classList.remove('selected'));
  showError('');
  updateSubmitState();
  setMode('upload');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
