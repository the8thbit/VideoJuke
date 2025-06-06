export default class LoadingScreen {
    constructor(logger, config = null) {
        this.logger = logger;
        this.config = config;
        this.loadingScreen = document.getElementById('loadingScreen');
        this.subtitle = document.querySelector('.loading-subtitle');
        this.progressBar = document.getElementById('loadingProgress');
        
        this.consoleLines = [];
    }
    
    show() {
        if (this.loadingScreen) {
            this.loadingScreen.classList.remove('hidden');
        }
    }
    
    hide() {
        if (this.loadingScreen) {
            this.loadingScreen.classList.add('hidden');
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
    }
    
    addLog(message, level = 'info') {
        // Simple console logging for debugging
        console.log(`[LoadingScreen] ${message}`);
    }
}