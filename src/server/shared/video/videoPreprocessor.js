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
     * @param {string} channelLayout - Input channel layout (e.g., 'stereo', '5.1', 'mono')
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
        
        this.logger.log(`    🎵 Processing ${channels}-channel audio (layout: ${channelLayout || 'unknown'})`);
        
        if (channels === 1) {
            // Mono audio - requires special handling to avoid silent output
            this.logger.log(`    🔊 Converting mono to 5.1 (rear: ${rearLevel}, center: ${centerLevel}, LFE: ${lfeLevel})`);
            
            // Apply normalization first if enabled
            if (normConfig) {
                const normFilter = `loudnorm=I=${normConfig.targetLUFS}:TP=${normConfig.truePeak}:LRA=${normConfig.LRA}${normConfig.dualMono ? ':dual_mono=true' : ''}`;
                filters.push(normFilter);
                this.logger.log(`    🎚️ Applying mono normalization: I=${normConfig.targetLUFS} LUFS`);
            } else {
                this.logger.log(`    🔇 Audio normalization disabled`);
            }
            
            // For mono audio, duplicate the single channel to both FL and FR before 5.1 conversion
            // This ensures we have proper stereo input for the 5.1 pan filter
            filters.push([
                'pan=5.1|',
                'FL=c0|',                               // Front left = mono channel
                'FR=c0|',                               // Front right = mono channel (same as left)
                `FC=${centerLevel}*c0|`,                // Center = mono channel at config level
                `LFE=${lfeLevel}*c0|`,                  // Subwoofer = mono channel at config level
                `BL=${rearLevel}*c0|`,                  // Back left = mono channel at config level
                `BR=${rearLevel}*c0`                    // Back right = mono channel at config level
            ].join(''));
            
        } else if (channels === 2) {
            // Stereo to 5.1 conversion with configurable levels
            this.logger.log(`    🔊 Converting stereo to 5.1 (rear: ${rearLevel}, center: ${centerLevel}, LFE: ${lfeLevel})`);
            
            // Apply normalization if enabled
            if (normConfig) {
                const normFilter = `loudnorm=I=${normConfig.targetLUFS}:TP=${normConfig.truePeak}:LRA=${normConfig.LRA}${normConfig.dualMono ? ':dual_mono=true' : ''}`;
                filters.push(normFilter);
                this.logger.log(`    🎚️ Applying stereo normalization: I=${normConfig.targetLUFS} LUFS`);
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
            
        } else if (channels === 3 || channels === 4 || channels === 5) {
            // Intermediate channel counts - upmix to 5.1
            this.logger.log(`    🔊 Upmixing ${channels}-channel audio to 5.1`);
            
            // Normalize first if enabled
            if (normConfig) {
                const normFilter = `loudnorm=I=${normConfig.targetLUFS}:TP=${normConfig.truePeak}:LRA=${normConfig.LRA}`;
                filters.push(normFilter);
                this.logger.log(`    🎚️ Applying ${channels}-channel normalization: I=${normConfig.targetLUFS} LUFS`);
            }
            
            // Use aresample to upmix to 5.1 with configurable levels
            filters.push('aresample=resampler=soxr');
            
            if (channels === 3) {
                // 2.1 to 5.1 mapping
                filters.push(`pan=5.1|FL=c0|FR=c1|FC=${centerLevel*0.6}*c0+${centerLevel*0.6}*c1|LFE=c2+${lfeLevel*0.4}*c0+${lfeLevel*0.4}*c1|BL=${rearLevel*1.2}*c0|BR=${rearLevel*1.2}*c1`);
            } else if (channels === 4) {
                // Quad to 5.1 mapping
                filters.push(`pan=5.1|FL=c0|FR=c1|FC=${centerLevel*0.6}*c0+${centerLevel*0.6}*c1|LFE=${lfeLevel}*c0+${lfeLevel}*c1|BL=c2|BR=c3`);
            } else {
                // 5.0 to 5.1 mapping
                filters.push(`pan=5.1|FL=c0|FR=c1|FC=c2|LFE=${lfeLevel}*c0+${lfeLevel}*c1|BL=c3|BR=c4`);
            }
            
        } else if (channels >= 6) {
            // True multichannel content - preserve or process based on config
            const preserveOriginal = audioConfig.compatibility?.preserveOriginalIfMultichannel;
            
            if (preserveOriginal && (channelLayout === '5.1' || channelLayout === '5.1(side)')) {
                this.logger.log(`    🔊 Preserving original ${channels}-channel ${channelLayout} audio`);
                // Light normalization only if enabled
                if (normConfig) {
                    const normFilter = `loudnorm=I=${normConfig.targetLUFS}:TP=${normConfig.truePeak}:LRA=${normConfig.LRA}:dual_mono=${normConfig.dualMono}`;
                    filters.push(normFilter);
                    this.logger.log(`    🎚️ Applying light multichannel normalization: I=${normConfig.targetLUFS} LUFS`);
                }
            } else {
                this.logger.log(`    🔊 Processing ${channels}-channel audio with normalization`);
                // Use multichannel-aware loudnorm if enabled
                if (normConfig) {
                    const normFilter = `loudnorm=I=${normConfig.targetLUFS}:TP=${normConfig.truePeak}:LRA=${normConfig.LRA}:dual_mono=${normConfig.dualMono}`;
                    filters.push(normFilter);
                    this.logger.log(`    🎚️ Applying multichannel normalization: I=${normConfig.targetLUFS} LUFS`);
                }
            }
            
        } else {
            // Fallback for unusual channel counts or no audio
            this.logger.log(`    ⚠️  Fallback processing for ${channels}-channel audio`);
            if (normConfig && channels > 0) {
                const normFilter = `loudnorm=I=${normConfig.targetLUFS}:TP=${normConfig.truePeak}:LRA=${normConfig.LRA}`;
                filters.push(normFilter);
                this.logger.log(`    🎚️ Applying fallback normalization: I=${normConfig.targetLUFS} LUFS`);
            }
            
            // Create a safe fallback mapping for unusual channel counts
            if (channels > 0) {
                const channelMappings = [];
                channelMappings.push('FL=c0');                                    // Use first channel for front left
                channelMappings.push(channels > 1 ? 'FR=c1' : 'FR=c0');         // Use second channel or duplicate first
                channelMappings.push(`FC=${centerLevel}*c0${channels > 1 ? `+${centerLevel}*c1` : ''}`); // Center mix
                channelMappings.push(`LFE=${lfeLevel}*c0${channels > 1 ? `+${lfeLevel}*c1` : ''}`);     // LFE mix
                channelMappings.push(`BL=${rearLevel}*c0`);                      // Rear from first channel
                channelMappings.push(`BR=${rearLevel}*${channels > 1 ? 'c1' : 'c0'}`); // Rear from second or first
                
                filters.push(`pan=5.1|${channelMappings.join('|')}`);
            }
        }
        
        // Log the complete filter chain for debugging
        this.logger.log(`    🎛️ Audio filter chain: ${filters.join(' -> ')}`);
        
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
    
    /**
     * Gets performance configuration settings with preset support
     * @returns {Object} Performance configuration object
     */
    getPerformanceConfig() {
        const performanceConfig = this.configManager?.config?.performance || {};
        const mode = performanceConfig.mode || 'balanced';
        
        // Start with preset values
        const presets = performanceConfig.presets || {};
        let config = presets[mode] || presets.balanced || {
            maxThreads: 2,
            processingDelay: 1000,
            threadQueueSize: 512,
            priority: 'normal'
        };
        
        // Override with any direct settings from cpuLimiting
        const cpuLimiting = performanceConfig.cpuLimiting || {};
        if (cpuLimiting.enabled !== false) {
            config = {
                ...config,
                ...cpuLimiting
            };
        }
        
        this.logger.log(`    ⚙️ Performance mode: ${mode} (threads: ${config.maxThreads}, delay: ${config.processingDelay}ms)`);
        
        return config;
    }
    
    /**
     * Applies performance optimizations to FFmpeg command
     * @param {Object} ffmpegCommand - Fluent-ffmpeg command object
     * @returns {Object} Modified FFmpeg command with performance settings
     */
    applyPerformanceSettings(ffmpegCommand) {
        const performanceConfig = this.getPerformanceConfig();
        
        // Core performance settings
        const performanceOptions = [
            '-threads', performanceConfig.maxThreads.toString(),
            '-thread_queue_size', performanceConfig.threadQueueSize.toString(),
            '-preset', 'medium'  // Use medium preset for balance of speed/quality
        ];
        
        // Add CPU throttling for quiet mode
        if (performanceConfig.maxThreads === 1) {
            performanceOptions.push('-cpu-used', '1');  // Lower CPU usage
        }
        
        return ffmpegCommand.outputOptions(performanceOptions);
    }
    
    /**
     * Adds processing delay between video preprocessing jobs
     * @param {number} delayMs - Delay in milliseconds
     * @returns {Promise} Promise that resolves after delay
     */
    async addProcessingDelay(delayMs) {
        if (delayMs > 0) {
            this.logger.log(`    ⏱️ Adding ${delayMs}ms processing delay for CPU throttling`);
            return new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    
    /**
     * Main preprocessing function with enhanced error handling and performance controls
     * @param {Object} videoData - Video data object with originalPath and filename
     * @returns {Promise<Object>} Processed video data with metadata
     */
    async preprocess(videoData) {
        const videoId = crypto.randomUUID();
        const outputPath = path.join(this.tempDir, `processed_${videoId}.mp4`);
        
        this.logger.log(`🎬 Preprocessing: ${videoData.filename}`);
        
        // Apply CPU throttling delay before starting
        const performanceConfig = this.getPerformanceConfig();
        await this.addProcessingDelay(performanceConfig.processingDelay);
        
        // Get metadata during preprocessing with enhanced logging
        const metadata = await VideoMetadata.extract(videoData.originalPath, this.logger);
        
        if (!metadata) {
            throw new Error(`Failed to get metadata for: ${videoData.filename}`);
        }
        
        // Special logging for problematic audio formats
        if (metadata.audioCodec === 'opus' && metadata.audioChannels === 1) {
            this.logger.log(`    🔍 OPUS mono detected - using enhanced processing pipeline`);
        }
        
        // Add metadata to video data
        const videoWithMetadata = {
            ...videoData,
            metadata: metadata
        };
        
        return new Promise((resolve, reject) => {
            try {
                const attemptProcessing = (useCompatibilityMode = false) => {
                    let ffmpegCommand = ffmpeg(videoData.originalPath);
                    
                    // Apply performance settings first
                    ffmpegCommand = this.applyPerformanceSettings(ffmpegCommand);
                    
                    // Determine processing mode based on configuration and metadata
                    const audioConfig = this.configManager?.config?.audio || {};
                    const enabled51Processing = audioConfig.enabled51Processing !== false;
                    const forceOutputChannels = audioConfig.forceOutputChannels || 6;
                    
                    // Skip 5.1 processing if disabled or in compatibility mode
                    if (!enabled51Processing || useCompatibilityMode) {
                        const modeReason = !enabled51Processing ? 
                            '5.1 processing disabled' : 'compatibility mode enabled';
                        this.logger.log(`    🔊 Using stereo output (${modeReason})`);
                        
                        // Get normalization config for stereo processing
                        const normConfig = this.getNormalizationConfig();
                        
                        const stereoFilters = [];
                        if (normConfig) {
                            const normFilter = `loudnorm=I=${normConfig.targetLUFS}:TP=${normConfig.truePeak}:LRA=${normConfig.LRA}${normConfig.dualMono ? ':dual_mono=true' : ''}`;
                            stereoFilters.push(normFilter);
                        }
                        
                        ffmpegCommand = ffmpegCommand
                            .audioFilters(stereoFilters.length > 0 ? stereoFilters : [])
                            .videoCodec('copy')
                            .audioCodec('aac')
                            .audioBitrate('256k')
                            .format('mp4')
                            .outputOptions([
                                '-movflags', 'faststart',
                                '-avoid_negative_ts', 'make_zero'
                            ]);
                    } else {
                        // Full 5.1 processing mode
                        this.logger.log(`    🔊 Using 5.1 surround processing`);
                        
                        const audioFilters = this.createAudioFilters(metadata.audioChannels, metadata.channelLayout);
                        const outputCodec = this.getAudioCodec(forceOutputChannels);
                        
                        ffmpegCommand = ffmpegCommand
                            .audioFilters(audioFilters.length > 0 ? audioFilters : [])
                            .videoCodec('copy')
                            .audioCodec(outputCodec.codec)
                            .audioBitrate(Math.floor(outputCodec.bitrate / 1000) + 'k')
                            .audioChannels(forceOutputChannels)
                            .format('mp4')
                            .outputOptions([
                                '-movflags', 'faststart',
                                '-avoid_negative_ts', 'make_zero'
                            ]);
                    }
                    
                    ffmpegCommand
                        .on('start', (commandLine) => {
                            this.logger.log(`    🔧 FFmpeg started: ${videoData.filename}`);
                            this.logger.log(`    🔧 Performance settings applied: ${performanceConfig.maxThreads} threads, ${performanceConfig.threadQueueSize} queue size`);
                        })
                        .on('progress', (progress) => {
                            if (progress.percent && Number.isInteger(progress.percent) && progress.percent % 25 === 0) {
                                this.logger.log(`    ⚡ Progress: ${progress.percent}% - ${videoData.filename}`);
                            }
                        })
                        .on('error', (err) => {
                            this.logger.error(`    ❌ FFmpeg error for ${videoData.filename}:`, err);
                            
                            // Check if this is an audio-related error and retry with compatibility mode
                            const errorMessage = err.message.toLowerCase();
                            if (!useCompatibilityMode && 
                                (errorMessage.includes('audio') || 
                                errorMessage.includes('pan') || 
                                errorMessage.includes('loudnorm') ||
                                errorMessage.includes('channel'))) {
                                
                                this.logger.log(`    🔄 Audio error detected, retrying with compatibility mode...`);
                                return attemptProcessing(true);
                            }
                            
                            reject(new Error(`FFmpeg processing failed: ${err.message}`));
                        })
                        .on('end', async () => {
                            this.logger.log(`    ✅ Preprocessed: ${videoData.filename}`);
                            
                            // Verify output file exists and has reasonable size
                            if (await FileUtils.exists(outputPath)) {
                                const stats = require('fs').statSync(outputPath);
                                if (stats.size > 1024) { // At least 1KB
                                    this.logger.log(`    📁 Output size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
                                    
                                    // Create properly structured processed video data
                                    const processedVideoData = {
                                        ...videoWithMetadata,
                                        processedPath: outputPath,
                                        processedAt: new Date().toISOString()
                                    };
                                    
                                    resolve(processedVideoData);
                                } else {
                                    this.logger.error(`    ❌ Output file too small: ${stats.size} bytes`);
                                    reject(new Error(`Output file is suspiciously small: ${stats.size} bytes`));
                                }
                            } else {
                                this.logger.error(`    ❌ Output file not created: ${outputPath}`);
                                reject(new Error(`Output file was not created: ${outputPath}`));
                            }
                        })
                        .save(outputPath);
                };
                
                // Start processing
                attemptProcessing(false);
                
            } catch (setupError) {
                this.logger.error(`Failed to set up preprocessing for ${videoData.filename}:`, setupError);
                reject(setupError);
            }
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