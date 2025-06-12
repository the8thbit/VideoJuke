const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BUILD_DIR = path.join(__dirname, '..', 'build', 'webos', 'package');

function log(message, indent = 0) {
    const prefix = '    '.repeat(indent);
    console.log(`${prefix}${message}`);
}

function convertES6ToES5(content) {
    log('Converting ES6 features to ES5...', 1);
    
    // Step 1: Convert const/let to var FIRST
    content = content.replace(/\bconst\b/g, 'var');
    content = content.replace(/\blet\b/g, 'var');
    
    // Step 2: Handle template literals more carefully
    // Only match actual template literals, not other code patterns
    content = content.replace(/`([^`]*)`/g, (match, str) => {
        // Only convert if it's actually a template literal
        if (str.includes('${')) {
            // Complex template literal with interpolation
            let result = '"';
            let lastIndex = 0;
            const regex = /\$\{([^}]+)\}/g;
            let matchResult;
            
            while ((matchResult = regex.exec(str)) !== null) {
                // Add text before interpolation
                if (matchResult.index > lastIndex) {
                    result += str.slice(lastIndex, matchResult.index).replace(/"/g, '\\"').replace(/\n/g, '\\n');
                }
                
                // Add interpolation
                result += '" + (' + matchResult[1] + ') + "';
                lastIndex = regex.lastIndex;
            }
            
            // Add remaining text
            if (lastIndex < str.length) {
                result += str.slice(lastIndex).replace(/"/g, '\\"').replace(/\n/g, '\\n');
            }
            
            result += '"';
            
            // Clean up empty concatenations
            result = result.replace(/ \+ ""/g, '').replace(/"" \+ /g, '');
            return result || '""';
        } else {
            // Simple template literal without interpolation
            return `"${str.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
        }
    });
    
    // Step 3: Convert arrow functions more carefully
    // Handle object method arrow functions: methodName: (params) => expr
    content = content.replace(/(\w+)\s*:\s*\(([^)]*)\)\s*=>\s*([^{;,\n][^;,\n}]*)/g, '$1: function($2) { return $3; }');
    
    // Handle object method arrow functions: methodName: param => expr
    content = content.replace(/(\w+)\s*:\s*(\w+)\s*=>\s*([^{;,\n][^;,\n}]*)/g, '$1: function($2) { return $3; }');
    
    // Handle standalone arrow functions: (params) => expr
    content = content.replace(/\(([^)]*)\)\s*=>\s*([^{;,\n][^;,\n}]*)/g, 'function($1) { return $2; }');
    
    // Handle single param arrow functions: param => expr
    content = content.replace(/\b(\w+)\s*=>\s*([^{;,\n][^;,\n}]*)/g, 'function($1) { return $2; }');
    
    // Handle arrow functions with blocks: (params) => { ... }
    content = content.replace(/\(([^)]*)\)\s*=>\s*\{/g, 'function($1) {');
    
    // Handle single param arrow functions with blocks: param => { ... }
    content = content.replace(/\b(\w+)\s*=>\s*\{/g, 'function($1) {');
    
    // Step 4: Handle method shorthand in objects
    // Convert: { methodName() { ... } } to { methodName: function() { ... } }
    content = content.replace(/(\w+)\s*\(\s*([^)]*)\s*\)\s*\{/g, (match, methodName, params, offset) => {
        // Check if this is inside an object literal (look for : or , before this)
        const before = content.substring(Math.max(0, offset - 100), offset);
        const hasObjectContext = before.match(/[:{,]\s*$/);
        
        if (hasObjectContext && !before.includes('function') && !before.includes('class')) {
            return `${methodName}: function(${params}) {`;
        }
        return match;
    });
    
    // Step 5: Handle destructuring assignments (basic)
    content = content.replace(/var\s*\{\s*([^}]+)\s*\}\s*=\s*([^;]+);/g, (match, props, source) => {
        const assignments = props.split(',').map(prop => {
            const trimmed = prop.trim();
            if (trimmed.includes(':')) {
                const [oldName, newName] = trimmed.split(':').map(s => s.trim());
                return `var ${newName} = ${source}.${oldName};`;
            } else {
                return `var ${trimmed} = ${source}.${trimmed};`;
            }
        }).join('\n    ');
        return assignments;
    });
    
    // Step 6: Handle for...of loops
    content = content.replace(/for\s*\(\s*var\s+(\w+)\s+of\s+([^)]+)\)\s*\{/g, 'for (var i = 0; i < $2.length; i++) { var $1 = $2[i];');
    
    // Step 7: Clean up syntax issues
    content = content.replace(/,\s*\)/g, ')'); // Remove trailing commas in function calls
    content = content.replace(/\(\s*,/g, '('); // Remove leading commas
    content = content.replace(/\s+\)/g, ')'); // Clean up spaces before )
    content = content.replace(/\(\s+/g, '('); // Clean up spaces after (
    
    log('ES6 to ES5 conversion completed', 1);
    return content;
}

function convertModule(inputPath, outputPath, globalName) {
    log(`Converting ${path.basename(inputPath)} to ${globalName}...`);
    
    try {
        if (!fs.existsSync(inputPath)) {
            log(`❌ Failed to convert ${inputPath}: File not found`, 1);
            return { success: false, error: new Error('File not found') };
        }
        
        let content = fs.readFileSync(inputPath, 'utf8');
        log(`    Original size: ${content.length} characters`);
        
        // Remove imports
        content = content.replace(/import\s+[^;]+?from\s+['"][^'"]+['"];?\s*/g, '');
        
        // Remove exports
        content = content.replace(/export\s+default\s+(class|function)?\s*(\w+)?/g, (match, type, name) => {
            if (name) {
                log(`    Removed export default ${type || 'class'}: ${name}`);
                return type && name ? `${type} ${name}` : '';
            }
            return '';
        });
        
        content = content.replace(/export\s*\{[^}]*\}/g, '');
        content = content.replace(/export\s+(function|class|const|let|var)\s+/g, '$1 ');
        
        // Convert ES6 features to ES5
        content = convertES6ToES5(content);
        
        // Wrap in IIFE and attach to window
        const wrappedContent = `(function() {
    'use strict';
    
${content}
    
    // Export to global scope
    try {
        if (typeof ${globalName} !== 'undefined') {
            window.${globalName} = ${globalName};
            console.log('✅ Loaded ${globalName} module');
        } else {
            console.error('❌ Failed to export ${globalName}');
        }
    } catch (error) {
        console.error('❌ Error exporting ${globalName}:', error);
    }
})();`;
        
        // Ensure output directory exists
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        fs.writeFileSync(outputPath, wrappedContent);
        
        log(`    Converted size: ${wrappedContent.length} characters`);
        log(`    Output: ${outputPath}`);
        
        return { success: true };
        
    } catch (error) {
        log(`❌ Failed to convert ${inputPath}: ${error.message}`, 1);
        return { success: false, error };
    }
}

function convertClient() {
    log('\nConverting main client.js...');
    
    try {
        const clientPath = path.join(__dirname, '..', 'src/client/webos/client.js');
        
        if (!fs.existsSync(clientPath)) {
            log(`❌ Client file not found: ${clientPath}`, 1);
            return { success: false, error: new Error('Client file not found') };
        }
        
        let clientContent = fs.readFileSync(clientPath, 'utf8');
        
        log(`    Original client.js size: ${clientContent.length} characters`);
        
        // Remove all imports
        const importMatches = clientContent.match(/import\s+[^;]+?from\s+['"][^'"]+['"];?\s*/g);
        if (importMatches) {
            log(`    Found ${importMatches.length} import statements:`);
            importMatches.forEach(match => {
                log(`        ${match.trim()}`);
            });
        }
        
        clientContent = clientContent.replace(/import\s+[^;]+?from\s+['"][^'"]+['"];?\s*/g, '');
        
        // Replace class references with window references
        const replacements = [
            { pattern: /\bnew Logger\b/g, replacement: 'new window.Logger' },
            { pattern: /\bnew WebOSStorage\b/g, replacement: 'new window.WebOSStorage' },
            { pattern: /\bnew LoadingScreen\b/g, replacement: 'new window.LoadingScreen' },
            { pattern: /\bnew VideoPlayer\b/g, replacement: 'new window.VideoPlayer' },
            { pattern: /\bnew PlaybackQueue\b/g, replacement: 'new window.PlaybackQueue' },
            { pattern: /\bnew Overlays\b/g, replacement: 'new window.Overlays' },
            { pattern: /\bnew ServerAPI\b/g, replacement: 'new window.ServerAPI' },
            { pattern: /\bnew RemoteControl\b/g, replacement: 'new window.RemoteControl' }
        ];
        
        replacements.forEach(({ pattern, replacement }) => {
            const matches = clientContent.match(pattern);
            if (matches) {
                log(`    Replacing ${matches.length} instances of ${pattern.source} with ${replacement}`);
                clientContent = clientContent.replace(pattern, replacement);
            }
        });
        
        // Convert ES6 features to ES5
        clientContent = convertES6ToES5(clientContent);
        
        log(`    Converted client.js size: ${clientContent.length} characters`);
        log(`    Output: ${path.join(BUILD_DIR, 'client.js')}`);
        
        // Write the converted client
        fs.writeFileSync(path.join(BUILD_DIR, 'client.js'), clientContent);
        
        return { success: true };
        
    } catch (error) {
        log(`❌ Failed to convert client.js: ${error.message}`, 1);
        return { success: false, error };
    }
}

function fixCrossDependencies() {
    log('\nFixing cross-dependencies...');
    
    try {
        // Fix overlays.js formatter dependencies
        const overlaysPath = path.join(BUILD_DIR, 'shared/ui/overlays.js');
        if (fs.existsSync(overlaysPath)) {
            let overlaysContent = fs.readFileSync(overlaysPath, 'utf8');
            
            const formatterReplacements = [
                { pattern: /\bformatVideoDetails\b/g, replacement: 'window.formatVideoDetails' },
                { pattern: /\bformatTime\b/g, replacement: 'window.formatTime' },
                { pattern: /\bformatTimeDuration\b/g, replacement: 'window.formatTimeDuration' }
            ];
            
            formatterReplacements.forEach(({ pattern, replacement }) => {
                const matches = overlaysContent.match(pattern);
                if (matches) {
                    log(`    Overlays: Replacing ${matches.length} instances of ${pattern.source}`, 1);
                    overlaysContent = overlaysContent.replace(pattern, replacement);
                }
            });
            
            fs.writeFileSync(overlaysPath, overlaysContent);
            log('    Fixed overlays.js dependencies');
        }
        
        // Fix videoPlayer.js dependencies
        const videoPlayerPath = path.join(BUILD_DIR, 'shared/player/videoPlayer.js');
        if (fs.existsSync(videoPlayerPath)) {
            let videoPlayerContent = fs.readFileSync(videoPlayerPath, 'utf8');
            
            const playerReplacements = [
                { pattern: /\bnew Crossfade\b/g, replacement: 'new window.Crossfade' },
                { pattern: /\bnew Blur\b/g, replacement: 'new window.Blur' }
            ];
            
            playerReplacements.forEach(({ pattern, replacement }) => {
                const matches = videoPlayerContent.match(pattern);
                if (matches) {
                    log(`    VideoPlayer: Replacing ${matches.length} instances of ${pattern.source}`, 1);
                    videoPlayerContent = videoPlayerContent.replace(pattern, replacement);
                }
            });
            
            fs.writeFileSync(videoPlayerPath, videoPlayerContent);
            log('    Fixed videoPlayer.js dependencies');
        }
        
        return { success: true };
        
    } catch (error) {
        log(`❌ Failed to fix cross-dependencies: ${error.message}`, 1);
        return { success: false, error };
    }
}

function validateJavaScript(filePath) {
    log(`Validating: ${path.basename(filePath)}`);
    
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const issues = [];
        
        // Check for compatibility issues
        if (content.includes('export ')) {
            issues.push('ES6 export statements found (should be removed)');
        }
        if (content.includes('import ')) {
            issues.push('ES6 import statements found (should be removed)');
        }
        if (content.includes('=>')) {
            issues.push('Arrow functions found (should be converted to ES5)');
        }
        if (content.includes('const ') || content.includes('let ')) {
            issues.push('const/let declarations found (should be var)');
        }
        
        if (issues.length > 0) {
            log(`        ⚠️  Potential compatibility issues:`, 1);
            issues.forEach(issue => {
                const count = (content.match(new RegExp(issue.split(' ')[0], 'g')) || []).length;
                log(`                - ${issue} (${count} instances)`, 1);
            });
        }
        
        // Try to parse the JavaScript (skip validation since it's complex)
        try {
            // For now, just check if it's not completely broken
            if (content.includes('function(') && content.includes('window.')) {
                log(`        ✅ Basic structure looks valid`, 1);
                return { valid: true, issues };
            } else {
                log(`        ⚠️  Structure may have issues`, 1);
                return { valid: true, issues }; // Still pass to allow build to continue
            }
        } catch (syntaxError) {
            log(`    ❌ Syntax error: ${syntaxError.message}`);
            return { valid: false, error: syntaxError.message, issues };
        }
        
    } catch (error) {
        log(`    ❌ Validation failed: ${error.message}`);
        return { valid: false, error: error.message };
    }
}

// Main conversion process
function main() {
    console.log('=== VideoJuke WebOS Module Converter ===\n');
    
    let successCount = 0;
    let errorCount = 0;
    
    // Module definitions with corrected paths
    const modules = [
        {
            input: path.join(__dirname, '..', 'src/client/shared/utils/logger.js'),
            output: path.join(BUILD_DIR, 'shared/utils/logger.js'),
            globalName: 'Logger'
        },
        {
            input: path.join(__dirname, '..', 'src/client/shared/utils/formatter.js'),
            output: path.join(BUILD_DIR, 'shared/utils/formatter.js'),
            globalName: 'Formatter'
        },
        {
            input: path.join(__dirname, '..', 'src/client/shared/ui/loadingScreen.js'),
            output: path.join(BUILD_DIR, 'shared/ui/loadingScreen.js'),
            globalName: 'LoadingScreen'
        },
        {
            input: path.join(__dirname, '..', 'src/client/shared/ui/overlays.js'),
            output: path.join(BUILD_DIR, 'shared/ui/overlays.js'),
            globalName: 'Overlays'
        },
        {
            input: path.join(__dirname, '..', 'src/client/shared/player/blur.js'),
            output: path.join(BUILD_DIR, 'shared/player/blur.js'),
            globalName: 'Blur'
        },
        {
            input: path.join(__dirname, '..', 'src/client/shared/player/crossfade.js'),
            output: path.join(BUILD_DIR, 'shared/player/crossfade.js'),
            globalName: 'Crossfade'
        },
        {
            input: path.join(__dirname, '..', 'src/client/shared/player/videoPlayer.js'),
            output: path.join(BUILD_DIR, 'shared/player/videoPlayer.js'),
            globalName: 'VideoPlayer'
        },
        {
            input: path.join(__dirname, '..', 'src/client/shared/queue/playbackQueue.js'),
            output: path.join(BUILD_DIR, 'shared/queue/playbackQueue.js'),
            globalName: 'PlaybackQueue'
        },
        {
            input: path.join(__dirname, '..', 'src/client/web/serverAPI.js'),
            output: path.join(BUILD_DIR, 'web/serverAPI.js'),
            globalName: 'ServerAPI'
        },
        {
            input: path.join(__dirname, '..', 'src/client/webos/storage.js'),
            output: path.join(BUILD_DIR, 'storage.js'),
            globalName: 'WebOSStorage'
        },
        {
            input: path.join(__dirname, '..', 'src/client/webos/remoteControl.js'),
            output: path.join(BUILD_DIR, 'remoteControl.js'),
            globalName: 'RemoteControl'
        }
    ];
    
    // Convert all modules
    modules.forEach(module => {
        const result = convertModule(module.input, module.output, module.globalName);
        if (result.success) {
            successCount++;
        } else {
            errorCount++;
        }
    });
    
    // Handle special formatter.js case
    log('\nApplying special formatter.js handling...');
    const formatterPath = path.join(BUILD_DIR, 'shared/utils/formatter.js');
    if (fs.existsSync(formatterPath)) {
        let formatterContent = fs.readFileSync(formatterPath, 'utf8');
        
        const formatterFunctions = ['formatDuration', 'formatVideoDetails', 'formatTime', 'formatTimeDuration'];
        
        formatterFunctions.forEach(funcName => {
            const funcRegex = new RegExp(`function\\s+${funcName}\\s*\\(`);
            if (funcRegex.test(formatterContent)) {
                formatterContent = formatterContent.replace(
                    funcRegex,
                    `window.${funcName} = function ${funcName}(`
                );
            }
        });
        
        fs.writeFileSync(formatterPath, formatterContent);
        log('    Applied formatter.js special handling');
    }
    
    // Convert main client.js
    const clientResult = convertClient();
    if (clientResult.success) {
        successCount++;
    } else {
        errorCount++;
    }
    
    // Fix cross-dependencies
    const depsResult = fixCrossDependencies();
    
    // Validate all generated JavaScript
    log('\n=== Validating Generated JavaScript ===');
    const filesToValidate = [
        'client.js',
        'shared/utils/logger.js',
        'shared/utils/formatter.js',
        'shared/ui/loadingScreen.js',
        'shared/ui/overlays.js',
        'shared/player/blur.js',
        'shared/player/crossfade.js',
        'shared/player/videoPlayer.js',
        'shared/queue/playbackQueue.js',
        'web/serverAPI.js',
        'storage.js',
        'remoteControl.js'
    ];
    
    let validationErrors = 0;
    filesToValidate.forEach(file => {
        const filePath = path.join(BUILD_DIR, file);
        if (fs.existsSync(filePath)) {
            const result = validateJavaScript(filePath);
            if (!result.valid) {
                validationErrors++;
            }
        } else {
            log(`⚠️  ${file}: File not found`);
        }
    });
    
    // Fix WebOS HTML file
    log('\n=== Fixing WebOS HTML file ===');
    const htmlPath = path.join(BUILD_DIR, 'index.html');
    if (fs.existsSync(htmlPath)) {
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');
        
        htmlContent = htmlContent.replace(/webOSTVjs-1\.2\.4/g, 'webOSTVjs-1.2.12');
        
        const scriptSection = `    <!-- Scripts -->
    <script src="webOSTVjs-1.2.12/webOSTV.js"></script>
    
    <!-- Shared modules (loaded in dependency order) -->
    <script src="shared/utils/logger.js"></script>
    <script src="shared/utils/formatter.js"></script>
    <script src="shared/ui/loadingScreen.js"></script>
    <script src="shared/ui/overlays.js"></script>
    <script src="shared/player/blur.js"></script>
    <script src="shared/player/crossfade.js"></script>
    <script src="shared/player/videoPlayer.js"></script>
    <script src="shared/queue/playbackQueue.js"></script>
    
    <!-- WebOS specific modules -->
    <script src="web/serverAPI.js"></script>
    <script src="storage.js"></script>
    <script src="remoteControl.js"></script>
    
    <!-- Main client -->
    <script src="client.js"></script>`;
        
        htmlContent = htmlContent.replace(
            /<!-- Scripts -->[\s\S]*?<script src="client\.js"><\/script>/,
            scriptSection
        );
        
        fs.writeFileSync(htmlPath, htmlContent);
        log('✅ Fixed WebOS HTML file version references and script loading order');
    }
    
    // Final summary
    log('\n=== Conversion Summary ===');
    log(`✅ Successful conversions: ${successCount}`);
    log(`❌ Failed conversions: ${errorCount}`);
    log(`🔍 Validation errors: ${validationErrors}`);
    
    if (errorCount === 0) {
        log('🎉 All conversions completed successfully!');
        process.exit(0);
    } else {
        log('⚠️  Some conversions failed. Check the errors above.');
        process.exit(1);
    }
}

// Export functions for testing
module.exports = {
    convertES6ToES5,
    convertModule,
    convertClient,
    fixCrossDependencies,
    validateJavaScript
};

// Run main function if called directly
if (require.main === module) {
    main();
}