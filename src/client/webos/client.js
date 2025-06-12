import Logger from '../shared/utils/logger.js';
import LoadingScreen from '../shared/ui/loadingScreen.js';
import VideoPlayer from '../shared/player/videoPlayer.js';
import PlaybackQueue from '../shared/queue/playbackQueue.js';
import Overlays from '../shared/ui/overlays.js';
import ServerAPI from '../web/serverAPI.js';
import WebOSStorage from './storage.js';
import RemoteControl from './remoteControl.js';

class VideoJukeWebOS {
    constructor() {
        this.logger = new Logger('WEBOS-CLIENT');
        this.storage = new WebOSStorage(this.logger);
        this.loadingScreen = null;
        this.serverAPI = null;
        this.videoPlayer = null;
        this.playbackQueue = null;
        this.overlays = null;
        this.remoteControl = null;
        
        this.config = {};
        this.serverConfig = null;
        this.isPlaybackActive = false;
        this.hasStartedPlayback = false;
        
        // UI elements
        this.configScreen = document.getElementById('configScreen');
        this.loadingScreenEl = document.getElementById('loadingScreen');
        this.serverHostInput = document.getElementById('serverHost');
        this.serverPortInput = document.getElementById('serverPort');
        this.connectButton = document.getElementById('connectButton');
        
        this.initialize();
    }
    
    async initialize() {
        try {
            this.logger.log('Initializing VideoJuke for WebOS...');
            
            // Initialize WebOS service
            if (window.webOS) {
                this.logger.log('WebOS environment detected');
                webOS.deviceInfo((deviceInfo) => {
                    this.logger.log('Device info:', deviceInfo);
                });
            } else {
                this.logger.log('Running in browser mode (non-WebOS)');
            }
            
            // Load saved server configuration
            this.serverConfig = await this.storage.load();
            
            if (this.serverConfig && this.serverConfig.host && this.serverConfig.port) {
                this.logger.log(`Found saved server config: ${this.serverConfig.host}:${this.serverConfig.port}`);
                this.showLoadingScreen();
                await this.connectToServer();
            } else {
                this.logger.log('No server config found, showing configuration screen');
                this.showConfigScreen();
            }
            
        } catch (error) {
            this.logger.error('Failed to initialize', error);
            this.showError('Failed to initialize: ' + error.message);
        }
    }
    
    showConfigScreen() {
        this.configScreen.classList.remove('hidden');
        this.loadingScreenEl.classList.add('hidden');
        
        // Pre-fill inputs if we have saved values
        if (this.serverConfig) {
            this.serverHostInput.value = this.serverConfig.host || '';
            this.serverPortInput.value = this.serverConfig.port || '';
        }
        
        this.setupConfigNavigation();
    }
    
    setupConfigNavigation() {
        const focusableElements = [
            this.serverHostInput,
            this.serverPortInput,
            this.connectButton
        ];
        
        let currentFocus = 0;
        this.updateFocus(focusableElements, currentFocus);
        
        // Form submission
        document.getElementById('configForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            this.logger.log('Form submitted via submit event');
            await this.handleConnect();
        });
        
        // Keyboard navigation for config screen
        const handleConfigKeydown = async (e) => {
            this.logger.log(`Config screen key pressed: ${e.keyCode}`);
            
            switch(e.keyCode) {
                case 38: // Up arrow
                    e.preventDefault();
                    currentFocus = Math.max(0, currentFocus - 1);
                    this.updateFocus(focusableElements, currentFocus);
                    break;
                    
                case 40: // Down arrow
                    e.preventDefault();
                    currentFocus = Math.min(focusableElements.length - 1, currentFocus + 1);
                    this.updateFocus(focusableElements, currentFocus);
                    break;
                    
                case 13: // Enter/OK
                    e.preventDefault();
                    this.logger.log(`Enter pressed on element ${currentFocus}`);
                    if (currentFocus === 2) { // Connect button
                        this.logger.log('Connect button activated via remote');
                        await this.handleConnect();
                    } else {
                        // Move to next field
                        currentFocus = Math.min(focusableElements.length - 1, currentFocus + 1);
                        this.updateFocus(focusableElements, currentFocus);
                    }
                    break;
                    
                case 461: // Back button
                case 27:  // ESC
                    this.logger.log('Back button pressed');
                    if (window.webOS) {
                        webOS.platformBack();
                    }
                    break;
            }
        };
        
        // Remove any existing listener and add new one
        if (this.configKeydownHandler) {
            document.removeEventListener('keydown', this.configKeydownHandler);
        }
        this.configKeydownHandler = handleConfigKeydown;
        document.addEventListener('keydown', this.configKeydownHandler);
        
        this.logger.log('Config navigation setup complete');
    }
    
    updateFocus(elements, index) {
        elements.forEach((el, i) => {
            if (i === index) {
                el.classList.add('focused');
                el.focus();
            } else {
                el.classList.remove('focused');
            }
        });
    }
    
    async handleConnect() {
        const host = this.serverHostInput.value.trim();
        const port = parseInt(this.serverPortInput.value) || 3123;
        
        this.logger.log(`=== CONNECTION ATTEMPT ===`);
        this.logger.log(`Host: ${host}`);
        this.logger.log(`Port: ${port}`);
        
        if (!host) {
            this.logger.error('No host provided');
            this.showConfigError('Please enter a server host');
            return;
        }
        
        // Validate host format
        if (!host.match(/^[a-zA-Z0-9.-]+$/)) {
            this.logger.error('Invalid host format');
            this.showConfigError('Please enter a valid server host (IP address or hostname)');
            return;
        }
        
        // Validate port range
        if (port < 1 || port > 65535) {
            this.logger.error('Invalid port range');
            this.showConfigError('Please enter a valid port number (1-65535)');
            return;
        }
        
        this.serverConfig = { host, port };
        
        try {
            await this.storage.save(this.serverConfig);
            this.logger.log('Server config saved successfully');
        } catch (error) {
            this.logger.error('Failed to save server config', error);
            this.showConfigError('Failed to save configuration');
            return;
        }
        
        this.logger.log(`Attempting to connect to server: ${host}:${port}`);
        this.showLoadingScreen();
        
        try {
            await this.connectToServer();
        } catch (error) {
            this.logger.error('Connection failed in handleConnect', error);
            this.showConfigError(`Connection failed: ${error.message}`);
        }
    }
    
    showLoadingScreen() {
        this.configScreen.classList.add('hidden');
        this.loadingScreenEl.classList.remove('hidden');
        
        if (!this.loadingScreen) {
            this.loadingScreen = new LoadingScreen(this.logger);
        }
    }
    
    async connectToServer() {
        try {
            const serverUrl = `http://${this.serverConfig.host}:${this.serverConfig.port}`;
            this.logger.log(`=== SERVER CONNECTION ===`);
            this.logger.log(`Server URL: ${serverUrl}`);
            
            // Update loading screen
            this.loadingScreen.updateText('Connecting to server...');
            this.loadingScreen.updateProgress(10);
            
            // Initialize server API
            this.logger.log('Initializing ServerAPI...');
            this.serverAPI = new ServerAPI(this.logger, serverUrl);
            
            // Create electron-like API wrapper
            window.electronAPI = this.createElectronAPIWrapper();
            
            // Wait for connection with progress updates
            this.logger.log('Waiting for connection...');
            this.loadingScreen.updateText('Establishing connection...');
            this.loadingScreen.updateProgress(30);
            
            await this.waitForConnection();
            
            // Load configuration from server
            this.logger.log('Loading configuration from server...');
            this.loadingScreen.updateText('Loading configuration...');
            this.loadingScreen.updateProgress(50);
            
            this.config = await this.serverAPI.getConfig();
            this.logger.log('Configuration loaded successfully');
            
            // Initialize components
            this.logger.log('Initializing components...');
            this.loadingScreen.updateText('Initializing components...');
            this.loadingScreen.updateProgress(70);
            
            this.initializeComponents();
            
            // Start monitoring server initialization
            this.logger.log('Starting initialization monitoring...');
            this.loadingScreen.updateText('Checking server status...');
            this.loadingScreen.updateProgress(80);
            
            await this.startInitializationMonitoring();
            
        } catch (error) {
            this.logger.error('Failed to connect to server', error);
            
            // Provide more specific error messages
            let errorMessage = 'Failed to connect to server';
            if (error.message.includes('timeout')) {
                errorMessage = 'Connection timeout - please check the server address and ensure the server is running';
            } else if (error.message.includes('Failed to fetch')) {
                errorMessage = 'Cannot reach server - please check the IP address and port number';
            } else if (error.message.includes('Connection refused')) {
                errorMessage = 'Server refused connection - please check if VideoJuke server is running';
            } else if (error.message) {
                errorMessage = `Connection error: ${error.message}`;
            }
            
            this.showConfigError(errorMessage);
        }
    }

    showConfigError(message) {
        this.logger.error(`Config error: ${message}`);
        
        // Hide loading screen
        this.loadingScreenEl.classList.add('hidden');
        
        // Show error on config screen
        this.showConfigScreen();
        
        // Create or update error display on config screen
        let errorDisplay = document.getElementById('configError');
        if (!errorDisplay) {
            errorDisplay = document.createElement('div');
            errorDisplay.id = 'configError';
            errorDisplay.style.cssText = `
                color: #dc3545;
                background: rgba(220, 53, 69, 0.1);
                border: 2px solid #dc3545;
                padding: 20px;
                border-radius: 10px;
                margin-top: 20px;
                font-size: 24px;
                text-align: center;
            `;
            
            const configContainer = document.querySelector('.config-container');
            configContainer.appendChild(errorDisplay);
        }
        
        errorDisplay.textContent = message;
        errorDisplay.style.display = 'block';
        
        // Auto-hide error after 10 seconds
        setTimeout(() => {
            if (errorDisplay) {
                errorDisplay.style.display = 'none';
            }
        }, 10000);
    }

    async waitForConnection() {
        const maxWait = 15000; // Increased to 15 seconds
        const startTime = Date.now();
        
        return new Promise((resolve, reject) => {
            const checkConnection = () => {
                const elapsed = Date.now() - startTime;
                const progress = Math.min((elapsed / maxWait) * 100, 95);
                
                if (this.loadingScreen) {
                    this.loadingScreen.updateProgress(30 + (progress * 0.2)); // 30-50% range
                }
                
                if (this.serverAPI.isConnected()) {
                    this.logger.log('Server connection established successfully');
                    resolve();
                } else if (elapsed > maxWait) {
                    this.logger.error('Connection timeout after 15 seconds');
                    reject(new Error('Connection timeout - server may be unreachable'));
                } else {
                    setTimeout(checkConnection, 200); // Check every 200ms
                }
            };
            
            checkConnection();
        });
    }
    
    createElectronAPIWrapper() {
        return {
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
            quitApplication: () => this.quit(),
            on: (channel, callback) => this.serverAPI.on(channel, callback),
            removeListener: (channel) => this.serverAPI.removeListener(channel)
        };
    }
    
    initializeComponents() {
        // Update loading screen with config
        this.loadingScreen.config = this.config;
        
        // Initialize video components
        this.overlays = new Overlays(this.logger, this.config);
        this.videoPlayer = new VideoPlayer(this.logger, this.config);
        this.playbackQueue = new PlaybackQueue(this.logger, this.config);
        
        // Initialize remote control
        this.remoteControl = new RemoteControl(this.logger, this.config);
        
        // Connect components
        this.connectComponents();
        
        // Set up event listeners
        this.setupEventListeners();
    }
    
    connectComponents() {
        // Video player callbacks
        this.videoPlayer.onVideoEnded((videoData, fromCrossfade = false) => {
            this.handleVideoEnded(videoData, fromCrossfade);
        });
        
        this.videoPlayer.onVideoError((error) => {
            this.handleVideoError(error);
        });
        
        this.videoPlayer.onNeedNextVideo(() => {
            return this.playbackQueue.getNext();
        });
        
        this.videoPlayer.onVideoStartedPlaying((videoData, isFirstVideo) => {
            if (isFirstVideo && !this.hasStartedPlayback) {
                this.logger.log('First video started, hiding loading screen');
                this.loadingScreenEl.classList.add('hidden');
                this.hasStartedPlayback = true;
                
                // Unmute after first video starts
                this.videoPlayer.isMuted = false;
                const currentVideo = this.videoPlayer.getCurrentElement();
                if (currentVideo) {
                    currentVideo.muted = false;
                    currentVideo.volume = 1.0;
                }
            }
        });
        
        // Connect remote control to player and UI
        this.remoteControl.setVideoPlayer(this.videoPlayer);
        this.remoteControl.setOverlays(this.overlays);
        
        // Remote control callbacks
        this.remoteControl.onNextVideo(() => this.handleManualNext());
        this.remoteControl.onPreviousVideo(() => this.handleManualPrevious());
        this.remoteControl.onShowSettings(() => this.showConfigScreen());
        this.remoteControl.onExit(() => this.quit());
    }
    
    async startInitializationMonitoring() {
        const monitor = async () => {
            try {
                const status = await this.serverAPI.getQueueStatus();
                
                if (status?.initializationState) {
                    this.loadingScreen.updateInitialization(status.initializationState);
                    
                    if (status.initializationState.stage === 'complete') {
                        this.logger.log('Server initialization complete');
                        
                        if (status.preprocessedQueue?.current > 0 || status.totalVideos > 0) {
                            await this.startVideoPlayback();
                        } else {
                            this.logger.log('Server initialized but no videos available');
                            setTimeout(monitor, 2000);
                        }
                        return;
                    } else if (status.initializationState.stage === 'error') {
                        this.logger.error('Server initialization failed');
                        this.showError('Server initialization failed');
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
            
            const ready = await this.playbackQueue.buildInitialQueue(
                (progress) => {
                    this.loadingScreen.updateQueueProgress(progress);
                }
            );
            
            if (ready) {
                await this.startFirstVideo();
                this.playbackQueue.startMonitoring();
                this.isPlaybackActive = true;
                
                // Start remote control handling
                this.remoteControl.start();
                
                // Remove config keydown handler
                if (this.configKeydownHandler) {
                    document.removeEventListener('keydown', this.configKeydownHandler);
                    this.configKeydownHandler = null;
                }
            } else {
                throw new Error('Failed to build initial queue');
            }
        } catch (error) {
            this.logger.error('Failed to start video playback', error);
            this.showError(`Failed to start playback: ${error.message}`);
        }
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
        if (!this.isPlaybackActive) return;
        
        try {
            const currentVideo = this.videoPlayer.getCurrentVideo();
            
            if (!this.videoPlayer.skipToNext()) {
                this.logger.log('Cannot skip during transition');
                return;
            }
            
            if (currentVideo && !currentVideo._fromHistory) {
                await this.serverAPI.addToHistory(currentVideo);
            }
            
            await this.serverAPI.videoSkippedManual();
            
            const video = await this.playbackQueue.getNext();
            if (video) {
                await this.videoPlayer.play(video, false, true);
            } else {
                this.overlays.showError('No videos available');
            }
        } catch (error) {
            this.logger.error('Error in manual next', error);
            this.overlays.showError('Error playing video');
        }
    }
    
    async handleManualPrevious() {
        if (!this.isPlaybackActive) return;
        
        try {
            const previousVideo = await this.serverAPI.getPreviousVideo();
            
            if (!previousVideo) {
                this.overlays.showError('No previous video available');
                return;
            }
            
            const processedPrevious = await this.serverAPI.ensureVideoProcessed(previousVideo);
            
            if (!processedPrevious) {
                this.overlays.showError('Previous video not available');
                return;
            }
            
            processedPrevious._fromHistory = true;
            
            if (!this.videoPlayer.skipToNext()) {
                return;
            }
            
            const currentVideo = this.videoPlayer.getCurrentVideo();
            if (currentVideo) {
                const cleanVideo = { ...currentVideo };
                delete cleanVideo._fromHistory;
                this.playbackQueue.addBack(cleanVideo);
            }
            
            await this.serverAPI.videoReturnedToPrevious();
            await this.videoPlayer.play(processedPrevious, false, true);
            
        } catch (error) {
            this.logger.error('Error in manual previous', error);
            this.overlays.showError('Error playing previous video');
        }
    }
    
    async handleVideoEnded(videoData, fromCrossfade = false) {
        if (!this.isPlaybackActive) return;
        
        try {
            if (videoData) {
                await this.serverAPI.videoEnded(videoData);
            }
            
            if (!fromCrossfade) {
                const nextVideo = await this.playbackQueue.getNext();
                if (nextVideo) {
                    await this.videoPlayer.play(nextVideo, false);
                } else {
                    this.overlays.showError('No videos available');
                    
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
        }
    }
    
    async handleVideoError(error) {
        this.logger.error('Video playback error', error);
        
        await this.serverAPI.videoError(error.message || 'Unknown playback error');
        this.overlays.showError(`Playback error: ${error.message || 'Unknown error'}`);
        
        const errorRecoveryDelay = this.config.timeouts?.errorRecoveryDelay || 1000;
        
        setTimeout(() => {
            if (this.isPlaybackActive) {
                this.handleVideoEnded(null);
            }
        }, errorRecoveryDelay);
    }
    
    setupEventListeners() {
        // Listen for server messages
        this.serverAPI.on('main-log', (logData) => {
            this.logger.log(`[SERVER] ${logData.message}`);
        });
        
        this.serverAPI.on('initialization-update', (initState) => {
            this.loadingScreen.updateInitialization(initState);
        });
        
        // WebOS app lifecycle events
        if (window.webOS) {
            document.addEventListener('webOSRelaunch', (e) => {
                this.logger.log('App relaunched with params:', e.detail);
            });
            
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    this.logger.log('App hidden');
                } else {
                    this.logger.log('App visible');
                }
            });
        }
        
        // Clean up on unload
        window.addEventListener('beforeunload', () => {
            this.cleanup();
        });
    }
    
    showError(message) {
        if (this.overlays) {
            this.overlays.showError(message);
        } else {
            // Fallback error display
            const errorEl = document.getElementById('errorMessage');
            const errorOverlay = document.getElementById('errorOverlay');
            if (errorEl && errorOverlay) {
                errorEl.textContent = message;
                errorOverlay.classList.add('visible');
                setTimeout(() => {
                    errorOverlay.classList.remove('visible');
                }, 5000);
            }
        }
    }
    
    quit() {
        this.logger.log('Quitting application');
        this.cleanup();
        
        if (window.webOS) {
            webOS.platformBack();
        } else {
            window.close();
        }
    }
    
    cleanup() {
        this.isPlaybackActive = false;
        
        if (this.remoteControl) {
            this.remoteControl.stop();
        }
        
        if (this.videoPlayer) {
            this.videoPlayer.cleanup();
        }
        
        if (this.playbackQueue) {
            this.playbackQueue.cleanup();
        }
        
        if (this.serverAPI) {
            this.serverAPI.cleanup();
        }
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new VideoJukeWebOS());
} else {
    new VideoJukeWebOS();
}