const FileUtils = require('../utils/fileUtils');

class ReprocessHandler {
    constructor(logger, preprocessedQueue, videoIndex) {
        this.logger = logger;
        this.preprocessedQueue = preprocessedQueue;
        this.videoIndex = videoIndex;
    }
    
    async ensureVideoProcessed(videoData) {
        if (!videoData || !videoData.originalPath) {
            this.logger.error('Invalid video data for reprocessing');
            return null;
        }
        
        this.logger.log(`Ensuring video is processed: ${videoData.filename}`);
        
        // Check if original file exists first
        if (!(await FileUtils.exists(videoData.originalPath))) {
            this.logger.error(`Original file missing: ${videoData.originalPath}`);
            return null;
        }
        
        // Check if processed file exists
        if (videoData.processedPath && await FileUtils.exists(videoData.processedPath)) {
            this.logger.log(`Processed file exists: ${videoData.filename}`);
            return videoData;
        }
        
        this.logger.log(`Processed file missing or not set for: ${videoData.filename}, reprocessing...`);
        
        // Reprocess the video using the preprocessedQueue's preprocessor
        try {
            const reprocessed = await this.preprocessedQueue.preprocessor.preprocess({
                originalPath: videoData.originalPath,
                filename: videoData.filename,
                directory: videoData.directory,
                addedAt: videoData.addedAt || new Date().toISOString()
            });
            
            // Merge with existing data
            const mergedData = {
                ...videoData,
                ...reprocessed,
                _reprocessed: true
            };
            
            // Preserve or calculate crossfade timing
            if (videoData.crossfadeTiming) {
                mergedData.crossfadeTiming = videoData.crossfadeTiming;
            } else if (mergedData.metadata?.duration) {
                // Use the preprocessor's method to calculate crossfade timing
                mergedData.crossfadeTiming = this.preprocessedQueue.preprocessor.calculateCrossfadeTiming(mergedData.metadata.duration);
            }
            
            this.logger.log(`Successfully reprocessed: ${videoData.filename}`);
            return mergedData;
            
        } catch (error) {
            this.logger.error(`Failed to reprocess: ${videoData.filename}`, error);
            return null;
        }
    }
    
    async ensureMultipleVideosProcessed(videos) {
        const results = [];
        
        for (const video of videos) {
            const processed = await this.ensureVideoProcessed(video);
            if (processed) {
                results.push(processed);
            }
        }
        
        return results;
    }
}

module.exports = ReprocessHandler;