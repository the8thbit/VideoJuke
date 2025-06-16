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
- **Seasonal Directories**: Time-based conditional video selection with configurable probability
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

# Open browser to http://localhost:3123
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
         "port": 3123,
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
      "port": 3123,
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

## Audio Processing & 5.1 Surround Sound

VideoJuke includes sophisticated audio processing capabilities with full 5.1 surround sound support, automatically converting stereo content and preserving multichannel audio.

### Audio Features

**5.1 Surround Output**: All videos are processed to 5.1 surround sound with intelligent channel mapping
**Stereo Upmixing**: Stereo content is intelligently converted to 5.1 with configurable rear channel levels
**Multichannel Preservation**: True 5.1/7.1 content maintains original channel layout and quality
**Smart Normalization**: Audio levels are normalized while preserving multichannel dynamics
**Configurable Processing**: Extensive configuration options for fine-tuning audio behavior

### Stereo to 5.1 Conversion

For 2-channel (stereo) content, VideoJuke creates a full 5.1 mix:

- **Front Channels**: Original left/right channels preserved
- **Center Channel**: Balanced mix of left/right at configurable level (default 50%)
- **Rear Channels**: Front channels duplicated at reduced level (default 20%)
- **LFE (Subwoofer)**: Mixed content from front channels (default 30%, bass frequencies naturally present)

### Audio Configuration

```json
{
  "audio": {
    "enabled51Processing": true,
    "forceOutputChannels": 6,
    "outputChannelLayout": "5.1",
    "stereoUpmixing": {
      "enabled": true,
      "rearChannelLevel": 0.2,
      "centerChannelLevel": 0.5,
      "lfeChannelLevel": 0.3
    },
    "normalization": {
      "enabled": true,
      "strength": "medium",
      "targetLUFS": -16,
      "truePeak": -1.5,
      "LRA": 11,
      "dualMono": true,
      "presets": {
        "light": {
          "targetLUFS": -12,
          "truePeak": -1.0,
          "LRA": 15
        },
        "medium": {
          "targetLUFS": -16,
          "truePeak": -1.5,
          "LRA": 11
        },
        "strong": {
          "targetLUFS": -20,
          "truePeak": -2.0,
          "LRA": 8
        },
        "broadcast": {
          "targetLUFS": -23,
          "truePeak": -1.0,
          "LRA": 7
        }
      }
    },
    "codecPreferences": {
      "multichannel": "ac3",
      "stereo": "aac",
      "multichannelBitrate": 640000,
      "stereoBitrate": 256000
    },
    "compatibility": {
      "preserveOriginalIfMultichannel": true,
      "fallbackToStereo": false,
      "volumeAdjustmentFor51": 0.9
    }
  }
}
```

### Audio Processing Options

**Normalization Strength Presets**:
- `"light"`: Minimal normalization, preserves original dynamics (-12 LUFS)
- `"medium"`: Balanced normalization for streaming (-16 LUFS) **[Default]**
- `"strong"`: Aggressive normalization for consistent volume (-20 LUFS)
- `"broadcast"`: Professional broadcast standard (-23 LUFS, EBU R128)

**Manual Normalization Settings**:
- `targetLUFS`: Target loudness level (more negative = more aggressive)
- `truePeak`: Maximum peak level (prevents clipping and distortion)
- `LRA`: Loudness range for dynamic content (lower = more compressed)
- `dualMono`: Enhanced processing for dual-mono content
- `enabled`: Set to `false` to disable all normalization

**Stereo Upmixing Levels**:
- `rearChannelLevel`: Volume of duplicated rear channels (0.0-1.0)
- `centerChannelLevel`: Center channel mix level (0.0-1.0)
- `lfeChannelLevel`: Subwoofer channel level (0.0-1.0)

### Normalization Control

VideoJuke offers flexible audio normalization control through both simple presets and detailed manual configuration:

#### Quick Setup (Recommended)
Simply set the `strength` parameter to control normalization intensity:

```json
{
  "audio": {
    "normalization": {
      "enabled": true,
      "strength": "medium"
    }
  }
}
```

#### Advanced Manual Control
Override specific parameters for fine-tuned control:

```json
{
  "audio": {
    "normalization": {
      "enabled": true,
      "strength": "medium",
      "targetLUFS": -14,
      "truePeak": -1.0
    }
  }
}
```

**Manual settings override preset values**, allowing you to start with a preset and adjust specific parameters.

#### When to Use Each Preset

**Light Normalization** (`"light"`):
- Source material has consistent volume levels
- Preserving original audio dynamics is priority
- High-quality recordings that don't need much adjustment
- Classical music, audiophile content

**Medium Normalization** (`"medium"`) **[Default]**:
- Mixed content from various sources
- General streaming and playback use
- Balanced approach between consistency and dynamics
- Most home entertainment scenarios

**Strong Normalization** (`"strong"`):
- Content with widely varying volume levels
- Background listening scenarios
- Mixed media libraries with inconsistent mastering
- Noisy environments requiring consistent volume

**Broadcast Standard** (`"broadcast"`):
- Professional broadcast compliance
- Maximum consistency across all content
- Commercial/professional installations
- Hearing accessibility requirements

#### Disabling Normalization

Set `"enabled": false` to disable all normalization and preserve original audio levels:

```json
{
  "audio": {
    "normalization": {
      "enabled": false
    }
  }
}
```

This bypasses all loudness processing while maintaining 5.1 upmixing and other audio enhancements.

### Compatibility & Legacy Support

**5.1 Processing Toggle**: Set `enabled51Processing: false` to disable 5.1 processing entirely
**Preserve Original**: `preserveOriginalIfMultichannel: true` maintains original multichannel audio
**Fallback Options**: Automatic fallback to stereo if 5.1 processing fails
**Volume Adjustment**: Automatic volume reduction for 5.1 content to prevent clipping

### Platform-Specific Audio Support

**Electron (Desktop)**: Full 5.1 support with hardware audio device detection
**Web Browser**: 5.1 support depends on browser and audio system capabilities
**WebOS TV**: Enhanced support with Dolby Atmos detection and ARC compatibility

### Audio Processing Pipeline

1. **Source Analysis**: FFprobe extracts detailed audio metadata (channels, layout, codec)
2. **Channel Mapping**: Intelligent routing based on source channel configuration
3. **Normalization**: EBU R128 loudness normalization with multichannel awareness
4. **Upmixing/Processing**: Stereo-to-5.1 conversion or multichannel preservation
5. **Encoding**: High-quality AC-3 or AAC encoding with optimized bitrates
6. **Metadata**: Processing details logged for debugging and quality assurance

### Audio Quality Settings

**High Quality** (Default):
- AC-3 640kbps for 5.1 content
- AAC 256kbps for stereo content
- Full dynamic range preservation

**Balanced Quality**:
- Reduce bitrates by 25% for smaller files
- Maintain surround separation

**Compatibility Mode**:
- AAC for all content
- Reduced processing complexity
- Maximum device compatibility

### Troubleshooting Audio Issues

**No audio output**: Check system audio device supports multichannel
**Distorted audio**: Reduce volume levels in configuration
**Missing rear channels**: Verify audio system configuration and speaker setup
**Compatibility issues**: Try disabling 5.1 processing for problem files

### Advanced Audio Features

**Dynamic Range Compression**: Optional for late-night viewing
**Channel Mapping**: Custom channel assignments for unusual speaker setups
**Spatial Audio**: Enhanced positioning for immersive audio systems
**Real-time Processing**: Live audio adjustments during playback

The audio processing system is designed to provide the best possible surround sound experience while maintaining compatibility across different playback environments.

## Supported Video Formats

**Primary**: MP4, AVI, MOV, WMV, FLV, WebM, MKV  
**Additional**: M4V, 3GP, MPEG, MPG, TS, MTS, M2TS

All videos are preprocessed with:
- **5.1 Surround Sound Processing**: Intelligent upmixing and multichannel preservation
- **Audio Normalization**: EBU R128 loudness normalization with multichannel support
- **Video Optimization**: MP4 container with fast-start encoding for web streaming
- **Metadata Enhancement**: Detailed audio and video analysis for optimal processing

### Audio Format Support

**Input Formats**: Any format supported by FFmpeg (AAC, MP3, AC-3, DTS, FLAC, PCM, etc.)
**Output Formats**: 
- AC-3 5.1 (640kbps) for multichannel content
- AAC stereo (256kbps) for fallback compatibility
**Channel Layouts**: Mono, Stereo, 2.1, 4.0, 5.0, 5.1, 7.1 (all converted to 5.1 output)

## Seasonal Directories

VideoJuke supports "seasonal directories" that are conditionally active based on time/date conditions with configurable probability. This powerful feature allows you to create special video collections that only appear during specific times, dates, or conditions.

### Overview

Seasonal directories work by:
1. **Time Evaluation**: Before each video selection, VideoJuke evaluates all seasonal directory conditions against the current time
2. **Probability Testing**: For each directory whose conditions match, a random probability roll is performed against the configured `likelihood`
3. **Selection**: If the probability check passes, a random video is selected from that seasonal directory instead of the regular directories
4. **Fallback**: If no seasonal directories are active or selected, normal random selection from regular directories occurs

### Basic Configuration

Add seasonal directories to your `config.json`:

```json
{
  "seasonalDirectories": [
    {
      "directory": "./seasonal/tuesday_morning",
      "likelihood": 0.001,
      "conditions": {
        "dayOfWeek": [2],
        "hourRange": [6, 12]
      }
    }
  ]
}
```

Each seasonal directory object requires:
- **directory**: Path to the video directory (relative or absolute)
- **likelihood**: Probability value from 0.0 to 1.0 (0.001 = 0.1%, 0.05 = 5%, etc.)
- **conditions**: Object containing one or more time/date conditions (ALL must match)

### Time and Date Conditions Reference

#### Day of Week (`dayOfWeek`)

Matches specific days of the week using numeric values:
- `0` = Sunday, `1` = Monday, `2` = Tuesday, `3` = Wednesday, `4` = Thursday, `5` = Friday, `6` = Saturday

```json
{
  "dayOfWeek": [1, 2, 3, 4, 5],  // Monday through Friday (weekdays)
  "dayOfWeek": [0, 6],           // Saturday and Sunday (weekends)
  "dayOfWeek": [5],              // Friday only
  "dayOfWeek": 2                 // Tuesday only (single value)
}
```

#### Hour Conditions

**Specific Hours (`hour`)**
```json
{
  "hour": [9, 12, 15],          // 9AM, 12PM, and 3PM exactly
  "hour": 23,                   // 11PM only
  "hour": [0, 1, 2, 3, 4, 5]    // Midnight through 5AM
}
```

**Hour Ranges (`hourRange`)**
```json
{
  "hourRange": [9, 17],         // 9AM to 5PM (5PM not included)
  "hourRange": [22, 6],         // 10PM to 6AM (overnight range)
  "hourRange": [0, 24],         // All day (equivalent to no hour restriction)
  "hourRange": [12, 13]         // Noon hour only
}
```

**Important**: Hour ranges use 24-hour format and the end hour is exclusive. Overnight ranges (where start > end) automatically wrap around midnight.

#### Minute Conditions

**Specific Minutes (`minute`)**
```json
{
  "minute": [0, 15, 30, 45],    // Quarter hours
  "minute": [33],               // 33 minutes past any hour
  "minute": 0                   // Top of every hour
}
```

**Minute Parity (`minuteParity`)**
```json
{
  "minuteParity": "even",       // All even minutes (0, 2, 4, 6, ...)
  "minuteParity": "odd"         // All odd minutes (1, 3, 5, 7, ...)
}
```

#### Day of Month (`dayOfMonth`)

Matches specific days within any month:
```json
{
  "dayOfMonth": [1],            // First day of every month
  "dayOfMonth": [13],           // 13th of every month
  "dayOfMonth": [1, 15],        // 1st and 15th of every month
  "dayOfMonth": [28, 29, 30, 31] // End of month days
}
```

**Note**: February and 30-day months will never match day 31, and February will only match days 29+ in leap years.

#### Month (`month`)

Matches specific months using numeric values (1-12):
```json
{
  "month": [12],                // December only
  "month": [6, 7, 8],          // Summer months (June, July, August)
  "month": [12, 1, 2],         // Winter months
  "month": 10                  // October only
}
```

#### Year (`year`)

Matches specific years:
```json
{
  "year": [2024],              // Only during 2024
  "year": [2024, 2025, 2026],  // Multiple specific years
  "year": 2027                 // Single year
}
```

#### Date Ranges (`dateRange`)

Matches a specific date range using ISO date strings:
```json
{
  "dateRange": ["2024-12-20", "2024-12-31"],  // Holiday season 2024
  "dateRange": ["2024-07-01", "2024-07-07"],  // First week of July 2024
  "dateRange": ["2024-01-01", "2024-01-01"]   // New Year's Day 2024 only
}
```

**Important**: Both start and end dates are inclusive. Times default to midnight (00:00:00).

### Complex Examples

#### Friday the 13th
```json
{
  "directory": "./seasonal/friday_13th",
  "likelihood": 0.02,
  "conditions": {
    "dayOfWeek": [5],
    "dayOfMonth": [13]
  }
}
```

#### Business Hours Weekdays
```json
{
  "directory": "./seasonal/office_hours",
  "likelihood": 0.1,
  "conditions": {
    "dayOfWeek": [1, 2, 3, 4, 5],
    "hourRange": [9, 17]
  }
}
```

#### Late Night Weekends
```json
{
  "directory": "./seasonal/weekend_late",
  "likelihood": 0.05,
  "conditions": {
    "dayOfWeek": [5, 6],
    "hourRange": [23, 3]
  }
}
```

#### Every Third Day at 33 Minutes Past the Hour
```json
{
  "directory": "./seasonal/third_day_33min",
  "likelihood": 0.001,
  "conditions": {
    "dayOfMonth": [3, 6, 9, 12, 15, 18, 21, 24, 27, 30],
    "minute": [33]
  }
}
```

#### Holiday Season with High Likelihood
```json
{
  "directory": "./seasonal/holidays",
  "likelihood": 0.3,
  "conditions": {
    "month": [12],
    "dayOfMonth": [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]
  }
}
```

#### Even Minutes During Odd Hours
```json
{
  "directory": "./seasonal/even_odd",
  "likelihood": 0.01,
  "conditions": {
    "hour": [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23],
    "minuteParity": "even"
  }
}
```

#### Summer 2024 Only
```json
{
  "directory": "./seasonal/summer_2024",
  "likelihood": 0.05,
  "conditions": {
    "year": [2024],
    "month": [6, 7, 8]
  }
}
```

#### Specific Date Range with Time
```json
{
  "directory": "./seasonal/conference_week",
  "likelihood": 0.2,
  "conditions": {
    "dateRange": ["2024-10-14", "2024-10-18"],
    "hourRange": [8, 18]
  }
}
```

### Advanced Configuration Patterns

#### Multiple Seasonal Directories
```json
{
  "seasonalDirectories": [
    {
      "directory": "./seasonal/morning_motivation",
      "likelihood": 0.02,
      "conditions": {
        "dayOfWeek": [1, 2, 3, 4, 5],
        "hourRange": [6, 9]
      }
    },
    {
      "directory": "./seasonal/friday_party",
      "likelihood": 0.05,
      "conditions": {
        "dayOfWeek": [5],
        "hourRange": [17, 23]
      }
    },
    {
      "directory": "./seasonal/weekend_chill",
      "likelihood": 0.03,
      "conditions": {
        "dayOfWeek": [0, 6]
      }
    }
  ]
}
```

#### Overlapping Conditions
When multiple seasonal directories match the current time, VideoJuke evaluates them in the order they appear in the configuration. The first directory to pass its probability check wins.

#### High vs Low Likelihood Examples
```json
{
  "likelihood": 0.001,  // 0.1% - Very rare, special occasions
  "likelihood": 0.01,   // 1% - Uncommon but noticeable  
  "likelihood": 0.05,   // 5% - Regular seasonal content
  "likelihood": 0.1,    // 10% - Frequent themed content
  "likelihood": 0.5,    // 50% - Dominant during active period
  "likelihood": 1.0     // 100% - Always active when conditions match
}
```

### Time Zone Behavior

All time evaluations use the server's local time zone. The system does not currently support multiple time zones or UTC-based conditions.

### Edge Cases and Special Behaviors

#### Leap Years
- February 29th will only match `dayOfMonth: [29]` during leap years
- Other February dates work normally

#### Month Boundaries
- Day 31 conditions never match in months with fewer than 31 days
- Day 30 conditions never match in February

#### Overnight Hour Ranges
- `"hourRange": [22, 6]` correctly handles midnight crossing
- Evaluation occurs at video selection time, so a 6-hour video starting at 11PM may cross into different conditions

#### Daylight Saving Time
- Hour-based conditions follow local system time including DST transitions
- During "spring forward" (lost hour), conditions may not match the skipped hour
- During "fall back" (repeated hour), conditions match during both instances of the repeated hour

#### System Clock Changes
- Conditions are evaluated in real-time based on the current system clock
- Manual clock adjustments immediately affect seasonal directory activation

### Debugging and Monitoring

VideoJuke provides extensive logging for seasonal directory behavior:

```
[2024-01-15T14:33:00.000Z] [MAIN] Checking seasonal conditions at 2024-01-15T14:33:00.000Z (day=1, hour=14, minute=33)
[2024-01-15T14:33:00.000Z] [MAIN] Seasonal directory active: ./seasonal/monday_afternoon (likelihood: 0.05)
[2024-01-15T14:33:00.000Z] [MAIN] Probability check passed: 0.023 < 0.05, selecting from ./seasonal/monday_afternoon
[2024-01-15T14:33:00.000Z] [MAIN] Selected seasonal video: motivational_monday.mp4 from ./seasonal/monday_afternoon
```

### Best Practices

#### Directory Organization
```
videos/
├── regular/           # Main video collection
├── seasonal/
│   ├── holidays/      # Holiday-themed content
│   ├── workday/       # Business hours content
│   ├── weekend/       # Weekend-specific content
│   ├── morning/       # Morning motivation
│   └── special_dates/ # Specific date content
```

#### Likelihood Guidelines
- **0.001-0.01**: Very special, rare content (holidays, special dates)
- **0.01-0.05**: Regular seasonal theming (work hours, weekends)
- **0.05-0.2**: Strong seasonal presence without overwhelming
- **0.2-1.0**: Dominant content during active periods (use sparingly)

#### Performance Considerations
- Keep seasonal directories reasonably sized (hundreds, not thousands of videos)
- Very complex condition combinations are evaluated quickly but log heavily
- Consider the frequency of condition checking when setting very specific minute/hour combinations

#### Testing Your Configuration
1. Use debug mode (`Q` key) to see current time evaluation
2. Check logs for seasonal directory activation messages
3. Temporarily increase likelihood values for testing
4. Use date ranges to test specific scenarios

### Troubleshooting

#### Common Issues

**Seasonal directory never activates**
- Verify directory path exists and contains video files
- Check that all conditions in the `conditions` object must match simultaneously
- Confirm time zone alignment (server local time vs expected time)

**Videos not appearing despite active conditions**
- Check likelihood value - very low values may take many attempts
- Verify video files in seasonal directory are in supported formats
- Ensure no file permission issues

**Unexpected activation times**
- Remember hour ranges are exclusive of end hour (`[9, 17]` means 9:00-16:59)
- Check for overnight ranges - `[22, 6]` includes late night hours
- Verify day of week numbering (0=Sunday, 6=Saturday)

**Performance issues**
- Reduce complexity of condition objects
- Consider consolidating very similar seasonal directories
- Monitor log output for excessive evaluation messages

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

# WebOS Build System

## Overview

The VideoJuke WebOS build system converts modern ES6 JavaScript modules into WebOS-compatible global scripts. This system has been enhanced to handle complex module dependencies and ensure compatibility with WebOS TV platforms.

## Recent Improvements

### Fixed Critical Issues

1. **Module Import Error**: Fixed missing `vm` module import that was causing "vm is not defined" errors during validation
2. **ES6 Compatibility**: Added comprehensive ES6 to ES5 conversion for better WebOS compatibility:
   - Template literals → String concatenation
   - Arrow functions → Regular functions
   - `const`/`let` → `var` declarations
3. **Export Statement Removal**: Enhanced regex patterns to properly remove all ES6 export statements
4. **Cross-dependency Resolution**: Improved handling of module dependencies between converted files
5. **Enhanced Error Handling**: Added comprehensive error handling with detailed logging throughout the conversion process

### Build Process Improvements

1. **Structured Logging**: Implemented proper indentation and clear status messages for better debugging
2. **Validation Enhancement**: Added thorough JavaScript syntax validation with compatibility warnings
3. **HTML Script Loading**: Fixed WebOS HTML file to ensure proper script loading order
4. **Robust File Operations**: Added better file existence checks and directory creation
5. **ES5 Conversion**: Added automatic conversion of modern JavaScript features to ES5 for maximum compatibility

## Build Commands

```bash
# Build WebOS app
npm run package:webos

# Platform-specific builds
scripts/package-webos.bat    # Windows
scripts/package-webos.sh     # Linux/macOS
```

## Build Process

1. **File Preparation**: Copies WebOS app files and assets
2. **Module Conversion**: Converts ES6 modules to global window objects
3. **ES6 to ES5 Translation**: Converts modern JavaScript to ES5 for compatibility
4. **Dependency Resolution**: Fixes cross-references between modules
5. **Validation**: Performs syntax and compatibility validation
6. **HTML Generation**: Updates HTML with proper script loading order
7. **Packaging**: Creates IPK package using `ares-package`

## Module Conversion Process

### Input (ES6 Module)
```javascript
import Logger from '../utils/logger.js';
export default class VideoPlayer {
    constructor() {
        this.logger = new Logger();
    }
}
```

### Output (WebOS Compatible)
```javascript
(function() {
    'use strict';
    
    var VideoPlayer = function VideoPlayer() {
        this.logger = new window.Logger();
    };
    
    try {
        if (typeof VideoPlayer !== 'undefined') {
            window.VideoPlayer = VideoPlayer;
            console.log('✅ Loaded VideoPlayer module');
        } else {
            console.error('❌ Failed to export VideoPlayer');
        }
    } catch (error) {
        console.error('❌ Error exporting VideoPlayer:', error);
    }
})();
```

## File Structure

```
build/webos/package/
├── client.js                    # Main application entry point
├── shared/
│   ├── utils/
│   │   ├── logger.js           # Logging utility
│   │   └── formatter.js        # Data formatting functions
│   ├── ui/
│   │   ├── loadingScreen.js    # Loading screen component
│   │   └── overlays.js         # Video overlay components
│   ├── player/
│   │   ├── blur.js            # Blur effect handler
│   │   ├── crossfade.js       # Crossfade transition handler
│   │   └── videoPlayer.js     # Main video player
│   └── queue/
│       └── playbackQueue.js   # Playback queue management
├── web/
│   └── serverAPI.js           # Server communication API
├── storage.js                 # WebOS storage wrapper
├── remoteControl.js          # WebOS remote control handler
└── webOSTVjs-1.2.12/        # WebOS TV SDK library
```

## Troubleshooting

### Common Issues

1. **Syntax Errors**: The build process now includes comprehensive validation and will report specific syntax issues
2. **Module Dependencies**: Cross-dependencies are automatically resolved during the build process
3. **ES6 Compatibility**: Modern JavaScript features are automatically converted to ES5
4. **Missing Files**: The build process will report missing source files with clear error messages

### Debugging

- Build logs include detailed conversion information with file sizes and transformation details
- Validation errors are reported with specific line numbers and issue descriptions
- The build process creates debug information in `build/webos/package/debug/` when errors occur

## Requirements

- Node.js 14+ for the build process
- WebOS SDK for packaging (`ares-package` command)
- Source files must be present in the expected directory structure

## WebOS SDK Installation

1. Download the WebOS SDK from: https://webostv.developer.lge.com/sdk/installation/
2. Install the SDK following the official documentation
3. Ensure `ares-package` is available in your PATH

## Installation Commands

```bash
# Install on WebOS TV
ares-setup-device           # Configure TV connection
ares-install package.ipk    # Install the generated package
ares-launch com.videojuke.player  # Launch the application
```

## Architecture Notes

The WebOS build system maintains a clear separation between:
- **Shared modules**: Platform-independent business logic
- **WebOS-specific modules**: Platform-specific implementations (storage, remote control)
- **Client code**: Main application entry point that orchestrates all modules

This architecture ensures that the core application logic remains platform-agnostic while providing WebOS-specific implementations where needed.

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