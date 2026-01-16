// DOM 元素
const introPathInput = document.getElementById('intro-path');
const videoDirInput = document.getElementById('video-dir');
const outputDirInput = document.getElementById('output-dir');
const overwriteSourceCheckbox = document.getElementById('overwrite-source');
const videoCountDiv = document.getElementById('video-count');
const videoList = document.getElementById('video-list');
const selectedCountSpan = document.getElementById('selected-count');
const progressSection = document.getElementById('progress-section');
const progressText = document.getElementById('progress-text');
const progressPercent = document.getElementById('progress-percent');
const progressFill = document.getElementById('progress-fill');
const currentFile = document.getElementById('current-file');
const logSection = document.getElementById('log-section');
const logContainer = document.getElementById('log-container');
const btnStart = document.getElementById('btn-start');
const btnCancel = document.getElementById('btn-cancel');
const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toast-message');

// 状态
let introPath = '';
let videoDir = '';
let outputDir = '';
let videoFiles = [];
let isProcessing = false;

// 显示 Toast 提示
function showToast(message, duration = 3000) {
  toastMessage.textContent = message;
  toast.style.display = 'flex';
  setTimeout(() => toast.classList.add('show'), 10);

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.style.display = 'none', 300);
  }, duration);
}

// 覆盖源文件勾选时禁用输出目录选择
overwriteSourceCheckbox.addEventListener('change', () => {
  const disabled = overwriteSourceCheckbox.checked;
  outputDirInput.disabled = disabled;
  document.getElementById('btn-select-output-dir').disabled = disabled;
  if (disabled) {
    outputDirInput.value = '';
    outputDir = '';
    outputDirInput.placeholder = '覆盖模式：将直接替换源文件';
  } else {
    outputDirInput.placeholder = '默认在视频目录下创建 output 文件夹...';
  }
});

// 选择片头
document.getElementById('btn-select-intro').addEventListener('click', async () => {
  const path = await window.electronAPI.selectIntro();
  if (path) {
    introPath = path;
    introPathInput.value = path;
    checkCanStart();
  }
});

// 选择视频目录
document.getElementById('btn-select-video-dir').addEventListener('click', async () => {
  const path = await window.electronAPI.selectVideoDir();
  if (path) {
    videoDir = path;
    videoDirInput.value = path;
    await loadVideoFiles();
    checkCanStart();
  }
});

// 选择输出目录
document.getElementById('btn-select-output-dir').addEventListener('click', async () => {
  const path = await window.electronAPI.selectOutputDir();
  if (path) {
    outputDir = path;
    outputDirInput.value = path;
  }
});

// 加载视频文件列表
async function loadVideoFiles() {
  videoFiles = await window.electronAPI.getVideoFiles(videoDir);

  if (videoFiles.length === 0) {
    videoList.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="8" y="12" width="32" height="24" rx="4" stroke="#86868b" stroke-width="2"/>
          <path d="M20 20L28 24L20 28V20Z" fill="#86868b"/>
        </svg>
        <p>该目录下没有找到视频文件</p>
      </div>`;
    videoCountDiv.textContent = '';
    selectedCountSpan.textContent = '';
  } else {
    videoCountDiv.textContent = `找到 ${videoFiles.length} 个视频文件（包含子文件夹）`;
    selectedCountSpan.textContent = `(${videoFiles.length}个)`;
    renderVideoList();
  }
}

// 渲染视频列表
function renderVideoList(statuses = {}) {
  videoList.innerHTML = videoFiles.map(file => {
    const status = statuses[file] || 'pending';
    const statusText = {
      pending: '等待',
      processing: '处理中',
      completed: '完成',
      failed: '失败'
    }[status];

    return `
      <div class="video-item" data-file="${file}">
        <span class="icon">🎬</span>
        <span class="filename" title="${file}">${file}</span>
        <span class="status ${status}">${statusText}</span>
      </div>
    `;
  }).join('');
}

// 检查是否可以开始
function checkCanStart() {
  btnStart.disabled = !(introPath && videoDir && videoFiles.length > 0);
}

// 添加日志
function addLog(message, type = 'info') {
  const logItem = document.createElement('div');
  logItem.className = `log-item ${type}`;
  logItem.textContent = message;
  logContainer.appendChild(logItem);
  logContainer.scrollTop = logContainer.scrollHeight;
}

// 开始处理
btnStart.addEventListener('click', async () => {
  if (isProcessing) return;

  isProcessing = true;
  btnStart.style.display = 'none';
  btnCancel.style.display = 'inline-flex';
  progressSection.style.display = 'block';
  logSection.style.display = 'block';
  logContainer.innerHTML = '';
  progressFill.style.width = '0%';
  progressPercent.textContent = '0%';

  await window.electronAPI.resetCancelStatus();

  const overwriteSource = overwriteSourceCheckbox.checked;
  const finalOutputDir = overwriteSource ? videoDir : (outputDir || `${videoDir}/output`);

  addLog(`开始处理，共 ${videoFiles.length} 个视频`);
  if (overwriteSource) {
    addLog(`模式: 覆盖源文件`);
  } else {
    addLog(`输出目录: ${finalOutputDir}`);
  }

  const statuses = {};
  videoFiles.forEach(f => statuses[f] = 'pending');
  renderVideoList(statuses);

  // 监听进度
  window.electronAPI.onProgress((progress) => {
    const { current, total, filename, status, percent, message } = progress;

    if (filename && status) {
      statuses[filename] = status;
      renderVideoList(statuses);

      // 滚动到当前处理的视频
      const currentItem = document.querySelector(`[data-file="${filename}"]`);
      if (currentItem) {
        currentItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }

    if (percent !== undefined) {
      const overallPercent = Math.round(((current - 1) / total * 100) + (percent / total));
      progressFill.style.width = `${overallPercent}%`;
      progressPercent.textContent = `${overallPercent}%`;
    }

    if (message) {
      progressText.textContent = message;
      currentFile.textContent = filename ? `当前: ${filename}` : '';

      if (status === 'completed') {
        addLog(`✓ ${filename}`, 'success');
      } else if (status === 'failed') {
        addLog(`✗ ${filename}`, 'error');
      }
    }
  });

  try {
    const result = await window.electronAPI.startProcess({
      introPath,
      videoDir,
      outputDir: finalOutputDir,
      overwriteSource
    });

    progressFill.style.width = '100%';
    progressPercent.textContent = '100%';

    if (result.success) {
      progressText.textContent = '全部完成';
      addLog(`处理完成！成功: ${result.successCount}, 失败: ${result.failedCount}`, 'success');
      showToast(`处理完成！成功 ${result.successCount} 个，失败 ${result.failedCount} 个`);
    } else {
      progressText.textContent = '已取消';
      addLog('处理被用户取消', 'info');
    }
  } catch (error) {
    progressText.textContent = '处理出错';
    addLog(`错误: ${error.message}`, 'error');
    showToast('处理过程中出现错误');
  }

  isProcessing = false;
  btnStart.style.display = 'inline-flex';
  btnCancel.style.display = 'none';
  btnStart.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 2L14 8L4 14V2Z" fill="currentColor"/>
    </svg>
    重新处理
  `;
  btnStart.disabled = false;

  window.electronAPI.removeProgressListener();
});

// 取消处理
btnCancel.addEventListener('click', async () => {
  await window.electronAPI.cancelProcess();
  btnCancel.disabled = true;
  btnCancel.textContent = '正在取消...';
  addLog('正在取消处理...', 'info');
});

// 拖放支持（功能预留，需要 Electron 侧支持）
const introDropZone = document.getElementById('intro-drop-zone');
const videoDropZone = document.getElementById('video-drop-zone');

// 通用拖放处理
function setupDropZone(element, onDrop) {
  element.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    element.classList.add('drag-over');
  });

  element.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    element.classList.remove('drag-over');
  });

  element.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    element.classList.remove('drag-over');
    // 拖放功能需要 Electron 端支持
    // 这里仅做 UI 反馈
  });
}

setupDropZone(introDropZone, () => {});
setupDropZone(videoDropZone, () => {});
