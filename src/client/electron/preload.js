const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods
contextBridge.exposeInMainWorld('electronAPI', {
    // Video playback methods
    getNextVideo: () => ipcRenderer.invoke('get-next-video'),
    ensureVideoProcessed: (videoData) => ipcRenderer.invoke('ensure-video-processed', videoData),
    videoEnded: (videoData) => ipcRenderer.invoke('video-ended', videoData),
    videoError: (errorMsg) => ipcRenderer.invoke('video-error', errorMsg),
    videoSkippedManual: () => ipcRenderer.invoke('video-skipped-manual'),
    videoReturnedToPrevious: () => ipcRenderer.invoke('video-returned-to-previous'),
    
    // History methods
    getPreviousVideo: () => ipcRenderer.invoke('get-previous-video'),
    addToHistory: (videoData) => ipcRenderer.invoke('add-to-history', videoData),
    
    // Configuration methods
    getConfig: () => ipcRenderer.invoke('get-config'),
    
    // Queue and status methods
    getQueueStatus: () => ipcRenderer.invoke('get-queue-status'),
    getDetailedStats: () => ipcRenderer.invoke('get-detailed-stats'),
    
    // Initialization tracking
    getInitializationStatus: () => ipcRenderer.invoke('get-initialization-status'),
    startInitialization: () => ipcRenderer.invoke('start-initialization'),
    
    // Window control
    quitApplication: () => ipcRenderer.invoke('quit-application'),
    
    // Event listeners
    on: (channel, callback) => {
        const validChannels = [
            'main-log',
            'initialization-update', 
            'indexing-progress'
        ];
        
        if (validChannels.includes(channel)) {
            ipcRenderer.removeAllListeners(channel);
            ipcRenderer.on(channel, (event, ...args) => callback(...args));
        }
    },
    
    removeListener: (channel) => {
        const validChannels = [
            'main-log',
            'initialization-update',
            'indexing-progress'
        ];
        
        if (validChannels.includes(channel)) {
            ipcRenderer.removeAllListeners(channel);
        }
    }
});