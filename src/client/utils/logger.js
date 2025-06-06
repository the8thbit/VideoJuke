export default class Logger {
    constructor(prefix = 'CLIENT') {
        this.prefix = prefix;
    }
    
    log(message) {
        console.log(`[${new Date().toISOString()}] [${this.prefix}] ${message}`);
    }
    
    warn(message) {
        console.warn(`[${new Date().toISOString()}] [${this.prefix}] ${message}`);
    }
    
    error(message, error = null) {
        console.error(`[${new Date().toISOString()}] [${this.prefix}] ${message}`);
        if (error) {
            console.error(error);
        }
    }
}