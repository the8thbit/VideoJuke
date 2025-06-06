export default class Crossfade {
    constructor(logger, config) {
        this.logger = logger;
        this.config = config;
        this.duration = config.crossfade.duration;
        this.enabled = config.crossfade.enabled;
        
        this.activeCrossfade = null;
        this.scheduledTimer = null;
        this.MIN_DURATION = config.timeouts?.crossfadeMinDuration || 200; // Minimum crossfade duration in ms
        this.BUFFER_TIME = config.timeouts?.crossfadeBufferTime || 500; // Buffer time for video loading
    }
    
    schedule(currentVideo, getNextVideo, onComplete) {
        if (!this.enabled || !currentVideo.duration) {
            return;
        }
        
        this.cancel();
        
        const videoDuration = currentVideo.duration;
        const crossfadeDuration = this.calculateCrossfadeDuration(videoDuration);
        const startTime = Math.max(0, videoDuration - crossfadeDuration - (this.BUFFER_TIME / 1000));
        const currentTime = currentVideo.currentTime;
        const delay = Math.max(0, startTime - currentTime) * 1000;
        
        if (delay <= 100) {
            // Start immediately
            this.start(currentVideo, getNextVideo, onComplete, crossfadeDuration);
        } else {
            this.scheduledTimer = setTimeout(() => {
                if (this.enabled) {
                    this.start(currentVideo, getNextVideo, onComplete, crossfadeDuration);
                }
            }, delay);
        }
    }
    
    reschedule(currentVideo) {
        if (!this.enabled || this.activeCrossfade) {
            return;
        }
        
        // Find stored scheduling info and reschedule
        if (currentVideo._crossfadeInfo) {
            const { getNextVideo, onComplete } = currentVideo._crossfadeInfo;
            this.schedule(currentVideo, getNextVideo, onComplete);
        }
    }
    
    async start(currentVideo, getNextVideo, onComplete, duration) {
        if (this.activeCrossfade || !this.enabled) {
            return;
        }
        
        try {
            const nextVideoData = await getNextVideo();
            if (!nextVideoData) {
                this.logger.error('No next video available for crossfade');
                return;
            }
            
            const nextVideo = this.getOtherVideoElement(currentVideo);
            if (!nextVideo) {
                return;
            }
            
            // Store scheduling info for rescheduling
            currentVideo._crossfadeInfo = { getNextVideo, onComplete };
            
            this.activeCrossfade = {
                currentVideo,
                nextVideo,
                nextVideoData,
                onComplete,
                duration
            };
            
            await this.performCrossfade();
            
        } catch (error) {
            this.logger.error('Error starting crossfade', error);
            this.cleanup();
        }
    }
    
    async performCrossfade() {
        const { currentVideo, nextVideo, nextVideoData, onComplete, duration } = this.activeCrossfade;
        
        // Prepare next video
        nextVideo.src = `file://${nextVideoData.processedPath}`;
        nextVideo.muted = currentVideo.muted;
        nextVideo.volume = 0;
        nextVideo.playbackRate = currentVideo.playbackRate;
        nextVideo.preservesPitch = true;
        nextVideo.loop = currentVideo.loop;
        
        await this.waitForVideoReady(nextVideo);
        await nextVideo.play();
        
        // Perform fade animation
        this.animateFade(duration * 1000);
        
        // Handle completion
        const onEnd = () => {
            currentVideo.removeEventListener('ended', onEnd);
            this.complete();
        };
        
        currentVideo.addEventListener('ended', onEnd);
        
        setTimeout(() => {
            currentVideo.removeEventListener('ended', onEnd);
            this.complete();
        }, duration * 1000);
    }
    
    animateFade(durationMs) {
        const { currentVideo, nextVideo } = this.activeCrossfade;
        const startTime = Date.now();
        
        const animate = () => {
            if (!this.activeCrossfade) return;
            
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / durationMs, 1);
            
            // Easing function
            const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
            
            // Apply fade
            currentVideo.style.opacity = (1 - eased).toString();
            nextVideo.style.opacity = eased.toString();
            currentVideo.volume = Math.max(0, 1 - eased);
            nextVideo.volume = Math.min(1, eased);
            
            // Apply blur if enabled
            if (this.config.blur.enabled) {
                const maxBlur = this.config.blur.maxAmount || 8;
                currentVideo.style.filter = `blur(${eased * maxBlur}px)`;
                nextVideo.style.filter = `blur(${(1 - eased) * maxBlur}px)`;
            }
            
            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                this.finalizeStates();
            }
        };
        
        requestAnimationFrame(animate);
    }
    
    finalizeStates() {
        const { currentVideo, nextVideo } = this.activeCrossfade;
        
        currentVideo.style.opacity = '0';
        nextVideo.style.opacity = '1';
        currentVideo.volume = 0;
        nextVideo.volume = 1;
        
        if (this.config.blur.enabled) {
            currentVideo.style.filter = `blur(${this.config.blur.maxAmount || 8}px)`;
            nextVideo.style.filter = 'blur(0px)';
        }
    }
    
    complete() {
        if (!this.activeCrossfade) return;
        
        this.logger.log('Completing crossfade');
        
        const { currentVideo, nextVideo, nextVideoData, onComplete } = this.activeCrossfade;
        
        // Update visual states
        if (nextVideo) {
            nextVideo.classList.add('visible');
            nextVideo.style.opacity = '';
            nextVideo.style.filter = '';
        }
        
        if (currentVideo) {
            currentVideo.classList.remove('visible');
            currentVideo.style.opacity = '';
            currentVideo.style.filter = '';
            currentVideo.pause();
            
            // Clean up crossfade info
            delete currentVideo._crossfadeInfo;
        }
        
        // Clear active crossfade
        this.activeCrossfade = null;
        
        // Trigger completion callback after clearing state
        if (onComplete && nextVideoData) {
            // Defer callback to prevent stack issues
            setTimeout(() => {
                onComplete(nextVideoData);
            }, 0);
        }
    }
    
    cancel() {
        if (this.scheduledTimer) {
            clearTimeout(this.scheduledTimer);
            this.scheduledTimer = null;
        }
        
        if (this.activeCrossfade) {
            this.cleanup();
        }
    }
    
    cleanup() {
        if (this.activeCrossfade) {
            const { currentVideo, nextVideo } = this.activeCrossfade;
            
            if (currentVideo) {
                currentVideo.style.opacity = '';
                currentVideo.style.filter = '';
            }
            
            if (nextVideo) {
                nextVideo.style.opacity = '';
                nextVideo.style.filter = '';
                nextVideo.pause();
                nextVideo.src = '';
            }
        }
        
        this.activeCrossfade = null;
    }
    
    calculateCrossfadeDuration(videoDuration) {
        const configDuration = this.duration / 1000;
        
        if (videoDuration < configDuration * 2) {
            return Math.max(videoDuration / 2, this.MIN_DURATION / 1000);
        }
        
        return Math.min(configDuration, videoDuration * 0.8, 
                       Math.max(configDuration, this.MIN_DURATION / 1000));
    }
    
    getOtherVideoElement(currentVideo) {
        const video1 = document.getElementById('video1');
        const video2 = document.getElementById('video2');
        return currentVideo === video1 ? video2 : video1;
    }
    
    waitForVideoReady(video) {
        return new Promise((resolve, reject) => {
            const onCanPlay = () => {
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('error', onError);
                resolve();
            };
            
            const onError = () => {
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('error', onError);
                reject(new Error('Video load error'));
            };
            
            video.addEventListener('canplay', onCanPlay);
            video.addEventListener('error', onError);
            
            setTimeout(() => {
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('error', onError);
                reject(new Error('Video load timeout'));
            }, 10000);
        });
    }
    
    // Legacy perform method for backward compatibility
    async perform(currentVideo, nextVideo) {
        return new Promise((resolve) => {
            const duration = this.duration;
            
            nextVideo.style.opacity = '0';
            nextVideo.classList.add('visible');
            
            nextVideo.play().then(() => {
                setTimeout(() => {
                    // Implement animation directly instead of relying on this.animateFade
                    const startTime = Date.now();
                    
                    const animate = () => {
                        const elapsed = Date.now() - startTime;
                        const progress = Math.min(elapsed / duration, 1);
                        
                        // Easing function
                        const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
                        
                        // Apply fade
                        currentVideo.style.opacity = (1 - eased).toString();
                        nextVideo.style.opacity = eased.toString();
                        currentVideo.volume = Math.max(0, 1 - eased);
                        nextVideo.volume = Math.min(1, eased);
                        
                        // Apply blur if enabled
                        if (this.config.blur.enabled) {
                            const maxBlur = this.config.blur.maxAmount || 8;
                            currentVideo.style.filter = `blur(${eased * maxBlur}px)`;
                            nextVideo.style.filter = `blur(${(1 - eased) * maxBlur}px)`;
                        }
                        
                        if (progress < 1) {
                            requestAnimationFrame(animate);
                        } else {
                            // Finalize states
                            currentVideo.classList.remove('visible');
                            currentVideo.pause();
                            nextVideo.style.opacity = '';
                            currentVideo.style.opacity = '';
                            
                            if (this.config.blur.enabled) {
                                currentVideo.style.filter = '';
                                nextVideo.style.filter = '';
                            }
                            
                            resolve();
                        }
                    };
                    
                    requestAnimationFrame(animate);
                }, 50);
            }).catch(error => {
                this.logger.error('Error in legacy crossfade', error);
                resolve();
            });
        });
    }
    
    isActive() {
        return this.activeCrossfade !== null;
    }
    
    isScheduled() {
        return this.scheduledTimer !== null;
    }
    
    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) {
            this.cancel();
        }
    }
    
    cleanup() {
        this.cancel();
    }
}