const { app } = require('electron');
const path = require('path');

const WindowManager = require('./window/windowManager');
const ConfigManager = require('./config/configManager');
const VideoIndex = require('./video/videoIndex');
const PreprocessedQueue = require('./queue/preprocessedQueue');
const QueuePersistence = require('./queue/queuePersistence');
const ReprocessHandler = require('./queue/reprocessHandler');
const HistoryManager = require('./queue/historyManager');
const IpcHandlers = require('./ipc/ipcHandlers');
const Logger = require('./utils/logger');

class VideoPlayerServer {
    constructor() {
        this.logger = new Logger('SERVER');
        this.windowManager = null;
        this.configManager = null;
        this.videoIndex = null;
        this.preprocessedQueue = null;
        this.queuePersistence = null;
        this.reprocessHandler = null;
        this.historyManager = null;
        this.ipcHandlers = null;
        
        this.initializationState = {
            stage: 'not_started',
            progress: 0,
            message: 'Waiting to start...',
            error: null
        };
        
        this.stats = {
            totalVideos: 0,
            preprocessedVideos: 0,
            preprocessingErrors: 0,
            lastIndexUpdate: null,
            videosPlayedThisSession: 0,
            videosSkippedErrors: 0,
            videosSkippedManual: 0,
            videosReturnedToPrevious: 0
        };
    }
    
    async initialize() {
        try {
            this.logger.log('Starting application initialization');
            
            // Load configuration first
            this.updateInitializationState('loading_config', 5, 'Loading configuration...');
            this.configManager = new ConfigManager(this.logger);
            await this.configManager.load();
            
            // Register basic IPC handlers early so client can get config
            this.registerBasicIpcHandlers();
            
            // Create window
            this.windowManager = new WindowManager(this.logger, this.configManager.config);
            this.windowManager.createWindow();
            
            // Initialize components
            this.videoIndex = new VideoIndex(this.logger, this.configManager);
            this.preprocessedQueue = new PreprocessedQueue(this.logger, this.configManager, this.videoIndex, this.stats);
            
            // Wait for preprocessor to be ready
            this.updateInitializationState('loading_config', 10, 'Initializing video processor...');
            await this.preprocessedQueue.initTempDir();
            this.logger.log('Preprocessed queue ready');
            
            this.historyManager = new HistoryManager(this.logger, this.configManager);
            this.queuePersistence = new QueuePersistence(this.logger, this.configManager, this.preprocessedQueue, this.historyManager);
            this.reprocessHandler = new ReprocessHandler(this.logger, this.preprocessedQueue, this.videoIndex);
            
            // Load history
            this.updateInitializationState('loading_config', 15, 'Loading history...');
            await this.historyManager.load();
            
            // Clean up temp directory (with error handling)
            this.updateInitializationState('loading_config', 20, 'Cleaning temporary files...');
            try {
                await this.queuePersistence.cleanupTempDirectory();
            } catch (error) {
                this.logger.error('Failed to cleanup temp directory during initialization', error);
                // Continue with initialization even if cleanup fails
            }
            
            // Set up full IPC handlers now that all components are ready
            this.ipcHandlers = new IpcHandlers(
                this.logger,
                this.configManager,
                this.videoIndex,
                this.preprocessedQueue,
                this.queuePersistence,
                this.reprocessHandler,
                this.historyManager,
                this.windowManager,
                this.stats,
                this.initializationState
            );
            this.ipcHandlers.register();
            
            // Set up event handlers
            this.setupEventHandlers();
            
            // Start initialization when window is ready
            this.windowManager.onReady(() => {
                setTimeout(() => this.performInitialization(), 100);
            });
            
            // Save queue and history on window close
            this.windowManager.onClose(async () => {
                try {
                    await this.queuePersistence.save(this.windowManager.getWindow());
                    await this.historyManager.save();
                } catch (error) {
                    this.logger.error('Failed to save during window close', error);
                }
            });
            
        } catch (error) {
            this.logger.error('Failed to initialize server', error);
            this.updateInitializationState('error', 0, 'Initialization failed', error.message);
        }
    }
    
    registerBasicIpcHandlers() {
        const { ipcMain } = require('electron');
        
        this.logger.log('Registering basic IPC handlers');
        
        // Configuration - essential for client startup
        ipcMain.handle('get-config', async () => {
            this.logger.log('Client requested configuration');
            return this.configManager.config;
        });
        
        // Initialization status
        ipcMain.handle('get-initialization-status', async () => {
            return this.initializationState;
        });
        
        ipcMain.handle('start-initialization', async () => {
            return this.initializationState;
        });
        
        // Basic queue status (with safe fallbacks)
        ipcMain.handle('get-queue-status', async () => {
            return {
                preprocessedQueue: {
                    current: this.preprocessedQueue ? this.preprocessedQueue.size() : 0,
                    target: this.configManager.config.video.preprocessedQueueSize
                },
                isPreprocessing: this.preprocessedQueue ? this.preprocessedQueue.isProcessing : false,
                totalVideos: this.stats.totalVideos,
                initializationState: this.initializationState
            };
        });
        
        this.logger.log('Basic IPC handlers registered successfully');
    }

    async performInitialization() {
        let retryCount = 0;
        const maxRetries = this.configManager.getRetry('maxInitializationAttempts', 3);
        
        while (retryCount < maxRetries) {
            try {
                // Start config watcher
                this.configManager.startWatcher(async () => {
                    await this.handleConfigChange();
                });
                
                // Load or build video index
                this.updateInitializationState('building_index', 25, 'Building video index...');
                const needsRebuild = await this.videoIndex.initialize();
                
                if (needsRebuild) {
                    await this.buildVideoIndex();
                } else {
                    this.logger.log(`Using existing index: ${this.videoIndex.getCount()} videos`);
                    this.updateInitializationState('building_index', 60, `Loaded index: ${this.videoIndex.getCount()} videos`);
                }
                
                this.stats.totalVideos = this.videoIndex.getCount();
                
                // Check if we have any videos
                if (this.stats.totalVideos === 0) {
                    this.logger.error('No videos found in configured directories');
                    this.updateInitializationState('error', 0, 'No videos found. Please check your config.json');
                    return;
                }
                
                this.logger.log(`Found ${this.stats.totalVideos} videos in index`);
                
                // Load saved queue state
                this.updateInitializationState('filling_queue', 65, 'Loading queue state...');
                const queueLoaded = await this.queuePersistence.load();
                
                if (queueLoaded) {
                    this.logger.log(`Queue state loaded: ${this.preprocessedQueue.size()} videos`);
                }
                
                // Start background monitoring
                this.startBackgroundUpdates();
                this.preprocessedQueue.startMonitoring();
                
                // Ensure minimum videos for startup
                if (this.preprocessedQueue.size() < 1) {
                    await this.fillPreprocessedQueue(1);
                } else {
                    this.updateInitializationState('complete', 100, 'Initialization complete!');
                }
                
                // Restore history after renderer is ready
                const historyRestoreDelay = this.configManager.getTimeout('historyRestoreDelay', 3000);
                setTimeout(async () => {
                    await this.queuePersistence.restoreHistoryToRenderer(this.windowManager.getWindow());
                }, historyRestoreDelay);
                
                // Success - exit retry loop
                return;
                
            } catch (error) {
                retryCount++;
                this.logger.error(`Initialization attempt ${retryCount} failed`, error);
                
                if (retryCount < maxRetries) {
                    const retryDelay = this.configManager.getTimeout('initializationRetryDelay', 2000);
                    this.updateInitializationState('retrying', 20, `Retrying initialization (attempt ${retryCount + 1}/${maxRetries})...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    this.logger.error('Maximum retry attempts reached');
                    this.updateInitializationState('error', 0, 'Initialization failed after multiple attempts', error.message);
                    
                    // Try to recover with minimal functionality
                    this.logger.log('Attempting minimal recovery...');
                    try {
                        this.stats.totalVideos = 0;
                        this.startBackgroundUpdates();
                        this.preprocessedQueue.startMonitoring();
                        
                        // Schedule another attempt in the background
                        const recoveryDelay = this.configManager.getTimeout('backgroundRecoveryDelay', 30000);
                        setTimeout(() => {
                            this.logger.log('Attempting background recovery...');
                            this.performInitialization();
                        }, recoveryDelay);
                    } catch (recoveryError) {
                        this.logger.error('Recovery failed', recoveryError);
                    }
                }
            }
        }
    }
    
    async buildVideoIndex() {
        this.updateInitializationState('building_index', 30, 'Scanning directories...');
        
        await this.videoIndex.build((progress) => {
            this.updateInitializationState('building_index', 30 + (progress.percent * 0.3), progress.message);
        });
        
        this.stats.totalVideos = this.videoIndex.getCount();
        this.stats.lastIndexUpdate = new Date().toISOString();
        
        await this.configManager.updateHash();
    }
    
    async fillPreprocessedQueue(targetSize) {
        this.updateInitializationState('filling_queue', 70, 'Preprocessing videos...');
        
        try {
            await this.preprocessedQueue.fill(targetSize, (progress) => {
                const currentProgress = 70 + (progress * 0.25);
                this.updateInitializationState('filling_queue', currentProgress, 
                    `Preprocessing: ${this.preprocessedQueue.size()}/${targetSize}`);
            });
            
            const actualSize = this.preprocessedQueue.size();
            
            if (actualSize >= 1) {
                if (actualSize >= targetSize) {
                    this.updateInitializationState('complete', 100, 'Initialization complete!');
                } else {
                    this.updateInitializationState('complete', 100, 
                        `Initialization complete with ${actualSize} videos (target was ${targetSize})`);
                }
            } else if (this.stats.totalVideos === 0) {
                this.updateInitializationState('error', 0, 'No videos found in configured directories');
            } else {
                // Try again with any videos we can get
                this.logger.log('Failed to preprocess minimum videos, trying with any available...');
                this.updateInitializationState('filling_queue', 75, 'Retrying with lower requirements...');
                
                await this.preprocessedQueue.fill(1, (progress) => {
                    const currentProgress = 75 + (progress * 0.20);
                    this.updateInitializationState('filling_queue', currentProgress, 
                        `Preprocessing any available video...`);
                });
                
                if (this.preprocessedQueue.size() >= 1) {
                    this.updateInitializationState('complete', 100, 
                        `Initialization complete with limited videos (${this.preprocessedQueue.size()} processed)`);
                } else {
                    this.updateInitializationState('error', 0, 'Failed to preprocess any videos');
                }
            }
        } catch (error) {
            this.logger.error('Error during fillPreprocessedQueue', error);
            this.updateInitializationState('error', 0, 'Failed to preprocess videos', error.message);
        }
    }
    
    async handleConfigChange() {
        const newHash = this.configManager.calculateHash();
        if (newHash !== this.configManager.config.system.lastConfigHash) {
            this.logger.log('Directories changed, rebuilding index...');
            await this.queuePersistence.clear();
            await this.buildVideoIndex();
        }
    }
    
    startBackgroundUpdates() {
        const updateInterval = this.configManager.get('video.updateInterval', 900000);
        const cleanupInterval = this.configManager.getTimeout('periodicCleanupInterval', 300000);
        const saveInterval = this.configManager.getTimeout('periodicSaveInterval', 60000);
        
        // Index update interval
        setInterval(async () => {
            try {
                const beforeCount = this.videoIndex.getCount();
                await this.buildVideoIndex();
                const afterCount = this.videoIndex.getCount();
                
                const difference = afterCount - beforeCount;
                if (Math.abs(difference) > 5) {
                    this.logger.log(`Significant changes detected (${difference > 0 ? '+' : ''}${difference}), clearing queue`);
                    await this.preprocessedQueue.clear();
                    await this.queuePersistence.clear();
                }
            } catch (error) {
                this.logger.error('Background update failed', error);
            }
        }, updateInterval);
        
        // Periodic cleanup
        setInterval(async () => {
            try {
                // Get current state from renderer if available
                const mainWindow = this.windowManager.getWindow();
                if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                    // Save current state to include in cleanup decisions
                    await this.queuePersistence.save(mainWindow);
                }
                
                // Run cleanup
                await this.queuePersistence.cleanupTempDirectory();
            } catch (error) {
                this.logger.error('Periodic cleanup failed', error);
            }
        }, cleanupInterval);
        
        // Periodic save
        setInterval(async () => {
            try {
                const mainWindow = this.windowManager.getWindow();
                if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                    await this.queuePersistence.save(mainWindow);
                }
            } catch (error) {
                this.logger.error('Periodic save failed', error);
            }
        }, saveInterval);
    }
    
    updateInitializationState(stage, progress, message, error = null) {
        this.initializationState.stage = stage;
        this.initializationState.progress = progress;
        this.initializationState.message = message;
        this.initializationState.error = error;
        
        this.windowManager?.sendToRenderer('initialization-update', this.initializationState);
    }
    
    setupEventHandlers() {
        app.on('before-quit', async (event) => {
            event.preventDefault();
            
            try {
                await this.queuePersistence.save(this.windowManager.getWindow());
                await this.preprocessedQueue.clear();
            } catch (error) {
                this.logger.error('Failed to save state during shutdown', error);
            }
            
            app.exit(0);
        });
        
        process.on('uncaughtException', (error) => {
            this.logger.error('Uncaught exception', error);
        });
        
        process.on('unhandledRejection', (reason) => {
            this.logger.error('Unhandled rejection', reason);
        });
    }
}

// Create and start server
const server = new VideoPlayerServer();
server.initialize();

// Export for window creation from main.js
module.exports = {
    createWindow: () => {
        if (server.windowManager) {
            server.windowManager.createWindow();
        }
    }
};