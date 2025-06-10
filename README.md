# VideoJuke

A random video player that continuously plays videos from configured directories with smooth transitions and intelligent queue management. Now available in both standalone and Electron versions with client-server architecture.

## Overview

VideoJuke is available in two modes:
- **Electron Mode**: Traditional desktop application (default, same as v1.x)
- **Standalone Mode**: Separate HTTP server and web client for remote access

Features:
- Plays random videos from multiple directories
- Preprocesses videos for smooth playback (audio normalization)
- Supports crossfade transitions between videos
- Maintains robust dual-layer history for navigation
- Provides keyboard controls for all features
- Real-time WebSocket communication for status updates

## Quick Start

### Original Electron Mode (Default)

```bash
# Install dependencies
npm install

# Start VideoJuke (same as always)
npm start
```

### New Standalone Mode

```bash
# Start both server and client in standalone mode
npm run start:standalone

# Or run them separately:
# Terminal 1: Start server
npm run start:server

# Terminal 2: Start client (opens browser)
npm run start:client
```

On first run, edit `config.json` to add your video directories:
   ```json
   {
     "directories": [
       "C:\\Videos\\Collection1",
       "D:\\Movies\\Collection2"
     ],
     "network": {
       "server": {
         "port": 8080,
         "host": "localhost"
       },
       "client": {
         "serverUrl": "http://localhost:8080"
       }
     }
   }
   ```

5. Restart the server: `npm run start:server`

### Electron Mode (Traditional)

```bash
npm start
# or
npm run start:electron
```

## Network Configuration

The standalone mode supports remote access through network configuration:

```json
{
  "network": {
    "server": {
      "enabled": true,
      "port": 8080,
      "host": "0.0.0.0"  // Allow external connections
    },
    "client": {
      "serverUrl": "http://192.168.1.100:8080"  // Server IP
    }
  }
}
```

**Security Note**: When exposing the server externally, ensure your network is secure as video files will be accessible via HTTP.

## Recent Changes (v2.0.0)

### New Architecture
- **Separated client and server**: Run independently for remote access
- **HTTP/WebSocket communication**: Replaces Electron IPC for flexibility
- **Real-time updates**: WebSocket connection for initialization progress and logs
- **Browser compatibility**: Client runs in any modern web browser
- **Backward compatibility**: Electron mode still available

### New Commands
- `npm start` - Start original Electron app (unchanged for backward compatibility)
- `npm run start:standalone` - Start both server and client in standalone mode
- `npm run start:server` - Start server only
- `npm run start:client` - Start client only (opens browser)
- `npm run start:electron` - Alias for original Electron mode
- `npm run dev:server` - Development server with auto-restart
- `npm run dev:client` - Development client launcher

### Network Features
- **Remote access**: Access VideoJuke from any device on the network
- **Auto-reconnection**: Client automatically reconnects to server
- **Connection status**: Visual indicator of server connection state
- **Graceful degradation**: Handles network interruptions smoothly

## Project Structure

```
videojuke/
├── main.js                    # Electron entry point (legacy)
├── preload.js                 # IPC bridge (Electron mode)
├── config.json                # User configuration
├── cache/                     # Application cache and state
│   ├── persisted-history.json # Long-term playback history
│   ├── queue-state.json       # Saved queue state
│   └── video-index.json       # Cached video index
├── temp/                      # Processed video cache
├── src/
│   ├── server/                # Server process (Node.js)
│   │   ├── standalone-server.js # Standalone HTTP server
│   │   ├── server.js          # Electron main process
│   │   ├── config/            # Configuration management
│   │   ├── video/             # Video indexing and preprocessing
│   │   ├── queue/             # Queue and history management
│   │   │   ├── preprocessedQueue.js
│   │   │   ├── queuePersistence.js
│   │   │   ├── reprocessHandler.js
│   │   │   └── historyManager.js
│   │   ├── window/            # Window management (Electron)
│   │   └── ipc/               # IPC handlers (Electron)
│   └── client/                # Client process (Browser/Electron)
│       ├── standalone-client.js # Client launcher
│       ├── standalone.html    # Standalone client HTML
│       ├── index.html         # Electron client HTML
│       ├── client.js          # Main client logic
│       ├── serverAPI.js       # HTTP/WebSocket API wrapper
│       ├── player/            # Video playback
│       │   ├── videoPlayer.js # Main player logic
│       │   ├── crossfade.js   # Crossfade transitions
│       │   └── blur.js        # Blur effects
│       ├── queue/             # Playback queue
│       ├── ui/                # User interface
│       └── utils/             # Utilities
```

## Architecture

### Standalone Mode (New)
Two independent processes communicate via HTTP and WebSocket:

**Server Process:**
- HTTP server with REST API endpoints
- WebSocket server for real-time communication
- Video processing and queue management
- File serving for processed videos
- Background indexing and monitoring

**Client Process:**
- Web browser application
- HTTP requests for video operations
- WebSocket connection for live updates
- Video playback and UI management
- Automatic reconnection handling

### Electron Mode (Traditional)
Two-process architecture with IPC communication (unchanged from v1.x).

### API Endpoints

The standalone server exposes these REST endpoints:

- `GET /` - Serve client application
- `GET /api/config` - Get configuration
- `GET /api/queue-status` - Get queue status
- `GET /api/detailed-stats` - Get detailed statistics
- `GET /api/next-video` - Get next video
- `GET /api/previous-video` - Get previous video
- `POST /api/video-ended` - Report video ended
- `POST /api/video-error` - Report video error
- `POST /api/add-to-history` - Add video to history
- `POST /api/ensure-video-processed` - Reprocess video
- `GET /videos/*` - Serve processed video files

### WebSocket Events

Real-time communication via WebSocket:

- `initialization-update` - Server initialization progress
- `main-log` - Server log messages
- Connection status monitoring

## Configuration

Edit `config.json` to customize behavior:

```json
{
  "directories": ["path/to/videos"],
  "network": {
    "server": {
      "enabled": true,
      "port": 8080,
      "host": "localhost"
    },
    "client": {
      "serverUrl": "http://localhost:8080"
    }
  },
  "video": {
    "preprocessedQueueSize": 20,
    "playbackQueueSize": 50,
    "playbackHistorySize": 10,
    "persistedHistorySize": 5000
  },
  "crossfade": {
    "enabled": true,
    "duration": 500
  },
  "blur": {
    "enabled": true,
    "maxAmount": 8
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
- `↑/↓` - Increase/decrease speed
- `0` - Reset speed to 1x

### Effects
- `M` - Toggle mute
- `F` - Toggle crossfade
- `B` - Toggle blur effects

### Information
- `I` - Show video info
- `T` - Show title only
- `Q` - Toggle debug overlay
- `?` or `/` - Show controls

### Application
- `ESC` - Quit (Electron) / Show message (Browser)

## Features

### Client-Server Architecture
- **Separation of concerns**: Server handles processing, client handles playback
- **Remote access**: Connect from any device on the network
- **Scalability**: Multiple clients can connect to one server
- **Flexibility**: Choose between Electron desktop app or web browser

### Real-time Communication
- **WebSocket integration**: Live updates of server status
- **Automatic reconnection**: Client reconnects after network interruptions
- **Connection monitoring**: Visual feedback of connection state
- **Graceful degradation**: Continues working during brief disconnections

### Dual-Layer History
- **Playback History**: Recent videos (default 10) for quick navigation
- **Persisted History**: Long-term tracking (default 5000) with file persistence
- Automatic temp file protection for recent videos
- Intelligent fallback between history layers

### Crossfade Transitions
When enabled, videos blend smoothly with:
- Configurable duration (default 500ms)
- Volume fading
- Optional blur integration
- Automatic timing based on video length

### Session Persistence
- Queue state saved on exit in `cache/`
- Playback history preserved across sessions
- Persisted history maintained long-term
- Resumes from where you left off

### Automatic Recovery
- Handles missing files gracefully
- Skips unplayable videos
- Maintains minimum queue levels
- Reprocesses videos as needed
- Network reconnection handling
- Comprehensive error logging

## Development

### Building
```bash
npm run build
```

### Development Mode
```bash
# Server with auto-restart
npm run dev:server

# Client launcher with auto-restart
npm run dev:client

# Traditional Electron development
npm run dev
```

### Testing Network Mode
1. Start server: `npm run start:server`
2. Open browser to: `http://localhost:8080`
3. Check different devices on network: `http://[server-ip]:8080`

## Deployment

### Standalone Server
The server can run on any Node.js-capable system:

```bash
# Production server
NODE_ENV=production npm run start:server

# With PM2 for process management
pm2 start src/server/standalone-server.js --name videojuke-server
```

### Docker (Future)
Future versions may include Docker support for easy deployment.

## Technical Details

### Supported Formats
Primary: MP4, AVI, MOV, WMV, FLV, WebM, MKV
Additional: M4V, 3GP, MPEG, MPG, TS, MTS, M2TS

### Dependencies
- **Server**: Express, WebSocket, FFmpeg, fluent-ffmpeg
- **Client**: Modern web browser with ES6+ support
- **Electron**: Electron framework (legacy mode)
- **Shared**: glob, mime-types

### File Locations
- `config.json` - User configuration
- `cache/queue-state.json` - Saved queue state
- `cache/persisted-history.json` - Long-term history
- `cache/video-index.json` - Cached video list
- `temp/` - Processed video cache

### Browser Requirements
- Modern browser with WebSocket support
- HTML5 video support
- ES6+ JavaScript support
- No Flash or additional plugins required

## Troubleshooting

### Connection Issues
- Check server is running: `http://localhost:8080/health`
- Verify port not in use by other applications
- Check firewall settings for external access
- Ensure WebSocket support in browser

### Video Playback Issues
- Verify video formats are supported by browser
- Check network speed for streaming
- Monitor browser developer console for errors
- Ensure FFmpeg processing completed successfully

### Server Issues
- Check console logs for server errors
- Verify config.json syntax is valid
- Ensure video directories exist and contain supported files
- Check available disk space for temp files
- Monitor server memory usage during processing

### Performance Optimization
- Reduce `preprocessedQueueSize` for lower memory usage
- Adjust `playbackQueueSize` based on network speed
- Use wired connection for better video streaming
- Close other bandwidth-intensive applications

## Migration from v1.x

**No migration required!** VideoJuke v2.0 maintains full backward compatibility:

1. `npm start` works exactly as before (launches Electron app)
2. All existing cache and history files remain compatible
3. Configuration format is unchanged (new network settings are optional)

**To try the new standalone mode:**
- `npm run start:standalone` for combined server+client
- `npm run start:server` then `npm run start:client` for separate mode

## Notes

- Standalone mode serves videos over HTTP for browser compatibility
- Electron mode still uses `file://` URLs for optimal performance
- WebSocket connection provides real-time updates but isn't required for basic functionality
- Client automatically falls back to polling if WebSocket connection fails
- Server can run headless for deployment scenarios
- Multiple clients can connect to the same server simultaneously
- History and queue state are managed server-side for consistency