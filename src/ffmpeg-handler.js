const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

// FFmpeg 路径
let ffmpegPath = '';
let ffprobePath = '';

// 设置内置的 ffmpeg 和 ffprobe 路径
function setupFFmpeg() {
  try {
    ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    ffprobePath = require('@ffprobe-installer/ffprobe').path;

    // 处理 asar 打包后的路径
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
    ffprobePath = ffprobePath.replace('app.asar', 'app.asar.unpacked');

    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);

    console.log('FFmpeg path:', ffmpegPath);
    console.log('FFprobe path:', ffprobePath);
  } catch (error) {
    console.error('FFmpeg 初始化失败:', error);
    throw new Error('FFmpeg 初始化失败，请重新安装应用');
  }
}

setupFFmpeg();

// 执行 FFmpeg 命令
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log('执行 FFmpeg:', ffmpegPath, args.join(' '));

    const proc = spawn(ffmpegPath, args);

    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      // 实时输出进度
      process.stdout.write(data.toString());
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        console.error('FFmpeg 错误输出:', stderr);
        reject(new Error(`FFmpeg 退出码: ${code}\n${stderr.slice(-500)}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

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
        duration: metadata.format.duration,
        video_time_base: videoStream?.time_base,
        audio_time_base: audioStream?.time_base
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

// 获取视频的比特流滤镜
function getVideoBsf(codec) {
  if (codec === 'h264') return 'h264_mp4toannexb';
  if (codec === 'hevc' || codec === 'h265') return 'hevc_mp4toannexb';
  return null;
}

// 转码片头并输出为 TS 格式
function transcodeIntroToTS(introPath, videoInfo, outputPath) {
  return new Promise(async (resolve, reject) => {
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

    const videoBsf = getVideoBsf(vcodec);

    const args = [
      '-y',
      '-i', introPath,
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fpsValue},format=${pix_fmt || 'yuv420p'}`,
      '-c:v', getEncoder(vcodec),
      '-preset', 'fast',
      '-crf', '18',
      '-c:a', getAudioEncoder(acodec),
      '-ar', String(parseInt(sample_rate) || 48000),
      '-ac', String(parseInt(channels) || 2),
    ];

    // 添加比特流滤镜（用于 TS 格式）
    if (videoBsf) {
      args.push('-bsf:v', videoBsf);
    }

    args.push('-f', 'mpegts', outputPath);

    try {
      await runFFmpeg(args);
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

// 将主视频转换为 TS 格式（不重新编码）
function convertToTS(inputPath, outputPath, vcodec) {
  return new Promise(async (resolve, reject) => {
    const videoBsf = getVideoBsf(vcodec);

    const args = [
      '-y',
      '-i', inputPath,
      '-c', 'copy',
    ];

    if (videoBsf) {
      args.push('-bsf:v', videoBsf);
    }

    args.push('-f', 'mpegts', outputPath);

    try {
      await runFFmpeg(args);
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

// 使用 concat protocol 拼接 TS 文件并输出为目标格式
function concatTSFiles(tsFiles, outputPath, vcodec) {
  return new Promise(async (resolve, reject) => {
    // 构建 concat 输入
    const concatInput = 'concat:' + tsFiles.join('|');

    const args = [
      '-y',
      '-i', concatInput,
      '-c', 'copy',
    ];

    // 如果输出是 MP4，需要添加音频比特流滤镜
    const ext = path.extname(outputPath).toLowerCase();
    if (ext === '.mp4' || ext === '.m4v' || ext === '.mov') {
      args.push('-bsf:a', 'aac_adtstoasc');
    }

    args.push('-movflags', '+faststart', outputPath);

    try {
      await runFFmpeg(args);
      resolve();
    } catch (err) {
      reject(err);
    }
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
  const videoFiles = getVideoFilesRecursive(videoDir, videoDir, introPath);

  if (videoFiles.length === 0) {
    return {
      success: true,
      successCount: 0,
      failedCount: 0,
      total: 0
    };
  }

  if (!overwriteSource && !fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-intro-'));

  let successCount = 0;
  let failedCount = 0;

  for (let i = 0; i < videoFiles.length; i++) {
    const relativePath = videoFiles[i];
    const videoPath = path.join(videoDir, relativePath);
    const ext = path.extname(relativePath);

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
      // 步骤 1: 获取主视频信息
      const videoInfo = await getVideoInfo(videoPath);
      console.log('主视频信息:', JSON.stringify(videoInfo, null, 2));

      onProgress({
        current: i + 1,
        total: videoFiles.length,
        filename: relativePath,
        status: 'processing',
        percent: 15,
        message: `转码片头中: ${relativePath}`
      });

      // 步骤 2: 转码片头为 TS 格式
      const introTS = path.join(tempDir, `intro_${i}.ts`);
      await transcodeIntroToTS(introPath, videoInfo, introTS);

      onProgress({
        current: i + 1,
        total: videoFiles.length,
        filename: relativePath,
        status: 'processing',
        percent: 45,
        message: `转换主视频格式: ${relativePath}`
      });

      // 步骤 3: 将主视频转换为 TS 格式（不重新编码）
      const videoTS = path.join(tempDir, `video_${i}.ts`);
      await convertToTS(videoPath, videoTS, videoInfo.vcodec);

      onProgress({
        current: i + 1,
        total: videoFiles.length,
        filename: relativePath,
        status: 'processing',
        percent: 70,
        message: `拼接视频中: ${relativePath}`
      });

      // 步骤 4: 使用 concat protocol 拼接 TS 文件
      const concatTarget = overwriteSource ? tempOutputPath : outputPath;
      await concatTSFiles([introTS, videoTS], concatTarget, videoInfo.vcodec);

      // 清理临时文件
      try { fs.unlinkSync(introTS); } catch (e) {}
      try { fs.unlinkSync(videoTS); } catch (e) {}

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
