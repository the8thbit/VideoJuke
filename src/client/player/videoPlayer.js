import Crossfade from './crossfade.js';
import Blur from './blur.js';

export default class VideoPlayer {
    constructor(logger, config) {
        this.logger = logger;
        this.config = config;
        
        this.video1 = document.getElementById('video1');
        this.video2 = document.getElementById('video2');
        this.currentPlayer = 1;
        
        this.crossfade = new Crossfade(logger, config);
        this.blur = new Blur(logger, config);
        
        this.currentVideo = null;
        this.isTransitioning = false;
        this.playbackSpeed = 1.0;
        this.isLooping = false;
        this.isPaused = false;
        this.isMuted = false;
        
        // Simplified state management
        this._transitionLock = false;
        this._eventHandlers = new WeakMap();
        
        // Callbacks
        this.onVideoEndedCallback = null;
        this.onVideoErrorCallback = null;
        this.onNeedNextVideoCallback = null;
        this.onVideoStartedPlayingCallback = null;
        
        this.initializeVideos();
    }
    
    initializeVideos() {
        [this.video1, this.video2].forEach(video => {
            video.muted = false;
            video.volume = 1.0;
            video.preload = 'auto';
            video.controls = false;
            // Ensure clean initial state
            video.src = '';
            video.classList.remove('visible');
        });
    }
    
    async play(videoData, isFirstVideo = false, isManualTransition = false) {
        // Prevent overlapping transitions
        if (this._transitionLock) {
            this.logger.log('Transition already in progress, queuing request');
            return;
        }
        
        this._transitionLock = true;
        
        try {
            const nextPlayer = this.currentPlayer === 1 ? 2 : 1;
            const nextVideo = nextPlayer === 1 ? this.video1 : this.video2;
            const currentVideo = this.currentPlayer === 1 ? this.video1 : this.video2;
            
            this.logger.log(`=== PLAY VIDEO: ${videoData.filename} ===`);
            this.logger.log(`Current player: ${this.currentPlayer} (${currentVideo.id})`);
            this.logger.log(`Next player: ${nextPlayer} (${nextVideo.id})`);
            this.logger.log(`Current video data: ${this.currentVideo?.filename || 'none'}`);
            this.logger.log(`Is first video: ${isFirstVideo}`);
            this.logger.log(`Is manual transition: ${isManualTransition}`);
            this.logger.log(`From history: ${videoData._fromHistory ? 'yes' : 'no'}`);
            
            // Cancel any active operations
            this.crossfade.cancel();
            
            // Store whether current video has content before cleanup
            const currentHasContent = currentVideo.src && currentVideo.src !== '';
            
            // Clean up current video completely (but only if not first video)
            if (!isFirstVideo && currentHasContent) {
                this._cleanupVideo(currentVideo);
            }
            
            // Prepare next video
            await this._prepareVideo(nextVideo, videoData);
            
            // Perform transition - skip crossfade for manual transitions
            if (this.config.crossfade.enabled && !isFirstVideo && currentHasContent && !isManualTransition) {
                await this._performCrossfadeTransition(currentVideo, nextVideo);
            } else {
                await this._performDirectTransition(currentVideo, nextVideo);
            }
            
            // Update state only after successful transition
            this.currentPlayer = nextPlayer;
            this.currentVideo = videoData;
            
            this.logger.log(`State updated: player=${this.currentPlayer}, video=${this.currentVideo.filename}`);
            this.logger.log(`=== PLAY COMPLETE ===`);
            
            // Set up event handling for the new video
            this._setupVideoEventHandlers(nextVideo);
            
            // Schedule next crossfade if applicable - skip for manual transitions
            if (this.config.crossfade.enabled && videoData.metadata?.duration && !isManualTransition) {
                this._scheduleCrossfade(nextVideo);
            }
            
            // Apply effects - skip blur for manual transitions
            if (this.config.blur.enabled && !isFirstVideo && !isManualTransition) {
                this.blur.startVideo(nextVideo);
            }
            
            // Notify playback started
            if (this.onVideoStartedPlayingCallback) {
                this.onVideoStartedPlayingCallback(videoData, isFirstVideo);
            }
            
        } catch (error) {
            this.logger.error('Error playing video', error);
            if (this.onVideoErrorCallback) {
                this.onVideoErrorCallback(error);
            }
        } finally {
            // Always release the lock
            setTimeout(() => {
                this._transitionLock = false;
            }, 100);
        }
    }
    
    async _prepareVideo(video, videoData) {
        this.logger.log(`Preparing video element ${video.id} with: ${videoData.filename}`);
        
        const loadTimeout = this.config.timeouts?.videoLoadTimeout || 10000;
        
        return new Promise((resolve, reject) => {
            // Set up one-time load handlers
            const loadHandler = () => {
                video.removeEventListener('canplaythrough', loadHandler);
                video.removeEventListener('error', errorHandler);
                this.logger.log(`Video ${video.id} ready: ${videoData.filename}`);
                resolve();
            };
            
            const errorHandler = (e) => {
                video.removeEventListener('canplaythrough', loadHandler);
                video.removeEventListener('error', errorHandler);
                reject(new Error(`Failed to load video: ${e.type}`));
            };
            
            // Set video properties
            video.src = `file://${videoData.processedPath}`;
            video.muted = this.isMuted;
            video.volume = 1.0;
            video.playbackRate = this.playbackSpeed;
            video.preservesPitch = true;
            video.loop = false; // We'll handle looping manually
            video.currentTime = 0;
            
            // Reset visual state
            video.style.opacity = '1';
            video.style.filter = '';
            video.classList.remove('visible');
            
            video.addEventListener('canplaythrough', loadHandler, { once: true });
            video.addEventListener('error', errorHandler, { once: true });
            
            // Force load
            video.load();
            
            // Timeout protection
            setTimeout(() => {
                video.removeEventListener('canplaythrough', loadHandler);
                video.removeEventListener('error', errorHandler);
                reject(new Error('Video load timeout'));
            }, loadTimeout);
        });
    }
    
    async _performDirectTransition(currentVideo, nextVideo) {
        nextVideo.classList.add('visible');
        
        if (!this.isPaused) {
            try {
                await nextVideo.play();
            } catch (error) {
                this.logger.error('Failed to start video playback', error);
                throw error;
            }
        }
        
        if (currentVideo.src) {
            currentVideo.classList.remove('visible');
            currentVideo.pause();
            currentVideo.currentTime = 0;
        }
    }
    
    async _performCrossfadeTransition(currentVideo, nextVideo) {
        // Use the simpler crossfade.perform for now
        await this.crossfade.perform(currentVideo, nextVideo);
    }
    
    _setupVideoEventHandlers(video) {
        // Remove any existing handlers first
        this._removeVideoEventHandlers(video);
        
        // Create new handlers
        const handlers = {
            ended: () => this._handleVideoEnded(video),
            error: (e) => this._handleVideoError(video, e),
            seeked: () => this._handleVideoSeeked(video),
            timeupdate: () => this._handleTimeUpdate(video)
        };
        
        // Store handlers for later removal
        this._eventHandlers.set(video, handlers);
        
        // Add event listeners
        Object.entries(handlers).forEach(([event, handler]) => {
            video.addEventListener(event, handler);
        });
    }
    
    _removeVideoEventHandlers(video) {
        const handlers = this._eventHandlers.get(video);
        if (handlers) {
            Object.entries(handlers).forEach(([event, handler]) => {
                video.removeEventListener(event, handler);
            });
            this._eventHandlers.delete(video);
        }
    }
    
    _handleVideoEnded(video) {
        // Ignore if not the current video
        if (video !== this.getCurrentElement()) {
            this.logger.log('Ignoring ended event from non-current video');
            return;
        }
        
        this.logger.log(`Video ended naturally: ${this.currentVideo?.filename || 'unknown'}`);
        
        if (this.isLooping) {
            this.logger.log('Looping enabled, restarting video');
            video.currentTime = 0;
            video.play().catch(err => {
                this.logger.error('Failed to restart looped video', err);
            });
            return;
        }
        
        // Prevent duplicate handling
        if (this._transitionLock) {
            this.logger.log('Transition already in progress, ignoring ended event');
            return;
        }
        
        // Auto-advance to next video
        if (this.onVideoEndedCallback && !this.crossfade.isActive()) {
            this.logger.log('Triggering video ended callback');
            this.onVideoEndedCallback(this.currentVideo);
        }
    }
    
    _handleVideoError(video, event) {
        // Ignore if not the current video
        if (video !== this.getCurrentElement()) {
            return;
        }
        
        const error = event.target.error;
        this.logger.error('Video playback error', error);
        
        if (this.onVideoErrorCallback) {
            this.onVideoErrorCallback(error);
        }
    }
    
    _handleVideoSeeked(video) {
        // Reschedule crossfade after seeking
        if (this.config.crossfade.enabled && video === this.getCurrentElement()) {
            this._scheduleCrossfade(video);
        }
    }
    
    _handleTimeUpdate(video) {
        // Monitor for videos that might be stuck
        if (video === this.getCurrentElement() && video.duration) {
            const timeRemaining = video.duration - video.currentTime;
            if (timeRemaining < 0.1 && !video.paused && !this.isLooping) {
                // Force end if video is stuck near the end
                video.pause();
                this._handleVideoEnded(video);
            }
        }
    }
    
    _scheduleCrossfade(video) {
        if (!video.duration || this.isPaused) {
            return;
        }
        
        this.crossfade.schedule(
            video,
            async () => {
                if (this.onNeedNextVideoCallback) {
                    return await this.onNeedNextVideoCallback();
                }
                return null;
            },
            (nextVideoData) => {
                // Store the video that's ending for history
                const endingVideo = this.currentVideo;
                
                // Update state after crossfade completes
                this.currentVideo = nextVideoData;
                this.currentPlayer = this.currentPlayer === 1 ? 2 : 1;
                
                const newCurrentVideo = this.getCurrentElement();
                this._setupVideoEventHandlers(newCurrentVideo);
                this._scheduleCrossfade(newCurrentVideo);
                
                // Add the video that just ended to history
                if (endingVideo && !endingVideo._fromHistory && this.onVideoEndedCallback) {
                    this.logger.log(`Crossfade complete: adding ${endingVideo.filename} to history`);
                    // Call with special flag to just add to history
                    this.onVideoEndedCallback(endingVideo, true);
                }
            }
        );
    }
    
    _cleanupVideo(video) {
        this.logger.log(`Cleaning up video element: ${video.id}`);
        this._removeVideoEventHandlers(video);
        video.pause();
        video.currentTime = 0;
        video.src = '';
        video.load(); // Force cleanup
        video.classList.remove('visible');
        video.style.opacity = '1';
        video.style.filter = '';
    }
    
    // Manual control methods
    skipToNext() {
        if (this._transitionLock) {
            this.logger.log('Cannot skip during transition');
            return false;
        }
        
        // Cancel any scheduled operations
        this.crossfade.cancel();
        
        // Don't apply blur effects for manual transitions - just clean up any existing effects
        const currentVideo = this.getCurrentElement();
        if (currentVideo.src) {
            this.blur.resetBlur(currentVideo);
        }
        
        return true;
    }
    
    // Playback controls
    togglePlayPause() {
        const currentVideo = this.getCurrentElement();
        if (!currentVideo.src) return;
        
        if (currentVideo.paused) {
            currentVideo.play().then(() => {
                this.isPaused = false;
                // Reschedule crossfade
                if (this.config.crossfade.enabled) {
                    this._scheduleCrossfade(currentVideo);
                }
            }).catch(err => {
                this.logger.error('Failed to resume playback', err);
            });
        } else {
            currentVideo.pause();
            this.isPaused = true;
            this.crossfade.cancel();
        }
    }
    
    setSpeed(speed) {
        this.playbackSpeed = Math.max(this.config.playback.minSpeed, 
                                     Math.min(this.config.playback.maxSpeed, speed));
        
        const currentVideo = this.getCurrentElement();
        if (currentVideo.src) {
            currentVideo.playbackRate = this.playbackSpeed;
            currentVideo.preservesPitch = true;
            
            // Reschedule crossfade due to speed change
            if (this.config.crossfade.enabled && !this.isPaused) {
                this._scheduleCrossfade(currentVideo);
            }
        }
    }
    
    skip(seconds) {
        const currentVideo = this.getCurrentElement();
        if (currentVideo.src && currentVideo.duration) {
            const newTime = Math.max(0, Math.min(currentVideo.duration - 0.1, 
                                                  currentVideo.currentTime + seconds));
            currentVideo.currentTime = newTime;
        }
    }
    
    restart() {
        const currentVideo = this.getCurrentElement();
        if (currentVideo.src) {
            this.crossfade.cancel();
            currentVideo.currentTime = 0;
            
            if (this.isPaused) {
                currentVideo.play().then(() => {
                    this.isPaused = false;
                }).catch(err => {
                    this.logger.error('Failed to restart video', err);
                });
            }
            
            if (this.config.crossfade.enabled) {
                this._scheduleCrossfade(currentVideo);
            }
        }
    }
    
    toggleLoop() {
        this.isLooping = !this.isLooping;
    }
    
    toggleMute() {
        this.isMuted = !this.isMuted;
        const currentVideo = this.getCurrentElement();
        if (currentVideo.src) {
            currentVideo.muted = this.isMuted;
        }
    }
    
    toggleCrossfade() {
        this.config.crossfade.enabled = !this.config.crossfade.enabled;
        this.crossfade.setEnabled(this.config.crossfade.enabled);
        
        if (this.config.crossfade.enabled && !this.isPaused) {
            const currentVideo = this.getCurrentElement();
            if (currentVideo.src) {
                this._scheduleCrossfade(currentVideo);
            }
        }
    }
    
    toggleBlur() {
        this.config.blur.enabled = !this.config.blur.enabled;
        this.blur.setEnabled(this.config.blur.enabled);
    }
    
    // Getters
    getCurrentVideo() {
        return this.currentVideo;
    }
    
    getCurrentElement() {
        return this.currentPlayer === 1 ? this.video1 : this.video2;
    }
    
    getState() {
        const currentElement = this.getCurrentElement();
        return {
            currentVideo: this.currentVideo,
            playbackSpeed: this.playbackSpeed,
            isLooping: this.isLooping,
            isPaused: this.isPaused || (currentElement.src && currentElement.paused),
            isMuted: this.isMuted,
            isTransitioning: this._transitionLock,
            crossfadeActive: this.crossfade.isActive(),
            crossfadeEnabled: this.config.crossfade.enabled,
            blurEnabled: this.config.blur.enabled
        };
    }
    
    // Callbacks
    onVideoEnded(callback) {
        this.onVideoEndedCallback = callback;
    }
    
    onVideoError(callback) {
        this.onVideoErrorCallback = callback;
    }
    
    onNeedNextVideo(callback) {
        this.onNeedNextVideoCallback = callback;
    }
    
    onVideoStartedPlaying(callback) {
        this.onVideoStartedPlayingCallback = callback;
    }
    
    // Cleanup
    cleanup() {
        this.crossfade.cancel();
        
        [this.video1, this.video2].forEach(video => {
            this._cleanupVideo(video);
        });
        
        this.blur.cleanup();
        this.crossfade.cleanup();
    }
}