const fs = require('fs').promises;
const path = require('path');
const mimeTypes = require('mime-types');

class FileUtils {
    static async exists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }
    
    static async ensureDirectory(dirPath) {
        try {
            await fs.mkdir(dirPath, { recursive: true });
            return true;
        } catch (error) {
            console.error(`Failed to create directory: ${dirPath}`, error);
            return false;
        }
    }
    
    static isVideoFile(filePath, configManager = null) {
        const ext = path.extname(filePath).toLowerCase();
        
        // Get extensions from config if available
        let videoExtensions;
        if (configManager) {
            videoExtensions = configManager.getFile('supportedVideoExtensions');
        }
        
        // Fallback to default extensions
        if (!videoExtensions) {
            videoExtensions = [
                '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv',
                '.m4v', '.3gp', '.mpeg', '.mpg', '.ts', '.mts', '.m2ts'
            ];
        }
        
        if (videoExtensions.includes(ext)) {
            return true;
        }
        
        // Check by MIME type as fallback
        const mimeType = mimeTypes.lookup(filePath);
        return mimeType && mimeType.startsWith('video/');
    }
    
    static async readJSON(filePath) {
        try {
            const data = await fs.readFile(filePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            return null;
        }
    }
    
    static async writeJSON(filePath, data) {
        try {
            await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
            return true;
        } catch (error) {
            console.error(`Failed to write JSON to ${filePath}`, error);
            return false;
        }
    }
    
    static async deleteFile(filePath) {
        try {
            if (await this.exists(filePath)) {
                await fs.unlink(filePath);
                return true;
            }
            return false;
        } catch (error) {
            console.error(`Failed to delete file: ${filePath}`, error);
            return false;
        }
    }
}

module.exports = FileUtils;