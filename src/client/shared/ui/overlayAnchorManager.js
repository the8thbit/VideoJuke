export default class OverlayAnchorManager {
    constructor(logger) {
        this.logger = logger;
        this.anchorElement = null;
        this.observer = null;
        this.overlaySelectors = [
            '.info-overlay',
            '.error-overlay', 
            '.status-indicator',
            '.debug-overlay',
            '.controls-overlay',
            '.loading-screen:not(.hidden)' // Include loading screen when not hidden
        ];
        
        this.init();
    }
    
    init() {
        this.createAnchorElement();
        this.setupObserver();
        this.updateAnchorVisibility(); // Initial check
        this.logger.log('🔗 Overlay anchor manager initialized');
    }
    
    createAnchorElement() {
        // Create the minimal anchor element
        this.anchorElement = document.createElement('div');
        this.anchorElement.className = 'overlay-anchor';
        this.anchorElement.id = 'overlayAnchor';
        
        // Add to body
        document.body.appendChild(this.anchorElement);
        this.logger.log('🔗 Overlay anchor element created');
    }
    
    setupObserver() {
        // Watch for changes to overlay visibility
        this.observer = new MutationObserver((mutations) => {
            let shouldUpdate = false;
            
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes' && 
                    (mutation.attributeName === 'class' || mutation.attributeName === 'style')) {
                    
                    const target = mutation.target;
                    if (this.isOverlayElement(target)) {
                        shouldUpdate = true;
                    }
                }
            });
            
            if (shouldUpdate) {
                this.updateAnchorVisibility();
            }
        });
        
        // Start observing
        this.observer.observe(document.body, {
            attributes: true,
            subtree: true,
            attributeFilter: ['class', 'style']
        });
    }
    
    isOverlayElement(element) {
        return this.overlaySelectors.some(selector => {
            return element.matches && element.matches(selector);
        });
    }
    
    isAnyOverlayVisible() {
        return this.overlaySelectors.some(selector => {
            const elements = document.querySelectorAll(selector);
            return Array.from(elements).some(el => {
                if (selector.includes(':not(.hidden)')) {
                    // For loading screen, check if it doesn't have 'hidden' class
                    return !el.classList.contains('hidden');
                } else {
                    // For other overlays, check if they have 'visible' class or are not hidden
                    return el.classList.contains('visible') || 
                           (el.style.display !== 'none' && 
                            el.style.visibility !== 'hidden' && 
                            el.style.opacity !== '0');
                }
            });
        });
    }
    
    updateAnchorVisibility() {
        if (!this.anchorElement) return;
        
        const shouldShow = this.isAnyOverlayVisible();
        
        if (shouldShow) {
            this.anchorElement.classList.add('active');
        } else {
            this.anchorElement.classList.remove('active');
        }
    }
    
    cleanup() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        
        if (this.anchorElement && this.anchorElement.parentNode) {
            this.anchorElement.parentNode.removeChild(this.anchorElement);
            this.anchorElement = null;
        }
        
        this.logger.log('🔗 Overlay anchor manager cleaned up');
    }
}