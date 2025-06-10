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
            this.logger.log(`Connecting to WebSocket: ${wsUrl}`);
            
            this.ws = new WebSocket(wsUrl);
            this.connectionState = 'connecting';
            this.updateConnectionStatus('connecting');
            
            this.ws.onopen = () => {
                this.logger.log('WebSocket connected');
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
                this.logger.log('WebSocket disconnected');
                this.connectionState = 'disconnected';
                this.updateConnectionStatus('disconnected');
                this.scheduleReconnect();
            };
            
            this.ws.onerror = (error) => {
                this.logger.error('WebSocket error', error);
                this.connectionState = 'disconnected';
                this.updateConnectionStatus('disconnected');
            };
            
        } catch (error) {
            this.logger.error('Failed to create WebSocket connection', error);
            this.connectionState = 'disconnected';
            this.updateConnectionStatus('disconnected');
            this.scheduleReconnect();
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
            const response = await fetch(url, {
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                },
                ...options
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            return await response.json();
        } catch (error) {
            this.logger.error(`Request failed: ${endpoint}`, error);
            throw error;
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
        this.logger.log('Requesting configuration from server');
        return this.get('/api/config');
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