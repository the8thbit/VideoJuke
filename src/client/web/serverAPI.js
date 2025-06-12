export default class ServerAPI {
    constructor(logger, baseUrl = null) {
        this.logger = logger;
        this.baseUrl = baseUrl || window.location.origin;
        this.ws = null;
        this.eventListeners = new Map();
        this.connectionState = 'disconnected';
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000;
        
        this.logger.log(`ServerAPI initialized with base URL: ${this.baseUrl}`);
        this.connectWebSocket();
    }
    
    // Connection management
    connectWebSocket() {
        try {
            const wsUrl = this.baseUrl.replace('http', 'ws');
            this.logger.log(`=== WEBSOCKET CONNECTION ===`);
            this.logger.log(`WebSocket URL: ${wsUrl}`);
            this.logger.log(`Base URL: ${this.baseUrl}`);
            
            // Don't attempt WebSocket connection on WebOS TVs - they may not support it properly
            if (typeof window !== 'undefined' && window.webOS) {
                this.logger.log('WebOS detected - skipping WebSocket, using HTTP polling only');
                this.connectionState = 'connected'; // Fake connected state for HTTP-only mode
                this.updateConnectionStatus('connected');
                return;
            }
            
            this.ws = new WebSocket(wsUrl);
            this.connectionState = 'connecting';
            this.updateConnectionStatus('connecting');
            
            // Reduced timeout for faster failure detection
            const connectionTimeout = setTimeout(() => {
                if (this.connectionState === 'connecting') {
                    this.logger.log('WebSocket connection timeout, falling back to HTTP-only mode');
                    this.ws.close();
                    this.connectionState = 'connected'; // Use HTTP-only mode
                    this.updateConnectionStatus('connected');
                }
            }, 3000); // 3 second timeout
            
            this.ws.onopen = () => {
                clearTimeout(connectionTimeout);
                this.logger.log('WebSocket connected successfully');
                this.connectionState = 'connected';
                this.reconnectAttempts = 0;
                this.updateConnectionStatus('connected');
            };
            
            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleMessage(message);
                } catch (error) {
                    this.logger.error('Failed to parse WebSocket message', error);
                }
            };
            
            this.ws.onclose = () => {
                clearTimeout(connectionTimeout);
                this.logger.log('WebSocket disconnected - continuing with HTTP-only mode');
                this.connectionState = 'connected'; // Continue with HTTP-only
                this.updateConnectionStatus('connected');
            };
            
            this.ws.onerror = (error) => {
                clearTimeout(connectionTimeout);
                this.logger.log('WebSocket error - falling back to HTTP-only mode');
                this.connectionState = 'connected'; // Continue with HTTP-only
                this.updateConnectionStatus('connected');
            };
            
        } catch (error) {
            this.logger.log('WebSocket creation failed - using HTTP-only mode');
            this.connectionState = 'connected'; // Use HTTP-only mode
            this.updateConnectionStatus('connected');
        }
    }
    
    scheduleReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            this.logger.log(`Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${this.reconnectDelay}ms`);
            
            setTimeout(() => {
                this.connectWebSocket();
            }, this.reconnectDelay * this.reconnectAttempts);
        } else {
            this.logger.error('Maximum reconnect attempts reached');
            this.updateConnectionStatus('failed');
        }
    }
    
    updateConnectionStatus(status) {
        const statusElement = document.getElementById('connectionStatus');
        if (statusElement) {
            statusElement.className = `connection-status ${status}`;
            switch (status) {
                case 'connected':
                    statusElement.textContent = 'Connected';
                    break;
                case 'connecting':
                    statusElement.textContent = 'Connecting...';
                    break;
                case 'disconnected':
                    statusElement.textContent = 'Disconnected';
                    break;
                case 'failed':
                    statusElement.textContent = 'Connection failed';
                    break;
            }
        }
        
        // Update debug info
        const debugConnection = document.getElementById('debugConnection');
        if (debugConnection) {
            debugConnection.textContent = `${status} (attempts: ${this.reconnectAttempts})`;
        }
    }
    
    handleMessage(message) {
        const { type, data } = message;
        
        if (this.eventListeners.has(type)) {
            const callbacks = this.eventListeners.get(type);
            callbacks.forEach(callback => {
                try {
                    callback(data);
                } catch (error) {
                    this.logger.error(`Error in event listener for ${type}`, error);
                }
            });
        }
    }
    
    // HTTP API methods
    async request(endpoint, options = {}) {
        try {
            const url = `${this.baseUrl}${endpoint}`;
            this.logger.log(`HTTP Request: ${options.method || 'GET'} ${url}`);
            
            // Add timeout for requests
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
            
            const response = await fetch(url, {
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                },
                signal: controller.signal,
                ...options
            });
            
            clearTimeout(timeoutId);
            
            this.logger.log(`HTTP Response: ${response.status} ${response.statusText}`);
            
            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Unknown error');
                throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText}`);
            }
            
            const result = await response.json();
            this.logger.log(`Response data received (${JSON.stringify(result).length} chars)`);
            return result;
            
        } catch (error) {
            if (error.name === 'AbortError') {
                this.logger.error(`Request timeout: ${endpoint}`);
                throw new Error(`Request timeout - server may be slow or unreachable`);
            } else if (error.message.includes('Failed to fetch')) {
                this.logger.error(`Network error: ${endpoint}`, error);
                throw new Error(`Network error - cannot reach server at ${this.baseUrl}`);
            } else {
                this.logger.error(`Request failed: ${endpoint}`, error);
                throw error;
            }
        }
    }
    
    async get(endpoint) {
        return this.request(endpoint, { method: 'GET' });
    }
    
    async post(endpoint, data = null) {
        return this.request(endpoint, {
            method: 'POST',
            body: data ? JSON.stringify(data) : null
        });
    }
    
    // API methods that mirror the original electronAPI
    async getConfig() {
        this.logger.log('=== LOADING CONFIG FROM SERVER ===');
        try {
            const config = await this.get('/api/config');
            this.logger.log('Config loaded successfully:', Object.keys(config));
            return config;
        } catch (error) {
            this.logger.error('Failed to load config from server', error);
            throw new Error(`Cannot load configuration: ${error.message}`);
        }
    }
    
    async getNextVideo() {
        return this.get('/api/next-video');
    }
    
    async ensureVideoProcessed(videoData) {
        return this.post('/api/ensure-video-processed', videoData);
    }
    
    async videoEnded(videoData) {
        return this.post('/api/video-ended', videoData);
    }
    
    async videoError(errorMsg) {
        return this.post('/api/video-error', { errorMessage: errorMsg });
    }
    
    async videoSkippedManual() {
        return this.post('/api/video-skipped-manual');
    }
    
    async videoReturnedToPrevious() {
        return this.post('/api/video-returned-to-previous');
    }
    
    async getPreviousVideo() {
        return this.get('/api/previous-video');
    }
    
    async addToHistory(videoData) {
        return this.post('/api/add-to-history', videoData);
    }
    
    async getQueueStatus() {
        return this.get('/api/queue-status');
    }
    
    async getDetailedStats() {
        return this.get('/api/detailed-stats');
    }
    
    async getInitializationStatus() {
        return this.get('/api/initialization-status');
    }
    
    async startInitialization() {
        // Server auto-starts, so just return current status
        return this.getInitializationStatus();
    }
    
    async quitApplication() {
        // For web client, just close the tab/window
        this.logger.log('Closing application');
        if (window.close) {
            window.close();
        } else {
            // Fallback: navigate away or show message
            if (confirm('Close VideoJuke?')) {
                window.location.href = 'about:blank';
            }
        }
    }
    
    // Event handling methods
    on(channel, callback) {
        if (!this.eventListeners.has(channel)) {
            this.eventListeners.set(channel, []);
        }
        this.eventListeners.get(channel).push(callback);
        this.logger.log(`Registered listener for channel: ${channel}`);
    }
    
    removeListener(channel) {
        if (this.eventListeners.has(channel)) {
            this.eventListeners.delete(channel);
            this.logger.log(`Removed listeners for channel: ${channel}`);
        }
    }
    
    // Connection state getter
    isConnected() {
        return this.connectionState === 'connected';
    }
    
    getConnectionState() {
        return this.connectionState;
    }
    
    // Cleanup
    cleanup() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.eventListeners.clear();
    }
}