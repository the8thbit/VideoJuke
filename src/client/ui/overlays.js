import { formatVideoDetails, formatTime, formatTimeDuration } from '../utils/formatter.js';

export default class Overlays {
    constructor(logger, config) {
        this.logger = logger;
        this.config = config;
        
        // Get overlay elements
        this.infoOverlay = document.getElementById('infoOverlay');
        this.videoTitle = document.getElementById('videoTitle');
        this.videoDetails = document.getElementById('videoDetails');
        
        this.errorOverlay = document.getElementById('errorOverlay');
        this.errorMessage = document.getElementById('errorMessage');
        
        this.statusIndicator = document.getElementById('statusIndicator');
        this.statusIcon = document.getElementById('statusIcon');
        
        this.debugOverlay = document.getElementById('debugOverlay');
        this.debugVisible = false;
        this.debugUpdateInterval = null;
        this.debugCallbacks = null;
        
        this.controlsOverlay = document.getElementById('controlsOverlay');
        this.controlsVisible = false;
    }
    
    showInfo(title, details = '', duration = null) {
        const displayDuration = duration || this.config.ui.infoDuration;
        
        if (this.videoTitle) {
            this.videoTitle.textContent = title;
        }
        if (this.videoDetails) {
            this.videoDetails.textContent = details;
        }
        
        this.show(this.infoOverlay, displayDuration);
    }
    
    showVideoInfo(videoData, titleOnly = false) {
        if (!videoData) {
            return;
        }
        
        const fileName = videoData.filename;
        
        if (titleOnly) {
            this.showInfo(fileName, '', this.config.ui.tempInfoDuration);
        } else {
            const details = formatVideoDetails(videoData.metadata);
            this.showInfo(fileName, details, this.config.ui.tempInfoDuration);
        }
    }
    
    showError(message) {
        // Check if error toasts are enabled
        if (this.config.ui?.showErrorToast === false) {
            this.logger.log(`Error toast suppressed: ${message}`);
            return;
        }
        
        if (this.errorMessage) {
            this.errorMessage.textContent = message;
        }
        
        this.show(this.errorOverlay, this.config.ui.errorDuration);
    }
    
    showStatus(icon, duration = null) {
        const displayDuration = duration || this.config.timeouts?.statusDisplayDuration || 1500;
        
        if (this.statusIcon) {
            this.statusIcon.textContent = icon;
        }
        
        this.show(this.statusIndicator, displayDuration);
    }
    
    toggleDebug(getPlayerState, getQueueSize, getHistory) {
        this.debugVisible = !this.debugVisible;
        
        if (this.debugOverlay) {
            this.debugOverlay.style.display = this.debugVisible ? 'block' : 'none';
            
            if (this.debugVisible) {
                this.debugCallbacks = {
                    getPlayerState,
                    getQueueSize,
                    getHistory
                };
                
                this.updateDebug();
                
                if (!this.debugUpdateInterval) {
                    const updateInterval = this.config.timeouts?.debugUpdateInterval || 2000;
                    this.debugUpdateInterval = setInterval(() => {
                        if (this.debugVisible) {
                            this.updateDebug();
                        }
                    }, updateInterval);
                }
            } else {
                if (this.debugUpdateInterval) {
                    clearInterval(this.debugUpdateInterval);
                    this.debugUpdateInterval = null;
                }
                this.debugCallbacks = null;
            }
        }
    }
    
async updateDebug() {
        if (!this.debugVisible || !this.debugCallbacks) return;
        
        try {
            const stats = await window.electronAPI.getDetailedStats();
            const playerState = this.debugCallbacks.getPlayerState();
            const queueSize = this.debugCallbacks.getQueueSize();
            const historyInfo = await this.debugCallbacks.getHistory();
            
            // Update debug content
            document.getElementById('debugQueue').textContent = 
                `${queueSize}/${stats.playbackQueueTarget} (preprocessed: ${stats.preprocessedQueueSize}/${stats.preprocessedQueueTarget})`;
            
            document.getElementById('debugHistory').textContent = 
                `Playback: ${historyInfo.playbackHistoryCount}/${historyInfo.playbackHistorySize}, Persisted: ${historyInfo.persistedHistoryCount}/${historyInfo.persistedHistorySize}`;
            
            document.getElementById('debugCurrentVideo').textContent = 
                playerState.currentVideo ? playerState.currentVideo.filename : 'None';
            
            document.getElementById('debugPlayback').textContent = 
                `${playerState.playbackSpeed}x, ${playerState.isPaused ? 'paused' : 'playing'}, ${playerState.isLooping ? 'loop' : 'no loop'}`;
            
            document.getElementById('debugEffects').textContent = 
                `Crossfade: ${playerState.crossfadeEnabled ? 'on' : 'off'}, Blur: ${playerState.blurEnabled ? 'on' : 'off'}`;
            
            document.getElementById('debugSession').textContent = 
                `Played: ${stats.videosPlayedThisSession}, Errors: ${stats.videosSkippedErrors}, Skips: ${stats.videosSkippedManual}`;
            
        } catch (error) {
            this.logger.error('Failed to update debug overlay', error);
        }
    }
    
    toggleControls() {
        this.controlsVisible = !this.controlsVisible;
        
        if (this.controlsOverlay) {
            this.controlsOverlay.style.display = this.controlsVisible ? 'block' : 'none';
        }
    }
    
    // Helper method to show/hide overlays
    show(element, duration) {
        if (!element) return;
        
        element.classList.add('visible');
        
        if (duration && duration > 0) {
            setTimeout(() => {
                element.classList.remove('visible');
            }, duration);
        }
    }
    
    cleanup() {
        if (this.debugUpdateInterval) {
            clearInterval(this.debugUpdateInterval);
            this.debugUpdateInterval = null;
        }
    }
}