export default class Controls {
    constructor(logger, config, videoPlayer, overlays) {
        this.logger = logger;
        this.config = config;
        this.videoPlayer = videoPlayer;
        this.overlays = overlays;
        
        // Callbacks
        this.onNextVideoCallback = null;
        this.onPreviousVideoCallback = null;
        this.getQueueSize = null;
        this.playbackQueue = null;
        
        // Prevent double-triggering
        this._commandInProgress = false;
        
        this.setupEventListeners();
    }
    
    async previousVideo() {
        if (this._commandInProgress) {
            this.logger.log('Command already in progress');
            return;
        }
        
        this._commandInProgress = true;
        
        try {
            // Get previous video from server's HistoryManager
            const previousVideo = await window.electronAPI.getPreviousVideo();
            
            if (!previousVideo) {
                this.logger.log('No previous video available');
                this.overlays.showError('No previous video available');
                return;
            }
            
            // Trigger the callback with the previous video
            if (this.onPreviousVideoCallback) {
                this.onPreviousVideoCallback(previousVideo);
            }
            
        } catch (error) {
            this.logger.error('Error getting previous video', error);
            this.overlays.showError('Error accessing previous video');
        } finally {
            // Reset flag after delay
            const commandCooldown = this.config.timeouts?.commandCooldown || 200;
            setTimeout(() => {
                this._commandInProgress = false;
            }, commandCooldown);
        }
    }
    
    async addToHistory(videoData) {
        if (!videoData || !videoData.originalPath) {
            this.logger.log('Invalid video data for history');
            return;
        }
        
        try {
            await window.electronAPI.addToHistory(videoData);
            this.logger.log(`Added to history: ${videoData.filename}`);
        } catch (error) {
            this.logger.error('Failed to add video to history', error);
        }
    }
    
    async getHistory() {
        // Get history info for debug display
        try {
            const stats = await window.electronAPI.getDetailedStats();
            return {
                playbackHistoryCount: stats.playbackHistoryCount || 0,
                persistedHistoryCount: stats.persistedHistoryCount || 0,
                playbackHistorySize: stats.playbackHistorySize || 0,
                persistedHistorySize: stats.persistedHistorySize || 0
            };
        } catch (error) {
            this.logger.error('Failed to get history info', error);
            return {
                playbackHistoryCount: 0,
                persistedHistoryCount: 0,
                playbackHistorySize: 0,
                persistedHistorySize: 0
            };
        }
    }
    
    setupEventListeners() {
        this.keyHandler = (event) => this.handleKeyDown(event);
        document.addEventListener('keydown', this.keyHandler);
        
        // Prevent context menu and drag/drop
        document.addEventListener('contextmenu', (e) => e.preventDefault());
        document.addEventListener('dragover', (e) => e.preventDefault());
        document.addEventListener('drop', (e) => e.preventDefault());
    }
    
    handleKeyDown(event) {
        const key = event.key.toLowerCase();
        
        // Handle all our keys
        const handlers = {
            'escape': () => this.quit(),
            'n': () => this.nextVideo(),
            'p': () => this.previousVideo(),
            'q': () => this.toggleDebug(),
            '?': () => this.toggleControls(),
            '/': () => this.toggleControls(),
            ' ': () => this.playPause(),
            'r': () => this.restart(),
            'l': () => this.toggleLoop(),
            'm': () => this.toggleMute(),
            'f': () => this.toggleCrossfade(),
            'b': () => this.toggleBlur(),
            'arrowup': () => this.speedUp(),
            'arrowdown': () => this.speedDown(),
            '0': () => this.resetSpeed(),
            'arrowright': () => this.skipForward(),
            'arrowleft': () => this.skipBackward(),
            'i': () => this.showInfo(),
            't': () => this.showTitle()
        };
        
        if (handlers[key]) {
            event.preventDefault();
            handlers[key]();
        }
    }
    
    quit() {
        if (window.electronAPI?.quitApplication) {
            window.electronAPI.quitApplication();
        }
    }
    
    nextVideo() {
        if (this._commandInProgress) {
            this.logger.log('Command already in progress');
            return;
        }
        
        this._commandInProgress = true;
        
        if (this.onNextVideoCallback) {
            this.onNextVideoCallback();
        }
        
        // Reset flag after delay
        const commandCooldown = this.config.timeouts?.commandCooldown || 200;
        setTimeout(() => {
            this._commandInProgress = false;
        }, commandCooldown);
    }
    
    toggleDebug() {
        const getPlayerState = () => this.videoPlayer.getState();
        const getQueueSize = () => this.getQueueSize ? this.getQueueSize() : 0;
        const getHistory = () => this.getHistory();
        
        this.overlays.toggleDebug(getPlayerState, getQueueSize, getHistory);
    }
    
    toggleControls() {
        this.overlays.toggleControls();
    }
    
    playPause() {
        this.videoPlayer.togglePlayPause();
        const state = this.videoPlayer.getState();
        this.overlays.showStatus(state.isPaused ? '⏸️' : '▶️');
    }
    
    restart() {
        this.videoPlayer.restart();
        this.overlays.showStatus('⏮️');
    }
    
    toggleLoop() {
        this.videoPlayer.toggleLoop();
        const state = this.videoPlayer.getState();
        this.overlays.showStatus(state.isLooping ? '🔄' : '↗️');
    }
    
    toggleMute() {
        this.videoPlayer.toggleMute();
        const state = this.videoPlayer.getState();
        this.overlays.showStatus(state.isMuted ? '🔇' : '🔊');
    }
    
    toggleCrossfade() {
        this.videoPlayer.toggleCrossfade();
        const state = this.videoPlayer.getState();
        this.overlays.showStatus(state.crossfadeEnabled ? '🎭' : '⚡');
    }
    
    toggleBlur() {
        this.videoPlayer.toggleBlur();
        const state = this.videoPlayer.getState();
        this.overlays.showStatus(state.blurEnabled ? '🌫️' : '🚫');
    }
    
    speedUp() {
        const state = this.videoPlayer.getState();
        const newSpeed = state.playbackSpeed + this.config.playback.speedIncrement;
        this.videoPlayer.setSpeed(newSpeed);
        const updatedState = this.videoPlayer.getState();
        this.overlays.showStatus(`${updatedState.playbackSpeed}x`);
    }
    
    speedDown() {
        const state = this.videoPlayer.getState();
        const newSpeed = state.playbackSpeed - this.config.playback.speedIncrement;
        this.videoPlayer.setSpeed(newSpeed);
        const updatedState = this.videoPlayer.getState();
        this.overlays.showStatus(`${updatedState.playbackSpeed}x`);
    }
    
    resetSpeed() {
        this.videoPlayer.setSpeed(1.0);
        this.overlays.showStatus('1.0x');
    }
    
    skipForward() {
        this.videoPlayer.skip(this.config.playback.skipSeconds);
    }
    
    skipBackward() {
        this.videoPlayer.skip(-this.config.playback.skipSeconds);
    }
    
    showInfo() {
        const current = this.videoPlayer.getCurrentVideo();
        if (current) {
            this.overlays.showVideoInfo(current, false);
        }
    }
    
    showTitle() {
        const current = this.videoPlayer.getCurrentVideo();
        if (current) {
            this.overlays.showVideoInfo(current, true);
        }
    }
    
    // Callback setters
    onNextVideo(callback) {
        this.onNextVideoCallback = callback;
    }
    
    onPreviousVideo(callback) {
        this.onPreviousVideoCallback = callback;
    }
    
    setQueueSizeGetter(getter) {
        this.getQueueSize = getter;
    }
    
    setPlaybackQueue(playbackQueue) {
        this.playbackQueue = playbackQueue;
    }
    
    cleanup() {
        if (this.keyHandler) {
            document.removeEventListener('keydown', this.keyHandler);
        }
        this._commandInProgress = false;
    }
}