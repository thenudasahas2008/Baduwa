<div align="center">

<img src="assets/header.svg" width="100%" alt="Baduwa Music Bot Header" />

[![NodeJS](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.js.org/)
[![Discord Player](https://img.shields.io/badge/discord--player-v6-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://discord-player.js.org/)
[![Status](https://img.shields.io/badge/24%2F7%20Voice-Persistent-00C7B7?style=for-the-badge&logo=signal&logoColor=white)](#-247-continuous-voice-presence)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

<p align="center">
  <b>An enterprise-grade, high-performance 24/7 Discord audio streaming bot featuring low-latency track prefetching, rich in-Discord interactive button controls, smart algorithmic autoplay, and multi-source streaming (YouTube, Spotify, SoundCloud).</b>
</p>

[Key Features](#-key-features) • [Interactive Control Panel](#-in-discord-interactive-control-panel) • [Quick Start](#-quick-start) • [Slash Commands](#-slash-command-matrix) • [24/7 Cloud Deployment](#-247-cloud-hosting)

---

</div>

## 📖 Overview

**Baduwa** is an advanced Discord audio engine designed for community servers that demand flawless, non-stop music streaming. Unlike standard music bots that disconnect when the queue empties or lag between songs, **Baduwa** utilizes **discord-player v6** memory caching and track prefetching to eliminate playback stutter.

With a persistent, interactive **Button Control Panel**, users can control track navigation, audio loop modes, autoplay radio, and track scrubbing entirely with point-and-click button interactions directly inside Discord text channels.

---

## ✨ Key Features

- ⚡ **Low-Latency Playback & Next-Song Prefetching:** Pre-buffers upcoming queue tracks in background memory, completely eliminating buffering pauses between songs.
- 🎛️ **In-Discord Interactive Dashboard:** Dynamic persistent message embed featuring a live scrub bar, volume indicators, and 10 interactive button controls.
- ♾️ **24/7 Voice Channel Retention (`/247`):** Stays connected to voice channels permanently, surviving empty channels, finished queues, and automatic process reboots.
- 🔮 **Algorithmic Smart Autoplay:** When your playlist finishes, Baduwa automatically analyzes the audio fingerprint and streams similar tracks continuously.
- 🔎 **Real-Time Search Autocomplete:** Instant interactive suggestions appear directly inside Discord's slash command input as you type track names.
- 📢 **Dynamic Voice Channel Status Sync:** Automatically updates the native Discord voice channel topic with the live playing track name and artist.
- 🎵 **Multi-Source Ingestion:** Seamlessly streams high-fidelity audio from **YouTube**, **Spotify** (Tracks, Playlists, Albums), and **SoundCloud**.
- ☁️ **Serverless / VPS Friendly:** Requires zero incoming ports; deploys smoothly on VPS (Ubuntu/Debian), Oracle Cloud Free Tier, or container environments.

---


## 🎛️ In-Discord Interactive Control Panel

Whenever `/play` or `/nowplaying` is invoked, Baduwa deploys an auto-updating control embed:

```text
┌────────────────────────────────────────────────────────────────────────┐
│  ▶ NOW PLAYING: Starboy (feat. Daft Punk) - The Weeknd                 │
│  Requested by: @Thenuda • Quality: 320kbps Opus High-Fidelity          │
│                                                                        │
│  [02:14] ▬▬▬▬▬▬▬▬▬▬●▬▬▬▬▬▬▬▬▬▬ [03:50]                                 │
│                                                                        │
│  [Volume: 100%] • [Queue: 8 Tracks] • [Loop: Off] • [Autoplay: Active] │
└────────────────────────────────────────────────────────────────────────┘
```

### Dashboard Button Controls

| Button | Action | State Behavior |
| :--- | :--- | :--- |
| `⏯️ Pause / Resume` | Toggles playback state | Switches dynamic label and color between Primary and Success |
| `⏭️ Skip` | Skips to next song | Instantly triggers prefetched audio cache |
| `⏮️ Previous` | Plays previous history track | Recalls previous track from session history |
| `⏹️ Stop` | Stops & flushes queue | Halts audio and cleans session memory |
| `🔀 Shuffle` | Shuffles remaining tracks | Randomizes future queue order using Fisher-Yates algorithm |
| `🔮 Autoplay` | Toggles recommendation engine | Activates continuous radio streaming when queue is exhausted |
| `🔁 Loop Track` | Repeats current track | Infinite single-track loop mode |
| `🔂 Loop Queue` | Loops entire queue | Re-queues finished tracks at the end of queue |
| `📜 Queue List` | Ephemeral queue view | Displays paginated upcoming tracks without channel clutter |
| `🔇 Mute / Unmute` | Toggles audio volume | Mutes volume instantly without stopping track timestamp |

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js** v18.0.0 or higher ([nodejs.org](https://nodejs.org))
- **Git**
- A registered **Discord Bot Application** on the [Discord Developer Portal](https://discord.com/developers/applications)

### 2. Clone Repository
```bash
git clone https://github.com/thenudasahas2008/Baduwa.git
cd Baduwa
```

### 3. Install Dependencies
```bash
npm install
```

### 4. Configure Environment
Copy `.env.example` to `.env` and enter your credentials:
```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_id_here
GUILD_ID=your_test_guild_id_optional
DEFAULT_VOLUME=100
AUTO_PLAY_DEFAULT=true
```

### 5. Start the Engine
```bash
# Production mode
npm start

# Development mode (with live reload)
npm run dev
```

---

## ⚡ Slash Command Matrix

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/play` | `<query>` | Searches and streams from YouTube, Spotify, or SoundCloud with autocomplete |
| `/nowplaying` | *None* | Spawns or brings the interactive button control panel to the active channel |
| `/pause` | *None* | Pauses the current audio stream |
| `/resume` | *None* | Resumes paused audio playback |
| `/skip` | *None* | Skips the current track to the next prefetched item |
| `/queue` | `[page]` | Displays upcoming tracks with pagination and duration totals |
| `/volume` | `<1-100>` | Adjusts audio volume with zero clipping distortion |
| `/247` | *None* | Toggles permanent 24/7 channel presence mode |
| `/shuffle` | *None* | Randomizes current queue order |
| `/stop` | *None* | Stops playback, clears the queue, and resets channel presence |

---

## ☁️ 24/7 Cloud Hosting

### Background VPS Daemon (PM2)
To keep Baduwa running permanently on an Ubuntu / Debian VPS:

```bash
# Install PM2 process daemon
npm install -g pm2

# Launch Baduwa under PM2 supervisor
pm2 start index.js --name "baduwa-music"

# Persist daemon across server reboots
pm2 startup
pm2 save
```

### Process Management
```bash
pm2 logs baduwa-music      # View live streaming telemetry & song logs
pm2 restart baduwa-music   # Restart the bot
pm2 stop baduwa-music      # Gracefully stop the bot
```

---

## 📁 Repository Structure

```text
Baduwa/
├── src/
│   ├── commands/          # Slash command definitions & logic
│   ├── events/            # Discord.js client & voice gateway events
│   ├── buttons/           # Interactive button handlers
│   └── player/            # Discord-player audio pipeline & event hooks
├── locales/               # Multi-language localization strings
├── docs/                  # Detailed setup, permissions, and invite guides
├── .env.example           # Template environment configuration
├── index.js               # Application bootstrap and client initialization
├── package.json           # Node.js project manifest & dependencies
└── README.md              # Project documentation and deployment guide
```
