const { ipcMain, app } = require('electron');

class IpcHandlers {
    constructor(logger, configManager, videoIndex, preprocessedQueue, queuePersistence, reprocessHandler, historyManager, windowManager, stats, initializationState) {
        this.logger = logger;
        this.configManager = configManager;
        this.videoIndex = videoIndex;
        this.preprocessedQueue = preprocessedQueue;
        this.queuePersistence = queuePersistence;
        this.reprocessHandler = reprocessHandler;
        this.historyManager = historyManager;
        this.windowManager = windowManager;
        this.stats = stats;
        this.initializationState = initializationState;
    }
    
    register() {
        this.logger.log('Registering full IPC handlers');
        
        // Note: Basic handlers (get-config, get-initialization-status, start-initialization, get-queue-status) 
        // are already registered in server.js registerBasicIpcHandlers()
        
        // Detailed statistics
        ipcMain.handle('get-detailed-stats', async () => {
            const now = new Date();
            const lastUpdateDate = this.stats.lastIndexUpdate ? new Date(this.stats.lastIndexUpdate) : null;
            const nextUpdateTime = lastUpdateDate ? 
                new Date(lastUpdateDate.getTime() + (this.configManager.config.video.updateInterval || 900000)) : null;
            
            const timeUntilNextUpdate = nextUpdateTime ? Math.max(0, nextUpdateTime - now) : null;
            
            const historyInfo = this.historyManager ? this.historyManager.getDebugInfo() : {
                playbackHistory: [],
                persistedHistoryCount: 0,
                playbackHistorySize: 0,
                persistedHistorySize: 0
            };
            
            return {
                // Queue information
                preprocessedQueueSize: this.preprocessedQueue.size(),
                preprocessedQueueTarget: this.configManager.config.video.preprocessedQueueSize,
                
                // Configuration
                playbackQueueTarget: this.configManager.config.video.playbackQueueSize,
                playbackQueueInitThreshold: this.configManager.config.video.playbackQueueInitializationThreshold,
                historySize: this.configManager.config.video.historySize, // Legacy
                playbackHistorySize: this.configManager.config.video.playbackHistorySize,
                persistedHistorySize: this.configManager.config.video.persistedHistorySize,
                updateInterval: this.configManager.config.video.updateInterval,
                
                // Index information
                totalVideosInIndex: this.stats.totalVideos,
                lastIndexUpdate: this.stats.lastIndexUpdate,
                timeUntilNextUpdate: timeUntilNextUpdate,
                
                // Session statistics
                videosPlayedThisSession: this.stats.videosPlayedThisSession,
                videosSkippedErrors: this.stats.videosSkippedErrors,
                videosSkippedManual: this.stats.videosSkippedManual,
                videosReturnedToPrevious: this.stats.videosReturnedToPrevious,
                
                // Processing statistics
                preprocessedVideos: this.stats.preprocessedVideos,
                preprocessingErrors: this.stats.preprocessingErrors,
                isPreprocessing: this.preprocessedQueue.isProcessing,
                
                // History information
                playbackHistoryCount: historyInfo.playbackHistory.length,
                persistedHistoryCount: historyInfo.persistedHistoryCount
            };
        });
        
        // Video operations
        ipcMain.handle('get-next-video', async () => {
            const video = this.preprocessedQueue.getNext();
            if (video) {
                this.logger.log(`Sending video: ${video.filename}`);
                this.stats.videosPlayedThisSession++;
            }
            return video;
        });
        
        ipcMain.handle('video-ended', async (event, videoData) => {
            // Add to history when video ends naturally
            if (videoData && this.historyManager) {
                this.historyManager.addToHistory(videoData);
                this.logger.log(`Video ended and added to history: ${videoData.filename}`);
            }
        });
        
        ipcMain.handle('video-error', async (event, errorMessage) => {
            this.logger.error(`Renderer error: ${errorMessage}`);
            this.stats.videosSkippedErrors++;
        });
        
        ipcMain.handle('video-skipped-manual', async () => {
            this.stats.videosSkippedManual++;
        });
        
        ipcMain.handle('video-returned-to-previous', async () => {
            this.stats.videosReturnedToPrevious++;
        });
        
        // History operations
        ipcMain.handle('get-previous-video', async () => {
            if (this.historyManager) {
                const previous = this.historyManager.getPreviousVideo();
                if (previous) {
                    this.logger.log(`Sending previous video: ${previous.filename}`);
                    return previous;
                }
            }
            this.logger.log('No previous video available');
            return null;
        });
        
        ipcMain.handle('add-to-history', async (event, videoData) => {
            if (videoData && this.historyManager) {
                this.historyManager.addToHistory(videoData);
                this.logger.log(`Manually added to history: ${videoData.filename}`);
            }
        });
        
        // Application control
        ipcMain.handle('quit-application', async () => {
            try {
                await this.queuePersistence.save(this.windowManager.getWindow());
                if (this.historyManager) {
                    await this.historyManager.save();
                }
            } catch (error) {
                this.logger.error('Failed to save state before quit', error);
            }
            
            app.quit();
        });

        ipcMain.handle('ensure-video-processed',  async (event, videoData) => {
            try {
                return await this.reprocessHandler.ensureVideoProcessed(videoData);
            } catch (error) {
                this.logger.error('Failed to ensure video processed', error);
                return null;
            }
        });
        
        this.logger.log('Full IPC handlers registered successfully');
    }
}

module.exports = IpcHandlers;