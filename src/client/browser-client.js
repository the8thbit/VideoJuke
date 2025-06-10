import Logger from './utils/logger.js';
import LoadingScreen from './ui/loadingScreen.js';
import VideoPlayer from './player/videoPlayer.js';
import PlaybackQueue from './queue/playbackQueue.js';
import Overlays from './ui/overlays.js';
import Controls from './ui/controls.js';
import ServerAPI from './serverAPI.js';

class VideoPlayerStandaloneClient {
    constructor() {
        this.logger = new Logger('STANDALONE-CLIENT');
        this.loadingScreen = new LoadingScreen(this.logger);
        this.serverAPI = null;
        this.videoPlayer = null;
        this.playbackQueue = null;
        this.overlays = null;
        this.controls = null;
        this.config = {};
        
        this.isPlaybackActive = false;
        this.hasStartedPlayback = false;
        this.connectionRetryTimer = null;
        this.startButton = null;
        this.firstVideoReady = false;
        
        // Initialize
        this.logger.log('Starting standalone client...');
        this.loadingScreen.show();
        this.setupPersistenceCallbacks();
        this.setupStartButton();
        this.initialize();
    }

    setupStartButton() {
        this.startButton = document.getElementById('startButton');
        if (this.startButton) {
            this.startButton.addEventListener('click', () => {
                this.handleStartButtonClick();
            });
        }
    }

    handleStartButtonClick() {
        if (!this.firstVideoReady) {
            this.logger.log('Start button clicked but first video not ready');
            return;
        }
        
        this.logger.log('Start button clicked, beginning playback');
        
        // Hide loading screen
        this.loadingScreen.hide();
        this.hasStartedPlayback = true;
        
        // Hide connection status
        const connectionStatus = document.getElementById('connectionStatus');
        if (connectionStatus) {
            connectionStatus.classList.add('hidden');
        }
        
        // Ensure background is black
        document.body.style.background = '#000';
        
        // Start playing the current video
        const currentVideo = this.videoPlayer.getCurrentElement();
        if (currentVideo && currentVideo.src) {
            currentVideo.muted = false;
            currentVideo.volume = 1.0;
            this.videoPlayer.isMuted = false;

            currentVideo.play().then(() => {
                this.logger.log('Playback started successfully');
                this.videoPlayer.isPaused = false;
            }).catch(error => {
                this.logger.error('Failed to start playback', error);
                this.overlays.showError('Failed to start playback. Press space to try again.');
            });
        }
    }
    
    setupPersistenceCallbacks() {
        // Expose functions for queue persistence
        window.getQueueStateForPersistence = () => this.playbackQueue?.getQueueForPersistence() || [];
        window.getCurrentVideoForCleanup = () => this.videoPlayer?.getCurrentVideo();
    }
    
    async initialize() {
        try {
            // Initialize server API connection
            this.serverAPI = new ServerAPI(this.logger);
            
            // Wait for connection
            await this.waitForConnection();
            
            // Create electron-like API for backward compatibility
            window.electronAPI = this.createElectronAPIWrapper();
            
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
            this.loadingScreen.showError('Initialization failed: ' + error.message);
            
            // Retry connection
            this.scheduleConnectionRetry();
        }
    }
    
    async waitForConnection() {
        const maxWait = 10000; // 10 seconds
        const startTime = Date.now();
        
        return new Promise((resolve, reject) => {
            const checkConnection = () => {
                if (this.serverAPI.isConnected()) {
                    this.logger.log('Server connection established');
                    resolve();
                } else if (Date.now() - startTime > maxWait) {
                    reject(new Error('Connection timeout'));
                } else {
                    setTimeout(checkConnection, 100);
                }
            };
            
            checkConnection();
        });
    }
    
    scheduleConnectionRetry() {
        if (this.connectionRetryTimer) {
            clearTimeout(this.connectionRetryTimer);
        }
        
        this.connectionRetryTimer = setTimeout(() => {
            this.logger.log('Retrying connection...');
            this.loadingScreen.updateText('Retrying connection to server...');
            this.initialize();
        }, 3000);
    }
    
    createElectronAPIWrapper() {
        // Create a wrapper that maintains backward compatibility
        return {
            // Add identifier to distinguish from real Electron API
            _isBrowserWrapper: true,
            
            getConfig: () => this.serverAPI.getConfig(),
            getNextVideo: () => this.serverAPI.getNextVideo(),
            ensureVideoProcessed: (videoData) => this.serverAPI.ensureVideoProcessed(videoData),
            videoEnded: (videoData) => this.serverAPI.videoEnded(videoData),
            videoError: (errorMsg) => this.serverAPI.videoError(errorMsg),
            videoSkippedManual: () => this.serverAPI.videoSkippedManual(),
            videoReturnedToPrevious: () => this.serverAPI.videoReturnedToPrevious(),
            getPreviousVideo: () => this.serverAPI.getPreviousVideo(),
            addToHistory: (videoData) => this.serverAPI.addToHistory(videoData),
            getQueueStatus: () => this.serverAPI.getQueueStatus(),
            getDetailedStats: () => this.serverAPI.getDetailedStats(),
            getInitializationStatus: () => this.serverAPI.getInitializationStatus(),
            startInitialization: () => this.serverAPI.startInitialization(),
            quitApplication: () => this.serverAPI.quitApplication(),
            on: (channel, callback) => this.serverAPI.on(channel, callback),
            removeListener: (channel) => this.serverAPI.removeListener(channel)
        };
    }
    
    connectComponents() {
        // Video player callbacks  
        this.videoPlayer.onVideoEnded((videoData, fromCrossfade = false) => {
            if (fromCrossfade) {
                this.handleVideoEnded(videoData, true);
            } else {
                this.handleVideoEnded(videoData);
            }
        });
        this.videoPlayer.onVideoError((error) => this.handleVideoError(error));
        this.videoPlayer.onNeedNextVideo(() => this.playbackQueue.getNext());
        this.videoPlayer.onVideoStartedPlaying((videoData, isFirstVideo) => {
            this.logger.log(`=== VIDEO STARTED PLAYING CALLBACK ===`);
            this.logger.log(`Video: ${videoData?.filename || 'unknown'}`);
            this.logger.log(`isFirstVideo: ${isFirstVideo}`);
            this.logger.log(`Current queue size: ${this.playbackQueue?.getSize() || 0}`);
            this.logger.log(`hasStartedPlayback: ${this.hasStartedPlayback}`);
            
            if (isFirstVideo && !this.hasStartedPlayback) {
                this.logger.log('First video ready, enabling start button');
                
                // Enable the start button instead of hiding loading screen
                if (this.startButton) {
                    this.startButton.disabled = false;
                    this.startButton.style.opacity = '1';
                    this.loadingScreen.updateText('Ready to play!');
                }
                
                this.firstVideoReady = true;
                
                // Pause the video until start button is clicked
                const currentVideo = this.videoPlayer.getCurrentElement();
                if (currentVideo) {
                    currentVideo.pause();
                    this.videoPlayer.isPaused = true;
                }
            }
            
            if (videoData?._fromHistory) {
                delete videoData._fromHistory;
            }
            
            this.logger.log(`=== END VIDEO STARTED CALLBACK ===`);
        });
        
        // Controls callbacks
        this.controls.onNextVideo(() => this.handleManualNext());
        this.controls.onPreviousVideo((previousVideo) => this.handleManualPrevious(previousVideo));
        this.controls.setQueueSizeGetter(() => this.playbackQueue?.getSize() || 0);
        this.controls.setPlaybackQueue(this.playbackQueue);
        
        // FALLBACK: Monitor video elements directly for playing events
        this.setupVideoElementMonitoring();
    }
    
    setupVideoElementMonitoring() {
        const video1 = document.getElementById('video1');
        const video2 = document.getElementById('video2');
        
        if (video1 && video2) {
            this.logger.log('Video element monitoring setup (start button mode)');
        }
    }
    
    async loadConfiguration() {
        try {
            this.config = await this.serverAPI.getConfig();
            this.logger.log('Configuration loaded from server');
        } catch (error) {
            this.logger.error('Failed to load configuration', error);
            throw error;
        }
    }
    
    async startInitializationMonitoring() {
        let monitoringStartTime = Date.now();
        const maxMonitoringTime = 60000; // 60 seconds max
        let lastStage = null;
        let stageStuckCount = 0;
        
        const monitor = async () => {
            try {
                // Check if we've been monitoring too long
                if (Date.now() - monitoringStartTime > maxMonitoringTime) {
                    this.logger.error('Initialization monitoring timeout - server may be stuck');
                    this.loadingScreen.showError('Server initialization timeout. Please refresh the page or restart the server.');
                    return;
                }
                
                if (!this.serverAPI.isConnected()) {
                    this.logger.log('Lost connection to server, attempting to reconnect...');
                    this.scheduleConnectionRetry();
                    return;
                }
                
                const status = await this.serverAPI.getQueueStatus();
                
                if (status?.initializationState) {
                    const currentStage = status.initializationState.stage;
                    
                    // Check if we're stuck on the same stage
                    if (currentStage === lastStage && currentStage !== 'complete') {
                        stageStuckCount++;
                        
                        if (stageStuckCount > 30) { // 30 seconds on same stage
                            this.logger.warn(`Stuck on stage "${currentStage}" for too long`);
                            
                            // If stuck on building_index, server might need help
                            if (currentStage === 'building_index') {
                                this.loadingScreen.updateText('Server is taking longer than expected to scan directories...');
                            }
                        }
                    } else {
                        stageStuckCount = 0;
                        lastStage = currentStage;
                    }
                    
                    this.loadingScreen.updateInitialization(status.initializationState);
                    
                    if (status.initializationState.stage === 'complete') {
                        this.logger.log('Server initialization complete');
                        
                        if (status.preprocessedQueue?.current > 0 || status.totalVideos > 0) {
                            await this.startVideoPlayback();
                        } else {
                            this.logger.log('Server initialized but no videos available, waiting...');
                            this.loadingScreen.updateText('No videos found. Please check server configuration.');
                            setTimeout(monitor, 2000);
                        }
                        return;
                    } else if (status.initializationState.stage === 'error') {
                        this.logger.error('Server initialization failed');
                        this.loadingScreen.showError(status.initializationState.message || 'Server initialization failed');
                        return;
                    }
                }
                
                setTimeout(monitor, 1000);
                
            } catch (error) {
                this.logger.error('Error monitoring initialization', error);
                
                if (error.message.includes('Failed to fetch')) {
                    this.logger.log('Server connection lost, attempting to reconnect...');
                    this.scheduleConnectionRetry();
                } else {
                    // Continue monitoring even on error
                    setTimeout(monitor, 2000);
                }
            }
        };
        
        monitor();
    }
    
    async startVideoPlayback() {
        try {
            this.logger.log('Building initial queue...');
            
            const status = await this.serverAPI.getQueueStatus();
            this.logger.log(`Server status: preprocessed=${status.preprocessedQueue?.current || 0}, total=${status.totalVideos || 0}`);
            
            if (status.totalVideos === 0) {
                throw new Error('No videos found in configured directories');
            }
            
            if ((status.preprocessedQueue?.current || 0) < 3 && status.totalVideos > 3) {
                this.logger.log('Server still preprocessing, waiting for more videos...');
                this.loadingScreen.updateText('Waiting for server to process more videos...');
                await this.waitForServerVideos();
            }
            
            // Log queue building details
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
            
            setTimeout(() => {
                this.logger.log('Attempting recovery...');
                this.startVideoPlayback();
            }, 500);
        }
    }
    
    async waitForServerVideos() {
        const maxWait = 30000;
        const startTime = Date.now();
        
        while (Date.now() - startTime < maxWait) {
            try {
                const status = await this.serverAPI.getQueueStatus();
                const preprocessedCount = status.preprocessedQueue?.current || 0;
                
                this.logger.log(`Waiting for server videos: ${preprocessedCount} preprocessed`);
                
                if (preprocessedCount >= 3 || !status.isPreprocessing) {
                    this.logger.log(`Proceeding with ${preprocessedCount} preprocessed videos`);
                    return;
                }
                
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                this.logger.error('Error checking server status', error);
                break;
            }
        }
        
        this.logger.log('Timeout waiting for server videos, proceeding anyway');
    }
    
    async startFirstVideo() {
        const video = await this.playbackQueue.getNext();
        if (video) {
            this.logger.log(`Loading first video: ${video.filename}`);
            this.logger.log(`Video data:`, {
                filename: video.filename,
                serverUrl: video.serverUrl,
                processedPath: video.processedPath,
                hasMetadata: !!video.metadata
            });
            this.logger.log(`Queue size after getting first video: ${this.playbackQueue.getSize()}`);
            
            // Play the video (which will trigger the callback to enable start button)
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
            const currentVideo = this.videoPlayer.getCurrentVideo();
            
            if (!this.videoPlayer.skipToNext()) {
                this.logger.log('Cannot skip during transition');
                return;
            }
            
            if (currentVideo && !currentVideo._fromHistory) {
                // Don't wait for history update to complete
                this.serverAPI.addToHistory(currentVideo).catch(err => {
                    this.logger.error('Failed to add to history', err);
                });
            }
            
            // Don't wait for skip notification
            this.serverAPI.videoSkippedManual().catch(err => {
                this.logger.error('Failed to notify skip', err);
            });
            
            const video = await this.playbackQueue.getNext();
            if (video) {
                this.logger.log(`Manual skip to: ${video.filename}`);
                
                try {
                    await this.videoPlayer.play(video, false, true);
                } catch (playError) {
                    this.logger.error('Failed to play next video', playError);
                    this.overlays.showError(`Failed to play video: ${playError.message}`);
                    
                    // Try to recover by getting another video
                    setTimeout(() => {
                        this.logger.log('Attempting to recover from play error...');
                        this.handleManualNext();
                    }, 1000);
                }
            } else {
                this.logger.error('No videos available');
                this.overlays.showError('No videos available');
                
                // Try to refill queue
                this.playbackQueue.fill().then(() => {
                    this.logger.log('Queue refilled, trying again...');
                    this.handleManualNext();
                }).catch(err => {
                    this.logger.error('Failed to refill queue', err);
                });
            }
        } catch (error) {
            this.logger.error('Error in manual next', error);
            this.overlays.showError('Error playing video');
            
            // Always ensure we can try again
            setTimeout(() => {
                this.videoPlayer._transitionLock = false;
            }, 500);
        }
    }

    async handleManualPrevious(previousVideo) {
        if (!this.isPlaybackActive) {
            return;
        }
        
        this.logger.log('=== PREVIOUS VIDEO REQUEST ===');
        
        try {
            const currentVideo = this.videoPlayer.getCurrentVideo();
            this.logger.log(`Current video: ${currentVideo?.filename || 'none'}`);
            
            if (!previousVideo) {
                this.logger.log('No previous video provided by controls');
                this.overlays.showError('No previous video available');
                return;
            }
            
            this.logger.log(`Going back to: ${previousVideo.filename}`);
            
            const processedPrevious = await this.serverAPI.ensureVideoProcessed(previousVideo);
            
            if (!processedPrevious) {
                this.logger.error('Could not process previous video');
                this.overlays.showError('Previous video not available');
                return;
            }
            
            processedPrevious._fromHistory = true;
            
            if (!this.videoPlayer.skipToNext()) {
                this.logger.log('Cannot go to previous during transition');
                return;
            }
            
            if (currentVideo) {
                this.logger.log(`Adding current video back to queue: ${currentVideo.filename}`);
                const cleanVideo = { ...currentVideo };
                delete cleanVideo._fromHistory;
                this.playbackQueue.addBack(cleanVideo);
            }
            
            // Don't wait for notification
            this.serverAPI.videoReturnedToPrevious().catch(err => {
                this.logger.error('Failed to notify previous', err);
            });
            
            this.logger.log(`Playing previous: ${processedPrevious.filename}`);
            
            try {
                await this.videoPlayer.play(processedPrevious, false, true);
                this.logger.log('=== PREVIOUS VIDEO COMPLETE ===');
            } catch (playError) {
                this.logger.error('Failed to play previous video', playError);
                this.overlays.showError(`Failed to play previous video: ${playError.message}`);
                
                // Try to recover by playing next instead
                setTimeout(() => {
                    this.logger.log('Recovering from previous video error...');
                    this.handleVideoEnded(null);
                }, 1000);
            }
        } catch (error) {
            this.logger.error('Error in manual previous', error);
            this.overlays.showError('Error playing previous video');
            
            // Always ensure we can try again
            setTimeout(() => {
                this.videoPlayer._transitionLock = false;
            }, 500);
        }
    }
    
    async handleVideoEnded(videoData, fromCrossfade = false) {
        if (!this.isPlaybackActive) {
            this.logger.log('Playback not active, ignoring video ended');
            return;
        }
        
        this.logger.log(`Video ended: ${videoData?.filename || 'unknown'}, fromCrossfade: ${fromCrossfade}`);
        
        try {
            if (videoData) {
                this.logger.log('Notifying server about video end');
                await this.serverAPI.videoEnded(videoData);
            }
            
            if (!fromCrossfade) {
                this.logger.log('Getting next video from queue...');
                const nextVideo = await this.playbackQueue.getNext();
                if (nextVideo) {
                    this.logger.log(`Auto-advancing to: ${nextVideo.filename}`);
                    await this.videoPlayer.play(nextVideo, false);
                } else {
                    this.logger.error('No next video available');
                    this.overlays.showError('No videos available');
                    
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
            
            setTimeout(() => {
                this.logger.log('Attempting recovery from video end error...');
                this.handleVideoEnded(null);
            }, 2000);
        }
    }
    
    async handleVideoError(error) {
        this.logger.error('Video playback error', error);
        
        try {
            await this.serverAPI.videoError(error.message || 'Unknown playback error');
        } catch (apiError) {
            this.logger.error('Failed to report video error to server', apiError);
        }
        
        this.overlays.showError(`Playback error: ${error.message || 'Unknown error'}`);
        
        // Determine if this is an autoplay error
        const isAutoplayError = error.message && (
            error.message.includes('play() request was interrupted') ||
            error.message.includes('play() failed') ||
            error.message.includes('user didn\'t interact')
        );
        
        // Always try to recover unless it's an autoplay error on first video
        if (!isAutoplayError || this.hasStartedPlayback) {
            const errorRecoveryDelay = this.config.timeouts?.errorRecoveryDelay || 1000;
            
            this.logger.log(`Scheduling recovery in ${errorRecoveryDelay}ms...`);
            
            setTimeout(() => {
                if (this.isPlaybackActive) {
                    this.logger.log('Attempting error recovery by advancing to next video');
                    
                    // Ensure transition lock is cleared
                    this.videoPlayer._transitionLock = false;
                    
                    this.handleVideoEnded(null);
                }
            }, errorRecoveryDelay);
        } else {
            this.logger.log('Autoplay error on first video, waiting for user interaction');
            // Clear transition lock so user can try again
            this.videoPlayer._transitionLock = false;
        }
    }
    
    setupEventListeners() {
        // Listen for server messages
        this.serverAPI.on('main-log', (logData) => {
            this.loadingScreen.addLog(`[SERVER] ${logData.message}`, logData.level);
        });
        
        this.serverAPI.on('initialization-update', (initState) => {
            this.loadingScreen.updateInitialization(initState);
        });
        
        // Cleanup on unload
        window.addEventListener('beforeunload', () => {
            this.isPlaybackActive = false;
            this.videoPlayer?.cleanup();
            this.playbackQueue?.cleanup();
            this.controls?.cleanup();
            this.serverAPI?.cleanup();
            
            if (this.connectionRetryTimer) {
                clearTimeout(this.connectionRetryTimer);
            }
        });
        
        // Error handling
        window.addEventListener('error', (event) => {
            this.logger.error('Global error', event.error);
            if (event.error?.stack?.includes('Maximum call stack')) {
                this.logger.error('Stack overflow detected, attempting recovery');
                setTimeout(() => {
                    window.location.reload();
                }, 2000);
            }
        });
        
        // Handle visibility changes
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.logger.log('Page hidden, pausing monitoring');
            } else {
                this.logger.log('Page visible, resuming monitoring');
                // Check connection status when page becomes visible again
                if (!this.serverAPI?.isConnected()) {
                    this.scheduleConnectionRetry();
                }
            }
        });
    }
}

// Start client when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new VideoPlayerStandaloneClient());
} else {
    new VideoPlayerStandaloneClient();
}