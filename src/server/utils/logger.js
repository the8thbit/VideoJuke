class Logger {
    constructor(prefix = 'MAIN') {
        this.prefix = prefix;
        this.mainWindow = null;
    }
    
    setWindow(window) {
        this.mainWindow = window;
    }
    
    log(message) {
        console.log(`[${new Date().toISOString()}] [${this.prefix}] ${message}`);
        this.sendToRenderer('INFO', message);
    }
    
    warn(message) {
        console.warn(`[${new Date().toISOString()}] [${this.prefix}] ${message}`);
        this.sendToRenderer('WARN', message);
    }
    
    error(message, error = null) {
        console.error(`[${new Date().toISOString()}] [${this.prefix}] ${message}`);
        if (error) {
            console.error(error);
        }
        
        const fullMessage = error ? `${message} - ${error.message}` : message;
        this.sendToRenderer('ERROR', fullMessage);
    }
    
    sendToRenderer(level, message) {
        try {
            if (this.mainWindow && !this.mainWindow.isDestroyed() && 
                this.mainWindow.webContents && !this.mainWindow.webContents.isDestroyed()) {
                this.mainWindow.webContents.send('main-log', {
                    timestamp: new Date().toISOString(),
                    level,
                    message
                });
            }
        } catch (error) {
            // Ignore errors when window is being destroyed
        }
    }
}

module.exports = Logger;