# 🎧 24/7 Discord Music Bot

A full-featured Discord music bot built with **discord.js v14**, **discord-player v6**, and **discord-player-youtubei v3**.

- ⚡ **Fast playback & prefetching** — Next-song caching reduces gap delay between tracks.
- 🎛️ **In-Discord ZYRO-style control panel** — Rich persistent embed with live progress bar and 10 interactive buttons.
- ♾️ **24/7 mode (`/247`)** — Bot stays in the voice channel permanently: even when empty, queue finished, or after restarts.
- 🔮 **Smart Autoplay** — Seamlessly queues similar tracks when your playlist ends (like a radio).
- 🔎 **/play autocomplete suggestions** — Live search suggestions while typing track titles.
- 📢 **Voice channel status** — Real-time song title automatically appears under the voice channel name.
- 🎭 **Rotating bot presence** — Dynamically shows listening activities and playful status messages.
- 🎵 **Multi-source support** — YouTube, Spotify, and SoundCloud (search names, direct links, and playlists).
- ☁️ **Ready for free 24/7 hosting** — No open ports, no web servers; runs continuously on free hosts (bot-hosting.net, Oracle Cloud).

---

## ⚡ Quick Start (3 minutes)

1. **Install Node.js 18+** ([nodejs.org](https://nodejs.org))
2. In the project folder, install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and fill in your credentials:
   ```env
   DISCORD_TOKEN=your-bot-token
   CLIENT_ID=your-application-id
   ```
4. Start the bot:
   ```bash
   npm start
   ```
5. Invite the bot to your server (see `docs/SETUP.md` for the invite URL with voice permissions) and run `/play <song>`!

---

## 🎛️ In-Discord Button Control Panel

Every `/play` or `/nowplaying` command presents a rich ZYRO-style control panel that updates in place:

```text
▶ Now playing: Gaulois - Jolie feat. @ninho
by Gaulois officiel • requested by @User

▬▬▬▬●▬▬▬▬ 3:07 / 4:21

Volume: 100% | Queue: 3 | Loop: Off | Autoplay Radio: On
[ Baduwa Music • 24/7 mode active • Today at 09:30 ]
```

### Button Controls:

| Button | Action | Details |
| :--- | :--- | :--- |
| **⏯️ Pause / Resume** | Toggle playback | Label and style dynamically swap (`Pause` ↔ `Resume`) |
| **⏭️ Skip** | Skip current track | Instantly advances to next track in queue |
| **⏮️ Previous** | Replay previous song | Plays the last track from history |
| **⏹️ Stop** | Stop & clear | Stops audio and clears remaining tracks |
| **🔀 Shuffle** | Shuffle queue | Randomizes upcoming tracks |
| **🔮 Autoplay** | Toggle autoplay | Turns green (`Success`) when active; remains active in standby |
| **🔁 Loop** | Cycle repeat mode | Cycles: `Off` ➔ `Track` ➔ `Queue` ➔ `Off` |
| **📜 Queue** | Quick queue popup | Shows the current & next 10 tracks in an ephemeral message |
| **🔊 Vol+** | Volume +10% | Increases volume in 10% steps (clamped up to 150%) |
| **🔉 Vol-** | Volume -10% | Decreases volume in 10% steps (down to 0%) |

> **Voice channel guard:** Buttons only respond to users in the same voice channel as the bot to prevent trolling.

---

## 📜 Slash Commands (20)

| Command | Description |
| :--- | :--- |
| `/play <song/link>` | Play song with instant autocomplete suggestions (`next:true` to insert at top) |
| `/pause` / `/resume` | Pause or resume playback |
| `/skip [count]` | Skip current track or multiple tracks |
| `/previous` | Jump back to previous song from history |
| `/seek <1:30>` | Seek to a specific timestamp |
| `/stop` | Stop playback and clear the queue |
| `/volume <0-150>` | Adjust playback volume |
| `/queue [history]` | View current track queue or playback history |
| `/nowplaying` | Display current song and interactive control panel |
| `/shuffle` | Shuffle the queue |
| `/remove <position>` | Remove a track from queue |
| `/clear` | Clear upcoming tracks |
| `/move <from> <to>` | Reorder a track in the queue |
| `/loop <mode>` | Set repeat mode (off, track, queue, autoplay) |
| `/autoplay` | Toggle smart continuous radio mode |
| `/247` | Toggle 24/7 voice channel persistence |
| `/disconnect` | Leave the voice channel |
| `/ping` | Check bot latency and uptime |
| `/help` | Detailed command and control guide |

---

## 🌐 24/7 Free Hosting (Laptop OFF)

Because the bot uses in-Discord button controls and slash commands exclusively:
- **No open ports or public URLs are needed.**
- It can be deployed on free services like **[bot-hosting.net](https://bot-hosting.net)** or **Oracle Cloud Always Free VPS**.
- Detailed hosting steps are available in [`docs/FREE-HOSTING.md`](docs/FREE-HOSTING.md).

---

## 📁 Project Structure

```
discord-music-bot/
├── index.js                  # Clean entry point
├── Procfile                  # Cloud worker process definition
├── package.json              # Project dependencies & scripts
├── src/
│   ├── config.js             # Environment configuration
│   ├── bot/
│   │   ├── init.js           # Client & Player setup, voice safeguards & button handler
│   │   ├── panel.js          # ZYRO-style embed & button builder + state manager
│   │   ├── music.js          # Audio engine & queue handling
│   │   ├── events.js         # Discord-player event listeners & silent-stream watchdog
│   │   ├── prefetch.js       # Low-latency track prefetching
│   │   ├── spotify.js        # Spotify playlist & track resolver
│   │   ├── store.js          # Guild settings persistence (data/guilds.json)
│   │   ├── presence.js       # Dynamic bot status rotator
│   │   ├── vcStatus.js       # Live voice channel title status
│   │   └── ui.js             # Embed builders
│   └── commands/             # 20 slash commands
├── docs/
│   ├── SETUP.md              # Discord Developer Portal setup & permissions
│   ├── FREE-HOSTING.md       # 24/7 cloud hosting guide
│   └── ANTIGRAVITY.md        # Antigravity IDE guide
└── scripts/
    ├── test-boot.js          # Boot validation without token
    ├── test-panel.js         # Panel math, loop cycle & button test suite
    └── test-vcstatus.js      # Voice status tests
```
