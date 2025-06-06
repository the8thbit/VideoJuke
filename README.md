# VideoJuke

A random video player that continuously plays videos from configured directories with smooth transitions and intelligent queue management.

## Overview

VideoJuke is an Electron-based application that:
- Plays random videos from multiple directories
- Preprocesses videos for smooth playback (audio normalization)
- Supports crossfade transitions between videos
- Maintains robust dual-layer history for navigation
- Provides keyboard controls for all features

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run the application:
   ```bash
   npm start
   ```

3. On first run, edit `config.json` to add your video directories:
   ```json
   {
     "directories": [
       "C:\\Videos\\Collection1",
       "D:\\Movies\\Collection2"
     ]
   }
   ```

4. Restart the application

## Recent Bug Fixes (v1.0.1)

- **Fixed loading screen freeze**: Resolved missing methods in PreprocessedQueue class that prevented proper initialization
- **Fixed IPC handler registration**: Moved essential IPC handlers to register early, preventing "No handler registered" errors
- **Improved error handling**: Added comprehensive error handling for temp directory cleanup and initialization failures  
- **Enhanced logging**: Added detailed logging throughout queue operations and initialization process
- **Removed duplicate functions**: Cleaned up duplicate `performInitialization()` function in server.js

## Project Structure

```
videojuke/
├── main.js                    # Electron entry point
├── preload.js                 # IPC bridge
├── config.json                # User configuration
├── cache/                     # Application cache and state
│   ├── persisted-history.json # Long-term playback history
│   ├── queue-state.json       # Saved queue state
│   └── video-index.json       # Cached video index
├── temp/                      # Processed video cache
├── src/
│   ├── server/                # Main process (Node.js)
│   │   ├── server.js          # Main server orchestrator
│   │   ├── config/            # Configuration management
│   │   ├── video/             # Video indexing and preprocessing
│   │   ├── queue/             # Queue and history management
│   │   │   ├── preprocessedQueue.js
│   │   │   ├── queuePersistence.js
│   │   │   ├── reprocessHandler.js
│   │   │   └── historyManager.js    # Dual-layer history
│   │   ├── window/            # Window management
│   │   └── ipc/               # IPC handlers
│   └── client/                # Renderer process (Browser)
│       ├── index.html         # UI structure
│       ├── client.js          # Client orchestrator
│       ├── player/            # Video playback
│       │   ├── videoPlayer.js # Main player logic
│       │   ├── crossfade.js   # Crossfade transitions
│       │   └── blur.js        # Blur effects
│       ├── queue/             # Playback queue
│       ├── ui/                # User interface
│       └── utils/             # Utilities
```

## Architecture

The application uses a two-process architecture:

### Main Process (Server)
- Scans directories for video files
- Preprocesses videos (FFmpeg audio normalization)
- Maintains a preprocessed queue
- Manages dual-layer history system
- Handles file system operations

### Renderer Process (Client)
- Manages video playback
- Tests video playability in browser
- Maintains playback queue
- Handles user interface and controls

### Queue System

Two queues work together:

1. **Preprocessed Queue** (Main Process)
   - Target size: 20 videos (configurable)
   - Performs audio normalization
   - Runs in background
   - Includes methods: `size()`, `getQueue()`, `setQueue()` for proper state management

2. **Playback Queue** (Renderer Process)
   - Target size: 50 videos (configurable)
   - Tests browser playability
   - Feeds the video player

### History System

The application uses a robust dual-layer history system:

1. **Playback History** (In-memory)
   - Default size: 10 videos
   - Stores recently played videos for quick access
   - Used for immediate "previous video" navigation
   - Prevents temporary file cleanup of recent videos

2. **Persisted History** (File-based)
   - Default size: 5000 videos
   - Stored in `cache/persisted-history.json`
   - Long-term playback tracking
   - Fallback when playback history is empty

When navigating to previous videos:
- If playback history has entries: uses playback history, removes from persisted history
- If playback history is empty: uses persisted history
- Current video is returned to playback queue

### Cache Management

The application maintains a `cache/` directory for state persistence:
- **Video Index** (`video-index.json`): Cached list of all video files
- **Queue State** (`queue-state.json`): Saved queue state for session recovery
- **Persisted History** (`persisted-history.json`): Long-term playback history

This separation keeps user configuration (`config.json`) separate from application-generated cache files.

### IPC Handler Management

The application uses a two-stage IPC handler registration:

1. **Basic Handlers** (Early Registration)
   - `get-config` - Essential for client startup
   - `get-initialization-status` - Progress tracking
   - `get-queue-status` - Basic queue information

2. **Full Handlers** (After Component Initialization)
   - Video operations, history management, detailed stats
   - Registered after all components are ready

## Configuration

Edit `config.json` to customize:

```json
{
  "directories": ["path/to/videos"],
  "video": {
    "preprocessedQueueSize": 20,      // Preprocessed queue target
    "playbackQueueSize": 50,          // Playback queue target
    "playbackHistorySize": 10,        // Recent history size
    "persistedHistorySize": 5000,     // Long-term history size
    "historySize": 50                 // Legacy, kept for compatibility
  },
  "crossfade": {
    "enabled": true,                  // Enable/disable crossfade
    "duration": 500                   // Crossfade duration (ms)
  },
  "blur": {
    "enabled": true,                  // Enable/disable blur
    "maxAmount": 8                    // Max blur amount (px)
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
- `ESC` - Quit

## Features

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
- Comprehensive error logging for debugging

### Robust Initialization
- Early IPC handler registration prevents timing issues
- Graceful degradation if components fail to initialize
- Detailed progress reporting during startup
- Background recovery attempts for failed initializations

## Technical Details

### Supported Formats
Primary: MP4, AVI, MOV, WMV, FLV, WebM, MKV
Additional: M4V, 3GP, MPEG, MPG, TS, MTS, M2TS

### Dependencies
- Electron - Application framework
- FFmpeg - Video processing (bundled)
- fluent-ffmpeg - FFmpeg wrapper
- glob - File pattern matching

### File Locations
- `config.json` - User configuration
- `cache/queue-state.json` - Saved queue state
- `cache/persisted-history.json` - Long-term history
- `cache/video-index.json` - Cached video list
- `temp/` - Processed video cache

## Development

### Building
```bash
npm run build
```

### Debug Mode
```bash
npm run dev
```

## Troubleshooting

### Loading Screen Stuck
- Check console for IPC handler registration errors
- Verify config.json syntax is valid
- Ensure video directories exist and contain supported files
- Check temp directory permissions

### Queue Issues
- Monitor logs for preprocessing errors
- Verify FFmpeg binaries are properly bundled
- Check available disk space for temp files

## Notes

- First video starts immediately without effects
- Crossfade requires sufficient video duration
- Blur effects integrate with crossfade when both enabled
- Queue sizes represent minimum targets, not hard limits
- History system automatically manages temp file cleanup
- Playback history protects recently played videos from cleanup
- Cache directory is automatically created and managed by the application
- Basic IPC handlers register early to prevent client startup issues