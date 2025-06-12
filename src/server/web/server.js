const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const cors = require('cors');

const ConfigManager = require('../shared/config/configManager');
const VideoIndex = require('../shared/video/videoIndex');
const PreprocessedQueue = require('../shared/queue/preprocessedQueue');
const QueuePersistence = require('../shared/queue/queuePersistence');
const ReprocessHandler = require('../shared/queue/reprocessHandler');
const HistoryManager = require('../shared/queue/historyManager');
const Logger = require('../shared/utils/logger');

class VideoPlayerWebServer {
    constructor() {
        this.logger = new Logger('WEB-SERVER');
        this.app = express();
        this.server = null;
        this.wss = null;
        this.clients = new Set();
        
        // Core components
        this.configManager = null;
        this.videoIndex = null;
        this.preprocessedQueue = null;
        this.queuePersistence = null;
        this.reprocessHandler = null;
        this.historyManager = null;
        
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
    
    async start() {
        try {
            this.logger.log('Starting VideoJuke web server...');
            
            // Load configuration
            this.configManager = new ConfigManager(this.logger);
            await this.configManager.load();
            
            const serverConfig = this.configManager.config.network?.server || {};
            const port = serverConfig.port || 3123;
            const host = serverConfig.host || 'localhost';
            const autoOpenBrowser = serverConfig.autoOpenBrowser !== false; // Default to true
            
            // Setup Express middleware
            this.setupMiddleware();
            
            // Setup routes
            this.setupRoutes();
            
            // Create HTTP server
            this.server = http.createServer(this.app);
            
            // Setup WebSocket server
            this.setupWebSocket();
            
            // Initialize components
            await this.initializeComponents();
            
            // Start server
            this.server.listen(port, host, () => {
                this.logger.log(`VideoJuke web server running on http://${host}:${port}`);
                this.logger.log('WebSocket server ready for real-time communication');
                
                if (autoOpenBrowser) {
                    this.logger.log('Auto-opening browser (configured in config.json)');
                    this.openBrowser(host, port);
                } else {
                    this.logger.log(`Auto-open disabled. Open http://${host}:${port} in your browser to use VideoJuke`);
                }
                
                // Start initialization
                this.performInitialization();
            });
            
        } catch (error) {
            this.logger.error('Failed to start server', error);
            process.exit(1);
        }
    }

    async openBrowser(host, port) {
        try {
            // Use dynamic import for ESM module
            const openModule = await import('open');
            const open = openModule.default;
            
            // Construct URL - use localhost if host is 0.0.0.0 (since 0.0.0.0 doesn't work in browsers)
            const browserHost = host === '0.0.0.0' ? 'localhost' : host;
            const url = `http://${browserHost}:${port}`;
            
            // Add a small delay to ensure server is fully ready
            const openDelay = this.configManager.getTimeout('browserOpenDelay', 1000);
            
            setTimeout(async () => {
                try {
                    this.logger.log(`Opening browser to: ${url}`);
                    await open(url);
                    this.logger.log('Browser opened successfully');
                } catch (openError) {
                    this.logger.error('Failed to open browser automatically', openError);
                    this.logger.log(`Please manually open: ${url}`);
                }
            }, openDelay);
            
        } catch (importError) {
            this.logger.error('Failed to import open module for browser launch', importError);
            const browserHost = host === '0.0.0.0' ? 'localhost' : host;
            this.logger.log(`Please manually open: http://${browserHost}:${port}`);
        }
    }
    
    setupMiddleware() {
        // CORS for cross-origin requests
        this.app.use(cors());
        
        // JSON parsing
        this.app.use(express.json());
        
        // Request logging
        this.app.use((req, res, next) => {
            this.logger.log(`${req.method} ${req.path}`);
            next();
        });
        
        // Serve static client files with proper MIME types
        this.app.use('/client', express.static(path.join(__dirname, '../../client/web'), {
            setHeaders: (res, filePath) => {
                if (filePath.endsWith('.js')) {
                    res.setHeader('Content-Type', 'application/javascript');
                }
            }
        }));
        
        // Serve shared client files with proper MIME types
        this.app.use('/shared', express.static(path.join(__dirname, '../../client/shared'), {
            setHeaders: (res, filePath) => {
                if (filePath.endsWith('.js')) {
                    res.setHeader('Content-Type', 'application/javascript');
                }
            }
        }));

        // Serve individual client files at root level
        this.app.get('/*.js', (req, res, next) => {
            const filename = req.params[0] + '.js';
            const filePath = path.join(__dirname, '../../client/web', filename);
            res.setHeader('Content-Type', 'application/javascript');
            res.sendFile(filePath, (err) => {
                if (err) {
                    next();
                }
            });
        });
    }
    
    setupRoutes() {
        // Health check
        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok', timestamp: new Date().toISOString() });
        });
        
        // Configuration
        this.app.get('/api/config', (req, res) => {
            this.logger.log('Client requested configuration');
            res.json(this.configManager.config);
        });
        
        // Initialization status
        this.app.get('/api/initialization-status', (req, res) => {
            res.json(this.initializationState);
        });
        
        // Queue status
        this.app.get('/api/queue-status', (req, res) => {
            res.json({
                preprocessedQueue: {
                    current: this.preprocessedQueue ? this.preprocessedQueue.size() : 0,
                    target: this.configManager.config.video.preprocessedQueueSize
                },
                isPreprocessing: this.preprocessedQueue ? this.preprocessedQueue.isProcessing : false,
                totalVideos: this.stats.totalVideos,
                initializationState: this.initializationState
            });
        });
        
        // Detailed statistics
        this.app.get('/api/detailed-stats', (req, res) => {
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
            
            res.json({
                preprocessedQueueSize: this.preprocessedQueue.size(),
                preprocessedQueueTarget: this.configManager.config.video.preprocessedQueueSize,
                playbackQueueTarget: this.configManager.config.video.playbackQueueSize,
                playbackQueueInitThreshold: this.configManager.config.video.playbackQueueInitializationThreshold,
                historySize: this.configManager.config.video.historySize,
                playbackHistorySize: this.configManager.config.video.playbackHistorySize,
                persistedHistorySize: this.configManager.config.video.persistedHistorySize,
                updateInterval: this.configManager.config.video.updateInterval,
                totalVideosInIndex: this.stats.totalVideos,
                lastIndexUpdate: this.stats.lastIndexUpdate,
                timeUntilNextUpdate: timeUntilNextUpdate,
                videosPlayedThisSession: this.stats.videosPlayedThisSession,
                videosSkippedErrors: this.stats.videosSkippedErrors,
                videosSkippedManual: this.stats.videosSkippedManual,
                videosReturnedToPrevious: this.stats.videosReturnedToPrevious,
                preprocessedVideos: this.stats.preprocessedVideos,
                preprocessingErrors: this.stats.preprocessingErrors,
                isPreprocessing: this.preprocessedQueue.isProcessing,
                playbackHistoryCount: historyInfo.playbackHistory.length,
                persistedHistoryCount: historyInfo.persistedHistoryCount
            });
        });
        
        // Video operations
        this.app.get('/api/next-video', (req, res) => {
            const video = this.preprocessedQueue.getNext();
            if (video) {
                // Validate that the processed file still exists
                const fs = require('fs');
                if (video.processedPath && !fs.existsSync(video.processedPath)) {
                    this.logger.error(`Processed file missing for video: ${video.filename}`);
                    this.logger.error(`Expected path: ${video.processedPath}`);
                    
                    // Try to get another video
                    this.logger.log('Attempting to get another video due to missing file');
                    
                    // Recursively try up to 5 times to find a valid video
                    let attempts = 0;
                    let validVideo = null;
                    
                    while (attempts < 5 && !validVideo) {
                        const nextVideo = this.preprocessedQueue.getNext();
                        if (!nextVideo) {
                            break;
                        }
                        
                        if (nextVideo.processedPath && fs.existsSync(nextVideo.processedPath)) {
                            validVideo = nextVideo;
                        } else {
                            this.logger.error(`Skipping video with missing file: ${nextVideo.filename}`);
                        }
                        attempts++;
                    }
                    
                    if (validVideo) {
                        video = validVideo;
                        this.logger.log(`Found valid video after ${attempts} attempts: ${video.filename}`);
                    } else {
                        this.logger.error('No valid videos found in queue');
                        res.status(404).json({ error: 'No valid videos available' });
                        
                        // Trigger queue refill
                        setImmediate(() => {
                            this.logger.log('Triggering emergency queue refill');
                            this.preprocessedQueue.fill();
                        });
                        
                        return;
                    }
                }
                
                this.logger.log(`Sending video: ${video.filename}`);
                this.stats.videosPlayedThisSession++;
                
                // Convert file path to HTTP URL with proper encoding
                const processedPath = video.processedPath;
                const filename = path.basename(processedPath);
                
                // Use query parameter for filename to avoid route parameter encoding issues
                const encodedFilename = encodeURIComponent(filename);
                video.serverUrl = `/videos?filename=${encodedFilename}`;
                
                this.logger.log(`Video filename: ${filename}`);
                this.logger.log(`Encoded filename: ${encodedFilename}`);
                this.logger.log(`Video URL: ${video.serverUrl}`);
            }
            res.json(video);
        });
        
        this.app.post('/api/video-ended', (req, res) => {
            const videoData = req.body;
            if (videoData && this.historyManager) {
                this.historyManager.addToHistory(videoData);
                this.logger.log(`Video ended and added to history: ${videoData.filename}`);
            }
            res.json({ success: true });
        });
        
        this.app.post('/api/video-error', (req, res) => {
            const { errorMessage } = req.body;
            this.logger.error(`Client error: ${errorMessage}`);
            this.stats.videosSkippedErrors++;
            res.json({ success: true });
        });
        
        this.app.post('/api/video-skipped-manual', (req, res) => {
            this.stats.videosSkippedManual++;
            res.json({ success: true });
        });
        
        this.app.post('/api/video-returned-to-previous', (req, res) => {
            this.stats.videosReturnedToPrevious++;
            res.json({ success: true });
        });
        
        // History operations
        this.app.get('/api/previous-video', (req, res) => {
            if (this.historyManager) {
                const previous = this.historyManager.getPreviousVideo();
                if (previous) {
                    this.logger.log(`Sending previous video: ${previous.filename}`);
                    
                    // Convert file path to HTTP URL with proper encoding
                    if (previous.processedPath) {
                        const filename = path.basename(previous.processedPath);
                        const encodedFilename = encodeURIComponent(filename);
                        previous.serverUrl = `/videos?filename=${encodedFilename}`;
                        
                        this.logger.log(`Previous video filename: ${filename}`);
                        this.logger.log(`Encoded filename: ${encodedFilename}`);
                        this.logger.log(`Previous video URL: ${previous.serverUrl}`);
                    }
                    
                    res.json(previous);
                    return;
                }
            }
            this.logger.log('No previous video available');
            res.json(null);
        });
        
        this.app.post('/api/add-to-history', (req, res) => {
            const videoData = req.body;
            if (videoData && this.historyManager) {
                this.historyManager.addToHistory(videoData);
                this.logger.log(`Manually added to history: ${videoData.filename}`);
            }
            res.json({ success: true });
        });
        
        this.app.post('/api/ensure-video-processed', async (req, res) => {
            try {
                const videoData = req.body;
                const processedVideo = await this.reprocessHandler.ensureVideoProcessed(videoData);
                if (processedVideo && processedVideo.processedPath) {
                    const filename = path.basename(processedVideo.processedPath);
                    const encodedFilename = encodeURIComponent(filename);
                    processedVideo.serverUrl = `/videos?filename=${encodedFilename}`;
                    
                    this.logger.log(`Reprocessed video filename: ${filename}`);
                    this.logger.log(`Encoded filename: ${encodedFilename}`);
                    this.logger.log(`Reprocessed video URL: ${processedVideo.serverUrl}`);
                }
                res.json(processedVideo);
            } catch (error) {
                this.logger.error('Failed to ensure video processed', error);
                res.status(500).json({ error: error.message });
            }
        });
        
        // Custom route to serve video files with proper decoding
        this.app.get('/videos', (req, res) => {
            try {
                // Get filename from query parameter
                const encodedFilename = req.query.filename;
                if (!encodedFilename) {
                    this.logger.error('No filename provided in query');
                    return res.status(400).json({ error: 'Missing filename parameter' });
                }
                
                const decodedFilename = decodeURIComponent(encodedFilename);
                
                this.logger.log(`Video request - encoded: ${encodedFilename}, decoded: ${decodedFilename}`);
                
                const videoPath = path.join(process.cwd(), 'temp', decodedFilename);
                
                // Check if file exists
                const fs = require('fs');
                if (!fs.existsSync(videoPath)) {
                    this.logger.error(`Video file not found: ${decodedFilename}`);
                    return res.status(404).json({ error: 'Video file not found' });
                }
                
                // Get file stats for range requests
                const stat = fs.statSync(videoPath);
                const fileSize = stat.size;
                
                // Set proper headers
                const ext = path.extname(decodedFilename).toLowerCase();
                let contentType = 'video/mp4'; // default
                
                if (ext === '.webm') contentType = 'video/webm';
                else if (ext === '.avi') contentType = 'video/x-msvideo';
                else if (ext === '.mov') contentType = 'video/quicktime';
                else if (ext === '.mkv') contentType = 'video/x-matroska';
                
                // Handle range requests for video seeking
                const range = req.headers.range;
                if (range) {
                    const parts = range.replace(/bytes=/, "").split("-");
                    const start = parseInt(parts[0], 10);
                    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                    const chunksize = (end - start) + 1;
                    
                    const file = fs.createReadStream(videoPath, { start, end });
                    const head = {
                        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                        'Accept-Ranges': 'bytes',
                        'Content-Length': chunksize,
                        'Content-Type': contentType,
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                        'Access-Control-Allow-Headers': 'Range'
                    };
                    
                    res.writeHead(206, head);
                    file.pipe(res);
                } else {
                    const head = {
                        'Content-Length': fileSize,
                        'Content-Type': contentType,
                        'Accept-Ranges': 'bytes',
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                        'Access-Control-Allow-Headers': 'Range'
                    };
                    
                    res.writeHead(200, head);
                    fs.createReadStream(videoPath).pipe(res);
                }
                
            } catch (error) {
                this.logger.error('Error serving video file', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });
        
        // Serve the client application
        this.app.get('/', (req, res) => {
            const htmlPath = path.join(__dirname, '../../client/web/index.html');
            res.sendFile(htmlPath);
        });
        
        // Serve any other static files from client directory
        this.app.use(express.static(path.join(__dirname, '../../client/web'), {
            setHeaders: (res, filePath) => {
                if (filePath.endsWith('.js')) {
                    res.setHeader('Content-Type', 'application/javascript');
                }
            }
        }));
    }
    
    setupWebSocket() {
        this.wss = new WebSocket.Server({ server: this.server });
        
        this.wss.on('connection', (ws) => {
            this.logger.log('Client connected via WebSocket');
            this.clients.add(ws);
            
            ws.on('close', () => {
                this.logger.log('Client disconnected from WebSocket');
                this.clients.delete(ws);
            });
            
            ws.on('error', (error) => {
                this.logger.error('WebSocket error', error);
                this.clients.delete(ws);
            });
            
            // Send current initialization state to new client
            // If server is already initialized, make sure we send the complete state
            let stateToSend = this.initializationState;
            
            // If initialization completed but state shows otherwise, fix it
            if (this.preprocessedQueue && this.videoIndex && this.stats.totalVideos > 0) {
                // Server is actually initialized
                if (this.initializationState.stage !== 'complete' && this.initializationState.stage !== 'error') {
                    this.logger.log('Correcting initialization state for new client connection');
                    this.initializationState = {
                        stage: 'complete',
                        progress: 100,
                        message: 'Initialization complete!',
                        error: null
                    };
                    stateToSend = this.initializationState;
                }
            }
            
            ws.send(JSON.stringify({
                type: 'initialization-update',
                data: stateToSend
            }));
            
            this.logger.log(`Sent initialization state to new client: ${stateToSend.stage}`);
        });
    }
    
    broadcast(type, data) {
        const message = JSON.stringify({ type, data });
        this.clients.forEach((ws) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        });
    }
    
    async initializeComponents() {
        this.videoIndex = new VideoIndex(this.logger, this.configManager);
        this.preprocessedQueue = new PreprocessedQueue(this.logger, this.configManager, this.videoIndex, this.stats);
        
        await this.preprocessedQueue.initTempDir();
        this.logger.log('Preprocessed queue ready');
        
        this.historyManager = new HistoryManager(this.logger, this.configManager);
        this.queuePersistence = new QueuePersistence(this.logger, this.configManager, this.preprocessedQueue, this.historyManager);
        this.reprocessHandler = new ReprocessHandler(this.logger, this.preprocessedQueue, this.videoIndex);
        
        await this.historyManager.load();
        
        try {
            await this.queuePersistence.cleanupTempDirectory();
        } catch (error) {
            this.logger.error('Failed to cleanup temp directory during initialization', error);
        }
    }
    
    async performInitialization() {
        let retryCount = 0;
        const maxRetries = this.configManager.getRetry('maxInitializationAttempts', 3);
        const initTimeout = 120000; // 2 minutes max for initialization
        const initStartTime = Date.now();
        
        while (retryCount < maxRetries) {
            try {
                // Check if initialization is taking too long
                if (Date.now() - initStartTime > initTimeout) {
                    this.logger.error('Initialization timeout exceeded');
                    this.updateInitializationState('error', 0, 'Initialization timeout - please check your video directories');
                    return;
                }
                
                this.configManager.startWatcher(async () => {
                    await this.handleConfigChange();
                });
                
                this.updateInitializationState('building_index', 25, 'Building video index...');
                const needsRebuild = await this.videoIndex.initialize();
                
                if (needsRebuild) {
                    await this.buildVideoIndex();
                } else {
                    this.logger.log(`Using existing index: ${this.videoIndex.getCount()} videos`);
                    this.updateInitializationState('building_index', 60, `Loaded index: ${this.videoIndex.getCount()} videos`);
                }
                
                this.stats.totalVideos = this.videoIndex.getCount();
                
                if (this.stats.totalVideos === 0) {
                    this.logger.error('No videos found in configured directories');
                    this.updateInitializationState('error', 0, 'No videos found. Please check your config.json');
                    return;
                }
                
                this.logger.log(`Found ${this.stats.totalVideos} videos in index`);
                
                this.updateInitializationState('filling_queue', 65, 'Loading queue state...');
                const queueLoaded = await this.queuePersistence.load();
                
                if (queueLoaded) {
                    this.logger.log(`Queue state loaded: ${this.preprocessedQueue.size()} videos`);
                }
                
                this.startBackgroundUpdates();
                this.preprocessedQueue.startMonitoring();
                
                if (this.preprocessedQueue.size() < 1) {
                    await this.fillPreprocessedQueue(1);
                } else {
                    this.updateInitializationState('complete', 100, 'Initialization complete!');
                }
                
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
                }
            }
        }
    }
    
    async buildVideoIndex() {
        this.updateInitializationState('building_index', 30, 'Scanning directories...');
        
        const buildStartTime = Date.now();
        const buildTimeout = 60000; // 1 minute timeout for index building
        
        try {
            await this.videoIndex.build((progress) => {
                // Check for timeout
                if (Date.now() - buildStartTime > buildTimeout) {
                    throw new Error('Video index building timeout');
                }
                
                this.updateInitializationState('building_index', 30 + (progress.percent * 0.3), progress.message);
                
                // Send more detailed progress updates
                this.logger.log(`Index build progress: ${progress.percent.toFixed(1)}% - ${progress.message}`);
            });
            
            this.stats.totalVideos = this.videoIndex.getCount();
            this.stats.lastIndexUpdate = new Date().toISOString();
            
            await this.configManager.updateHash();
            
        } catch (error) {
            this.logger.error('Failed to build video index', error);
            
            if (error.message.includes('timeout')) {
                this.updateInitializationState('error', 0, 'Video scanning timeout - directories may be too large or inaccessible');
            } else {
                throw error;
            }
        }
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
                
                // Ensure state remains complete
                this.ensureInitializationStateComplete();
            } else if (this.stats.totalVideos === 0) {
                this.updateInitializationState('error', 0, 'No videos found in configured directories');
            } else {
                this.updateInitializationState('error', 0, 'Failed to preprocess any videos');
            }
        } catch (error) {
            this.logger.error('Error during fillPreprocessedQueue', error);
            this.updateInitializationState('error', 0, 'Failed to preprocess videos', error.message);
        }
    }

    // Add this new method
    ensureInitializationStateComplete() {
        // Set a timer to ensure state remains 'complete' for new connections
        setInterval(() => {
            if (this.preprocessedQueue && this.videoIndex && this.stats.totalVideos > 0) {
                if (this.initializationState.stage !== 'complete' && this.initializationState.stage !== 'error') {
                    this.logger.log('Resetting initialization state to complete');
                    this.initializationState = {
                        stage: 'complete',
                        progress: 100,
                        message: 'Initialization complete!',
                        error: null
                    };
                }
            }
        }, 5000); // Check every 5 seconds
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
        
        setInterval(async () => {
            try {
                await this.queuePersistence.cleanupTempDirectory();
            } catch (error) {
                this.logger.error('Periodic cleanup failed', error);
            }
        }, cleanupInterval);
        
        setInterval(async () => {
            try {
                await this.queuePersistence.save(null);
                await this.historyManager.save();
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
        
        // Broadcast to connected clients
        this.broadcast('initialization-update', this.initializationState);
    }
}

// Start server if this file is run directly
if (require.main === module) {
    const server = new VideoPlayerWebServer();
    
    // Graceful shutdown handlers
    const gracefulShutdown = async (signal) => {
        server.logger.log(`Received ${signal}, shutting down gracefully...`);
        
        try {
            // Close WebSocket connections
            if (server.wss) {
                server.wss.clients.forEach(ws => {
                    ws.close();
                });
            }
            
            // Save state
            if (server.queuePersistence) {
                await server.queuePersistence.save(null);
            }
            if (server.historyManager) {
                await server.historyManager.save();
            }
            if (server.preprocessedQueue) {
                await server.preprocessedQueue.clear();
            }
            
            // Close HTTP server
            if (server.server) {
                server.server.close(() => {
                    server.logger.log('HTTP server closed');
                    process.exit(0);
                });
                
                // Force exit after 5 seconds
                setTimeout(() => {
                    server.logger.log('Force exiting...');
                    process.exit(1);
                }, 5000);
            } else {
                process.exit(0);
            }
        } catch (error) {
            server.logger.error('Error during shutdown', error);
            process.exit(1);
        }
    };
    
    // Handle different signals
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGQUIT', () => gracefulShutdown('SIGQUIT'));
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
        server.logger.error('Uncaught exception', error);
        gracefulShutdown('uncaughtException');
    });
    
    process.on('unhandledRejection', (reason) => {
        server.logger.error('Unhandled rejection', reason);
        gracefulShutdown('unhandledRejection');
    });
    
    server.start().catch(error => {
        console.error('Failed to start server:', error);
        process.exit(1);
    });
}

module.exports = VideoPlayerWebServer;