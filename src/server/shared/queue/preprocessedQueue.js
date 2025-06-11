const path = require('path');
const FileUtils = require('../utils/fileUtils');
const VideoPreprocessor = require('../video/videoPreprocessor');

class PreprocessedQueue {
    constructor(logger, configManager, videoIndex, stats) {
        this.logger = logger;
        this.configManager = configManager;
        this.videoIndex = videoIndex;
        this.stats = stats;
        this.queue = [];
        this.isProcessing = false;
        this.tempDir = path.join(process.cwd(), 'temp');
        this.preprocessor = null;
        
        this.initTempDir();
    }
    
    async initTempDir() {
        if (this.isInitialized) {
            return;
        }
        
        try {
            this.logger.log('Initializing preprocessed queue...');
            await FileUtils.ensureDirectory(this.tempDir);
            this.preprocessor = new VideoPreprocessor(this.logger, this.tempDir, this.configManager);
            this.isInitialized = true;
            this.logger.log('VideoPreprocessor initialized successfully');
        } catch (error) {
            this.logger.error('Failed to initialize VideoPreprocessor:', error);
            throw error;
        }
    }
    
    async ensureReady() {
        if (!this.isInitialized || !this.preprocessor) {
            this.logger.log('Preprocessor not ready, initializing...');
            await this.initTempDir();
        }
        
        if (!this.preprocessor) {
            throw new Error('Failed to initialize preprocessor');
        }
    }
    
    async fill(targetSize = null, progressCallback = null) {
        if (this.isProcessing) {
            return;
        }
        
        this.isProcessing = true;
        
        try {
            // Ensure preprocessor is ready before proceeding
            await this.ensureReady();
            
            const target = targetSize || this.configManager.config.video.preprocessedQueueSize;
            const needed = target - this.queue.length;
            
            this.logger.log(`Filling preprocessed queue: current=${this.queue.length}, target=${target}, needed=${needed}`);
            
            if (needed <= 0) {
                if (progressCallback) progressCallback(1.0);
                return;
            }
            
            // Get videos to process
            const processedPaths = new Set(this.queue.map(v => v.originalPath));
            const videosToProcess = [];
            
            for (let i = 0; i < needed; i++) {
                try {
                    const video = this.videoIndex.getRandomVideo([...processedPaths]);
                    if (!video) {
                        this.logger.log(`No more unique videos available after ${i} selections`);
                        break;
                    }
                    
                    processedPaths.add(video.originalPath);
                    videosToProcess.push(video);
                } catch (error) {
                    this.logger.error(`Error getting random video (iteration ${i}):`, error);
                    break;
                }
            }
            
            if (videosToProcess.length === 0) {
                this.logger.log('No videos to process');
                return;
            }
            
            this.logger.log(`Selected ${videosToProcess.length} videos for processing`);
            
            // Process videos
            let processedCount = 0;
            for (const videoData of videosToProcess) {
                try {
                    this.logger.log(`Processing video: ${videoData.filename}`);
                    
                    if (!(await FileUtils.exists(videoData.originalPath))) {
                        this.logger.log(`Skipping missing file: ${videoData.originalPath}`);
                        continue;
                    }
                    
                    const processedVideo = await this.preprocessor.preprocess(videoData);
                    this.queue.push(processedVideo);
                    processedCount++;
                    this.stats.preprocessedVideos++;
                    
                    this.logger.log(`Preprocessed: ${processedVideo.filename} (${this.queue.length}/${target})`);
                    
                    if (progressCallback) {
                        progressCallback(this.queue.length / target);
                    }
                    
                } catch (error) {
                    this.logger.error(`Failed to preprocess: ${videoData.filename}`, error);
                    this.stats.preprocessingErrors++;
                    
                    // Add more detailed error information
                    if (error.message && error.message.includes('window')) {
                        this.logger.error('Window reference detected in preprocessing - this should not happen in main process');
                        this.logger.error('Error stack:', error.stack);
                    }
                }
            }
            
            this.logger.log(`Preprocessing complete: ${processedCount} videos added`);
            
        } catch (error) {
            this.logger.error('Error in fill method:', error);
            
            // Add detailed error logging
            if (error.message && error.message.includes('window')) {
                this.logger.error('Window reference detected in fill method');
                this.logger.error('Error stack:', error.stack);
                this.logger.error('Preprocessor state:', {
                    hasPreprocessor: !!this.preprocessor,
                    hasConfigManager: !!this.configManager,
                    hasVideoIndex: !!this.videoIndex
                });
            }
            
            throw error;
        } finally {
            this.isProcessing = false;
        }
    }
    
    async clear() {
        for (const video of this.queue) {
            await FileUtils.deleteFile(video.processedPath);
        }
        this.queue = [];
    }

    getNext() {
        if (this.queue.length === 0) {
            this.logger.log('Preprocessed queue empty');
            return null;
        }
        
        // Find a video with an existing file
        let video = null;
        let attempts = 0;
        const maxAttempts = Math.min(this.queue.length, 10);
        
        while (attempts < maxAttempts && !video) {
            const randomIndex = Math.floor(Math.random() * this.queue.length);
            const candidate = this.queue.splice(randomIndex, 1)[0];
            
            // Validate file exists
            if (candidate.processedPath && FileUtils.exists(candidate.processedPath)) {
                video = candidate;
            } else {
                this.logger.error(`Processed file missing for: ${candidate.filename}, removing from queue`);
                this.stats.preprocessingErrors++;
            }
            
            attempts++;
        }
        
        if (!video) {
            this.logger.error('No valid videos found in preprocessed queue');
            // Trigger immediate refill
            setImmediate(() => this.fill());
            return null;
        }
        
        this.logger.log(`Dequeued: ${video.filename} (remaining: ${this.queue.length})`);
        
        // Trigger refill immediately if below target
        if (this.queue.length < this.configManager.config.video.preprocessedQueueSize && !this.isProcessing) {
            this.logger.log('Preprocessed queue below target, triggering immediate refill');
            setImmediate(() => this.fill());
        }
        
        return video;
    }
    
    async cleanupVideo(videoData) {
        if (videoData?.processedPath) {
            await FileUtils.deleteFile(videoData.processedPath);
        }
    }

    async validateQueue() {
        const validVideos = [];
        let invalidCount = 0;
        
        for (const video of this.queue) {
            if (video.processedPath && await FileUtils.exists(video.processedPath)) {
                validVideos.push(video);
            } else {
                this.logger.error(`Removing video with missing file from queue: ${video.filename}`);
                invalidCount++;
            }
        }
        
        if (invalidCount > 0) {
            this.logger.log(`Queue validation: removed ${invalidCount} videos with missing files`);
            this.queue = validVideos;
            
            // Trigger refill if needed
            if (this.queue.length < this.configManager.config.video.preprocessedQueueSize) {
                setImmediate(() => this.fill());
            }
        }
    }

    startMonitoring() {
        const monitorInterval = this.configManager.getTimeout('queueMonitorInterval', 30000);
        const criticalMonitorInterval = this.configManager.getTimeout('queueCriticalMonitorInterval', 5000);
        
        // Monitor queue size periodically
        setInterval(async () => {
            // First validate the queue
            await this.validateQueue();
            
            const minSize = this.configManager.config.video.preprocessedQueueSize;
            const currentSize = this.queue.length;
            
            if (currentSize < minSize && !this.isProcessing && this.videoIndex.getCount() > 0) {
                this.logger.log(`Preprocessed queue below minimum: ${currentSize}/${minSize}, refilling...`);
                await this.fill();
            } else if (currentSize === 0 && !this.isProcessing) {
                this.logger.error(`Preprocessed queue empty! Emergency refill...`);
                await this.fill();
            }
        }, monitorInterval);
        
        // Also monitor more frequently when queue is very low
        setInterval(async () => {
            if (this.queue.length < 5 && !this.isProcessing && this.videoIndex.getCount() > 0) {
                this.logger.log(`Preprocessed queue critically low: ${this.queue.length}, refilling...`);
                await this.fill();
            }
        }, criticalMonitorInterval);
    }

    size() {
        return this.queue.length;
    }
    
    getQueue() {
        return this.queue;
    }
    
    setQueue(queue) {
        this.queue = queue || [];
    }
}

module.exports = PreprocessedQueue;