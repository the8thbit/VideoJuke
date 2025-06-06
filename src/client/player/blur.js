export default class Blur {
    constructor(logger, config) {
        this.logger = logger;
        this.config = config;
        this.enabled = config.blur.enabled;
        this.maxAmount = config.blur.maxAmount;
        this.activeAnimations = new Set();
    }
    
    startVideo(videoElement) {
        if (!this.enabled || this.isPartOfCrossfade(videoElement)) {
            return;
        }
        
        this.cancelAnimations(videoElement);
        videoElement.style.filter = `blur(${this.maxAmount}px)`;
        this.animateBlur(videoElement, this.maxAmount, 0, 500);
    }
    
    endVideo(videoElement) {
        if (!this.enabled || this.isPartOfCrossfade(videoElement)) {
            return;
        }
        
        this.animateBlur(videoElement, 0, this.maxAmount, 500);
    }
    
    applyCrossfadeBlur(videoElement, blurAmount) {
        if (!this.enabled) return;
        
        this.cancelAnimations(videoElement);
        videoElement.style.filter = `blur(${blurAmount}px)`;
    }
    
    isPartOfCrossfade(videoElement) {
        return videoElement.classList.contains('fading-in') || 
               videoElement.classList.contains('fading-out');
    }
    
    animateBlur(element, fromBlur, toBlur, duration) {
        const animationId = `${element.id}_${Date.now()}`;
        this.activeAnimations.add(animationId);
        
        const startTime = Date.now();
        
        const animate = () => {
            if (!this.activeAnimations.has(animationId)) {
                return;
            }
            
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
            const currentBlur = fromBlur + (toBlur - fromBlur) * eased;
            
            element.style.filter = `blur(${currentBlur}px)`;
            
            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                this.activeAnimations.delete(animationId);
            }
        };
        
        requestAnimationFrame(animate);
        return animationId;
    }
    
    cancelAnimations(element) {
        const toDelete = [];
        this.activeAnimations.forEach(animationId => {
            if (animationId.startsWith(element.id)) {
                toDelete.push(animationId);
            }
        });
        
        toDelete.forEach(animationId => {
            this.activeAnimations.delete(animationId);
        });
    }
    
    resetBlur(element) {
        this.cancelAnimations(element);
        element.style.filter = '';
    }
    
    setEnabled(enabled) {
        const wasEnabled = this.enabled;
        this.enabled = enabled;
        
        if (!enabled && wasEnabled) {
            // Cancel all animations and reset
            this.activeAnimations.clear();
            
            document.querySelectorAll('video').forEach(video => {
                video.style.filter = '';
            });
        }
    }
    
    cleanup() {
        this.activeAnimations.clear();
        document.querySelectorAll('video').forEach(video => {
            video.style.filter = '';
        });
    }
}