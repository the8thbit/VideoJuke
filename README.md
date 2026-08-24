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
- **Access Control**: A shared token, generated on first run, guards the web server
- **Multi-Screen Sync**: One screen leads and the rest mirror it
- **Archiving**: Flag videos while watching, then move them out of the library in one command

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

### Start Menu Shortcut (Windows)

```bash
npm run setup
```

Run that once. It installs dependencies if they are missing, builds, and puts
**VideoJuke** in your Start Menu.

The shortcut does not just start the app — it runs `scripts/launch.mjs`, which
first checks whether anything under `src/`, `package.json`, the tsconfigs or
`config.default.json` has changed since the last build. If nothing has, it starts
straight away; if something has, it rebuilds first and then starts. So the
shortcut never runs yesterday's code after an edit, and never spends a minute
building when it does not need to.

The console window it opens closes itself once the app is up, because the app is
started detached. If the build fails the window stays open with the error on it.

```bash
npm run setup -- --mode=web    # a shortcut that starts the web server instead
npm run setup:remove           # take the shortcut away again
npm run launch                 # the same build-if-stale-then-start, from a terminal
```

On anything other than Windows `npm run setup` explains itself and does nothing:
a Start Menu is a Windows idea. Point your desktop environment's launcher at
`node scripts/launch.mjs` instead.

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
         "host": "localhost",
         "allowedOrigins": ["null"],
         "authToken": ""
       }
     }
   }
   ```

   Set `host` to `0.0.0.0` to reach the player from other devices on your
   network. `allowedOrigins` lists the cross-origin pages allowed to call the
   API; the browser client is served by this server, so it is same-origin and
   never needs an entry. The default `"null"` is what the webOS app sends,
   because a TV app runs from `file://`. Add an origin only if you have written
   your own client for it.

4. **Restart**: Restart VideoJuke to scan your video directories

## Project Structure

```
videojuke/
├── src/
│   ├── shared/                 # Platform-neutral types and pure logic
│   │   ├── types/              # Domain types, Result, the client/server protocol
│   │   ├── config/             # Defaults, normalisation, cache fingerprint
│   │   ├── video/              # Audio filters, codec choice, crossfade timing
│   │   ├── queue/              # History transitions, random selection
│   │   ├── time/               # Clock and time-condition evaluation
│   │   ├── state/              # The one sanctioned mutable-state primitive
│   │   ├── logging/            # Logger and sinks
│   │   └── util/               # Numbers, arrays, objects, decoding, formatting
│   ├── server/                 # Node-only
│   │   ├── infra/              # Filesystem, ffmpeg, paths, clock, browser launch
│   │   ├── domain/             # Index, preprocessing, queue, history, persistence
│   │   ├── api/                # PlayerService, shared by both transports
│   │   ├── electron/           # Main process, window, IPC
│   │   └── web/                # HTTP server, routes, streaming, WebSocket
│   └── client/                 # Browser-only
│       ├── core/               # The whole player, shared by all three clients
│       │   ├── dom/            # Element lookup, the single animation loop
│       │   ├── player/         # Stage, video player, crossfade, blur
│       │   ├── queue/          # Client-side playback queue
│       │   ├── ui/             # Loading screen, overlays, debug panel
│       │   ├── input/          # Commands, keyboard, TV remote
│       │   ├── transport/      # PlayerApi over IPC and over HTTP
│       │   └── app/            # The orchestrator every entry point uses
│       ├── electron/           # Renderer entry, preload, page
│       ├── web/                # Browser entry and page
│       └── webos/              # TV entry, storage, setup form, polyfills
├── tests/                      # node:test suites for the pure core
├── scripts/                    # Build, test, clean, webOS packaging
├── docs/ARCHITECTURE.md        # How the pieces fit together, and why
├── config.default.json         # Complete default configuration
├── config.json                 # Your overrides (created on first run)
├── cache/                      # Video index, queue state, playback history
├── temp/                       # Transcoded videos
├── archive/                    # Videos moved out by `npm run archive`
└── flagged_for_archive.json    # What `A` flagged, waiting to be moved
```

## Architecture

VideoJuke is one application with two servers and three clients.

A **server** owns the filesystem: it indexes the configured directories,
transcodes videos with ffmpeg into `temp/`, keeps a queue of ready videos and
remembers what has been played. It runs either inside Electron's main process
or as a standalone HTTP server.

A **client** owns the screen: it keeps a small playback queue, drives two
`<video>` elements, crossfades between them and handles input. It runs as an
Electron renderer, a browser page, or a webOS TV app.

The two meet at exactly one interface, `PlayerApi`
(`src/shared/types/protocol.ts`). Electron implements it over IPC and browsers
over HTTP plus a WebSocket. The player itself never learns which transport it
is using, which is why all three clients share the same code.

Decisions are pure functions and effects are thin shells around them: config
merging, time conditions, ffmpeg filter selection, crossfade timing, random
selection and history transitions all live in `src/shared` and are unit-tested
without a filesystem, ffmpeg or a browser. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the layering rules.

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
  },
  "system": {
    "tempDirectory": "./temp",
    "cacheDirectory": "./cache",
    "archiveDirectory": "./archive"
  }
}
```

`archiveDirectory` is where `npm run archive` moves flagged videos; see
[Archiving Videos](#archiving-videos). It is never scanned, so it is safe to put
inside a library.

### Network Configuration (Web Mode)

```json
{
  "network": {
    "server": {
      "enabled": true,
      "port": 3123,
      "host": "0.0.0.0",
      "autoOpenBrowser": true,
      "allowedOrigins": ["null"]
    }
  },
  "timeouts": {
    "connectionTimeout": 5000,
    "transcodeTimeout": 1800000,
    "probeTimeout": 60000
  },
  "retries": {
    "maxInitializationAttempts": 3,
    "maxQueueBuildAttempts": 3
  }
}
```

- `connectionTimeout`: how long a client waits for one request.
- `transcodeTimeout`: how long a single ffmpeg run may take before it is killed.
  Without a limit, one file that stops making progress holds the preprocessing
  lock for the life of the process and the queue is never topped up again.
- `probeTimeout`: the same, for the much quicker `ffprobe` pass.
- `enabled`: set to `false` and the web server refuses to start.

### Transcoding Performance

Transcoding is the only CPU-hungry thing VideoJuke does, and it happens in the
background while you are watching. These settings decide how much of the machine
it is allowed to take.

```json
{
  "performance": {
    "mode": "balanced",
    "cpuLimiting": {
      "enabled": true,
      "maxThreads": 2,
      "processingDelay": 1000,
      "threadQueueSize": 512,
      "priority": "normal"
    }
  }
}
```

- `mode`: `"quiet"`, `"balanced"` or `"performance"`, selecting one of the
  presets under `performance.presets`.
- `cpuLimiting.enabled`: when `true`, this block replaces the selected preset
  outright rather than merging into it.
- `maxThreads`: 1 to 8, passed to ffmpeg as `-threads`. At `1`, encoder quality
  is also traded down for less CPU.
- `processingDelay`: milliseconds to pause *before* each transcode, so a queue
  fill spaces its work out instead of running it back to back.
- `priority`: `"low"`, `"normal"` or `"high"`. The ffmpeg process is renice'd to
  match, on Windows as well as Linux and macOS. `"high"` means above normal, not
  the highest class the OS offers — an encoder that outranks the window manager
  makes the whole machine unresponsive. On Linux, raising priority needs
  privileges, so `"high"` there logs a warning and carries on at normal.

Only one transcode ever runs at a time, so `maxThreads` is the real ceiling on
how many cores are in use.

## Access Control

The web server will not start without an access token. On first run it generates
one, saves it to `config.json` under `network.server.authToken`, and prints it to
the console **once**:

```
  VideoJuke generated an access token and saved it to .../config.json

      3f9a1c07b25e4d8891af6cb3027de145
```

That is the only time it is printed — it is deliberately kept out of the log,
because every log line is broadcast to every connected screen.

- **A browser on the same machine** needs nothing: the server opens it with the
  token in the URL, and the page moves it into local storage and strips it from
  the address bar.
- **A browser elsewhere** should be opened once as `?token=<token>`. The token is
  remembered per address, so a player opened at a different hostname or port has
  to be given it again.
- **A TV** has an access-token field on its setup screen.
- **The desktop app** needs nothing at all. It talks to its own process and has
  no network surface to protect.

The API and the WebSocket both require the token. Video streams cannot — a
`<video>` element cannot send a header — so the server signs each stream URL it
hands out with a short-lived key derived from the token. The secret itself never
appears in a URL, and a signed URL only ever works for the one file it names.

Changing `authToken` in `config.json` takes effect on the next start, not
immediately. Use letters and digits: a token containing a space or a comma
cannot travel as a WebSocket subprotocol, and browser clients will silently fall
back to polling (the server warns about this at startup).

## Multi-Screen Sync

Two or more screens can show the same thing. One leads and the rest follow:

```bash
# the screen that decides what plays
npm run electron -- --role=leader

# a second screen that mirrors it
npm run electron -- --role=follower
```

In a browser, open the player once as `?role=follower` (remembered per address,
like the token). On a TV, set the screen role on the setup screen. Leave it blank
— the default — for a screen that plays on its own, which is what a single screen
should be.

A follower keeps no queue of its own: it plays what the leader plays, matches its
pauses, and converges on its position by bending its playback rate by up to 5%,
jumping only if it is more than a second out. Realistically it lands within a
frame or two over a LAN — enough that two screens in adjoining rooms feel
together. Frame-exact sync is not something a browser can promise.

The leader reports where it is once a second and immediately whenever the video
changes. Followers poll for that at the same rate, and the round trip doubles as
a clock measurement, so screens whose clocks disagree — a TV that has never
reached a time server can be hours out — still converge. Where a WebSocket is
available the update also arrives as a push, which just saves a second of
latency; the TV client has no WebSocket at all and works purely on the poll.

## Archiving Videos

Press `A` while a video is playing to flag it for archiving; press it again to
change your mind. An on-screen indicator confirms either way. Nothing is moved
while the player is running - flagging only records the decision, in
`flagged_for_archive.json` beside `config.json`:

```json
{
  "savedAt": "2026-08-23T06:03:14.628Z",
  "flagged": [
    {
      "originalPath": "X:/videos/holiday/blooper.mp4",
      "filename": "blooper.mp4",
      "flaggedAt": "2026-08-23T06:02:58.114Z"
    }
  ]
}
```

The file is plain JSON and meant to be read - look it over before you commit to
anything. Then, with the player stopped:

```bash
npm run archive
```

Every flagged video is moved into `system.archiveDirectory` (`./archive` by
default) and the list is cleared.

- A name that already exists in the archive is **never overwritten**; the
  incoming file becomes `blooper (2).mp4`.
- A video that cannot be moved - locked, or on a drive that has gone away -
  stays exactly where it is and stays on the list, so the next run retries it.
  Every other video still moves.
- A video that has already been moved or deleted by hand is dropped from the
  list without complaint.
- The archive directory is never scanned, even if you put it inside a library,
  so an archived video does not come back.
- The video index cache is cleared afterwards, so the next start re-scans.

Run it with the player stopped. Moving a file out from under a running player
that may be about to transcode it is not a surprise worth arranging.

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

### Library
- `A` - Flag the current video for archiving, or clear the flag

### Information & Debug
- `I` - Show video information overlay
- `T` - Show video title only
- `Q` - Toggle debug information
- `?` or `/` - Show keyboard controls help

### Application
- `ESC` - Quit application (Electron) / Close tab (Web)

## API Reference (Web Mode)

### REST Endpoints

- `GET /api/config` - Configuration the client needs
- `GET /api/status` - Initialization state, queue gauge and video count
- `GET /api/detailed-stats` - Full diagnostics behind the debug overlay
- `GET /api/next-video` - Take the next prepared video (204 when there is none)
- `GET /api/previous-video` - Take the last played video back out of history
- `POST /api/ensure-playable` - Re-transcode a video whose temp file is gone
- `POST /api/video-ended` - Report completion, which records it in history
- `POST /api/video-error` - Report a playback failure
- `POST /api/manual-skip` - Report a skip
- `POST /api/return-to-previous` - Report a step backwards
- `POST /api/playback-queue` - Mirror the client queue so a restart can resume it
- `GET /videos?filename=<encoded>` - Stream a transcoded video, with range support
- `GET /health` - Liveness check

Every payload is validated on arrival; a body that does not decode is answered
with `400` rather than being trusted, and the streaming route refuses any
filename that would escape the temp directory.

### WebSocket Events

One message type, a `ServerEvent` discriminated union:

- `{ "type": "initialization", "state": { ... } }` - Startup progress
- `{ "type": "log", "entry": { ... } }` - Server log entries

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

**Manual Normalization Settings**: absent by default, so `strength` is what
decides the loudness. Write one of these only to override the preset. Each is
clamped to the range ffmpeg's `loudnorm` filter accepts; a value outside it is
reported at startup and clamped rather than failing every transcode.
- `targetLUFS`: Target loudness level, -70 to -5 (more negative = more aggressive)
- `truePeak`: Maximum peak level, -9 to 0 (prevents clipping and distortion)
- `LRA`: Loudness range for dynamic content, 1 to 50 (lower = more compressed)
- `dualMono`: Enhanced processing for dual-mono content
- `enabled`: Set to `false` to disable all normalization

**Output Channels** (`forceOutputChannels`): how many channels the transcode is
written with, 1 to 8. The default of `6` is what the 5.1 upmix exists for: a
stereo source is panned up to 5.1 and every speaker gets signal.

Set it to `1` or `2` and the upmix is skipped entirely, because there is nothing
to upmix to — a genuinely multichannel source is downmixed once, by ffmpeg, from
its real layout. Previously the pan ran anyway and the result was folded straight
back down to two, which put audible crosstalk into hard-panned mixes and left
them several dB under the loudness target.

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

### Runtime
- **express** - HTTP server for web mode
- **ws** - WebSocket transport for server-pushed events
- **cors** - Cross-origin access for remote clients
- **fluent-ffmpeg**, **ffmpeg-static**, **ffprobe-static** - Transcoding and probing

### Build and development
- **typescript** - The whole codebase, type-checked in strict mode
- **esbuild** - Bundles the three browser clients
- **electron**, **electron-builder** - Desktop shell and installers

Directory scanning uses Node's own recursive `readdir`, file types come from
the configurable extension list, and the browser is opened with a three-line
platform command, so `glob`, `mime-types` and `open` are no longer needed.

## Development

### Scripts

```bash
npm run build       # Compile the server and bundle the clients into dist/
npm run typecheck   # Type-check everything without emitting
npm test            # Run the unit tests for the pure core
npm run clean       # Remove dist/, build/, release/ and .tsbuild/

npm start           # Build, then launch the desktop app
npm run web         # Build, then serve on http://localhost:3123
npm run dev:electron  # As above, with DevTools open
```

### Build pipeline

| Target            | Pipeline                                    | Output                       |
| ----------------- | ------------------------------------------- | ---------------------------- |
| Server + Electron | `tsc` to CommonJS                           | `dist/server`, `dist/shared` |
| Electron renderer | `esbuild` bundle, Chromium target           | `dist/client/electron`       |
| Web client        | `esbuild` bundle, ES2017 target             | `dist/client/web`            |
| webOS TV          | `tsc` to ES5, then an `esbuild` IIFE bundle | `build/webos/package`        |

### Tests

`tests/` holds `node:test` suites covering config normalisation, time
conditions, audio filter construction, crossfade timing, history, selection and
the shared utilities. They need no ffmpeg, no browser and no filesystem, and
one of them asserts that `config.default.json` normalises to exactly the
defaults declared in code, so the two cannot drift apart.

### File locations
- **Configuration**: `config.json` in the working directory; `config.default.json` ships with the app
- **Cache**: `cache/` holds the video index, queue state and playback history
- **Temporary files**: `temp/` holds transcoded videos
- **Logs**: Console output, filtered by `system.logLevel`

User data follows the working directory, so one installation can serve
different libraries from different directories.

## Deployment

### Desktop distribution

```bash
npm run package:electron
```

Creates platform-specific installers in `release/`.

### Web server deployment

```bash
npm run build
NODE_ENV=production node dist/server/web/main.js

# Under a process manager
pm2 start dist/server/web/main.js --name videojuke-server
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

webOS TVs run an old Chromium, so the TV client is compiled down rather than
shipped as-is. TypeScript emits ES5, esbuild bundles the result into a single
IIFE, and a small polyfill module fills in the handful of built-ins the TV
lacks. `ares-package` then wraps it as an IPK.

Earlier versions did this with a hand-written regular-expression transpiler
that rewrote `const`, template literals and arrow functions by pattern
matching, then validated its own output by grepping for `=>`. Any syntax it
had not been taught about produced silently broken JavaScript. A real compiler
removes that entire class of failure.

## Build commands

```bash
npm run package:webos
```

The same command works on every platform. When `ares-package` is not installed
the build still produces the unpackaged app in `build/webos/package` and says
so, so you can inspect or side-load it.

## Build process

1. **Compile**: `tsc -p tsconfig.webos.json` emits ES5 into `.tsbuild/webos`
2. **Bundle**: esbuild produces one self-contained `client.js` targeting ES5
3. **Assets**: the page, stylesheets, icons, `appinfo.json` and the webOS TV
   library are copied into `build/webos/package`
4. **Package**: `ares-package` produces an IPK in `release/webos`

The TV client shares every module under `src/client/core` with the desktop and
browser clients. Only the entry point, the server-address form, the storage
adapter, the remote-control key map and the polyfills are webOS-specific.

## Requirements

- Node.js 20 or newer for the build
- The webOS SDK for packaging (the `ares-package` command)

## WebOS SDK installation

1. Download the webOS SDK from https://webostv.developer.lge.com/sdk/installation/
2. Install it following the official documentation
3. Ensure `ares-package` is on your PATH

## Installation commands

```bash
ares-setup-device                 # Configure the TV connection
ares-install release/webos/*.ipk  # Install the generated package
ares-launch com.videojuke.player  # Launch it
```

## Configuring the TV

On first launch the app asks for the address of a machine running
`npm run web`. Use the arrow keys to move between the fields and OK to confirm.
The address is remembered, and the blue remote button returns to the form.

Set `network.server.host` to `0.0.0.0` on the server so the TV can reach it.

## Remote control

| Button      | Action           |
| ----------- | ---------------- |
| OK, Play    | Play/pause       |
| Right       | Next video       |
| Left        | Previous video   |
| Up, Down    | Playback speed   |
| Red         | Toggle crossfade |
| Green       | Toggle blur      |
| Yellow      | Show video info  |
| Blue        | Server settings  |
| Back        | Exit             |

## Build troubleshooting

**The bundle fails to build**: the TypeScript compiler reports the file and
line. There is no separate validation step to interpret, because the compiler
is the validation.

**A feature works in the browser but not on the TV**: the TV engine predates
much of the standard library. Add the missing built-in to
`src/client/webos/polyfills.ts` rather than working around it at the call site.

**`ares-package` is not found**: install the webOS SDK, or use the unpackaged
output in `build/webos/package` directly.

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