# 🌐 Free 24/7 Hosting Guide (Laptop OFF, Bot Stays ON)

To keep your bot playing music 24/7 even when your PC/laptop is turned off, host it on a free cloud service. Because the bot is now 100% controlled from inside Discord via slash commands and interactive buttons, **it requires NO open ports, NO web servers, and NO public URLs**.

---

## Option 1: bot-hosting.net ⭐ (Recommended — 5-minute setup)

[bot-hosting.net](https://bot-hosting.net) is a free Pterodactyl-based hosting platform built specifically for Discord bots. It runs your bot 24/7 without sleeping.

### Step-by-Step:

1. Go to [bot-hosting.net](https://bot-hosting.net) and **Log in with Discord**.
2. Go to **Servers** ➔ **Create Server**:
   - **Server Type:** Node.js (Node 18+ or Node 20/22)
   - **Server Name:** `discord-music-bot`
3. Upload your project files:
   - Create a zip of your `discord-music-bot` folder (**DO NOT include `node_modules` or `.env`**).
   - In the bot-hosting panel, go to the **Files** tab.
   - Upload the zip file and click **Unarchive**.
   - *(Alternative: Connect your GitHub repository).*
4. Configure Startup:
   - **Startup File:** `index.js`
   - **Startup Command:** `npm install && node index.js`
5. Configure Environment Variables (in the **Variables** or **Settings** tab):

   | Key | Value | Description |
   | --- | --- | --- |
   | `DISCORD_TOKEN` | *your_bot_token* | Required: Bot token from Discord Developer Portal |
   | `CLIENT_ID` | *your_application_id* | Required: Application ID from General Information |
   | `DP_SPOTIFY_CLIENT_ID` | *(optional)* | Spotify developer Client ID |
   | `DP_SPOTIFY_CLIENT_SECRET` | *(optional)* | Spotify developer Client Secret |
   | `YOUTUBE_COOKIE` | *(optional)* | Browser cookie header string for YouTube gating bypass |

6. Click **Console** ➔ **Start**!
   - You will see `[bot] logged in as Baduwa#9417` and `[bot] slash commands synced`.
   - Your bot is now online 24/7!

---

## Option 2: Oracle Cloud Always Free VPS (Most powerful & reliable)

Oracle provides lifetime free Linux virtual machines that never sleep:

1. Register at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) (credit card required for verification, $0 charge).
2. Create an **Ubuntu 22.04 LTS** Compute instance (`VM.Standard.E2.1.Micro`, Always Free).
3. Connect via SSH:
   ```bash
   ssh ubuntu@<your-vps-ip>
   ```
4. Install Node.js 22 & Git:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs git
   ```
5. Clone or upload your bot folder:
   ```bash
   git clone <your-repo> discord-music-bot
   cd discord-music-bot
   npm install
   ```
6. Create your `.env` file:
   ```bash
   nano .env
   ```
   Add `DISCORD_TOKEN` and `CLIENT_ID`.
7. Run 24/7 with **PM2** (process manager):
   ```bash
   sudo npm install -g pm2
   pm2 start index.js --name music-bot
   pm2 save
   pm2 startup
   ```
   The bot will automatically restart on system reboots and run continuously!

---

## No Open Ports Required
Since the web dashboard was completely replaced with in-Discord interactive button controls and slash commands, you do **not** need to open any firewall ports or configure reverse proxies.
