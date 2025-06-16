export default class OverlayAnchorManager {
    constructor(logger) {
        this.logger = logger;
        this.anchorElement = null;
        this.observer = null;
        // Exclude loading screen from anchor visibility - it's a startup overlay, not user-facing
        this.overlaySelectors = [
            '.info-overlay',
            '.error-overlay', 
            '.status-indicator',
            '.debug-overlay',
            '.controls-overlay'
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
                if (mutation.type === 'attributes') {
                    const target = mutation.target;
                    
                    // Check if this is an overlay element we care about
                    if (this.isOverlayElement(target)) {
                        // Log what changed for debugging
                        if (mutation.attributeName === 'class') {
                            this.logger.log(`🔗 Class change detected on ${target.id || target.className}: ${target.className}`);
                        } else if (mutation.attributeName === 'style') {
                            this.logger.log(`🔗 Style change detected on ${target.id || target.className}: ${target.style.cssText}`);
                        }
                        shouldUpdate = true;
                    }
                }
            });
            
            if (shouldUpdate) {
                this.updateAnchorVisibility();
            }
        });
        
        // Start observing - watch both class and style changes
        this.observer.observe(document.body, {
            attributes: true,
            subtree: true,
            attributeFilter: ['class', 'style']
        });
        
        this.logger.log('🔗 Observer setup complete - watching for overlay changes');
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
                // Check different visibility patterns used by different overlays
                if (el.classList.contains('debug-overlay') || el.classList.contains('controls-overlay')) {
                    // Debug and controls overlays use style.display
                    return el.style.display === 'block';
                } else {
                    // Info, error, status overlays use 'visible' class
                    return el.classList.contains('visible');
                }
            });
        });
    }
    
    updateAnchorVisibility() {
        if (!this.anchorElement) return;
        
        const shouldShow = this.isAnyOverlayVisible();
        const wasVisible = this.anchorElement.classList.contains('active');
        
        // Debug: log current overlay states
        const overlayStates = this.overlaySelectors.map(selector => {
            const elements = document.querySelectorAll(selector);
            const visibleCount = Array.from(elements).filter(el => {
                if (el.classList.contains('debug-overlay') || el.classList.contains('controls-overlay')) {
                    return el.style.display === 'block';
                } else {
                    return el.classList.contains('visible');
                }
            }).length;
            return `${selector}: ${visibleCount}`;
        }).join(', ');
        
        if (shouldShow !== wasVisible) {
            if (shouldShow) {
                this.anchorElement.classList.add('active');
                this.logger.log(`🔗 Overlay anchor shown - overlays detected (${overlayStates})`);
            } else {
                this.anchorElement.classList.remove('active');
                this.logger.log(`🔗 Overlay anchor hidden - no overlays visible (${overlayStates})`);
            }
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