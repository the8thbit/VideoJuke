export default class WebOSStorage {
    constructor(logger) {
        this.logger = logger;
        this.storageKey = 'videojuke_config';
        this.isWebOS = window.webOS !== undefined;
        
        this.logger.log(`WebOS Storage initialized (isWebOS: ${this.isWebOS})`);
    }
    
    async load() {
        try {
            this.logger.log(`=== LOADING STORAGE ===`);
            this.logger.log(`WebOS available: ${this.isWebOS}`);
            this.logger.log(`WebOS storage available: ${!!(this.isWebOS && window.webOS && window.webOS.storage)}`);
            
            // Try WebOS storage first if available
            if (this.isWebOS && window.webOS && window.webOS.storage) {
                this.logger.log('Attempting to load from WebOS storage...');
                return new Promise((resolve, reject) => {
                    window.webOS.storage.get(this.storageKey, (result) => {
                        this.logger.log('WebOS storage get result:', result);
                        if (result && result.value) {
                            try {
                                const parsed = JSON.parse(result.value);
                                this.logger.log('Successfully loaded config from WebOS storage:', parsed);
                                resolve(parsed);
                            } catch (parseError) {
                                this.logger.error('Failed to parse WebOS storage data', parseError);
                                resolve(this.loadFromLocalStorage());
                            }
                        } else {
                            this.logger.log('No config found in WebOS storage, trying localStorage');
                            resolve(this.loadFromLocalStorage());
                        }
                    }, (error) => {
                        this.logger.error('WebOS storage get error:', error);
                        resolve(this.loadFromLocalStorage());
                    });
                });
            } else {
                this.logger.log('WebOS storage not available, using localStorage');
                return this.loadFromLocalStorage();
            }
        } catch (error) {
            this.logger.error('Failed to load storage', error);
            return null;
        }
    }

    async save(data) {
        try {
            this.logger.log(`=== SAVING STORAGE ===`);
            this.logger.log('Data to save:', data);
            
            const jsonData = JSON.stringify(data);
            this.logger.log('JSON data length:', jsonData.length);
            
            // Try WebOS storage first if available
            if (this.isWebOS && window.webOS && window.webOS.storage) {
                this.logger.log('Attempting to save to WebOS storage...');
                return new Promise((resolve, reject) => {
                    window.webOS.storage.set(this.storageKey, jsonData, (result) => {
                        this.logger.log('WebOS storage set result:', result);
                        this.logger.log('Successfully saved config to WebOS storage');
                        // Also save to localStorage as backup
                        this.saveToLocalStorage(data);
                        resolve(true);
                    }, (error) => {
                        this.logger.error('WebOS storage set error:', error);
                        // Fall back to localStorage
                        resolve(this.saveToLocalStorage(data));
                    });
                });
            } else {
                this.logger.log('WebOS storage not available, using localStorage');
                return this.saveToLocalStorage(data);
            }
        } catch (error) {
            this.logger.error('Failed to save storage', error);
            return false;
        }
    }

    loadFromLocalStorage() {
        try {
            this.logger.log('Loading from localStorage...');
            const data = localStorage.getItem(this.storageKey);
            if (data) {
                const parsed = JSON.parse(data);
                this.logger.log('Successfully loaded config from localStorage:', parsed);
                return parsed;
            }
            this.logger.log('No config found in localStorage');
            return null;
        } catch (error) {
            this.logger.error('localStorage load error', error);
            return null;
        }
    }

    saveToLocalStorage(data) {
        try {
            this.logger.log('Saving to localStorage...');
            localStorage.setItem(this.storageKey, JSON.stringify(data));
            this.logger.log('Successfully saved config to localStorage');
            return true;
        } catch (error) {
            this.logger.error('localStorage save error', error);
            return false;
        }
    }
    
    async clear() {
        try {
            if (this.isWebOS && window.webOS.storage) {
                return new Promise((resolve) => {
                    window.webOS.storage.remove(this.storageKey, () => {
                        this.logger.log('Cleared WebOS storage');
                        localStorage.removeItem(this.storageKey);
                        resolve(true);
                    }, () => {
                        // Try localStorage anyway
                        localStorage.removeItem(this.storageKey);
                        resolve(true);
                    });
                });
            } else {
                localStorage.removeItem(this.storageKey);
                this.logger.log('Cleared localStorage');
                return true;
            }
        } catch (error) {
            this.logger.error('Failed to clear storage', error);
            return false;
        }
    }
}