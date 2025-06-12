const path = require('path');
const { glob } = require('glob');
const FileUtils = require('../utils/fileUtils');
const TimeConditionEvaluator = require('../utils/timeConditionEvaluator');

class VideoIndex {
    constructor(logger, configManager) {
        this.logger = logger;
        this.configManager = configManager;
        this.cacheDir = path.join(process.cwd(), 'cache');
        this.indexPath = path.join(this.cacheDir, 'video-index.json');
        this.seasonalIndexPath = path.join(this.cacheDir, 'seasonal-video-index.json');
        this.videos = [];
        this.seasonalVideos = new Map(); // Map<directory, videos[]>
        this.timeEvaluator = new TimeConditionEvaluator(logger);
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
            let regularLoaded = false;
            let seasonalLoaded = false;
            
            // Load regular video index
            if (await FileUtils.exists(this.indexPath)) {
                const indexData = await FileUtils.readJSON(this.indexPath);
                
                if (Array.isArray(indexData)) {
                    this.videos = indexData;
                    this.logger.log(`Loaded regular video index from cache: ${this.videos.length} videos`);
                    regularLoaded = true;
                }
            }
            
            // Load seasonal video index
            if (await FileUtils.exists(this.seasonalIndexPath)) {
                const seasonalData = await FileUtils.readJSON(this.seasonalIndexPath);
                
                if (seasonalData && seasonalData.seasonalVideos) {
                    this.seasonalVideos.clear();
                    
                    // Convert the saved object back to a Map
                    for (const [directory, videos] of Object.entries(seasonalData.seasonalVideos)) {
                        if (Array.isArray(videos)) {
                            this.seasonalVideos.set(directory, videos);
                        }
                    }
                    
                    const totalSeasonalVideos = this.getTotalSeasonalVideos();
                    this.logger.log(`Loaded seasonal video index from cache: ${this.seasonalVideos.size} directories, ${totalSeasonalVideos} total videos`);
                    
                    // Log breakdown by directory
                    for (const [directory, videos] of this.seasonalVideos.entries()) {
                        this.logger.log(`  ${directory}: ${videos.length} videos`);
                    }
                    
                    seasonalLoaded = true;
                }
            }
            
            if (!regularLoaded) {
                this.videos = [];
                this.logger.log('No regular video index found in cache');
            }
            
            if (!seasonalLoaded) {
                this.seasonalVideos.clear();
                this.logger.log('No seasonal video index found in cache');
            }
            
            return regularLoaded || seasonalLoaded;
            
        } catch (error) {
            this.logger.error('Failed to load video indexes from cache', error);
            this.videos = [];
            this.seasonalVideos.clear();
            return false;
        }
    }
    
    async save() {
        try {
            // Ensure cache directory exists
            await FileUtils.ensureDirectory(this.cacheDir);
            
            // Save regular video index
            await FileUtils.writeJSON(this.indexPath, this.videos);
            this.logger.log(`Regular video index saved to cache: ${this.videos.length} videos`);
            
            // Save seasonal video index
            const seasonalData = {
                savedAt: new Date().toISOString(),
                seasonalVideos: Object.fromEntries(this.seasonalVideos) // Convert Map to plain object for JSON
            };
            
            await FileUtils.writeJSON(this.seasonalIndexPath, seasonalData);
            
            const totalSeasonalVideos = this.getTotalSeasonalVideos();
            this.logger.log(`Seasonal video index saved to cache: ${this.seasonalVideos.size} directories, ${totalSeasonalVideos} total videos`);
            
            // Log breakdown by directory
            for (const [directory, videos] of this.seasonalVideos.entries()) {
                this.logger.log(`  Saved ${directory}: ${videos.length} videos`);
            }
            
        } catch (error) {
            this.logger.error('Failed to save video indexes to cache', error);
        }
    }
    
    async build(progressCallback) {
        this.logger.log('Building video index...');
        
        try {
            const foundVideos = await this.scanDirectories(progressCallback);
            
            // Build regular index (even if empty)
            this.videos = foundVideos.map(videoPath => ({
                originalPath: videoPath,
                filename: path.basename(videoPath),
                directory: path.dirname(videoPath),
                addedAt: new Date().toISOString()
            }));
            
            this.logger.log(`Regular video index built: ${this.videos.length} files`);
            
            // Always build seasonal index
            await this.buildSeasonalIndex();
            
            // Save both indexes
            await this.save();
            
        } catch (error) {
            this.logger.error('Failed to build video index', error);
            this.videos = [];
            this.seasonalVideos.clear();
        }
    }
    
    async buildSeasonalIndex() {
        this.logger.log('=== BUILDING SEASONAL VIDEO INDEX ===');
        
        const seasonalDirectories = this.configManager.config.seasonalDirectories || [];
        this.logger.log(`Found ${seasonalDirectories.length} seasonal directory configurations`);
        
        this.seasonalVideos.clear();
        
        if (seasonalDirectories.length === 0) {
            this.logger.log('No seasonal directories configured');
            return;
        }
        
        for (let i = 0; i < seasonalDirectories.length; i++) {
            const seasonalConfig = seasonalDirectories[i];
            this.logger.log(`=== Processing seasonal directory ${i + 1}/${seasonalDirectories.length} ===`);
            this.logger.log(`Directory: ${seasonalConfig.directory}`);
            this.logger.log(`Likelihood: ${seasonalConfig.likelihood}`);
            this.logger.log(`Conditions:`, JSON.stringify(seasonalConfig.conditions, null, 2));
            
            try {
                const directory = seasonalConfig.directory;
                
                // Check if directory exists
                this.logger.log(`Checking if directory exists: ${directory}`);
                if (!(await FileUtils.exists(directory))) {
                    this.logger.error(`Seasonal directory does not exist: ${directory}`);
                    continue;
                }
                this.logger.log(`✓ Directory exists: ${directory}`);
                
                this.logger.log(`Scanning for video files in: ${directory}`);
                
                const pattern = path.join(directory, '**', '*').replace(/\\/g, '/');
                this.logger.log(`Using glob pattern: ${pattern}`);
                
                const files = await glob(pattern, { nodir: true });
                this.logger.log(`Found ${files.length} total files in directory`);
                
                const videos = [];
                let videoFileCount = 0;
                let nonVideoFileCount = 0;
                
                for (const file of files) {
                    const isVideo = FileUtils.isVideoFile(file, this.configManager);
                    if (isVideo) {
                        videos.push({
                            originalPath: file,
                            filename: path.basename(file),
                            directory: path.dirname(file),
                            addedAt: new Date().toISOString(),
                            seasonalDirectory: directory
                        });
                        videoFileCount++;
                        this.logger.log(`✓ Video file: ${path.basename(file)}`);
                    } else {
                        nonVideoFileCount++;
                        this.logger.log(`✗ Non-video file: ${path.basename(file)}`);
                    }
                }
                
                this.logger.log(`Video files found: ${videoFileCount}, Non-video files: ${nonVideoFileCount}`);
                
                if (videos.length > 0) {
                    this.seasonalVideos.set(directory, videos);
                    this.logger.log(`✓ Added ${videos.length} videos to seasonal index for: ${directory}`);
                    
                    // Log first few video filenames for verification
                    const sampleSize = Math.min(5, videos.length);
                    this.logger.log(`Sample videos from ${directory}:`);
                    for (let j = 0; j < sampleSize; j++) {
                        this.logger.log(`  - ${videos[j].filename}`);
                    }
                    if (videos.length > sampleSize) {
                        this.logger.log(`  ... and ${videos.length - sampleSize} more`);
                    }
                } else {
                    this.logger.error(`No video files found in seasonal directory: ${directory}`);
                }
                
            } catch (error) {
                this.logger.error(`Failed to scan seasonal directory: ${seasonalConfig.directory}`, error);
            }
        }
        
        const totalSeasonalVideos = this.getTotalSeasonalVideos();
        this.logger.log(`=== SEASONAL INDEX COMPLETE ===`);
        this.logger.log(`Total seasonal directories: ${this.seasonalVideos.size}`);
        this.logger.log(`Total seasonal videos: ${totalSeasonalVideos}`);
        
        // Debug: List all seasonal directories and their video counts
        for (const [directory, videos] of this.seasonalVideos.entries()) {
            this.logger.log(`  ${directory}: ${videos.length} videos`);
        }
    }
    
    getTotalSeasonalVideos() {
        let total = 0;
        for (const videos of this.seasonalVideos.values()) {
            total += videos.length;
        }
        return total;
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
            this.logger.log('Regular video index not found in cache - rebuild required');
            return true;
        }
        
        if (!(await FileUtils.exists(this.seasonalIndexPath))) {
            this.logger.log('Seasonal video index not found in cache - rebuild required');
            return true;
        }
        
        const currentHash = this.configManager.calculateHash();
        if (currentHash !== this.configManager.config.system.lastConfigHash) {
            this.logger.log('Configuration changed - rebuild required');
            return true;
        }
        
        // Check if seasonal directories configuration has changed
        const seasonalDirectories = this.configManager.config.seasonalDirectories || [];
        const currentSeasonalDirs = seasonalDirectories.map(sd => sd.directory).sort();
        const cachedSeasonalDirs = Array.from(this.seasonalVideos.keys()).sort();
        
        if (JSON.stringify(currentSeasonalDirs) !== JSON.stringify(cachedSeasonalDirs)) {
            this.logger.log('Seasonal directories configuration changed - rebuild required');
            this.logger.log(`Current: ${JSON.stringify(currentSeasonalDirs)}`);
            this.logger.log(`Cached: ${JSON.stringify(cachedSeasonalDirs)}`);
            return true;
        }
        
        return false;
    }
    
    getRandomVideo(excludePaths = []) {
        const excludeSet = new Set(excludePaths);
        
        // First, check seasonal directories
        const seasonalVideo = this.getSeasonalVideo(excludeSet);
        if (seasonalVideo) {
            this.logger.log(`Selected seasonal video: ${seasonalVideo.filename} from ${seasonalVideo.seasonalDirectory}`);
            return seasonalVideo;
        }
        
        // Fall back to regular video selection
        const availableVideos = this.videos.filter(video => !excludeSet.has(video.originalPath));
        
        if (availableVideos.length === 0) {
            this.logger.log('No available videos (regular or seasonal)');
            return null;
        }
        
        const randomIndex = Math.floor(Math.random() * availableVideos.length);
        const selectedVideo = availableVideos[randomIndex];
        
        this.logger.log(`Selected regular video: ${selectedVideo.filename}`);
        return selectedVideo;
    }
    
    getSeasonalVideo(excludeSet) {
        const seasonalDirectories = this.configManager.config.seasonalDirectories || [];
        
        if (seasonalDirectories.length === 0) {
            this.logger.log('No seasonal directories configured');
            return null;
        }
        
        // Debug current time conditions
        const debugInfo = this.timeEvaluator.getDebugInfo();
        this.logger.log(`=== SEASONAL VIDEO SELECTION ===`);
        this.logger.log(`Current time: ${debugInfo.currentTime}`);
        this.logger.log(`Day of week: ${debugInfo.dayOfWeek} (0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat)`);
        this.logger.log(`Hour: ${debugInfo.hour}, Minute: ${debugInfo.minute}`);
        this.logger.log(`Day of month: ${debugInfo.dayOfMonth}, Month: ${debugInfo.month}, Year: ${debugInfo.year}`);
        this.logger.log(`Minute parity: ${debugInfo.minuteParity}`);
        
        for (let i = 0; i < seasonalDirectories.length; i++) {
            const seasonalConfig = seasonalDirectories[i];
            const { directory, likelihood = 0, conditions } = seasonalConfig;
            
            this.logger.log(`--- Checking seasonal directory ${i + 1}/${seasonalDirectories.length} ---`);
            this.logger.log(`Directory: ${directory}`);
            this.logger.log(`Likelihood: ${likelihood}`);
            this.logger.log(`Conditions: ${JSON.stringify(conditions, null, 2)}`);
            
            try {
                // Check if this seasonal directory is currently active
                const conditionsMatch = this.timeEvaluator.evaluate(conditions);
                this.logger.log(`Conditions match: ${conditionsMatch}`);
                
                if (!conditionsMatch) {
                    this.logger.log(`✗ Conditions do not match, skipping directory`);
                    continue;
                }
                
                this.logger.log(`✓ Conditions match! Checking probability...`);
                
                // Roll probability dice
                const random = Math.random();
                this.logger.log(`Random roll: ${random}, Required: < ${likelihood}`);
                
                if (random >= likelihood) {
                    this.logger.log(`✗ Probability check failed: ${random} >= ${likelihood}`);
                    continue;
                }
                
                this.logger.log(`✓ Probability check passed: ${random} < ${likelihood}`);
                this.logger.log(`Selecting video from seasonal directory: ${directory}`);
                
                // Get videos from this seasonal directory
                const seasonalVideos = this.seasonalVideos.get(directory) || [];
                this.logger.log(`Videos available in seasonal directory: ${seasonalVideos.length}`);
                
                if (seasonalVideos.length === 0) {
                    this.logger.error(`No videos loaded for seasonal directory: ${directory}`);
                    this.logger.error(`This suggests the directory wasn't properly scanned during buildSeasonalIndex()`);
                    continue;
                }
                
                const availableSeasonalVideos = seasonalVideos.filter(video => !excludeSet.has(video.originalPath));
                this.logger.log(`Videos available after excluding already-used: ${availableSeasonalVideos.length}`);
                
                if (availableSeasonalVideos.length === 0) {
                    this.logger.log(`No available videos in seasonal directory after exclusions: ${directory}`);
                    continue;
                }
                
                // Select random video from this seasonal directory
                const randomIndex = Math.floor(Math.random() * availableSeasonalVideos.length);
                const selectedVideo = availableSeasonalVideos[randomIndex];
                
                this.logger.log(`✓ SELECTED SEASONAL VIDEO: ${selectedVideo.filename}`);
                this.logger.log(`   From directory: ${directory}`);
                this.logger.log(`   Original path: ${selectedVideo.originalPath}`);
                
                return selectedVideo;
                
            } catch (error) {
                this.logger.error(`Error processing seasonal directory: ${seasonalConfig.directory}`, error);
            }
        }
        
        this.logger.log(`No seasonal video selected, falling back to regular selection`);
        return null; // No seasonal video selected
    }
    
    getCount() {
        return this.videos.length + this.getTotalSeasonalVideos();
    }
}

module.exports = VideoIndex;