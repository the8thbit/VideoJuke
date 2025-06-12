#!/bin/bash

# VideoJuke WebOS App Packaging Script

echo "=== VideoJuke WebOS App Packager ==="

# Check if webOS CLI tools are installed
if ! command -v ares-package &> /dev/null; then
    echo "Error: webOS CLI tools not found!"
    echo "Please install the webOS SDK from: https://webostv.developer.lge.com/sdk/installation/"
    exit 1
fi

# Set up paths
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$SCRIPT_DIR/../.."
WEBOS_SRC="$PROJECT_ROOT/src/client/webos"
BUILD_DIR="$PROJECT_ROOT/build/webos"
PACKAGE_DIR="$BUILD_DIR/package"
OUTPUT_DIR="$PROJECT_ROOT/dist/webos"

echo "Building WebOS app..."

# Clean build directory
rm -rf "$BUILD_DIR"
mkdir -p "$PACKAGE_DIR"
mkdir -p "$OUTPUT_DIR"

# Copy WebOS app files
echo "Copying WebOS app files..."
cp "$WEBOS_SRC/appinfo.json" "$PACKAGE_DIR/"
cp "$WEBOS_SRC/index.html" "$PACKAGE_DIR/"
cp "$WEBOS_SRC/icon.png" "$PACKAGE_DIR/" 2>/dev/null || true
cp "$WEBOS_SRC/largeIcon.png" "$PACKAGE_DIR/" 2>/dev/null || true
cp -r "$WEBOS_SRC/webOSTVjs-1.2.12" "$PACKAGE_DIR/" 2>/dev/null || \
cp -r "$WEBOS_SRC/webOSTVjs-1.2.12" "$PACKAGE_DIR/webOSTVjs-1.2.12" 2>/dev/null || true

# Convert ES6 modules to WebOS format
echo "Converting ES6 modules to WebOS format..."
node "$SCRIPT_DIR/build-webos-modules.js"

# Download webOS TV library if not present
WEBOS_LIB_DIR="$PACKAGE_DIR/webOSTVjs-1.2.12"
if [ ! -d "$WEBOS_LIB_DIR" ]; then
    echo "Downloading webOS TV library..."
    mkdir -p "$WEBOS_LIB_DIR"
    curl -L "https://webostv.developer.lge.com/api/attachments/download/1658" -o "$BUILD_DIR/webOSTVjs.zip"
    unzip -q "$BUILD_DIR/webOSTVjs.zip" -d "$WEBOS_LIB_DIR"
fi

# Create icons if they don't exist
if [ ! -f "$PACKAGE_DIR/icon.png" ]; then
    echo "Warning: icon.png not found. Creating placeholder..."
    # Create a simple blue square as placeholder
    convert -size 80x80 xc:#3b82f6 "$PACKAGE_DIR/icon.png" 2>/dev/null || \
    echo "  - Please add icon.png (80x80) to $WEBOS_SRC/"
fi

if [ ! -f "$PACKAGE_DIR/largeIcon.png" ]; then
    echo "Warning: largeIcon.png not found. Creating placeholder..."
    # Create a simple blue square as placeholder
    convert -size 130x130 xc:#3b82f6 "$PACKAGE_DIR/largeIcon.png" 2>/dev/null || \
    echo "  - Please add largeIcon.png (130x130) to $WEBOS_SRC/"
fi

# Package the app
echo "Packaging WebOS app..."
cd "$PACKAGE_DIR"
ares-package . -o "$OUTPUT_DIR"

# Find the generated IPK file
IPK_FILE=$(find "$OUTPUT_DIR" -name "*.ipk" -type f | head -1)

if [ -f "$IPK_FILE" ]; then
    echo ""
    echo "=== Build Complete ==="
    echo "Package created: $IPK_FILE"
    echo ""
    echo "To install on your TV:"
    echo "1. Enable Developer Mode on your TV"
    echo "2. Set up device: ares-setup-device"
    echo "3. Install: ares-install $IPK_FILE"
    echo ""
else
    echo "Error: Failed to create IPK package"
    exit 1
fi