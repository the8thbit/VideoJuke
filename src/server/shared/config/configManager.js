const path = require('path');
const crypto = require('crypto');
const FileUtils = require('../utils/fileUtils');

class ConfigManager {
    constructor(logger) {
        this.logger = logger;
        this.configPath = path.join(process.cwd(), 'config.json');
        this.defaultConfigPath = path.join(process.cwd(), 'config.default.json');
        this.config = {};
        this.watcher = null;
    }
    
    async load() {
        try {
            // Always load default config first
            this.logger.log('Loading default configuration');
            if (await FileUtils.exists(this.defaultConfigPath)) {
                const defaultConfig = await FileUtils.readJSON(this.defaultConfigPath);
                if (defaultConfig) {
                    this.config = JSON.parse(JSON.stringify(defaultConfig));
                    this.logger.log('Default configuration loaded');
                } else {
                    throw new Error('Failed to parse default config file');
                }
            } else {
                throw new Error('config.default.json not found');
            }
            
            // Merge user config if it exists
            if (await FileUtils.exists(this.configPath)) {
                this.logger.log('Loading user configuration');
                const userConfig = await FileUtils.readJSON(this.configPath);
                
                if (userConfig) {
                    this.mergeConfig(userConfig);
                    this.logger.log('User configuration merged');
                } else {
                    this.logger.warn('Failed to parse user config file, using defaults');
                }
            } else {
                this.logger.log('No user config found, creating from defaults');
                await this.save();
            }
            
            this.validateConfig();
            
        } catch (error) {
            this.logger.error('Failed to load configuration', error);
            throw error;
        }
    }
    
    mergeConfig(userConfig) {
        this.deepMerge(this.config, userConfig);
    }
    
    deepMerge(target, source) {
        for (const key in source) {
            if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                if (!target[key] || typeof target[key] !== 'object') {
                    target[key] = {};
                }
                this.deepMerge(target[key], source[key]);
            } else {
                target[key] = source[key];
            }
        }
    }
    
    validateConfig() {
        // Ensure valid directories
        if (!Array.isArray(this.config.directories)) {
            this.logger.warn('Invalid directories config, using default');
            this.config.directories = ["C:\\Users\\Public\\Videos\\Sample Videos"];
        }
        
        // Ensure valid queue sizes
        if (this.config.video.preprocessedQueueSize < 1) {
            this.config.video.preprocessedQueueSize = 20;
        }
        if (this.config.video.playbackQueueSize < 1) {
            this.config.video.playbackQueueSize = 50;
        }
        if (this.config.video.playbackQueueInitializationThreshold < 1) {
            this.config.video.playbackQueueInitializationThreshold = 10;
        }
        
        // Ensure timeouts are positive numbers
        const timeouts = this.config.timeouts || {};
        for (const [key, value] of Object.entries(timeouts)) {
            if (typeof value !== 'number' || value < 0) {
                this.logger.warn(`Invalid timeout value for ${key}: ${value}, using default`);
                // Get from default config
                timeouts[key] = this.getDefaultValue('timeouts.' + key) || 1000;
            }
        }
    }
    
    async getDefaultValue(path) {
        try {
            if (await FileUtils.exists(this.defaultConfigPath)) {
                const defaultConfig = await FileUtils.readJSON(this.defaultConfigPath);
                return this.getNestedValue(defaultConfig, path);
            }
        } catch (error) {
            this.logger.error('Failed to get default value', error);
        }
        return null;
    }
    
    getNestedValue(obj, path) {
        return path.split('.').reduce((current, key) => current && current[key], obj);
    }
    
    get(path, fallback = null) {
        const value = this.getNestedValue(this.config, path);
        return value !== undefined ? value : fallback;
    }
    
    // Convenience methods for common config access patterns
    getTimeout(name, fallback = 1000) {
        return this.get(`timeouts.${name}`, fallback);
    }
    
    getRetry(name, fallback = 3) {
        return this.get(`retries.${name}`, fallback);
    }
    
    getFile(name, fallback = null) {
        return this.get(`files.${name}`, fallback);
    }
    
    async save() {
        try {
            await FileUtils.writeJSON(this.configPath, this.config);
            this.logger.log('Configuration saved');
        } catch (error) {
            this.logger.error('Failed to save configuration', error);
        }
    }
    
    startWatcher(onChange) {
        if (this.watcher) {
            this.watcher.close();
        }
        
        try {
            const fs = require('fs');
            this.watcher = fs.watchFile(this.configPath, async (curr, prev) => {
                if (curr.mtime !== prev.mtime) {
                    this.logger.log('Config file changed, reloading...');
                    await this.load();
                    if (onChange) {
                        await onChange();
                    }
                }
            });
        } catch (error) {
            this.logger.error('Failed to start config watcher', error);
        }
    }
    
    calculateHash() {
        const relevantConfig = {
            directories: this.config.directories,
            seasonalDirectories: this.config.seasonalDirectories, // Add this line
            video: {
                updateInterval: this.config.video?.updateInterval
            }
        };
        return crypto.createHash('md5').update(JSON.stringify(relevantConfig)).digest('hex');
    }
    
    async updateHash() {
        this.config.system.lastConfigHash = this.calculateHash();
        await this.save();
    }
}

module.exports = ConfigManager;