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
    
    /**
     * Gets normalization parameters from config, supporting both presets and manual values
     * @returns {Object} Normalization configuration
     */
    getNormalizationConfig() {
        const audioConfig = this.configManager?.config?.audio || {};
        const normConfig = audioConfig.normalization || {};
        
        // If normalization is disabled, return null
        if (normConfig.enabled === false) {
            return null;
        }
        
        // Start with defaults
        let config = {
            targetLUFS: -16,
            truePeak: -1.5,
            LRA: 11,
            dualMono: true
        };
        
        // Apply preset if specified
        const strength = normConfig.strength;
        const presets = normConfig.presets || {};
        
        if (strength && presets[strength]) {
            const preset = presets[strength];
            this.logger.log(`    🎚️ Using normalization preset: ${strength}`);
            
            config.targetLUFS = preset.targetLUFS || config.targetLUFS;
            config.truePeak = preset.truePeak || config.truePeak;
            config.LRA = preset.LRA || config.LRA;
        }
        
        // Manual overrides take precedence over presets
        if (normConfig.targetLUFS !== undefined) {
            config.targetLUFS = normConfig.targetLUFS;
        }
        if (normConfig.truePeak !== undefined) {
            config.truePeak = normConfig.truePeak;
        }
        if (normConfig.LRA !== undefined) {
            config.LRA = normConfig.LRA;
        }
        if (normConfig.dualMono !== undefined) {
            config.dualMono = normConfig.dualMono;
        }
        
        this.logger.log(`    🎚️ Normalization config: I=${config.targetLUFS} LUFS, TP=${config.truePeak} dB, LRA=${config.LRA} LU`);
        
        return config;
    }
    /**
     * Creates appropriate audio filter chain based on source channel count and config
     * @param {number} channels - Number of input audio channels
     * @param {string} channelLayout - Input channel layout (e.g., 'stereo', '5.1')
     * @returns {Array} Array of audio filter strings
     */
    createAudioFilters(channels, channelLayout) {
        const filters = [];
        const audioConfig = this.configManager?.config?.audio || {};
        
        // Get normalization configuration
        const normConfig = this.getNormalizationConfig();
        
        // Get upmixing configuration values with defaults
        const rearLevel = audioConfig.stereoUpmixing?.rearChannelLevel || 0.2;
        const centerLevel = audioConfig.stereoUpmixing?.centerChannelLevel || 0.5;
        const lfeLevel = audioConfig.stereoUpmixing?.lfeChannelLevel || 0.3;
        
        if (channels <= 2) {
            // Stereo to 5.1 conversion with configurable levels
            this.logger.log(`    🔊 Converting stereo/mono to 5.1 (rear: ${rearLevel}, center: ${centerLevel}, LFE: ${lfeLevel})`);
            
            // Apply normalization if enabled
            if (normConfig) {
                const normFilter = `loudnorm=I=${normConfig.targetLUFS}:TP=${normConfig.truePeak}:LRA=${normConfig.LRA}${normConfig.dualMono ? ':dual_mono=true' : ''}`;
                filters.push(normFilter);
            } else {
                this.logger.log(`    🔇 Audio normalization disabled`);
            }
            
            // Convert stereo to 5.1 using pan filter with configurable levels
            // Note: LFE content is created from the mixed signal, bass frequencies will naturally be present
            filters.push([
                'pan=5.1|',
                'FL=FL|',                           // Front left = original left
                'FR=FR|',                           // Front right = original right  
                `FC=${centerLevel}*FL+${centerLevel}*FR|`, // Center = configurable mix
                `LFE=${lfeLevel}*FL+${lfeLevel}*FR|`,       // Subwoofer = configurable mix
                `BL=${rearLevel}*FL|`,              // Back left = front left at config level
                `BR=${rearLevel}*FR`                // Back right = front right at config level
            ].join(''));
            
        } else if (channels >= 6) {
            // True multichannel content - preserve or process based on config
            const preserveOriginal = audioConfig.compatibility?.preserveOriginalIfMultichannel;
            
            if (preserveOriginal && channelLayout === '5.1') {
                this.logger.log(`    🔊 Preserving original ${channels}-channel ${channelLayout} audio`);
                // Light normalization only if enabled
                if (normConfig) {
                    const normFilter = `loudnorm=I=${normConfig.targetLUFS}:TP=${normConfig.truePeak}:LRA=${normConfig.LRA}:dual_mono=${normConfig.dualMono}`;
                    filters.push(normFilter);
                }
            } else {
                this.logger.log(`    🔊 Processing ${channels}-channel audio with normalization`);
                // Use multichannel-aware loudnorm if enabled
                if (normConfig) {
                    const normFilter = `loudnorm=I=${normConfig.targetLUFS}:TP=${normConfig.truePeak}:LRA=${normConfig.LRA}:dual_mono=${normConfig.dualMono}`;
                    filters.push(normFilter);
                }
            }
            
        } else if (channels === 3 || channels === 4 || channels === 5) {
            // Intermediate channel counts - upmix to 5.1
            this.logger.log(`    🔊 Upmixing ${channels}-channel audio to 5.1`);
            
            // Normalize first if enabled
            if (normConfig) {
                const normFilter = `loudnorm=I=${normConfig.targetLUFS}:TP=${normConfig.truePeak}:LRA=${normConfig.LRA}`;
                filters.push(normFilter);
            }
            
            // Use aresample to upmix to 5.1 with configurable levels
            filters.push('aresample=resampler=soxr');
            filters.push(`pan=5.1|FL=FL|FR=FR|FC=FC+${centerLevel*0.6}*FL+${centerLevel*0.6}*FR|LFE=${lfeLevel}*FL+${lfeLevel}*FR|BL=${rearLevel*1.5}*FL|BR=${rearLevel*1.5}*FR`);
            
        } else {
            // Fallback for unusual channel counts
            this.logger.log(`    🔊 Fallback processing for ${channels}-channel audio`);
            if (normConfig) {
                const normFilter = `loudnorm=I=${normConfig.targetLUFS}:TP=${normConfig.truePeak}:LRA=${normConfig.LRA}`;
                filters.push(normFilter);
            }
            filters.push(`pan=5.1|FL=c0|FR=c1|FC=${centerLevel}*c0+${centerLevel}*c1|LFE=${lfeLevel}*c0+${lfeLevel}*c1|BL=${rearLevel}*c0|BR=${rearLevel}*c1`);
        }
        
        return filters;
    }
    
    /**
     * Determines appropriate audio codec and bitrate based on channel configuration and config
     * @param {number} channels - Number of output channels
     * @returns {Object} Audio codec configuration object
     */
    getAudioCodec(channels) {
        const audioConfig = this.configManager?.config?.audio || {};
        const codecPrefs = audioConfig.codecPreferences || {};
        const compatibility = audioConfig.compatibility || {};
        
        // Force AAC for maximum compatibility if enabled
        if (compatibility.forceAAC) {
            this.logger.log(`    🔧 Forcing AAC codec for maximum browser compatibility`);
            
            // Use more conservative bitrates for better compatibility
            const baseBitrate = channels > 2 ? 384000 : 256000; // Reduced from 640k/512k
            const configuredBitrate = channels > 2 ? 
                (codecPrefs.multichannelBitrate || baseBitrate) : 
                (codecPrefs.stereoBitrate || baseBitrate);
            
            return {
                codec: 'aac',
                bitrate: Math.min(configuredBitrate, baseBitrate) // Cap at conservative values
            };
        }
        
        // For web compatibility, prefer AAC even for multichannel
        // AC-3 support in browsers is limited
        if (channels > 2) {
            const multichannelCodec = codecPrefs.multichannel || 'aac';
            
            // Warn if using AC-3 which has limited browser support
            if (multichannelCodec === 'ac3') {
                this.logger.log(`    ⚠️  Using AC-3 codec - limited browser support, consider AAC for better compatibility`);
            }
            
            return {
                codec: multichannelCodec,
                bitrate: codecPrefs.multichannelBitrate || (multichannelCodec === 'ac3' ? 640000 : 384000)
            };
        }
        
        return {
            codec: codecPrefs.stereo || 'aac',
            bitrate: codecPrefs.stereoBitrate || 256000
        };
    }
    
    async preprocess(videoData) {
        const videoId = crypto.randomUUID();
        const outputPath = path.join(this.tempDir, `processed_${videoId}.mp4`);
        
        this.logger.log(`🎬 Preprocessing: ${videoData.filename}`);
        
        // Get metadata
        const metadata = await VideoMetadata.extract(videoData.originalPath, this.logger);
        if (!metadata) {
            throw new Error(`Failed to get metadata for: ${videoData.filename}`);
        }
        
        // Log audio details
        this.logger.log(`    📊 Source audio: ${metadata.audioChannels} channels, layout: ${metadata.channelLayout || 'unknown'}`);
        
        const videoWithMetadata = {
            ...videoData,
            metadata: metadata
        };
        
        return new Promise((resolve, reject) => {
            const ffmpegCommand = ffmpeg(videoData.originalPath);
            
            // Check if 5.1 processing is enabled
            const audio51Enabled = this.configManager?.config?.audio?.enabled51Processing !== false;
            const forceOutputChannels = this.configManager?.config?.audio?.forceOutputChannels || 6;
            const compatibility = this.configManager?.config?.audio?.compatibility || {};
            
            // Check compatibility mode
            const compatibilityMode = compatibility.compatibilityMode || 'auto';
            const shouldUseStereo = compatibilityMode === 'stereo' || 
                                   (compatibilityMode === 'auto' && compatibility.fallbackToStereo);
            
            if (!audio51Enabled || shouldUseStereo) {
                // Stereo processing mode
                const modeReason = !audio51Enabled ? '5.1 processing disabled' : 'compatibility mode enabled';
                this.logger.log(`    🔊 Using stereo output (${modeReason})`);
                
                // Get normalization config for stereo processing too
                const normConfig = this.getNormalizationConfig();
                
                const stereoFilters = [];
                if (normConfig) {
                    const normFilter = `loudnorm=I=${normConfig.targetLUFS}:TP=${normConfig.truePeak}:LRA=${normConfig.LRA}${normConfig.dualMono ? ':dual_mono=true' : ''}`;
                    stereoFilters.push(normFilter);
                    this.logger.log(`    🎚️ Applying stereo normalization: I=${normConfig.targetLUFS} LUFS`);
                } else {
                    this.logger.log(`    🔇 Stereo normalization disabled`);
                }
                
                ffmpegCommand
                    .videoCodec('copy')
                    .audioCodec('aac')
                    .audioChannels(2)
                    .format('mp4')
                    .outputOptions([
                        '-movflags', 'faststart',
                        '-avoid_negative_ts', 'make_zero',
                        '-b:a', '256k',
                        '-profile:a', 'aac_low'
                    ]);
                
                // Apply normalization filters if enabled
                if (stereoFilters.length > 0) {
                    ffmpegCommand.audioFilters(stereoFilters);
                }
            } else {
                // 5.1 processing pipeline
                const audioFilters = this.createAudioFilters(metadata.audioChannels, metadata.channelLayout);
                const audioCodecConfig = this.getAudioCodec(forceOutputChannels);
                
                this.logger.log(`    🔧 Using audio codec: ${audioCodecConfig.codec} @ ${audioCodecConfig.bitrate}bps`);
                this.logger.log(`    🎛️ Audio filters: ${audioFilters.join(' -> ')}`);
                
                ffmpegCommand
                    .videoCodec('copy')
                    .audioCodec(audioCodecConfig.codec)
                    .audioChannels(forceOutputChannels)
                    .audioFilters(audioFilters)
                    .format('mp4')
                    .outputOptions([
                        '-movflags', 'faststart',
                        '-avoid_negative_ts', 'make_zero',
                        // Codec-specific options - avoid duplicate -ac flags
                        '-b:a', `${audioCodecConfig.bitrate}`,
                        ...(audioCodecConfig.codec === 'ac3' ? [
                            '-channel_layout', '5.1'
                        ] : [
                            // AAC 5.1 options
                            '-profile:a', 'aac_low'
                        ])
                    ]);
            }
            
            // Attach event handlers to the configured command
            ffmpegCommand
                .on('start', (commandLine) => {
                    this.logger.log(`🔧 FFmpeg started: ${videoData.filename}`);
                    this.logger.log(`    💻 Command: ${commandLine}`);
                })
                .on('progress', (progress) => {
                    if (progress.percent && progress.percent % 20 === 0) {
                        this.logger.log(`⏳ Processing ${videoData.filename}: ${Math.round(progress.percent)}%`);
                    }
                })
                .on('end', () => {
                    const audio51Enabled = this.configManager?.config?.audio?.enabled51Processing !== false;
                    const forceOutputChannels = this.configManager?.config?.audio?.forceOutputChannels || 6;
                    const compatibility = this.configManager?.config?.audio?.compatibility || {};
                    const compatibilityMode = compatibility.compatibilityMode || 'auto';
                    const shouldUseStereo = compatibilityMode === 'stereo' || 
                                           (compatibilityMode === 'auto' && compatibility.fallbackToStereo);
                    
                    const actuallyUsing51 = audio51Enabled && !shouldUseStereo;
                    const outputFormat = actuallyUsing51 ? '5.1 surround' : 'stereo';
                    
                    this.logger.log(`✅ Preprocessing complete: ${videoData.filename} -> ${outputFormat}`);
                    
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
                        crossfadeTiming: crossfadeTiming,
                        // Audio processing metadata
                        outputAudioChannels: actuallyUsing51 ? forceOutputChannels : 2,
                        outputChannelLayout: actuallyUsing51 ? '5.1' : 'stereo',
                        audioProcessingApplied: actuallyUsing51 ? 
                            (metadata.audioChannels <= 2 ? 'stereo-to-5.1' : 'multichannel-normalized') :
                            'stereo-compatible'
                    };
                    
                    resolve(processedVideoData);
                })
                .on('error', async (err) => {
                    this.logger.error(`❌ Preprocessing failed: ${videoData.filename}`, err);
                    
                    // Clean up partial file
                    await FileUtils.deleteFile(outputPath);
                    
                    reject(err);
                })
                .save(outputPath);
        });
    }
    
    calculateCrossfadeTiming(duration) {
        if (!duration || duration < 10) {
            return null;
        }
        
        const crossfadeDuration = Math.min(3, duration * 0.1);
        const startTime = Math.max(0, duration - crossfadeDuration - 1);
        
        return {
            duration: crossfadeDuration,
            startTime: startTime
        };
    }
    
    async cleanup() {
        // Cleanup temporary files if needed
        this.logger.log('🧹 VideoPreprocessor cleanup completed');
    }
}

module.exports = VideoPreprocessor;