# Antigravity IDE eken bot eka run karana widiha

Machan — **Google Antigravity** eka (free agentic IDE eka) weda karana widihat me guide eke thiyenawa. Bot eka **Node.js project ekak** nisa — Antigravity hari VS Code hari terminal hari — monwa hari editor ekakin run karanna puluwan. Antigravity eken karanna nam **Agent ekai** ekka podi bonus ekak thiyenawa: code eka change karanna puluwan weda AI agent ekata liyala denne puluwan.

> Antigravity eka anagath ekak: [antigravity.google](https://antigravity.google) — **no charge** (free) developers wenuwata. Windows 10+ (64-bit), macOS 13+, saha laga Linux distro tika support karanawa. Login wenuwata **personal Google account ekak** (Gmail) saha **Chrome browser ekak** one.

---

## 1) Antigravity + Node.js install karanna

1. [antigravity.google/download](https://antigravity.google/download) ekata gihinna → OS eke version eka (Windows/macOS/Linux) download karala install karanna. Open karaddi **Google account eken login** karanna.
2. **weda karanna one**: Antigravity eka editor ekak witharai — **Node.js eka sewwidhi** install wela nae. Bot eka run wenuwata **Node.js 18+** one:

   - [nodejs.org](https://nodejs.org) ekata gihinna → **LTS version eka** download karala install karanna
   - Windows: `winget install OpenJS.NodeJS.LTS` kiyyala run karanna puluwan
   - macOS: `brew install node`

3. Terminal ekaka check karanna (Antigravity eke terminal ekakath puluwan):

   ```bash
   node -v
   ```

   `v18` nathnam `v20`/`v22` wage penenawa nam OK!

---

## 2) Project eka open karanna

1. Bot eka zip file eka **extract** karanna — monwa hari thanaka (wenas: `discord-music-bot`)
2. Antigravity eke: **File → Open Folder** → project folder eka select karanna
3. **Ctrl + `** ekata aran karalla terminal ekak aran karanna (View → Terminal thamai path eka)

Dan project eka Antigravity eke thiyenawa — file tree eke `src/`, `docs/`, `commands/` okkoma penenawa.

---

## 3) Install + .env + Start (terminal eken)

Terminal eke (project folder ekaki):

```bash
npm install
```

`.env` file ekak hadanna — `.env.example` file eka copy karala `.env` kiyyala rename karalla (Antigravity eke file explorer eken right-click → Copy/Paste + Rename):

```bash
DISCORD_TOKEN=token_eka_me_danna
CLIENT_ID=application_id_eka_me_danna
```

> Token + ID eka ganna widiha: **docs/SETUP.md** eke steps 2-3 (5 walata thiyenawa).
> Spotify links + dashboard password optional — `.env.example` eke comments tika kiyawanna.

Bot eka start karanna:

```bash
npm start
```

Console eke `logged in as ...` + `[dashboard] http://localhost:3000` penenawa nam **OK**!

- Browser eken `http://localhost:3000` ekata gihinna → web dashboard eka (play/pause/skip/volume/queue/247/autoplay okkoma)
- Discord eka VC ekakata join wela `/play <song name>` gahanna — suggestions eken enawa

---

## 4) Antigravity Agent eken mokra karanna puluwan weda

Antigravity eke agent ekata (chat panel eken) plain English walin instructions denna puluwan — eka code eka liyala, terminal eken verify karala denawa:

- "Run `npm install` and then start this Discord music bot"
- "Add a `/lyrics` slash command that shows the current song's lyrics"
- "Change the dashboard theme to a dark purple color scheme"
- "Make `/play` accept a `shuffle: true` option"
- "Explain how the 24/7 mode works in this codebase"

Hoda practice eka: **bot token eka agent chat ekata paste karanna nae** — eka `.env` file eke danna (agent eka project files access karanawa, nam token eka prompt ekaka give karanna ape assurance kala nae).

Bot eka `pm2` walin Antigravity terminal eken run karama bot eka close wenne nae:

```bash
npm install -g pm2
pm2 start index.js --name music-bot
pm2 save
pm2 logs music-bot
```

---

## 5) 24/7 wenuwata

Antigravity eka close karaddi terminal eka winasai bot process eka stop wenawa:

- **Bot eka 24/7 run wenna one nam**: docs/FREE-HOSTING.md eke options tika (bot-hosting.net / Oracle free VPS / Render)
- Home PC eken thama run karanna nam: PC eka witharak on karala thiyanna + `pm2` ekka (`pm2 startup` ekata boot eke auto-start) — nam battery/light bill balanna

---

## 6) Common issues

| Issue | Fix |
| --- | --- |
| `node: command not found` | Node.js install wela nae — step 1 eken install karanna |
| `DISCORD_TOKEN is missing` | `.env` file eke values nathi — step 3 |
| `EADDRINUSE: port 3000` | Port 3000 mokak hari application ekak aran — `.env` ekata `DASHBOARD_PORT=3001` danna |
| Slash commands disi nathi wenawa | Discord eka cache ekak — thawa minit ekak wait karalla `/play` aye type karanna |
| Songs load wenna delay | `/play` eke autocomplete thawa YouTube search ekak — podi delay ekak normal |
| Free host eken songs play nae | `YOUTUBE_COOKIE` env eka danna (docs/SETUP.md eke "YouTube Cookie") — local PC eken meka awlk nae |

---

## VS Code / wena editor walin run karanna nam

Steps okkoma samanai: folder open → terminal → `npm install` → `.env` → `npm start`. Antigravity eken awlk nama podi code-change weda tika agent ekata dansenna puluwan witharai.
