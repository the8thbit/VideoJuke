const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const FileUtils = require('../utils/fileUtils');
const VideoMetadata = require('./videoMetadata');

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

class VideoPreprocessor {
    constructor(logger, tempDir, configManager = null) {
        this.logger = logger;
        this.tempDir = tempDir;
        this.configManager = configManager;
    }
    
    async preprocess(videoData) {
        const videoId = crypto.randomUUID();
        const outputPath = path.join(this.tempDir, `processed_${videoId}.mp4`);
        
        // Get metadata
        const metadata = await VideoMetadata.extract(videoData.originalPath, this.logger);
        if (!metadata) {
            throw new Error(`Failed to get metadata for: ${videoData.filename}`);
        }
        
        const videoWithMetadata = {
            ...videoData,
            metadata: metadata
        };
        
        return new Promise((resolve, reject) => {
            ffmpeg(videoData.originalPath)
                .audioFilters('loudnorm=I=-16:TP=-1.5:LRA=11')
                .videoCodec('copy')
                .audioCodec('aac')
                .format('mp4')
                .outputOptions([
                    '-movflags', 'faststart',
                    '-avoid_negative_ts', 'make_zero'
                ])
                .on('end', () => {
                    this.logger.log(`Successfully preprocessed: ${videoData.filename} -> ${path.basename(outputPath)}`);
                    
                    // Calculate crossfade timing based on duration
                    let crossfadeTiming = null;
                    if (metadata && metadata.duration) {
                        crossfadeTiming = this.calculateCrossfadeTiming(metadata.duration);
                    }
                    
                    const processedVideoData = {
                        ...videoWithMetadata,
                        processedPath: outputPath,
                        videoId: videoId,
                        processedAt: new Date().toISOString(),
                        crossfadeTiming: crossfadeTiming
                    };
                    resolve(processedVideoData);
                })
                .on('error', async (err) => {
                    this.logger.error(`Preprocessing failed: ${videoData.filename}`, err);
                    await FileUtils.deleteFile(outputPath);
                    reject(err);
                })
                .save(outputPath);
        });
    }
    
    calculateCrossfadeTiming(duration) {
        // Get config from configManager if available, otherwise use defaults
        const config = this.configManager?.config || {};
        const configDuration = (config.crossfade?.duration || 500) / 1000; // Convert ms to seconds
        const minDuration = 0.2;
        const bufferTime = 0.5;
        
        let crossfadeDuration;
        if (duration < configDuration * 2) {
            crossfadeDuration = Math.max(duration / 2, minDuration);
        } else {
            crossfadeDuration = Math.min(configDuration, duration * 0.8, Math.max(configDuration, minDuration));
        }
        
        const startTime = Math.max(0, duration - crossfadeDuration - bufferTime);
        
        return {
            duration: crossfadeDuration,
            startTime: startTime
        };
    }
}

module.exports = VideoPreprocessor;