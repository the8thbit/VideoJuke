export default class RemoteControl {
    constructor(logger, config) {
        this.logger = logger;
        this.config = config;
        this.videoPlayer = null;
        this.overlays = null;
        
        // Callbacks
        this.onNextVideoCallback = null;
        this.onPreviousVideoCallback = null;
        this.onShowSettingsCallback = null;
        this.onExitCallback = null;
        
        // State
        this.isActive = false;
        this.controlsVisible = false;
        this.controlsTimeout = null;
        
        // WebOS remote key codes
        this.keyCodes = {
            LEFT: 37,
            UP: 38,
            RIGHT: 39,
            DOWN: 40,
            OK: 13,
            BACK: 461,
            PLAY: 415,
            PAUSE: 19,
            STOP: 413,
            REWIND: 412,
            FAST_FORWARD: 417,
            RED: 403,
            GREEN: 404,
            YELLOW: 405,
            BLUE: 406,
            NUM_0: 48,
            NUM_1: 49,
            NUM_2: 50,
            NUM_3: 51,
            NUM_4: 52,
            NUM_5: 53,
            NUM_6: 54,
            NUM_7: 55,
            NUM_8: 56,
            NUM_9: 57
        };
        
        this.keyHandler = null;
    }
    
    setVideoPlayer(videoPlayer) {
        this.videoPlayer = videoPlayer;
    }
    
    setOverlays(overlays) {
        this.overlays = overlays;
    }
    
    start() {
        if (this.isActive) return;
        
        this.logger.log('Starting remote control handler');
        this.isActive = true;
        
        // Register key handler
        this.keyHandler = (e) => this.handleKeyPress(e);
        document.addEventListener('keydown', this.keyHandler);
        
        // Show controls briefly on start
        this.showControlsHelp();
    }
    
    stop() {
        if (!this.isActive) return;
        
        this.logger.log('Stopping remote control handler');
        this.isActive = false;
        
        if (this.keyHandler) {
            document.removeEventListener('keydown', this.keyHandler);
            this.keyHandler = null;
        }
        
        this.hideControlsHelp();
    }
    
    handleKeyPress(e) {
        if (!this.isActive) return;
        
        const keyCode = e.keyCode;
        this.logger.log(`Remote key pressed: ${keyCode}`);
        
        // Prevent default for all remote keys
        if (Object.values(this.keyCodes).includes(keyCode)) {
            e.preventDefault();
        }
        
        switch (keyCode) {
            // Navigation
            case this.keyCodes.OK:
            case this.keyCodes.PLAY:
            case this.keyCodes.PAUSE:
                this.handlePlayPause();
                break;
                
            case this.keyCodes.RIGHT:
            case this.keyCodes.FAST_FORWARD:
                this.handleNext();
                break;
                
            case this.keyCodes.LEFT:
            case this.keyCodes.REWIND:
                this.handlePrevious();
                break;
                
            case this.keyCodes.UP:
                this.handleSpeedUp();
                break;
                
            case this.keyCodes.DOWN:
                this.handleSpeedDown();
                break;
                
            // Color buttons
            case this.keyCodes.RED:
                this.handleToggleCrossfade();
                break;
                
            case this.keyCodes.GREEN:
                this.handleToggleBlur();
                break;
                
            case this.keyCodes.YELLOW:
                this.handleShowInfo();
                break;
                
            case this.keyCodes.BLUE:
                this.handleShowSettings();
                break;
                
            // Number buttons for speed presets
            case this.keyCodes.NUM_0:
                this.handleSpeedPreset(1.0);
                break;
                
            case this.keyCodes.NUM_1:
                this.handleSpeedPreset(0.5);
                break;
                
            case this.keyCodes.NUM_2:
                this.handleSpeedPreset(0.75);
                break;
                
            case this.keyCodes.NUM_3:
                this.handleSpeedPreset(1.25);
                break;
                
            case this.keyCodes.NUM_4:
                this.handleSpeedPreset(1.5);
                break;
                
            case this.keyCodes.NUM_5:
                this.handleSpeedPreset(2.0);
                break;
                
            // System
            case this.keyCodes.BACK:
                this.handleBack();
                break;
                
            case this.keyCodes.STOP:
                this.handleStop();
                break;
                
            // Help (any other button shows controls)
            default:
                this.showControlsHelp();
                break;
        }
    }
    
    // Control handlers
    handlePlayPause() {
        if (!this.videoPlayer) return;
        
        this.videoPlayer.togglePlayPause();
        const state = this.videoPlayer.getState();
        this.overlays.showStatus(state.isPaused ? '⏸️' : '▶️');
        
        this.logger.log(`Playback ${state.isPaused ? 'paused' : 'resumed'}`);
    }
    
    handleNext() {
        this.logger.log('Next video requested');
        
        if (this.onNextVideoCallback) {
            this.onNextVideoCallback();
        }
    }
    
    handlePrevious() {
        this.logger.log('Previous video requested');
        
        if (this.onPreviousVideoCallback) {
            this.onPreviousVideoCallback();
        }
    }
    
    handleSpeedUp() {
        if (!this.videoPlayer) return;
        
        const state = this.videoPlayer.getState();
        const newSpeed = Math.min(state.playbackSpeed + 0.25, 3.0);
        this.videoPlayer.setSpeed(newSpeed);
        
        this.overlays.showStatus(`${newSpeed}x`);
        this.logger.log(`Speed increased to ${newSpeed}x`);
    }
    
    handleSpeedDown() {
        if (!this.videoPlayer) return;
        
        const state = this.videoPlayer.getState();
        const newSpeed = Math.max(state.playbackSpeed - 0.25, 0.25);
        this.videoPlayer.setSpeed(newSpeed);
        
        this.overlays.showStatus(`${newSpeed}x`);
        this.logger.log(`Speed decreased to ${newSpeed}x`);
    }
    
    handleSpeedPreset(speed) {
        if (!this.videoPlayer) return;
        
        this.videoPlayer.setSpeed(speed);
        this.overlays.showStatus(`${speed}x`);
        this.logger.log(`Speed set to ${speed}x`);
    }
    
    handleToggleCrossfade() {
        if (!this.videoPlayer) return;
        
        this.videoPlayer.toggleCrossfade();
        const state = this.videoPlayer.getState();
        this.overlays.showStatus(state.crossfadeEnabled ? '🎭 ON' : '🎭 OFF');
        
        this.logger.log(`Crossfade ${state.crossfadeEnabled ? 'enabled' : 'disabled'}`);
    }
    
    handleToggleBlur() {
        if (!this.videoPlayer) return;
        
        this.videoPlayer.toggleBlur();
        const state = this.videoPlayer.getState();
        this.overlays.showStatus(state.blurEnabled ? '🌫️ ON' : '🌫️ OFF');
        
        this.logger.log(`Blur ${state.blurEnabled ? 'enabled' : 'disabled'}`);
    }
    
    handleShowInfo() {
        if (!this.videoPlayer) return;
        
        const current = this.videoPlayer.getCurrentVideo();
        if (current) {
            this.overlays.showVideoInfo(current, false);
        }
        
        this.logger.log('Showing video info');
    }
    
    handleShowSettings() {
        this.logger.log('Settings requested');
        
        if (this.onShowSettingsCallback) {
            this.onShowSettingsCallback();
        }
    }
    
    handleBack() {
        this.logger.log('Back button pressed');
        
        // If controls are visible, hide them
        if (this.controlsVisible) {
            this.hideControlsHelp();
        } else if (this.onExitCallback) {
            // Otherwise exit the app
            this.onExitCallback();
        }
    }
    
    handleStop() {
        this.logger.log('Stop button pressed');
        
        if (this.videoPlayer) {
            const currentVideo = this.videoPlayer.getCurrentElement();
            if (currentVideo && currentVideo.src) {
                currentVideo.pause();
                currentVideo.currentTime = 0;
                this.videoPlayer.isPaused = true;
                this.overlays.showStatus('⏹️');
            }
        }
    }
    
    // Controls help overlay
    showControlsHelp() {
        const controlsOverlay = document.getElementById('controlsOverlay');
        if (!controlsOverlay) return;
        
        controlsOverlay.classList.add('visible');
        this.controlsVisible = true;
        
        // Auto-hide after 5 seconds
        if (this.controlsTimeout) {
            clearTimeout(this.controlsTimeout);
        }
        
        this.controlsTimeout = setTimeout(() => {
            this.hideControlsHelp();
        }, 5000);
        
        this.logger.log('Showing controls help');
    }
    
    hideControlsHelp() {
        const controlsOverlay = document.getElementById('controlsOverlay');
        if (!controlsOverlay) return;
        
        controlsOverlay.classList.remove('visible');
        this.controlsVisible = false;
        
        if (this.controlsTimeout) {
            clearTimeout(this.controlsTimeout);
            this.controlsTimeout = null;
        }
        
        this.logger.log('Hiding controls help');
    }
    
    // Callback setters
    onNextVideo(callback) {
        this.onNextVideoCallback = callback;
    }
    
    onPreviousVideo(callback) {
        this.onPreviousVideoCallback = callback;
    }
    
    onShowSettings(callback) {
        this.onShowSettingsCallback = callback;
    }
    
    onExit(callback) {
        this.onExitCallback = callback;
    }
}