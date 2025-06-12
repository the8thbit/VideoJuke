const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BUILD_DIR = path.join(__dirname, '..', 'build', 'webos', 'package');

function log(message, indent = 0) {
    const spaces = '    '.repeat(indent);
    console.log(`${spaces}${message}`);
}

function debugConversionStep(content, stepName, filePath) {
    const debugDir = path.join(path.dirname(filePath), 'debug');
    if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
    }
    
    const debugFile = path.join(debugDir, `${path.basename(filePath, '.js')}_${stepName}.js`);
    fs.writeFileSync(debugFile, content);
    log(`Debug: ${stepName} → ${debugFile}`, 2);
    
    // Try to validate at each step
    try {
        new vm.Script(content);
        log(`✅ ${stepName} syntax valid`, 2);
    } catch (error) {
        log(`❌ ${stepName} syntax error: ${error.message}`, 2);
        
        // Find the problematic line
        const lines = content.split('\n');
        const lineNumber = error.lineNumber || 1;
        if (lineNumber <= lines.length) {
            log(`Problem line ${lineNumber}: ${lines[lineNumber - 1]}`, 3);
        }
    }
}

function simpleES6ToES5(content, filePath) {
    log('Converting ES6 to ES5 with step-by-step debugging...', 1);
    
    // Step 1: Remove imports and exports first
    debugConversionStep(content, '01_original', filePath);
    
    // Remove imports
    content = content.replace(/import\s+[^;]+?from\s+['"][^'"]+['"];?\s*/g, '');
    debugConversionStep(content, '02_imports_removed', filePath);
    
    // Remove exports
    content = content.replace(/export\s+default\s+/g, '');
    content = content.replace(/export\s+\{[^}]*\}/g, '');
    content = content.replace(/export\s+(function|class|const|let|var)\s+/g, '$1 ');
    debugConversionStep(content, '03_exports_removed', filePath);
    
    // Step 2: Convert const/let to var
    content = content.replace(/\bconst\b/g, 'var');
    content = content.replace(/\blet\b/g, 'var');
    debugConversionStep(content, '04_const_let_to_var', filePath);
    
    // Step 3: Convert simple template literals (no interpolation)
    content = content.replace(/`([^`$]*)`/g, (match, str) => {
        if (!str.includes('${')) {
            return `"${str.replace(/"/g, '\\"')}"`;
        }
        return match; // Keep complex ones for now
    });
    debugConversionStep(content, '05_simple_templates', filePath);
    
    // Step 4: Convert basic arrow functions
    // Start with the simplest: () => expression
    content = content.replace(/\(\s*\)\s*=>\s*([^{;,\n][^;,\n}]*)/g, 'function() { return $1; }');
    debugConversionStep(content, '06_arrow_no_params', filePath);
    
    // Single param: param => expression
    content = content.replace(/\b(\w+)\s*=>\s*([^{;,\n][^;,\n}]*)/g, 'function($1) { return $2; }');
    debugConversionStep(content, '07_arrow_single_param', filePath);
    
    // Multi param: (a, b) => expression
    content = content.replace(/\(([^)]+)\)\s*=>\s*([^{;,\n][^;,\n}]*)/g, 'function($1) { return $2; }');
    debugConversionStep(content, '08_arrow_multi_param', filePath);
    
    // Block arrows: () => { block }
    content = content.replace(/\(\s*\)\s*=>\s*\{/g, 'function() {');
    debugConversionStep(content, '09_arrow_blocks_no_param', filePath);
    
    // Block arrows: (param) => { block }
    content = content.replace(/\(([^)]+)\)\s*=>\s*\{/g, 'function($1) {');
    debugConversionStep(content, '10_arrow_blocks_with_params', filePath);
    
    // Single param blocks: param => { block }
    content = content.replace(/\b(\w+)\s*=>\s*\{/g, 'function($1) {');
    debugConversionStep(content, '11_arrow_blocks_single_param', filePath);
    
    // Step 5: Handle method shorthand in objects
    content = content.replace(/(\w+)\s*\(/g, (match, name, offset) => {
        // Check if this is inside an object literal
        const before = content.substring(Math.max(0, offset - 50), offset);
        const after = content.substring(offset, offset + 20);
        
        // If it looks like object method shorthand
        if (before.includes(':') && after.includes(')') && !before.includes('function')) {
            return `${name}: function(`;
        }
        return match;
    });
    debugConversionStep(content, '12_method_shorthand', filePath);
    
    // Step 6: Clean up any obvious syntax issues
    content = content.replace(/,\s*\)/g, ')'); // Remove trailing commas in function calls
    content = content.replace(/\(\s*,/g, '('); // Remove leading commas
    content = content.replace(/\s+\)/g, ')'); // Clean up spaces before )
    content = content.replace(/\(\s+/g, '('); // Clean up spaces after (
    debugConversionStep(content, '13_cleanup', filePath);
    
    return content;
}

function convertModuleWithDiagnostics(inputPath, outputPath, globalName) {
    log(`Converting ${path.basename(inputPath)} to ${globalName}...`);
    
    try {
        if (!fs.existsSync(inputPath)) {
            log(`❌ File not found: ${inputPath}`, 1);
            return { success: false, error: new Error('File not found') };
        }
        
        let content = fs.readFileSync(inputPath, 'utf8');
        log(`Original size: ${content.length} characters`, 1);
        
        // Convert with step-by-step debugging
        content = simpleES6ToES5(content, outputPath);
        
        // Wrap in IIFE
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
        
        // Final validation
        try {
            new vm.Script(wrappedContent);
            log(`✅ Final wrapped content is valid`, 1);
        } catch (error) {
            log(`❌ Final wrapped content has syntax error: ${error.message}`, 1);
            
            // Save the problematic final version
            const finalDebugPath = outputPath.replace('.js', '_final_error.js');
            fs.writeFileSync(finalDebugPath, wrappedContent);
            log(`Final error version saved: ${finalDebugPath}`, 2);
        }
        
        // Ensure output directory exists
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        fs.writeFileSync(outputPath, wrappedContent);
        log(`Output: ${outputPath}`, 1);
        
        return { success: true };
        
    } catch (error) {
        log(`❌ Failed to convert: ${error.message}`, 1);
        return { success: false, error };
    }
}

// Quick test on a single problematic file
function main() {
    console.log('=== Diagnostic ES6 to ES5 Converter ===\n');
    
    // Test on client.js first
    const clientPath = path.join(__dirname, '..', 'src/client/webos/client.js');
    if (fs.existsSync(clientPath)) {
        log('Testing client.js conversion...');
        convertModuleWithDiagnostics(clientPath, path.join(BUILD_DIR, 'client.js'), 'VideoJukeClient');
    } else {
        log('❌ Client.js not found');
    }
    
    // Test on one of the problematic shared files
    const loadingScreenPath = path.join(__dirname, '..', 'src/client/shared/ui/loadingScreen.js');
    if (fs.existsSync(loadingScreenPath)) {
        log('\nTesting loadingScreen.js conversion...');
        const outputPath = path.join(BUILD_DIR, 'shared/ui/loadingScreen.js');
        convertModuleWithDiagnostics(loadingScreenPath, outputPath, 'LoadingScreen');
    } else {
        log('❌ LoadingScreen.js not found');
    }
    
    console.log('\n=== Diagnostic Complete ===');
    console.log('Check the debug/ folders in the build directory for step-by-step conversion files.');
}

if (require.main === module) {
    main();
}