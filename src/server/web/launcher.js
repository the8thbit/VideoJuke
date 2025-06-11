const path = require('path');
const ConfigManager = require('../shared/config/configManager');
const Logger = require('../shared/utils/logger');

// Use dynamic import for ESM module
let openBrowser;

class VideoPlayerClientLauncher {
    constructor() {
        this.logger = new Logger('CLIENT-LAUNCHER');
        this.configManager = null;
    }
    
    async start() {
        try {
            this.logger.log('Starting VideoJuke client launcher...');
            
            // Dynamic import for open module
            if (!openBrowser) {
                const openModule = await import('open');
                openBrowser = openModule.default;
            }
            
            // Load configuration to get server URL
            this.configManager = new ConfigManager(this.logger);
            await this.configManager.load();
            
            const clientConfig = this.configManager.config.network?.client || {};
            const serverUrl = clientConfig.serverUrl || 'http://localhost:8080';
            
            this.logger.log(`Configured to connect to server: ${serverUrl}`);
            
            // Wait a moment for server to be ready
            await this.waitForServer(serverUrl);
            
            // Open browser directly to server
            this.logger.log(`Opening browser to ${serverUrl}`);
            await openBrowser(serverUrl);
            
            this.logger.log('Client launcher completed - browser should now be open');
            
            // Keep process alive briefly to show completion message
            setTimeout(() => {
                process.exit(0);
            }, 2000);
            
        } catch (error) {
            this.logger.error('Failed to start client launcher', error);
            
            // Fallback: just show the URL
            this.logger.log('Attempting fallback...');
            const serverUrl = 'http://localhost:8080';
            this.logger.log(`Please manually open: ${serverUrl}`);
            
            setTimeout(() => {
                process.exit(1);
            }, 2000);
        }
    }
    
    async waitForServer(serverUrl, maxWait = 5000) {
        this.logger.log(`Waiting ${maxWait}ms for server to be ready...`);
        await new Promise(resolve => setTimeout(resolve, maxWait));
        this.logger.log('Proceeding to open browser');
    }
}

// Start client launcher if this file is run directly
if (require.main === module) {
    const clientLauncher = new VideoPlayerClientLauncher();
    clientLauncher.start().catch(error => {
        console.error('Failed to start client launcher:', error);
        process.exit(1);
    });
}

module.exports = VideoPlayerClientLauncher;