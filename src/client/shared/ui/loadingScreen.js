export default class LoadingScreen {
    constructor(logger, config = null) {
        this.logger = logger;
        this.config = config;
        this.loadingScreen = document.getElementById('loadingScreen');
        this.subtitle = document.querySelector('.loading-subtitle');
        this.progressBar = document.getElementById('loadingProgress');
        this.startButton = document.getElementById('startButton');
        
        this.consoleLines = [];
    }
    
    show() {
        if (this.loadingScreen) {
            this.loadingScreen.classList.remove('hidden');
        }
    }
    
    hide() {
        this.logger.log('LoadingScreen.hide() called');
        if (this.loadingScreen) {
            this.logger.log('Adding hidden class to loading screen');
            this.loadingScreen.classList.add('hidden');
            
            // Force hide after transition in case CSS doesn't work
            setTimeout(() => {
                if (this.loadingScreen) {
                    this.loadingScreen.style.display = 'none';
                    this.logger.log('Loading screen display set to none');
                }
            }, 500);
        } else {
            this.logger.error('Loading screen element not found');
        }
    }
    
    updateText(message) {
        if (this.subtitle) {
            this.subtitle.textContent = message;
        }
    }
    
    updateProgress(percent) {
        if (this.progressBar) {
            this.progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
        }
    }
    
    updateInitialization(initState) {
        if (!initState) return;
        
        this.updateText(initState.message || 'Initializing...');
        this.updateProgress(initState.progress || 0);
        
        // Update start button text based on stage
        if (this.startButton && initState.stage === 'complete') {
            this.startButton.textContent = 'Start Playback';
        }
    }
    
    updateQueueProgress(progress) {
        if (!progress || typeof progress.playbackCurrent !== 'number' || typeof progress.playbackTarget !== 'number') {
            return;
        }
        
        const { playbackCurrent, playbackTarget } = progress;
        const percent = playbackTarget > 0 ? (playbackCurrent / playbackTarget) * 100 : 0;
        
        this.updateProgress(70 + (percent * 0.25)); // Scale to 70-95% of total progress
        this.updateText(`Building playback queue: ${playbackCurrent}/${playbackTarget} videos`);
    }
    
    showError(message) {
        this.updateText(`Error: ${message}`);
        this.updateProgress(0);
        
        // Disable start button on error
        if (this.startButton) {
            this.startButton.disabled = true;
            this.startButton.style.opacity = '0.3';
        }
    }
    
    addLog(message, level = 'info') {
        // Simple console logging for debugging
        console.log(`[LoadingScreen] ${message}`);
    }
}