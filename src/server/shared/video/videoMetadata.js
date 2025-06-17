const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

// Set FFmpeg and FFprobe paths
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

class VideoMetadata {
    /**
     * Extracts comprehensive metadata from video file including detailed audio information
     * @param {string} filePath - Path to the video file
     * @param {Object} logger - Logger instance
     * @returns {Object|null} Metadata object or null if extraction fails
     */
    static async extract(filePath, logger) {
        return new Promise((resolve) => {
            ffmpeg.ffprobe(filePath, (err, metadata) => {
                if (err) {
                    logger.error(`Failed to get metadata for: ${filePath}`, err);
                    resolve(null);
                    return;
                }
                
                try {
                    const videoStream = metadata.streams.find(s => s.codec_type === 'video');
                    const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
                    
                    // Extract detailed audio information
                    let audioChannels = 0;
                    let channelLayout = null;
                    let audioCodec = null;
                    let sampleRate = null;
                    let audioBitrate = null;
                    
                    if (audioStream) {
                        audioChannels = audioStream.channels || 0;
                        
                        // Handle OPUS and other codecs with missing channel_layout
                        if (audioStream.channel_layout) {
                            channelLayout = audioStream.channel_layout;
                        } else {
                            // Derive channel layout from channel count for common cases
                            channelLayout = this.deriveChannelLayout(audioChannels, audioStream.codec_name);
                        }
                        
                        audioCodec = audioStream.codec_name || null;
                        sampleRate = audioStream.sample_rate ? parseInt(audioStream.sample_rate) : null;
                        audioBitrate = audioStream.bit_rate ? parseInt(audioStream.bit_rate) : null;
                        
                        // Enhanced logging for debugging audio issues
                        logger.log(`    🎵 Audio details: ${audioChannels}ch, ${channelLayout || 'unknown layout'}, ${audioCodec}, ${sampleRate}Hz`);
                        
                        // Special logging for mono OPUS files that often cause issues
                        if (audioCodec === 'opus' && audioChannels === 1) {
                            logger.log(`    ⚠️  OPUS mono audio detected - special handling required`);
                        }
                    }
                    
                    const result = {
                        // Video information
                        duration: metadata.format.duration ? parseFloat(metadata.format.duration) : null,
                        width: videoStream?.width || null,
                        height: videoStream?.height || null,
                        fps: videoStream?.r_frame_rate ? eval(videoStream.r_frame_rate) : null,
                        videoCodec: videoStream?.codec_name || null,
                        
                        // Audio information
                        hasAudio: !!audioStream,
                        audioChannels: audioChannels,
                        channelLayout: channelLayout,
                        audioCodec: audioCodec,
                        sampleRate: sampleRate,
                        audioBitrate: audioBitrate,
                        
                        // File information
                        fileSize: metadata.format.size ? parseInt(metadata.format.size) : null,
                        bitrate: metadata.format.bit_rate ? parseInt(metadata.format.bit_rate) : null,
                        container: metadata.format.format_name || null,
                        
                        // Enhanced audio metadata for processing decisions
                        audioProfile: this.determineAudioProfile(audioChannels, channelLayout),
                        requiresUpmixing: this.requiresUpmixing({ audioChannels, channelLayout }),
                        
                        // Debug information
                        streams: {
                            video: videoStream ? {
                                codec: videoStream.codec_name,
                                profile: videoStream.profile,
                                level: videoStream.level,
                                pixelFormat: videoStream.pix_fmt,
                                colorSpace: videoStream.color_space,
                                colorRange: videoStream.color_range
                            } : null,
                            audio: audioStream ? {
                                codec: audioStream.codec_name,
                                profile: audioStream.profile,
                                channels: audioStream.channels,
                                layout: audioStream.channel_layout,
                                sampleFormat: audioStream.sample_fmt,
                                sampleRate: audioStream.sample_rate,
                                bitRate: audioStream.bit_rate
                            } : null
                        }
                    };
                    
                    resolve(result);
                } catch (parseError) {
                    logger.error(`Failed to parse metadata for: ${filePath}`, parseError);
                    resolve(null);
                }
            });
        });
    }
    
    /**
     * Derives channel layout when not provided by ffprobe (common with OPUS and other codecs)
     * @param {number} channels - Number of audio channels
     * @param {string} codec - Audio codec name
     * @returns {string} Derived channel layout
     */
    static deriveChannelLayout(channels, codec) {
        switch (channels) {
            case 1:
                return 'mono';
            case 2:
                return 'stereo';
            case 3:
                return '2.1';
            case 4:
                return 'quad';
            case 5:
                return '5.0';
            case 6:
                return '5.1';
            case 8:
                return '7.1';
            default:
                return `${channels}ch`;
        }
    }
    
    /**
     * Determines audio profile based on channel count and layout
     * @param {number} channels - Number of audio channels
     * @param {string} channelLayout - Channel layout string
     * @returns {string} Audio profile description
     */
    static determineAudioProfile(channels, channelLayout) {
        if (!channels || channels === 0) {
            return 'no-audio';
        }
        
        if (channels === 1) {
            return 'mono';
        }
        
        if (channels === 2) {
            return 'stereo';
        }
        
        if (channels === 6 && (channelLayout === '5.1' || channelLayout === '5.1(side)')) {
            return '5.1-surround';
        }
        
        if (channels === 8 && channelLayout === '7.1') {
            return '7.1-surround';
        }
        
        if (channels === 3) {
            return '2.1-surround';
        }
        
        if (channels === 4) {
            return channelLayout === 'quad' ? 'quadraphonic' : '4.0-surround';
        }
        
        if (channels === 5) {
            return '5.0-surround';
        }
        
        // Fallback for unusual configurations
        return `${channels}-channel`;
    }
    
    /**
     * Checks if audio configuration requires 5.1 upmixing
     * @param {Object} metadata - Metadata object with audioChannels and channelLayout
     * @returns {boolean} True if upmixing is beneficial
     */
    static requiresUpmixing(metadata) {
        if (!metadata || metadata.audioChannels < 1) {
            return false;
        }
        
        return metadata.audioChannels < 6;
    }
    
    /**
     * Gets recommended processing approach for audio
     * @param {Object} metadata - Metadata object  
     * @returns {string} Processing approach
     */
    static getRecommendedAudioProcessing(metadata) {
        if (!metadata || metadata.audioChannels < 1) {
            return 'no-processing';
        }
        
        if (metadata.audioChannels === 1) {
            return 'mono-to-5.1-upmix';
        }
        
        if (metadata.audioChannels === 2) {
            return 'stereo-to-5.1-upmix';
        }
        
        if (metadata.audioChannels === 6 && metadata.channelLayout === '5.1') {
            return 'preserve-5.1';
        }
        
        if (metadata.audioChannels > 6) {
            return 'downmix-to-5.1';
        }
        
        return 'upmix-to-5.1';
    }
}

module.exports = VideoMetadata;