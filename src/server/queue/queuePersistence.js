const path = require('path');
const fs = require('fs').promises;
const FileUtils = require('../utils/fileUtils');

class QueuePersistence {
    constructor(logger, configManager, preprocessedQueue, historyManager) {
        this.logger = logger;
        this.configManager = configManager;
        this.preprocessedQueue = preprocessedQueue;
        this.historyManager = historyManager;
        this.cacheDir = path.join(process.cwd(), 'cache');
        this.queueStatePath = path.join(this.cacheDir, 'queue-state.json');
        this.tempDir = path.join(process.cwd(), 'temp');
    }
    
    async save(mainWindow) {
        try {
            // Ensure cache directory exists
            await FileUtils.ensureDirectory(this.cacheDir);
            
            this.logger.log('Saving queue state to cache...');
            
            // Get playback queue from renderer
            let playbackQueue = [];
            if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                playbackQueue = await mainWindow.webContents.executeJavaScript(
                    'window.getQueueStateForPersistence ? window.getQueueStateForPersistence() : []'
                );
            }
            
            // Get playback history from HistoryManager
            let playbackHistory = [];
            if (this.historyManager) {
                playbackHistory = this.historyManager.getPlaybackHistoryForPersistence();
            }
            
            // Combine queues
            const preprocessedQueue = this.preprocessedQueue.getQueue();
            const combinedQueue = [...playbackQueue, ...preprocessedQueue];
            
            // Create queue state
            const queueState = {
                savedAt: new Date().toISOString(),
                configHash: this.configManager.calculateHash(),
                combinedQueue: combinedQueue,
                playbackHistory: playbackHistory,
                stats: {
                    totalVideos: this.preprocessedQueue.videoIndex.getCount(),
                    preprocessedVideos: this.preprocessedQueue.stats.preprocessedVideos
                }
            };
            
            await FileUtils.writeJSON(this.queueStatePath, queueState);
            this.logger.log(`Queue state saved to cache: ${combinedQueue.length} videos, ${playbackHistory.length} playback history`);
            
            // Clean up temp directory after saving
            const cleanupDelay = this.configManager.getTimeout('cleanupDelay', 2000);
            setTimeout(() => this.cleanupTempDirectory(queueState), cleanupDelay);
            
        } catch (error) {
            this.logger.error('Failed to save queue state to cache', error);
        }
    }
    
    async load() {
        try {
            // Ensure cache directory exists
            await FileUtils.ensureDirectory(this.cacheDir);
            
            if (!(await FileUtils.exists(this.queueStatePath))) {
                this.logger.log('No queue state found in cache');
                return false;
            }
            
            const queueState = await FileUtils.readJSON(this.queueStatePath);
            if (!queueState) {
                this.logger.log('Invalid queue state in cache');
                return false;
            }
            
            // Check config hash
            if (queueState.configHash !== this.configManager.calculateHash()) {
                this.logger.log('Configuration changed, discarding saved queue from cache');
                await this.clear();
                return false;
            }
            
            // Validate and restore videos
            const validVideos = [];
            for (const video of queueState.combinedQueue || []) {
                if (video && video.processedPath && video.originalPath) {
                    const originalExists = await FileUtils.exists(video.originalPath);
                    const processedExists = await FileUtils.exists(video.processedPath);
                    
                    if (originalExists && processedExists) {
                        // Add crossfade timing if missing
                        if (!video.crossfadeTiming && video.metadata?.duration) {
                            video.crossfadeTiming = this.calculateCrossfadeTiming(video.metadata.duration);
                        }
                        validVideos.push(video);
                    } else if (processedExists && !originalExists) {
                        // Clean up orphaned processed file
                        await this.safeDeleteFile(video.processedPath);
                    }
                }
            }
            
            // Validate and restore playback history
            const validPlaybackHistory = [];
            for (const video of queueState.playbackHistory || []) {
                if (video && video.originalPath) {
                    const exists = await FileUtils.exists(video.originalPath);
                    if (exists) {
                        // Clean up any temporary flags
                        const cleanVideo = { ...video };
                        delete cleanVideo._fromHistory;
                        validPlaybackHistory.push(cleanVideo);
                    }
                }
            }
            
            // Restore queue
            if (validVideos.length > 0) {
                this.preprocessedQueue.setQueue(validVideos);
                this.logger.log(`Restored ${validVideos.length} videos to queue from cache`);
            }
            
            // Restore playback history to HistoryManager
            if (this.historyManager && validPlaybackHistory.length > 0) {
                this.historyManager.setPlaybackHistoryFromPersistence(validPlaybackHistory);
            }
            
            return validVideos.length > 0;
            
        } catch (error) {
            this.logger.error('Failed to load queue state from cache', error);
            await this.clear();
            return false;
        }
    }
    
    calculateCrossfadeTiming(duration) {
        const configDuration = (this.configManager.config.crossfade.duration || 500) / 1000;
        const minDuration = 0.2;
        const bufferTime = 0.5;
        
        let crossfadeDuration;
        if (duration < configDuration * 2) {
            crossfadeDuration = Math.max(duration / 2, minDuration);
        } else {
            crossfadeDuration = Math.min(configDuration, duration * 0.8, Math.max(configDuration, minDuration));
        }
        
        const startTime = Math.max(0, duration - crossfadeDuration - bufferTime);
        
        return {
            duration: crossfadeDuration,
            startTime: startTime
        };
    }
    
    async restoreHistoryToRenderer(mainWindow) {
        if (!this.restoredHistory || this.restoredHistory.length === 0) {
            return;
        }
        
        try {
            if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                await mainWindow.webContents.executeJavaScript(
                    `window.setHistoryFromPersistence && window.setHistoryFromPersistence(${JSON.stringify(this.restoredHistory)})`
                );
                this.logger.log(`Restored ${this.restoredHistory.length} history entries`);
                this.restoredHistory = null;
            }
        } catch (error) {
            this.logger.error('Failed to restore history', error);
        }
    }
    
    async cleanupTempDirectory(queueState = null) {
        try {
            if (!(await FileUtils.exists(this.tempDir))) {
                return;
            }
            
            const tempFiles = await fs.readdir(this.tempDir);
            
            // Load queue state if not provided
            if (!queueState && await FileUtils.exists(this.queueStatePath)) {
                queueState = await FileUtils.readJSON(this.queueStatePath);
            }
            
            // Collect files to preserve
            const preservedFiles = new Set();
            
            if (queueState) {
                // Preserve files from queue
                for (const video of queueState.combinedQueue || []) {
                    if (video.processedPath) {
                        preservedFiles.add(path.basename(video.processedPath));
                    }
                }
                
                // Preserve files from playback history
                for (const video of queueState.playbackHistory || []) {
                    if (video.processedPath) {
                        preservedFiles.add(path.basename(video.processedPath));
                    }
                }
            }
            
            // Add current queue videos
            for (const video of this.preprocessedQueue.getQueue()) {
                if (video.processedPath) {
                    preservedFiles.add(path.basename(video.processedPath));
                }
            }
            
            // Add playback history videos from HistoryManager
            if (this.historyManager) {
                const playbackHistoryVideos = this.historyManager.getPlaybackHistoryVideos();
                for (const video of playbackHistoryVideos) {
                    if (video.processedPath) {
                        preservedFiles.add(path.basename(video.processedPath));
                    }
                }
            }
            
            // Clean up files
            let cleanedCount = 0;
            for (const filename of tempFiles) {
                if (!preservedFiles.has(filename)) {
                    const filePath = path.join(this.tempDir, filename);
                    if (await this.safeDeleteFile(filePath)) {
                        cleanedCount++;
                    }
                }
            }
            
            if (cleanedCount > 0) {
                this.logger.log(`Cleaned up ${cleanedCount} temp files`);
            }
            
        } catch (error) {
            this.logger.error('Failed to cleanup temp directory', error);
        }
    }
    
    async safeDeleteFile(filePath) {
        try {
            if (await FileUtils.exists(filePath)) {
                await fs.unlink(filePath);
                return true;
            }
            return false;
        } catch (error) {
            if (error.code === 'EBUSY' || error.code === 'ENOENT') {
                // File is locked or already deleted
                return false;
            }
            this.logger.error(`Failed to delete file: ${path.basename(filePath)}`, error);
            return false;
        }
    }
    
    async clear() {
        await FileUtils.deleteFile(this.queueStatePath);
        this.restoredHistory = null;
        this.logger.log('Queue state cache cleared');
    }
}

module.exports = QueuePersistence;