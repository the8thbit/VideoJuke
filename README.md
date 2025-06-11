# VideoJuke

A random video player that continuously plays videos from configured directories with smooth transitions, intelligent queue management, and dual-architecture support for both desktop and web deployment.

## Overview

VideoJuke supports two deployment modes:
- **Electron Mode**: Traditional desktop application with native OS integration
- **Web Mode**: HTTP server with browser-based client for remote access

## Features

- **Random Video Playback**: Continuously plays videos from multiple configured directories
- **Smart Preprocessing**: Audio normalization and format optimization for smooth playback
- **Crossfade Transitions**: Smooth blending between videos with configurable timing
- **Dual-Layer History**: Recent playback history + long-term persistence for navigation
- **Queue Management**: Intelligent preprocessing queue with automatic refilling
- **Real-time Communication**: WebSocket updates for server status and progress
- **Keyboard Controls**: Full playback control without mouse interaction
- **Session Persistence**: Maintains queue and history across restarts

## Quick Start

### Desktop Mode (Electron)

```bash
# Install dependencies
npm install

# Start desktop application
npm start
# or
npm run electron
```

### Web Mode (Server + Browser)

```bash
# Install dependencies
npm install

# Start web server
npm run web

# Open browser to http://localhost:8080
```

### Development Mode

```bash
# Electron development (with DevTools)
npm run dev:electron

# Web server development (with auto-restart)
npm run dev:web
```

## Initial Setup

1. **First Run**: On first startup, VideoJuke creates `config.json` from `config.default.json`

2. **Configure Video Directories**: Edit `config.json` to add your video folders:
   ```json
   {
     "directories": [
       "C:\\Users\\YourName\\Videos",
       "D:\\Movies\\Collection",
       "/path/to/your/videos"
     ]
   }
   ```

3. **Network Configuration** (Web Mode Only):
   ```json
   {
     "network": {
       "server": {
         "enabled": true,
         "port": 8080,
         "host": "localhost"
       }
     }
   }
   ```

4. **Restart**: Restart VideoJuke to scan your video directories

## Project Structure

```
videojuke/
├── src/
│   ├── server/                    # Server-side components
│   │   ├── electron/              # Electron main process
│   │   │   ├── server.js          # Electron server entry point
│   │   │   ├── windowManager.js   # Window management
│   │   │   └── ipcHandlers.js     # IPC communication
│   │   ├── web/                   # Web server
│   │   │   └── server.js          # Web server entry point
│   │   └── shared/                # Shared server components
│   │       ├── config/            # Configuration management
│   │       ├── video/             # Video processing & indexing
│   │       ├── queue/             # Queue & history management
│   │       └── utils/             # Utilities & logging
│   └── client/                    # Client-side components
│       ├── electron/              # Electron renderer
│       │   ├── main.js            # Electron app entry point
│       │   ├── client.js          # Electron client logic
│       │   └── index.html         # Electron UI
│       ├── web/                   # Web client
│       │   ├── client.js          # Web client logic
│       │   ├── serverAPI.js       # HTTP/WebSocket API wrapper
│       │   └── index.html         # Web UI
│       └── shared/                # Shared client components
│           ├── player/            # Video playback engine
│           ├── queue/             # Client-side queue management
│           ├── ui/                # User interface components
│           └── utils/             # Client utilities
├── config.json                    # User configuration
├── config.default.json            # Default configuration template
├── cache/                         # Application cache
│   ├── video-index.json           # Cached video directory index
│   ├── queue-state.json           # Saved queue state
│   └── persisted-history.json     # Long-term playback history
└── temp/                          # Processed video cache
```

## Architecture

### Electron Mode
- **Main Process**: Handles video processing, queue management, and system integration
- **Renderer Process**: Manages video playback, UI, and user interaction
- **IPC Communication**: Electron's inter-process communication for data exchange
- **File Access**: Direct file system access for optimal performance

### Web Mode
- **Server Process**: HTTP server with REST API and WebSocket support
- **Client Process**: Browser-based application with real-time updates
- **HTTP API**: RESTful endpoints for video operations and configuration
- **WebSocket**: Real-time communication for status updates and logging
- **Video Streaming**: HTTP range request support for efficient video delivery

## Configuration

### Core Settings

```json
{
  "directories": ["path/to/videos"],
  "video": {
    "preprocessedQueueSize": 20,
    "playbackQueueSize": 50,
    "playbackQueueInitializationThreshold": 10,
    "playbackHistorySize": 10,
    "persistedHistorySize": 5000,
    "updateInterval": 900000
  },
  "crossfade": {
    "enabled": false,
    "duration": 500
  },
  "blur": {
    "enabled": false,
    "maxAmount": 8
  },
  "ui": {
    "startFullscreen": true,
    "showErrorToast": false,
    "infoDuration": 5000
  }
}
```

### Network Configuration (Web Mode)

```json
{
  "network": {
    "server": {
      "enabled": true,
      "port": 8080,
      "host": "0.0.0.0"
    }
  },
  "timeouts": {
    "connectionTimeout": 5000,
    "reconnectDelay": 2000
  },
  "retries": {
    "maxConnectionAttempts": 5
  }
}
```

## Keyboard Controls

### Playback
- `Space` - Play/Pause
- `N` - Next video
- `P` - Previous video  
- `R` - Restart current video
- `L` - Toggle loop
- `←/→` - Skip backward/forward 5 seconds
- `↑/↓` - Increase/decrease playback speed
- `0` - Reset speed to 1x

### Audio & Effects
- `M` - Toggle mute
- `F` - Toggle crossfade transitions
- `B` - Toggle blur effects

### Information & Debug
- `I` - Show video information overlay
- `T` - Show video title only
- `Q` - Toggle debug information
- `?` or `/` - Show keyboard controls help

### Application
- `ESC` - Quit application (Electron) / Close tab (Web)

## API Reference (Web Mode)

### REST Endpoints

- `GET /api/config` - Get application configuration
- `GET /api/queue-status` - Get queue and initialization status
- `GET /api/detailed-stats` - Get detailed statistics
- `GET /api/next-video` - Get next video from queue
- `GET /api/previous-video` - Get previous video from history
- `POST /api/video-ended` - Report video completion
- `POST /api/video-error` - Report video error
- `POST /api/add-to-history` - Add video to history
- `POST /api/ensure-video-processed` - Reprocess/validate video
- `GET /videos?filename=<encoded>` - Stream video files with range support

### WebSocket Events

- `initialization-update` - Server initialization progress
- `main-log` - Server log messages with timestamp and level

## Supported Video Formats

**Primary**: MP4, AVI, MOV, WMV, FLV, WebM, MKV  
**Additional**: M4V, 3GP, MPEG, MPG, TS, MTS, M2TS

All videos are preprocessed with:
- Audio normalization (loudnorm filter)
- MP4 container optimization
- Fast-start encoding for web streaming

## Dependencies

### Core
- **Electron** - Desktop application framework
- **Express** - Web server framework
- **WebSocket** - Real-time communication
- **FFmpeg** - Video processing and metadata extraction

### Video Processing
- **fluent-ffmpeg** - FFmpeg wrapper for Node.js
- **ffmpeg-static** - Static FFmpeg binaries
- **ffprobe-static** - Static FFprobe binaries

### Utilities
- **glob** - File pattern matching
- **mime-types** - MIME type detection
- **cors** - Cross-origin resource sharing

## Development

### Building
```bash
npm run build
```

### Development Scripts
```bash
# Electron with DevTools
npm run dev:electron

# Web server with auto-restart
npm run dev:web
```

### File Locations
- **Configuration**: `config.json` (user), `config.default.json` (template)
- **Cache**: `cache/` directory for persistent data
- **Temporary Files**: `temp/` directory for processed videos
- **Logs**: Console output with structured logging

## Deployment

### Desktop Distribution
```bash
npm run build
```
Creates platform-specific installers in `dist/` directory.

### Web Server Deployment
```bash
# Production server
NODE_ENV=production npm run web

# Process manager (recommended)
pm2 start src/server/web/server.js --name videojuke-server
```

### Docker (Future Enhancement)
Container support planned for simplified deployment and scaling.

## Browser Compatibility (Web Mode)

### Required Features
- Modern ES6+ JavaScript support
- HTML5 video with range request support  
- WebSocket API
- Fetch API for HTTP requests

### Recommended Browsers
- Chrome/Chromium 80+
- Firefox 75+
- Safari 13+
- Edge 80+

### Mobile Support
Basic mobile browser support available, though optimized for desktop use.

## Troubleshooting

### Common Issues

**No videos found**: Check `config.json` directory paths and file permissions

**Autoplay blocked**: Web browsers require user interaction before playing audio/video

**Connection issues** (Web mode): Verify server is running and firewall allows the configured port

**Performance issues**: Reduce `preprocessedQueueSize` or check available disk space in `temp/`

### Debug Information
- Press `Q` to view queue status, processing statistics, and connection state
- Check console logs for detailed error information
- Monitor `cache/` directory for state persistence issues

### Recovery Features
- Automatic queue rebuilding on startup
- Session state persistence across restarts  
- Graceful handling of missing or corrupted video files
- Network reconnection for web clients

## License

AGPL-3.0-or-later