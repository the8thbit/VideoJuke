import Logger from './utils/logger.js';
import LoadingScreen from './ui/loadingScreen.js';
import VideoPlayer from './player/videoPlayer.js';
import PlaybackQueue from './queue/playbackQueue.js';
import Overlays from './ui/overlays.js';
import Controls from './ui/controls.js';

class VideoPlayerClient {
    constructor() {
        this.logger = new Logger('CLIENT');
        this.loadingScreen = new LoadingScreen(this.logger);
        this.videoPlayer = null;
        this.playbackQueue = null;
        this.overlays = null;
        this.controls = null;
        this.config = {};
        
        this.isPlaybackActive = false;
        this.hasStartedPlayback = false;
        
        // Initialize
        this.logger.log('Starting client...');
        this.loadingScreen.show();
        this.setupPersistenceCallbacks();
        this.checkAndStart();
    }
    
    setupPersistenceCallbacks() {
        // Expose functions for queue persistence (no longer need history callbacks)
        window.getQueueStateForPersistence = () => this.playbackQueue?.getQueueForPersistence() || [];
        window.getCurrentVideoForCleanup = () => this.videoPlayer?.getCurrentVideo();
    }
    
    async checkAndStart() {
        if (window.electronAPI) {
            this.logger.log('Electron API available');
            await this.initialize();
        } else {
            setTimeout(() => this.checkAndStart(), 100);
        }
    }
    
    async initialize() {
        try {
            await this.loadConfiguration();
            
            // Update loading screen with config
            this.loadingScreen.config = this.config;
            
            // Initialize components
            this.overlays = new Overlays(this.logger, this.config);
            this.videoPlayer = new VideoPlayer(this.logger, this.config);
            this.playbackQueue = new PlaybackQueue(this.logger, this.config);
            this.controls = new Controls(this.logger, this.config, this.videoPlayer, this.overlays);
            
            this.connectComponents();
            this.setupEventListeners();
            
            await this.startInitializationMonitoring();
            
        } catch (error) {
            this.logger.error('Failed to initialize client', error);
            this.loadingScreen.showError('Initialization failed');
        }
    }
    
    connectComponents() {
        // Video player callbacks
        this.videoPlayer.onVideoEnded((videoData, fromCrossfade = false) => {
            if (fromCrossfade) {
                // For crossfade transitions, let the server handle history
                this.handleVideoEnded(videoData, true);
            } else {
                // Full handling for natural video end
                this.handleVideoEnded(videoData);
            }
        });
        this.videoPlayer.onVideoError((error) => this.handleVideoError(error));
        this.videoPlayer.onNeedNextVideo(() => this.playbackQueue.getNext());
        this.videoPlayer.onVideoStartedPlaying((videoData, isFirstVideo) => {
            if (isFirstVideo) {
                this.loadingScreen.hide();
                this.hasStartedPlayback = true;
            }
            
            // Don't add videos from history back to history
            if (videoData?._fromHistory) {
                delete videoData._fromHistory;
            }
        });
        
        // Controls callbacks
        this.controls.onNextVideo(() => this.handleManualNext());
        this.controls.onPreviousVideo((previousVideo) => this.handleManualPrevious(previousVideo));
        this.controls.setQueueSizeGetter(() => this.playbackQueue?.getSize() || 0);
        this.controls.setPlaybackQueue(this.playbackQueue);
    }
    
    async loadConfiguration() {
        try {
            this.config = await window.electronAPI.getConfig();
            this.logger.log('Configuration loaded');
        } catch (error) {
            this.logger.error('Failed to load configuration', error);
            throw error;
        }
    }
    
async startInitializationMonitoring() {
        const monitor = async () => {
            try {
                const status = await window.electronAPI.getQueueStatus();
                
                if (status?.initializationState) {
                    this.loadingScreen.updateInitialization(status.initializationState);
                    
                    if (status.initializationState.stage === 'complete') {
                        this.logger.log('Main process initialization complete');
                        
                        // Verify server has videos before starting playback
                        if (status.preprocessedQueue?.current > 0 || status.totalVideos > 0) {
                            await this.startVideoPlayback();
                        } else {
                            this.logger.log('Server initialized but no videos available, waiting...');
                            setTimeout(monitor, 2000);
                        }
                        return;
                    } else if (status.initializationState.stage === 'error') {
                        this.logger.error('Main process initialization failed');
                        this.loadingScreen.showError('Initialization failed');
                        return;
                    }
                }
                
                setTimeout(monitor, 1000);
                
            } catch (error) {
                this.logger.error('Error monitoring initialization', error);
                setTimeout(monitor, 2000);
            }
        };
        
        monitor();
    }
    
    async startVideoPlayback() {
        try {
          this.logger.log('Building initial queue...');
            
            // Check server status before starting
            const status = await window.electronAPI.getQueueStatus();
            this.logger.log(`Server status: preprocessed=${status.preprocessedQueue?.current || 0}, total=${status.totalVideos || 0}`);
            
            if (status.totalVideos === 0) {
                throw new Error('No videos found in configured directories');
            }
            
            // If server has very few preprocessed videos, wait a bit more
            if ((status.preprocessedQueue?.current || 0) < 3 && status.totalVideos > 3) {
                this.logger.log('Server still preprocessing, waiting for more videos...');
                this.loadingScreen.updateText('Waiting for server to process more videos...');
                
                // Wait for server to process more videos
                await this.waitForServerVideos();
            }
            
            const threshold = this.config.video.playbackQueueInitializationThreshold;
            this.logger.log(`Starting queue build with STRICT target: ${threshold}`);
            
            const ready = await this.playbackQueue.buildInitialQueue(
                (progress) => {
                    this.logger.log(`Queue progress: ${progress.playbackCurrent}/${progress.playbackTarget}`);
                    this.loadingScreen.updateQueueProgress(progress);
                }
            );
            
            if (ready) {
                const finalSize = this.playbackQueue.getSize();
                this.logger.log(`Queue built successfully. Final size: ${finalSize}, Required: ${threshold}`);
                
                // Double-check the threshold is actually met
                if (finalSize >= threshold) {
                    this.logger.log(`Threshold satisfied (${finalSize} >= ${threshold}), starting playback`);
                    await this.startFirstVideo();
                    this.playbackQueue.startMonitoring();
                    this.isPlaybackActive = true;
                } else {
                    throw new Error(`Queue size ${finalSize} is below required threshold ${threshold}`);
                }
            } else {
                throw new Error(`Failed to build initial queue to threshold ${threshold}`);
            }
        } catch (error) {
            this.logger.error('Failed to start video playback', error);
            this.loadingScreen.showError(`Failed to start playback: ${error.message}`);
            this.overlays.showError('Failed to start video playback');
            
            setTimeout(() => {
                this.logger.log('Attempting recovery...');
                this.startVideoPlayback();
            }, 500);
        }
    }

    async waitForServerVideos() {
        const maxWait = 30000; // 30 seconds max wait
        const startTime = Date.now();
        
        while (Date.now() - startTime < maxWait) {
            const status = await window.electronAPI.getQueueStatus();
            const preprocessedCount = status.preprocessedQueue?.current || 0;
            
            this.logger.log(`Waiting for server videos: ${preprocessedCount} preprocessed`);
            
            // If we have at least 3 preprocessed videos or server stopped processing, proceed
            if (preprocessedCount >= 3 || !status.isPreprocessing) {
                this.logger.log(`Proceeding with ${preprocessedCount} preprocessed videos`);
                return;
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        this.logger.log('Timeout waiting for server videos, proceeding anyway');
    }
    
    async startFirstVideo() {
        const video = await this.playbackQueue.getNext();
        if (video) {
            this.logger.log(`Playing first video: ${video.filename}`);
            await this.videoPlayer.play(video, true);
        } else {
            throw new Error('No videos available');
        }
    }
    
    async handleManualNext() {
        if (!this.isPlaybackActive) {
            return;
        }
        
        try {
            // Get current video before skipping
            const currentVideo = this.videoPlayer.getCurrentVideo();
            
            // Skip to next
            if (!this.videoPlayer.skipToNext()) {
                this.logger.log('Cannot skip during transition');
                return;
            }
            
            // Add current video to history via server
            if (currentVideo && !currentVideo._fromHistory) {
                await window.electronAPI.addToHistory(currentVideo);
            }
            
            // Notify backend
            if (window.electronAPI?.videoSkippedManual) {
                window.electronAPI.videoSkippedManual();
            }
            
            // Get and play next video
            const video = await this.playbackQueue.getNext();
            if (video) {
                this.logger.log(`Manual skip to: ${video.filename}`);
                await this.videoPlayer.play(video, false, true);
            } else {
                this.logger.error('No videos available');
                this.overlays.showError('No videos available');
            }
        } catch (error) {
            this.logger.error('Error in manual next', error);
            this.overlays.showError('Error playing video');
        }
    }
    
    async handleManualPrevious(previousVideo) {
        if (!this.isPlaybackActive) {
            return;
        }
        
        this.logger.log('=== PREVIOUS VIDEO REQUEST ===');
        
        try {
            // Get current video info for logging
            const currentVideo = this.videoPlayer.getCurrentVideo();
            this.logger.log(`Current video: ${currentVideo?.filename || 'none'}`);
            
            if (!previousVideo) {
                this.logger.log('No previous video provided by controls');
                this.overlays.showError('No previous video available');
                return;
            }
            
            this.logger.log(`Going back to: ${previousVideo.filename}`);
            
            // Ensure the video is processed
            const processedPrevious = await window.electronAPI.ensureVideoProcessed(previousVideo);
            
            if (!processedPrevious) {
                this.logger.error('Could not process previous video');
                this.overlays.showError('Previous video not available');
                return;
            }
            
            // Mark as from history to prevent re-adding
            processedPrevious._fromHistory = true;
            
            // Skip current transition
            if (!this.videoPlayer.skipToNext()) {
                this.logger.log('Cannot go to previous during transition');
                return;
            }
            
            // Put current video back at the front of queue
            if (currentVideo) {
                this.logger.log(`Adding current video back to queue: ${currentVideo.filename}`);
                const cleanVideo = { ...currentVideo };
                delete cleanVideo._fromHistory;
                this.playbackQueue.addBack(cleanVideo);
            }
            
            // Notify backend
            if (window.electronAPI?.videoReturnedToPrevious) {
                window.electronAPI.videoReturnedToPrevious();
            }
            
            // Play previous video with manual transition flag
            this.logger.log(`Playing previous: ${processedPrevious.filename}`);
            await this.videoPlayer.play(processedPrevious, false, true);
            
            this.logger.log('=== PREVIOUS VIDEO COMPLETE ===');
        } catch (error) {
            this.logger.error('Error in manual previous', error);
            this.overlays.showError('Error playing previous video');
        }
    }
    
    async handleVideoEnded(videoData, fromCrossfade = false) {
        if (!this.isPlaybackActive) {
            this.logger.log('Playback not active, ignoring video ended');
            return;
        }
        
        this.logger.log(`Video ended: ${videoData?.filename || 'unknown'}, fromCrossfade: ${fromCrossfade}`);
        
        try {
            // Notify backend about video end (server will handle history)
            if (videoData && window.electronAPI) {
                this.logger.log('Notifying backend about video end');
                await window.electronAPI.videoEnded(videoData);
            }
            
            // Auto-advance to next (only if not from crossfade, as crossfade handles its own transition)
            if (!fromCrossfade) {
                this.logger.log('Getting next video from queue...');
                const nextVideo = await this.playbackQueue.getNext();
                if (nextVideo) {
                    this.logger.log(`Auto-advancing to: ${nextVideo.filename}`);
                    await this.videoPlayer.play(nextVideo, false);
                } else {
                    this.logger.error('No next video available');
                    this.overlays.showError('No videos available');
                    
                    // Try to refill queue
                    this.logger.log('Attempting to refill empty queue...');
                    setTimeout(() => {
                        this.playbackQueue.fill().then(() => {
                            this.handleVideoEnded(null);
                        });
                    }, 2000);
                }
            }
            
        } catch (error) {
            this.logger.error('Error in handleVideoEnded', error);
            this.overlays.showError('Error advancing to next video');
            
            // Try recovery
            setTimeout(() => {
                this.logger.log('Attempting recovery from video end error...');
                this.handleVideoEnded(null);
            }, 2000);
        }
    }
    
    async handleVideoError(error) {
        this.logger.error('Video playback error', error);
        
        if (window.electronAPI) {
            await window.electronAPI.videoError(error.message || 'Unknown playback error');
        }
        
        this.overlays.showError(`Playback error: ${error.message || 'Unknown error'}`);
        
        // Try next video after delay
        const errorRecoveryDelay = this.config.timeouts?.errorRecoveryDelay || 1000;
        setTimeout(() => {
            if (this.isPlaybackActive) {
                this.handleVideoEnded(null);
            }
        }, errorRecoveryDelay);
    }
    
    setupEventListeners() {
        // Listen for logs from main process
        window.electronAPI.on('main-log', (logData) => {
            this.loadingScreen.addLog(`[MAIN] ${logData.message}`, logData.level);
        });
        
        window.electronAPI.on('initialization-update', (initState) => {
            this.loadingScreen.updateInitialization(initState);
        });
        
        // Cleanup on unload
        window.addEventListener('beforeunload', () => {
            this.isPlaybackActive = false;
            this.videoPlayer?.cleanup();
            this.playbackQueue?.cleanup();
            this.controls?.cleanup();
        });
        
        // Error handling
        window.addEventListener('error', (event) => {
            this.logger.error('Global error', event.error);
            if (event.error?.stack?.includes('Maximum call stack')) {
                this.logger.error('Stack overflow detected, attempting recovery');
                // Force reload after saving state
                setTimeout(() => {
                    window.location.reload();
                }, 2000);
            }
        });
    }
}

// Start client when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new VideoPlayerClient());
} else {
    new VideoPlayerClient();
}