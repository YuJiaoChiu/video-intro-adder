const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 文件选择
  selectIntro: () => ipcRenderer.invoke('select-intro'),
  selectVideoDir: () => ipcRenderer.invoke('select-video-dir'),
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),

  // 获取视频文件列表
  getVideoFiles: (dirPath) => ipcRenderer.invoke('get-video-files', dirPath),

  // 处理控制
  startProcess: (options) => ipcRenderer.invoke('start-process', options),
  cancelProcess: () => ipcRenderer.invoke('cancel-process'),
  resetCancelStatus: () => ipcRenderer.invoke('reset-cancel-status'),

  // 监听进度
  onProgress: (callback) => {
    ipcRenderer.on('process-progress', (event, progress) => callback(progress));
  },

  // 移除监听
  removeProgressListener: () => {
    ipcRenderer.removeAllListeners('process-progress');
  }
});
