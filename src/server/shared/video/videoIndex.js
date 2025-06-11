const path = require('path');
const { glob } = require('glob');
const FileUtils = require('../utils/fileUtils');

class VideoIndex {
    constructor(logger, configManager) {
        this.logger = logger;
        this.configManager = configManager;
        this.cacheDir = path.join(process.cwd(), 'cache');
        this.indexPath = path.join(this.cacheDir, 'video-index.json');
        this.videos = [];
    }
    
    async initialize() {
        // Ensure cache directory exists
        await FileUtils.ensureDirectory(this.cacheDir);
        this.logger.log(`Cache directory ready: ${this.cacheDir}`);
        
        const indexLoaded = await this.load();
        const needsRebuild = !indexLoaded || await this.shouldRebuild();
        return needsRebuild;
    }
    
    async load() {
        try {
            if (await FileUtils.exists(this.indexPath)) {
                const indexData = await FileUtils.readJSON(this.indexPath);
                
                if (Array.isArray(indexData)) {
                    this.videos = indexData;
                    this.logger.log(`Loaded video index from cache: ${this.videos.length} videos`);
                    return true;
                }
            }
            
            this.videos = [];
            this.logger.log('No video index found in cache');
            return false;
            
        } catch (error) {
            this.logger.error('Failed to load video index from cache', error);
            this.videos = [];
            return false;
        }
    }
    
    async save() {
        try {
            // Ensure cache directory exists
            await FileUtils.ensureDirectory(this.cacheDir);
            
            await FileUtils.writeJSON(this.indexPath, this.videos);
            this.logger.log(`Video index saved to cache: ${this.videos.length} videos`);
        } catch (error) {
            this.logger.error('Failed to save video index to cache', error);
        }
    }
    
    async build(progressCallback) {
        this.logger.log('Building video index...');
        
        try {
            const foundVideos = await this.scanDirectories(progressCallback);
            
            if (foundVideos.length === 0) {
                this.logger.log('No video files found');
                this.videos = [];
                await this.save();
                return;
            }
            
            // Build index
            this.videos = foundVideos.map(videoPath => ({
                originalPath: videoPath,
                filename: path.basename(videoPath),
                directory: path.dirname(videoPath),
                addedAt: new Date().toISOString()
            }));
            
            this.logger.log(`Video index built: ${this.videos.length} files`);
            await this.save();
            
        } catch (error) {
            this.logger.error('Failed to build video index', error);
            this.videos = [];
        }
    }
    
async scanDirectories(progressCallback) {
        const foundVideos = [];
        const directories = this.configManager.config.directories || [];
        
        if (directories.length === 0) {
            this.logger.error('No directories configured');
            return foundVideos;
        }
        
        for (let i = 0; i < directories.length; i++) {
            const directory = directories[i];
            
            try {
                if (progressCallback) {
                    progressCallback({
                        percent: (i / directories.length) * 100,
                        message: `Scanning: ${path.basename(directory)}`
                    });
                }
                
                if (!(await FileUtils.exists(directory))) {
                    this.logger.log(`Directory does not exist: ${directory}`);
                    continue;
                }
                
                const pattern = path.join(directory, '**', '*').replace(/\\/g, '/');
                const files = await glob(pattern, { nodir: true });
                
                let videoCount = 0;
                for (const file of files) {
                    if (FileUtils.isVideoFile(file, this.configManager)) {
                        foundVideos.push(file);
                        videoCount++;
                    }
                }
                
                this.logger.log(`Found ${videoCount} videos in: ${directory}`);
                
            } catch (error) {
                this.logger.error(`Failed to scan directory: ${directory}`, error);
            }
        }
        
        this.logger.log(`Total videos found: ${foundVideos.length}`);
        return foundVideos;
    }
    
    async shouldRebuild() {
        if (!(await FileUtils.exists(this.indexPath))) {
            this.logger.log('Video index not found in cache - rebuild required');
            return true;
        }
        
        const currentHash = this.configManager.calculateHash();
        if (currentHash !== this.configManager.config.system.lastConfigHash) {
            this.logger.log('Configuration changed - rebuild required');
            return true;
        }
        
        return false;
    }
    
    getRandomVideo(excludePaths = []) {
        const excludeSet = new Set(excludePaths);
        const availableVideos = this.videos.filter(video => !excludeSet.has(video.originalPath));
        
        if (availableVideos.length === 0) {
            return null;
        }
        
        const randomIndex = Math.floor(Math.random() * availableVideos.length);
        return availableVideos[randomIndex];
    }
    
    getCount() {
        return this.videos.length;
    }
}

module.exports = VideoIndex;