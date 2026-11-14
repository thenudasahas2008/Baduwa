# 🔧 Setup Guide — Token, Permissions & Invite (step by step)

Meka follow karanna — 5 walata bot eka server ekakaat add wela music play wenawa.

Steps: (1) Application hadanna → (2) Bot token eka ganna → (3) General Information page eka fill karanna → (4) Bot eka invite karanna → (5) Run karanna.

---

## 1) Application eka hadanna

1. [discord.com/developers/applications](https://discord.com/developers/applications) ekata gihinna (login kanna)
2. **"New Application"** button eka click karanna
3. Name ekak dina (wenas: `My Music Bot`) → **Create**

## 2) Bot Token eka ganna

1. App eke left menu ekaka **"Bot"** tab ekata yanna
2. **"Reset Token"** click karala token eka **copy** karanna
   ⚠️ Token eka kenekuta denna **nae** — eka dekala account ekak hack wenna puluwan!
3. Project folder eke `.env` file ekaka dananna:

   ```
   DISCORD_TOKEN=paste-token-eka-meka
   ```

## 3) General Information page eka fill karanna (Description + Tags)

Me thama **3rd image** eke page eka (app eke **General Information** tab eke). Left menu eken ekata yanna.

### Description (bot eke About Me eka)

"Your description will appear in the About Me section of your bot's profile." — eka wenuwat me text eka copy karala **paste** karanna (400 characters wita):

> Nonstop music for your server. Zero-lag playback, instant /play suggestions and autoplay that keeps the beats coming. 24/7 mode so the party never stops, plus a web dashboard to control everything from your browser. Add me to a voice channel and let's go!

### Tags (podda 5k)

Portal eke tag list eken me tika **pick** karanna:

1. `music` ⭐ (meka wiwasthai one)
2. `entertainment`
3. `social`
4. `utility`
5. `games`

> (Tag list eke thiyena wena wena nam — `music` eka hambanne nam monada hari 5k thiyanna.)

### Application ID eka ganna

E page eke **APPLICATION ID** eka copy karanna → `.env` ekata danna:

```
CLIENT_ID=paste-id-eka-meka
```

(Meka invite link ekeuth use wenne — step 4 balanna.)

### Public Key

Eken one **nae**. Meka HTTP webhook interactions wenuwat witharak use wenne — me bot eka websocket gateway eken weda karanawa nisa ekakuth karanna one nae.

### Save Changes!

Sabba fill karanna aye passe **"Save Changes"** (haraha green button eka) click karanna.
Nathnam "Careful — you have unsaved changes!" warning eka enawa (3rd image eke penena wage) — save karana thama wena save wenne nae!

## 4) Bot eka server ekakaat invite karanna (permissions)

Mekakuth **privileged intents** on karanna one **nae** (voice + slash commands wenuwata default intents pramanai).

### Ready-made invite link eka (laga permission set eka):

```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID_EKA_MEKATA&permissions=281479308495872&scope=bot%20applications.commands
```

> `CLIENT_ID_EKA_MEKATA` eka replace karanna step 3 eke APPLICATION ID eken.

### E link eka ena permissions tika:

| Permission | Mokakda one |
| --- | --- |
| **View Channels** | Bot eka channels tika dedanna |
| **Send Messages** | Queue messages/embeds yanna |
| **Embed Links** | Now playing cards tika |
| **Attach Files** | Thumbnails attach karanna |
| **Read Message History** | Old now-playing message edit karanna |
| **Connect** | Voice channel ekakaat join wenna |
| **Speak** | Audio play karanna ⭐ |
| **Use Voice Activity** | Voice connection stable wenna |
| **Set Voice Channel Status** | VC eke name eka yala song eka **auto pennanna** (1st image wage "about" status eka) |

> **Set Voice Channel Status** eka nathnam: bot eka wedai, only VC status eka (song title eka VC eke penenna) update wenne nae — console ekata `[vcstatus]` warning ekakuth enna puluwan.

### Manual path eka (URL generator):

1. Dev portal eke app eka → **OAuth2 → URL Generator**
2. Scopes: ✅ `bot` + ✅ `applications.commands`
3. Bot Permissions (tick karanna): `View Channels`, `Send Messages`, `Embed Links`, `Attach Files`, `Read Message History`, `Connect`, `Speak`, `Use Voice Activity`, `Set Voice Channel Status`
4. URL eka copy karala browser eken open karanna → server eka select → **Authorize**

## 5) Run karanna!

```bash
npm install
npm start
```

Console eke `logged in as ...` penenawa nam **OK**! 🎉

Discord eka VC ekakata join wela `/play <song name>` gahanna — suggestions eken awilla select karanna puluwan.

---

## 🎵 Spotify Support (optional hoda)

Spotify **links** (track/album/playlist) reliable work karanna credentials dekak one:

1. [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) ekata gihinna (free Spotify account ekak)
2. **"Create app"**:
   - App name: `discord music bot`
   - Redirect URI: `http://localhost:3000` (onema dala) ✅ Web API / Web Playback SDK tick karanna
3. App eke **Settings** eken **Client ID** + **Client Secret** (Show button eken) copy karanna
4. `.env` ekata:

   ```
   DP_SPOTIFY_CLIENT_ID=client_id_eka
   DP_SPOTIFY_CLIENT_SECRET=client_secret_eka
   ```

> **Credentials nathi wita**: plain name searches (YouTube) saha YouTube links **wedai** — Spotify links pamanak podi patabela / fail wenna puluwan.

---

## 🍪 YouTube Cookie (optional — free hosts wita podi patabela)

Free hosting eken YouTube streams age/bot-check karana wita:

1. Browser eken [youtube.com](https://youtube.com) ekata login karanna
2. DevTools (F12) → **Network** tab → youtube.com request ekak click karanna → **Request Headers** → `Cookie:` row eka **full value eka** copy karanna
3. `.env` ekata danna:

   ```
   YOUTUBE_COOKIE=VISITOR_INFO1_LIVE=xxx; YSC=xxx; ... (full header eka)
   ```

Eka YouTubee request tika "real browser user" wage dedanna — podi patabela thama weda karanawa.
