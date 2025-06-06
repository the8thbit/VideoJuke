export default class PlaybackQueue {
    constructor(logger, config) {
        this.logger = logger;
        this.config = config;
        this.queue = [];
        this.isLoading = false;
        this.testVideo = null;
        this.minSize = config.video.playbackQueueSize;
        this.initThreshold = config.video.playbackQueueInitializationThreshold;
        
        this.createTestVideo();
    }
    
    createTestVideo() {
        this.testVideo = document.createElement('video');
        this.testVideo.style.display = 'none';
        this.testVideo.muted = true;
        this.testVideo.volume = 0;
        this.testVideo.preload = 'auto';
        document.body.appendChild(this.testVideo);
    }
    
    async buildInitialQueue(progressCallback) {
        this.logger.log(`Building initial queue (target: ${this.initThreshold})`);
        
        let attempts = 0;
        const maxAttempts = this.config.retries?.maxQueueBuildAttempts || 3;
        
        while (attempts < maxAttempts) {
            attempts++;
            this.logger.log(`Queue build attempt ${attempts}/${maxAttempts}`);
            
            // Try to fill to initialization threshold
            const result = await this.fill(this.initThreshold, false, progressCallback);
            
            if (this.queue.length >= this.initThreshold) {
                this.logger.log(`Initial queue ready with ${this.queue.length} videos`);
                
                // Continue filling to minimum size in background
                if (this.queue.length < this.minSize) {
                    const backgroundDelay = this.config.timeouts?.backgroundFillDelay || 2000;
                    setTimeout(() => this.fill(), backgroundDelay);
                }
                
                return true;
            }
            
            this.logger.log(`Attempt ${attempts}: Only got ${this.queue.length} videos, need ${this.initThreshold}`);
            
            // Check if we should give up early
            if (this.queue.length === 0 && attempts >= 2) {
                this.logger.error('No videos obtained after multiple attempts, likely no videos available');
                break;
            }
            
            // Wait a bit before retry, increasing delay each time
            if (attempts < maxAttempts) {
                const retryDelay = (this.config.timeouts?.backgroundFillRetryDelay || 2000) * attempts;
                this.logger.log(`Waiting ${retryDelay}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
        
        // If we couldn't reach threshold after attempts, check if we have any videos
        if (this.queue.length > 0) {
            this.logger.log(`Starting with only ${this.queue.length} videos (below threshold of ${this.initThreshold})`);
            
            // Try to fill more aggressively in background
            const backgroundDelay = this.config.timeouts?.backgroundFillDelay || 500;
            setTimeout(() => this.fill(), backgroundDelay);
            
            return true;
        }
        
        this.logger.error('Failed to build initial queue - no videos available');
        return false;
    }
    
    async fill(targetSize = null, allowEarlyReturn = false, progressCallback = null) {
        if (this.isLoading) {
            return { reachedTarget: false, canStartPlayback: false };
        }
        
        this.isLoading = true;
        
        try {
            const fillTarget = targetSize || this.minSize;
            
            while (this.queue.length < fillTarget) {
                if (progressCallback) {
                    progressCallback({
                        playbackCurrent: this.queue.length,
                        playbackTarget: fillTarget
                    });
                }
                
                // Check for early return
                if (allowEarlyReturn && this.queue.length >= this.initThreshold) {
                    this.isLoading = false;
                    return { reachedTarget: false, canStartPlayback: true };
                }
                
                // Get video from main process
                const videoData = await window.electronAPI.getNextVideo();
                
                if (!videoData) {
                    this.logger.error('No video data received');
                    break;
                }
                
                // Test video playability
                const isPlayable = await this.testVideoPlayability(videoData);
                
                if (isPlayable) {
                    // Add crossfade timing if needed
                    const videoWithTiming = this.addCrossfadeTiming(videoData);
                    this.queue.push(videoWithTiming);
                    this.logger.log(`Added to queue: ${videoWithTiming.filename} (${this.queue.length}/${fillTarget})`);
                } else {
                    this.logger.log(`Unplayable video: ${videoData.filename}`);
                    await window.electronAPI.videoEnded(videoData);
                }
            }
            
            this.isLoading = false;
            
            return {
                reachedTarget: this.queue.length >= fillTarget,
                canStartPlayback: this.queue.length >= Math.min(this.initThreshold, 1)
            };
            
        } catch (error) {
            this.logger.error('Error filling queue:', error);
            this.isLoading = false;
            return { 
                reachedTarget: false, 
                canStartPlayback: this.queue.length >= 1
            };
        }
    }
    
    addCrossfadeTiming(videoData) {
        if (!videoData.metadata || !videoData.metadata.duration) {
            return videoData;
        }
        
        const duration = videoData.metadata.duration;
        const configDuration = this.config.crossfade.duration / 1000;
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
            ...videoData,
            crossfadeTiming: {
                duration: crossfadeDuration,
                startTime: startTime
            }
        };
    }
    
    async testVideoPlayability(videoData) {
        const testTimeout = this.config.timeouts?.videoTestTimeout || 5000;
        
        return new Promise((resolve) => {
            if (!this.testVideo) {
                resolve(false);
                return;
            }
            
            this.testVideo.src = `file://${videoData.processedPath}`;
            
            const cleanup = () => {
                this.testVideo.removeEventListener('canplay', onCanPlay);
                this.testVideo.removeEventListener('error', onError);
                this.testVideo.pause();
                this.testVideo.src = '';
            };
            
            const onCanPlay = () => {
                cleanup();
                resolve(true);
            };
            
            const onError = () => {
                cleanup();
                resolve(false);
            };
            
            this.testVideo.addEventListener('canplay', onCanPlay);
            this.testVideo.addEventListener('error', onError);
            
            // Try to play
            this.testVideo.play().catch(() => {
                cleanup();
                resolve(false);
            });
            
            // Timeout
            setTimeout(() => {
                cleanup();
                resolve(false);
            }, testTimeout);
        });
    }

    async getNext() {
        if (this.queue.length === 0) {
            this.logger.error('Playback queue empty');
            return null;
        }
        
        const video = this.queue.shift();
        this.logger.log(`Dequeued: ${video.filename} (remaining: ${this.queue.length})`);
        
        // Refill if below minimum
        if (this.queue.length < this.minSize && !this.isLoading) {
            const refillDelay = this.config.timeouts?.queueRefillDelay || 100;
            setTimeout(() => this.fill(), refillDelay);
        }
        
        return video;
    }
    
    addBack(videoData) {
        if (!videoData || !videoData.processedPath) {
            return false;
        }
        
        // Check for duplicates
        const exists = this.queue.some(v => 
            v.processedPath === videoData.processedPath || 
            v.originalPath === videoData.originalPath
        );
        
        if (exists) {
            return false;
        }
        
        // Add missing crossfade timing if needed
        const videoWithTiming = videoData.crossfadeTiming ? 
            videoData : this.addCrossfadeTiming(videoData);
        
        this.queue.unshift(videoWithTiming);
        this.logger.log(`Added back to queue: ${videoWithTiming.filename} (total: ${this.queue.length})`);
        
        // Remove oldest if significantly over capacity
        const maxSize = this.minSize + Math.floor(this.minSize * 0.2);
        if (this.queue.length > maxSize) {
            const removed = this.queue.pop();
            this.logger.log(`Queue over capacity, removed: ${removed.filename}`);
        }
        
        return true;
    }
    
    startMonitoring() {
        const monitorInterval = this.config.timeouts?.queueMonitorInterval || 30000;
        
        // Monitor queue size periodically
        setInterval(() => {
            if (this.queue.length < this.minSize && !this.isLoading) {
                this.logger.log(`Queue below minimum: ${this.queue.length}/${this.minSize}`);
                this.fill();
            }
        }, monitorInterval);
    }
    
    getQueueForPersistence() {
        return this.queue.map(video => ({
            ...video,
            fromPlaybackQueue: true
        }));
    }
    
    getSize() {
        return this.queue.length;
    }
    
    cleanup() {
        if (this.testVideo) {
            this.testVideo.remove();
        }
    }
}