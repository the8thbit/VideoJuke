const path = require('path');
const FileUtils = require('../utils/fileUtils');

class HistoryManager {
    constructor(logger, configManager) {
        this.logger = logger;
        this.configManager = configManager;
        this.cacheDir = path.join(process.cwd(), 'cache');
        this.historyPath = path.join(this.cacheDir, 'persisted-history.json');
        
        // In-memory playback history (recent videos)
        this.playbackHistory = [];
        this.playbackHistorySize = configManager.config.video.playbackHistorySize || 10;
        
        // Persisted history (long-term storage)
        this.persistedHistory = [];
        this.persistedHistorySize = configManager.config.video.persistedHistorySize || 5000;
        
        this.logger.log(`HistoryManager initialized: playback=${this.playbackHistorySize}, persisted=${this.persistedHistorySize}`);
    }
    
    async load() {
        try {
            // Ensure cache directory exists
            await FileUtils.ensureDirectory(this.cacheDir);
            this.logger.log(`Cache directory ready: ${this.cacheDir}`);
            
            if (await FileUtils.exists(this.historyPath)) {
                const data = await FileUtils.readJSON(this.historyPath);
                if (data && Array.isArray(data.persistedHistory)) {
                    this.persistedHistory = data.persistedHistory
                        .filter(v => v && v.originalPath)
                        .slice(0, this.persistedHistorySize);
                    
                    this.logger.log(`Loaded ${this.persistedHistory.length} persisted history entries from cache`);
                    return true;
                }
            }
            
            this.persistedHistory = [];
            this.logger.log('No persisted history found in cache, starting fresh');
            return false;
            
        } catch (error) {
            this.logger.error('Failed to load persisted history from cache', error);
            this.persistedHistory = [];
            return false;
        }
    }
    
    async save() {
        try {
            // Ensure cache directory exists
            await FileUtils.ensureDirectory(this.cacheDir);
            
            const data = {
                savedAt: new Date().toISOString(),
                persistedHistory: this.persistedHistory
            };
            
            await FileUtils.writeJSON(this.historyPath, data);
            this.logger.log(`Saved ${this.persistedHistory.length} persisted history entries to cache`);
            
        } catch (error) {
            this.logger.error('Failed to save persisted history to cache', error);
        }
    }
    
    addToHistory(videoData) {
        if (!videoData || !videoData.originalPath) {
            this.logger.log('Invalid video data for history');
            return;
        }
        
        // Don't add if it's marked as from history
        if (videoData._fromHistory) {
            this.logger.log(`Not adding to history: ${videoData.filename} (from history)`);
            return;
        }
        
        this.logger.log(`Adding to history: ${videoData.filename}`);
        
        const historyEntry = {
            ...videoData,
            addedToHistoryAt: new Date().toISOString()
        };
        
        // Add to playback history (remove duplicates first)
        this.playbackHistory = this.playbackHistory.filter(v => 
            v.originalPath !== videoData.originalPath
        );
        this.playbackHistory.unshift(historyEntry);
        
        // Maintain playback history size
        if (this.playbackHistory.length > this.playbackHistorySize) {
            this.playbackHistory = this.playbackHistory.slice(0, this.playbackHistorySize);
        }
        
        // Add to persisted history (remove duplicates first)
        this.persistedHistory = this.persistedHistory.filter(v => 
            v.originalPath !== videoData.originalPath
        );
        this.persistedHistory.unshift(historyEntry);
        
        // Maintain persisted history size
        if (this.persistedHistory.length > this.persistedHistorySize) {
            this.persistedHistory = this.persistedHistory.slice(0, this.persistedHistorySize);
        }
        
        this.logger.log(`History updated: playback=${this.playbackHistory.length}, persisted=${this.persistedHistory.length}`);
        
        // Save persisted history async
        setImmediate(() => this.save());
    }
    
    getPreviousVideo() {
        this.logger.log(`Getting previous video: playback=${this.playbackHistory.length}, persisted=${this.persistedHistory.length}`);
        
        // First try playback history
        if (this.playbackHistory.length > 0) {
            const previous = this.playbackHistory.shift();
            this.logger.log(`Retrieved from playback history: ${previous.filename}`);
            
            // Remove matching entry from persisted history
            this.persistedHistory = this.persistedHistory.filter(v => 
                v.originalPath !== previous.originalPath
            );
            
            this.logger.log(`Removed from persisted history, remaining: ${this.persistedHistory.length}`);
            
            // Save persisted history async
            setImmediate(() => this.save());
            
            return previous;
        }
        
        // Fall back to persisted history
        if (this.persistedHistory.length > 0) {
            const previous = this.persistedHistory.shift();
            this.logger.log(`Retrieved from persisted history: ${previous.filename}`);
            
            // Save persisted history async
            setImmediate(() => this.save());
            
            return previous;
        }
        
        this.logger.log('No videos in either history');
        return null;
    }
    
    getPlaybackHistoryVideos() {
        // Return videos in playback history for temp file cleanup protection
        return this.playbackHistory.map(v => ({
            originalPath: v.originalPath,
            processedPath: v.processedPath,
            filename: v.filename
        }));
    }
    
    getPlaybackHistoryForPersistence() {
        // For saving state during shutdown
        return [...this.playbackHistory];
    }
    
    setPlaybackHistoryFromPersistence(historyData) {
        if (!Array.isArray(historyData)) {
            this.logger.log('Invalid playback history data from persistence');
            return;
        }
        
        this.logger.log(`Loading ${historyData.length} playback history entries from persistence`);
        this.playbackHistory = historyData
            .filter(v => v && v.originalPath)
            .slice(0, this.playbackHistorySize);
        
        this.logger.log(`Playback history loaded: ${this.playbackHistory.length} entries`);
    }
    
    getDebugInfo() {
        return {
            playbackHistory: this.playbackHistory.map((v, i) => ({
                index: i,
                filename: v.filename,
                originalPath: v.originalPath,
                addedAt: v.addedToHistoryAt
            })),
            persistedHistoryCount: this.persistedHistory.length,
            playbackHistorySize: this.playbackHistorySize,
            persistedHistorySize: this.persistedHistorySize
        };
    }
    
    cleanup() {
        // Save final state
        this.save().catch(err => {
            this.logger.error('Failed to save history during cleanup', err);
        });
    }
}

module.exports = HistoryManager;