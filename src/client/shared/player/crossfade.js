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
        
        // More conservative timing to ensure crossfade completes before video ends
        const safetyBuffer = Math.max(0.2, crossfadeDuration * 0.1); // 10% of crossfade duration or 0.2s
        const startTime = Math.max(0, videoDuration - crossfadeDuration - safetyBuffer);
        const currentTime = currentVideo.currentTime;
        const delay = Math.max(0, startTime - currentTime) * 1000;
        
        this.logger.log(`Scheduling crossfade: duration=${crossfadeDuration}s, startTime=${startTime}s, currentTime=${currentTime}s, delay=${delay}ms`);
        
        if (delay <= 100) {
            // Start immediately
            this.start(currentVideo, getNextVideo, onComplete, crossfadeDuration);
        } else {
            this.scheduledTimer = setTimeout(() => {
                if (this.enabled) {
                    this.logger.log('Crossfade timer fired, starting crossfade');
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
        
        // Construct proper video URL
        let videoUrl;
        if (nextVideoData.serverUrl) {
            // Web mode - use HTTP URL
            videoUrl = nextVideoData.serverUrl.startsWith('http') ? 
                nextVideoData.serverUrl : 
                `${window.location.origin}${nextVideoData.serverUrl}`;
        } else {
            // Electron mode - use file URL
            videoUrl = `file://${nextVideoData.processedPath}`;
        }
        
        this.logger.log(`Starting crossfade from ${currentVideo.id} to ${nextVideo.id}, duration: ${duration}s`);
        
        // Prepare next video
        nextVideo.src = videoUrl;
        nextVideo.muted = false;
        nextVideo.volume = 0;
        nextVideo.playbackRate = currentVideo.playbackRate;
        nextVideo.preservesPitch = true;
        nextVideo.loop = currentVideo.loop;
        
        await this.waitForVideoReady(nextVideo);
        
        try {
            await nextVideo.play();
            this.logger.log('Crossfade next video started successfully');
        } catch (error) {
            this.logger.error('Crossfade autoplay failed:', error);
            // Continue with crossfade even if autoplay fails
        }
        
        // Perform fade animation - this will handle completion
        this.animateFade(duration * 1000);
        
        // Set up a safety completion timer (slightly longer than animation)
        const safetyTimeout = setTimeout(() => {
            if (this.activeCrossfade) {
                this.logger.log('Crossfade safety timeout triggered');
                this.complete();
            }
        }, (duration * 1000) + 500);
        
        // Store the timeout so we can cancel it
        this.activeCrossfade.safetyTimeout = safetyTimeout;
    }

    animateFade(durationMs) {
        const { currentVideo, nextVideo } = this.activeCrossfade;
        const startTime = Date.now();
        
        this.logger.log(`Starting fade animation: ${durationMs}ms duration`);
        
        const animate = () => {
            if (!this.activeCrossfade) {
                this.logger.log('Animation cancelled - no active crossfade');
                return;
            }
            
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
                this.logger.log('Fade animation completed');
                this.finalizeStates();
                // Complete the crossfade when animation is done
                setTimeout(() => this.complete(), 0);
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
        
        const { currentVideo, nextVideo, nextVideoData, onComplete, safetyTimeout } = this.activeCrossfade;
        
        // Cancel safety timeout
        if (safetyTimeout) {
            clearTimeout(safetyTimeout);
        }
        
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
                this.logger.log(`Crossfade complete callback for: ${nextVideoData.filename}`);
                onComplete(nextVideoData);
            }, 0);
        }
    }
    
    cancel() {
        if (this.scheduledTimer) {
            clearTimeout(this.scheduledTimer);
            this.scheduledTimer = null;
            this.logger.log('Cancelled scheduled crossfade');
        }
        
        if (this.activeCrossfade) {
            this.logger.log('Cancelling active crossfade');
            this.cleanup();
        }
    }
    
    cleanup() {
        // Clear safety timeout if it exists
        if (this.activeCrossfade?.safetyTimeout) {
            clearTimeout(this.activeCrossfade.safetyTimeout);
        }
        
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
    
    async perform(currentVideo, nextVideo) {
        // Set active state to prevent video ended events from interrupting
        this.activeCrossfade = {
            currentVideo,
            nextVideo,
            isLegacyPerform: true
        };
        
        return new Promise((resolve) => {
            const duration = this.duration;
            
            this.logger.log(`Starting legacy crossfade: ${duration}ms duration`);
            
            nextVideo.style.opacity = '0';
            nextVideo.classList.add('visible');
            
            nextVideo.play().then(() => {
                // Reduced delay for more responsive crossfade
                setTimeout(() => {
                    const startTime = Date.now();
                    
                    const animate = () => {
                        // Check if crossfade was cancelled
                        if (!this.activeCrossfade) {
                            this.logger.log('Legacy crossfade cancelled');
                            resolve();
                            return;
                        }
                        
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
                            this.logger.log('Legacy crossfade animation completed');
                            
                            // Finalize states
                            currentVideo.classList.remove('visible');
                            currentVideo.pause();
                            nextVideo.style.opacity = '';
                            currentVideo.style.opacity = '';
                            
                            if (this.config.blur.enabled) {
                                currentVideo.style.filter = '';
                                nextVideo.style.filter = '';
                            }
                            
                            // Clear active state
                            this.activeCrossfade = null;
                            
                            resolve();
                        }
                    };
                    
                    requestAnimationFrame(animate);
                }, 25); // Reduced from 50ms to 25ms
            }).catch(error => {
                this.logger.error('Error in legacy crossfade', error);
                this.activeCrossfade = null;
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
}