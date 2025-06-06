const { BrowserWindow } = require('electron');
const path = require('path');

class WindowManager {
    constructor(logger, config) {
        this.logger = logger;
        this.config = config;
        this.mainWindow = null;
        this.onReadyCallback = null;
        this.onCloseCallback = null;
    }
    
    createWindow() {
        const startFullscreen = this.config.ui?.startFullscreen === true;
        
        const windowOptions = {
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, '..', '..', '..', 'preload.js')
            },
            show: false,
            autoHideMenuBar: true,
            icon: path.join(__dirname, '..', '..', '..', 'icon.png')
        };
        
        if (startFullscreen) {
            windowOptions.fullscreen = true;
            windowOptions.frame = false;
        } else {
            windowOptions.width = 1200;
            windowOptions.height = 800;
            windowOptions.frame = true;
        }
        
        this.mainWindow = new BrowserWindow(windowOptions);
        
        // Set logger window reference
        this.logger.setWindow(this.mainWindow);
        
        // Load HTML
        const htmlPath = path.join(__dirname, '..', '..', 'client', 'index.html');
        this.mainWindow.loadFile(htmlPath);
        
        // Show window when ready
        this.mainWindow.once('ready-to-show', () => {
            if (startFullscreen) {
                this.mainWindow.setFullScreen(true);
            }
            this.mainWindow.show();
            
            if (this.onReadyCallback) {
                this.onReadyCallback();
            }
        });
        
        // Handle window closed
        this.mainWindow.on('closed', () => {
            this.mainWindow = null;
        });
        
        // Handle window close event
        this.mainWindow.on('close', async (event) => {
            event.preventDefault();
            
            if (this.onCloseCallback) {
                await this.onCloseCallback();
            }
            
            this.mainWindow.destroy();
        });
        
        // Open DevTools in development
        if (process.argv.includes('--dev')) {
            this.mainWindow.webContents.openDevTools();
        }
    }
    
    onReady(callback) {
        this.onReadyCallback = callback;
    }
    
    onClose(callback) {
        this.onCloseCallback = callback;
    }
    
    sendToRenderer(channel, data) {
        if (this.mainWindow && this.mainWindow.webContents) {
            this.mainWindow.webContents.send(channel, data);
        }
    }
    
    getWindow() {
        return this.mainWindow;
    }
}

module.exports = WindowManager;