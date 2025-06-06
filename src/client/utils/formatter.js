export function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return 'Unknown';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
}

export function formatVideoDetails(metadata) {
    if (!metadata) return '';
    
    const parts = [];
    
    if (metadata.width && metadata.height) {
        parts.push(`${metadata.width}×${metadata.height}`);
    }
    
    if (metadata.duration) {
        parts.push(formatDuration(metadata.duration));
    }
    
    if (metadata.fps) {
        parts.push(`${Math.round(metadata.fps)}fps`);
    }
    
    if (metadata.hasAudio) {
        parts.push(`Audio: ${metadata.audioChannels}ch`);
    } else {
        parts.push('No audio');
    }
    
    return parts.join(' • ');
}

export function formatTime(timestamp) {
    if (!timestamp) return 'Never';
    return new Date(timestamp).toLocaleString();
}

export function formatTimeDuration(ms) {
    if (!ms || ms < 0) return 'N/A';
    
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}