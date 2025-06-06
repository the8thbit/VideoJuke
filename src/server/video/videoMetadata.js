const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

// Ensure we're in Node.js environment
if (typeof window !== 'undefined') {
    throw new Error('VideoMetadata should only be used in Node.js environment');
}

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

class VideoMetadata {
    static async extract(filePath, logger) {
        return new Promise((resolve) => {
            try {
                ffmpeg.ffprobe(filePath, (err, metadata) => {
                    if (err) {
                        logger.error(`Failed to get metadata for: ${filePath}`, err);
                        resolve(null);
                        return;
                    }
                    
                    try {
                        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
                        const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
                        
                        // Calculate FPS safely without eval
                        let fps = null;
                        if (videoStream?.r_frame_rate) {
                            const frameRate = videoStream.r_frame_rate;
                            if (frameRate.includes('/')) {
                                const [numerator, denominator] = frameRate.split('/').map(Number);
                                if (denominator && denominator !== 0) {
                                    fps = numerator / denominator;
                                }
                            } else {
                                fps = parseFloat(frameRate);
                            }
                        }
                        
                        const result = {
                            duration: metadata.format.duration ? parseFloat(metadata.format.duration) : null,
                            width: videoStream?.width || null,
                            height: videoStream?.height || null,
                            fps: fps,
                            hasAudio: !!audioStream,
                            audioChannels: audioStream?.channels || 0,
                            fileSize: metadata.format.size ? parseInt(metadata.format.size) : null,
                            bitrate: metadata.format.bit_rate ? parseInt(metadata.format.bit_rate) : null
                        };
                        
                        resolve(result);
                    } catch (parseError) {
                        logger.error(`Failed to parse metadata for: ${filePath}`, parseError);
                        resolve(null);
                    }
                });
            } catch (error) {
                logger.error(`Error in metadata extraction setup for: ${filePath}`, error);
                resolve(null);
            }
        });
    }
}

module.exports = VideoMetadata;