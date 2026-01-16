const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 设置内置的 ffmpeg 和 ffprobe 路径
function setupFFmpeg() {
  try {
    const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    const ffprobePath = require('@ffprobe-installer/ffprobe').path;

    // 处理 asar 打包后的路径
    const fixedFfmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
    const fixedFfprobePath = ffprobePath.replace('app.asar', 'app.asar.unpacked');

    ffmpeg.setFfmpegPath(fixedFfmpegPath);
    ffmpeg.setFfprobePath(fixedFfprobePath);

    console.log('FFmpeg path:', fixedFfmpegPath);
    console.log('FFprobe path:', fixedFfprobePath);
  } catch (error) {
    console.error('FFmpeg 初始化失败:', error);
    throw new Error('FFmpeg 初始化失败，请重新安装应用');
  }
}

setupFFmpeg();

// 获取视频信息
function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

      resolve({
        width: videoStream?.width,
        height: videoStream?.height,
        fps: videoStream?.r_frame_rate,
        vcodec: videoStream?.codec_name,
        pix_fmt: videoStream?.pix_fmt,
        acodec: audioStream?.codec_name,
        sample_rate: audioStream?.sample_rate,
        channels: audioStream?.channels,
        duration: metadata.format.duration
      });
    });
  });
}

// 获取编码器映射
function getEncoder(codec) {
  const encoderMap = {
    h264: 'libx264',
    hevc: 'libx265',
    h265: 'libx265',
    vp9: 'libvpx-vp9',
    vp8: 'libvpx',
    av1: 'libaom-av1'
  };
  return encoderMap[codec] || 'libx264';
}

function getAudioEncoder(codec) {
  const encoderMap = {
    aac: 'aac',
    mp3: 'libmp3lame',
    opus: 'libopus',
    vorbis: 'libvorbis',
    ac3: 'ac3',
    flac: 'flac'
  };
  return encoderMap[codec] || 'aac';
}

// 转码片头以匹配主视频参数
function transcodeIntro(introPath, videoInfo, outputPath) {
  return new Promise((resolve, reject) => {
    const { width, height, fps, vcodec, pix_fmt, acodec, sample_rate, channels } = videoInfo;

    // 解析帧率
    let fpsValue = 30;
    if (fps) {
      const parts = fps.split('/');
      if (parts.length === 2) {
        fpsValue = parseInt(parts[0]) / parseInt(parts[1]);
      } else {
        fpsValue = parseFloat(fps);
      }
    }
    fpsValue = Math.round(fpsValue * 100) / 100;

    const command = ffmpeg(introPath)
      .videoFilters([
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        `fps=${fpsValue}`,
        `format=${pix_fmt || 'yuv420p'}`
      ])
      .videoCodec(getEncoder(vcodec))
      .addOutputOptions(['-preset', 'fast', '-crf', '18'])
      .audioCodec(getAudioEncoder(acodec))
      .audioFrequency(parseInt(sample_rate) || 48000)
      .audioChannels(parseInt(channels) || 2)
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err));

    command.run();
  });
}

// 拼接视频（无损拼接）
function concatVideos(introPath, videoPath, outputPath, tempDir) {
  return new Promise((resolve, reject) => {
    const listFile = path.join(tempDir, `concat_${Date.now()}.txt`);
    const content = `file '${introPath.replace(/'/g, "'\\''")}'\nfile '${videoPath.replace(/'/g, "'\\''")}'`;

    fs.writeFileSync(listFile, content);

    ffmpeg()
      .input(listFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy'])
      .output(outputPath)
      .on('end', () => {
        try { fs.unlinkSync(listFile); } catch (e) {}
        resolve();
      })
      .on('error', (err) => {
        try { fs.unlinkSync(listFile); } catch (e) {}
        reject(err);
      })
      .run();
  });
}

// 递归获取视频文件
function getVideoFilesRecursive(dir, baseDir, introPath) {
  const videoExtensions = ['.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.webm', '.m4v', '.ts'];
  let results = [];

  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        // 跳过 output 文件夹
        if (file.toLowerCase() === 'output') continue;
        results = results.concat(getVideoFilesRecursive(filePath, baseDir, introPath));
      } else {
        const ext = path.extname(file).toLowerCase();
        if (videoExtensions.includes(ext)) {
          if (path.resolve(filePath) !== path.resolve(introPath)) {
            const relativePath = path.relative(baseDir, filePath);
            results.push(relativePath);
          }
        }
      }
    }
  } catch (error) {
    console.error('读取目录失败:', dir, error);
  }

  return results;
}

// 处理所有视频
async function processVideos(introPath, videoDir, outputDir, overwriteSource, onProgress) {
  // 递归获取所有视频文件（相对路径）
  const videoFiles = getVideoFilesRecursive(videoDir, videoDir, introPath);

  if (videoFiles.length === 0) {
    return {
      success: true,
      successCount: 0,
      failedCount: 0,
      total: 0
    };
  }

  // 创建输出目录（非覆盖模式）
  if (!overwriteSource && !fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 创建临时目录
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-intro-'));

  let successCount = 0;
  let failedCount = 0;

  for (let i = 0; i < videoFiles.length; i++) {
    const relativePath = videoFiles[i];
    const videoPath = path.join(videoDir, relativePath);
    const ext = path.extname(relativePath);

    // 根据是否覆盖源文件决定输出路径
    let outputPath;
    let tempOutputPath = null;

    if (overwriteSource) {
      tempOutputPath = path.join(tempDir, `output_${i}${ext}`);
      outputPath = videoPath;
    } else {
      outputPath = path.join(outputDir, relativePath);
      const outputSubDir = path.dirname(outputPath);
      if (!fs.existsSync(outputSubDir)) {
        fs.mkdirSync(outputSubDir, { recursive: true });
      }
    }

    onProgress({
      current: i + 1,
      total: videoFiles.length,
      filename: relativePath,
      status: 'processing',
      percent: 0,
      message: `正在处理 (${i + 1}/${videoFiles.length}): ${relativePath}`
    });

    try {
      // 获取主视频信息
      const videoInfo = await getVideoInfo(videoPath);

      onProgress({
        current: i + 1,
        total: videoFiles.length,
        filename: relativePath,
        status: 'processing',
        percent: 30,
        message: `转码片头中: ${relativePath}`
      });

      // 转码片头
      const tempIntro = path.join(tempDir, `intro_${i}${ext}`);
      await transcodeIntro(introPath, videoInfo, tempIntro);

      onProgress({
        current: i + 1,
        total: videoFiles.length,
        filename: relativePath,
        status: 'processing',
        percent: 70,
        message: `拼接视频中: ${relativePath}`
      });

      // 拼接
      const concatTarget = overwriteSource ? tempOutputPath : outputPath;
      await concatVideos(tempIntro, videoPath, concatTarget, tempDir);

      // 清理临时片头
      try { fs.unlinkSync(tempIntro); } catch (e) {}

      // 覆盖模式：替换原文件
      if (overwriteSource && tempOutputPath) {
        fs.unlinkSync(videoPath);
        fs.renameSync(tempOutputPath, videoPath);
      }

      successCount++;
      onProgress({
        current: i + 1,
        total: videoFiles.length,
        filename: relativePath,
        status: 'completed',
        percent: 100,
        message: `完成: ${relativePath}`
      });

    } catch (error) {
      console.error(`处理失败: ${relativePath}`, error);
      failedCount++;
      onProgress({
        current: i + 1,
        total: videoFiles.length,
        filename: relativePath,
        status: 'failed',
        percent: 100,
        message: `失败: ${relativePath} - ${error.message}`
      });
    }
  }

  // 清理临时目录
  try {
    fs.rmSync(tempDir, { recursive: true });
  } catch (e) {
    console.error('清理临时目录失败:', e);
  }

  return {
    success: true,
    successCount,
    failedCount,
    total: videoFiles.length
  };
}

// 检查 FFmpeg 是否可用
function checkFFmpegAvailable() {
  try {
    const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    const ffprobePath = require('@ffprobe-installer/ffprobe').path;
    return {
      available: true,
      ffmpegPath,
      ffprobePath
    };
  } catch (e) {
    return {
      available: false,
      ffmpegPath: null,
      ffprobePath: null
    };
  }
}

module.exports = { processVideos, getVideoInfo, checkFFmpegAvailable };
