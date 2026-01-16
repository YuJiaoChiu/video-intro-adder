const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { processVideos } = require('./ffmpeg-handler');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'default',
    title: '视频片头添加器'
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // 开发时打开开发者工具
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 选择片头文件
ipcMain.handle('select-intro', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择片头视频',
    filters: [
      { name: '视频文件', extensions: ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'webm', 'm4v', 'ts'] }
    ],
    properties: ['openFile']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// 选择视频目录
ipcMain.handle('select-video-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择视频目录',
    properties: ['openDirectory']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// 选择输出目录
ipcMain.handle('select-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择输出目录',
    properties: ['openDirectory', 'createDirectory']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// 递归获取目录中的视频文件
ipcMain.handle('get-video-files', async (event, dirPath) => {
  const videoExtensions = ['.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.webm', '.m4v', '.ts'];

  function walkDir(dir, baseDir) {
    let results = [];
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          // 递归搜索子目录
          results = results.concat(walkDir(filePath, baseDir));
        } else {
          const ext = path.extname(file).toLowerCase();
          if (videoExtensions.includes(ext)) {
            // 返回相对于基础目录的路径
            const relativePath = path.relative(baseDir, filePath);
            results.push(relativePath);
          }
        }
      }
    } catch (error) {
      console.error('读取目录失败:', dir, error);
    }
    return results;
  }

  return walkDir(dirPath, dirPath);
});

// 开始处理
ipcMain.handle('start-process', async (event, { introPath, videoDir, outputDir, overwriteSource }) => {
  return processVideos(introPath, videoDir, outputDir, overwriteSource, (progress) => {
    mainWindow.webContents.send('process-progress', progress);
  });
});

// 取消处理
let cancelProcessing = false;
ipcMain.handle('cancel-process', () => {
  cancelProcessing = true;
});

ipcMain.handle('get-cancel-status', () => {
  return cancelProcessing;
});

ipcMain.handle('reset-cancel-status', () => {
  cancelProcessing = false;
});
