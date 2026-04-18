# Blocky Weather Bot: VPS Setup Guide 🖥️

Follow these steps to deploy your bot 24/7 on a Linux VPS (Ubuntu/Debian).

## 🏢 1. Recommended Server Specs
- **OS**: Ubuntu 22.04 LTS
- **RAM**: 2 GB (Minimum)
- **CPU**: 1 - 2 vCPU

## 🛠️ 2. Environment Setup
SSH into your VPS and install the core dependencies:

```bash
# Update and install Node.js & Python
sudo apt update && sudo apt upgrade -y
sudo apt install -y nodejs npm python3 python3-pip sqlite3

# Install PM2 (Process Manager to keep the bot alive 24/7)
sudo npm install -g pm2
```

## 📦 3. Bot Deployment
```bash
# Clone or copy your bot folder
git clone <your-repo-link>
cd "Blocky Polymarket"

# Install dependencies
npm install
pip3 install requests python-dotenv
```

## 🔐 4. Configuration
Create your `.env` file on the VPS:
```bash
nano .env
```
Paste your `TELEGRAM_BOT_TOKEN`. Save with `Ctrl+O`, `Enter`, then `Ctrl+X`.

## 🚀 5. Running 24/7 with PM2
Use **PM2** to manage the processes separately. This ensures automatic restarts if a crash occurs.

```bash
# 1. Start the Signal Generator (Python Brain)
pm2 start "python3 brain/signals.py" --name "weather-signals"

# 2. Start the Telegram Bot Interface
pm2 start "npx ts-node app/bot.ts" --name "weather-bot"

# 3. Start the Trade Executor
pm2 start "npx ts-node app/executor.ts" --name "weather-executor"

# 4. Start the Settlement Monitor (Alerts)
pm2 start "npx ts-node app/settlement.ts" --name "weather-settler"

# 5. Persist the setup for server reboots
pm2 save
pm2 startup
```

## 📈 6. Monitoring & Logs
- **View All Logs**: `pm2 logs`
- **Check Status**: `pm2 status`
- **Restart All**: `pm2 restart all`
- **Stop All**: `pm2 stop all`

## 🛡️ 7. Security Best Practices
- **Firewall**: Ensure port 22 is open for SSH, but `ts-node` does not require any other external ports.
- **Backups**: Periodically back up `data/users.db` to keep your trade history.
- **Permissions**: Restrict `.env` access: `chmod 600 .env`.

---
**Your bot is now ready for autonomous 24/7 trading!** 🌡️📉🚀🦾
