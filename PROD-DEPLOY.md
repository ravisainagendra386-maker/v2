# Production Deploy

This folder is the deployable copy. The app is a Node HTTP/WebSocket server that serves `decimal-bot.html` and runs Playwright on the backend.

## Required Setup

Deploy with Docker and mount a persistent disk at `/data`.

Environment:

```env
NODE_ENV=production
SCRAPE_HEADLESS=true
SESSION_FILE=/data/rebel777-session.json
USER_DATA_DIR=/data/rebel777-profile
ADMIN_TOKEN=make-a-long-random-secret
REBEL777_USERNAME=your-rebel-login
REBEL777_PASSWORD=your-rebel-password
AUTO_REFRESH_SESSION_ON_START=true
APP_USERNAME=Ravi
APP_PASSWORD=Ravi386
```

The public URL should point to the Node server itself. Open:

```text
https://your-domain.com
```

The frontend will automatically call the same host for API routes and WebSocket:

```text
https://your-domain.com/start-rebel777
wss://your-domain.com
```

## Session Setup

`ADMIN_TOKEN` is only a private password for the admin refresh URL. It is not from Rebel777. Make it a long random string and keep it secret.

The server automatically refreshes the Rebel session on every restart when `REBEL777_USERNAME` and `REBEL777_PASSWORD` are configured. It uses a fresh temporary Chromium profile for the login, then overwrites:

```text
/data/rebel777-session.json
```

You can also refresh manually with the protected headless login endpoint:

```text
https://your-domain.com/admin/refresh-session?token=make-a-long-random-secret
```

That endpoint starts Chromium on the server, opens Rebel, enters `REBEL777_USERNAME` and `REBEL777_PASSWORD`, tries to close common banner/pop-up buttons, and saves:

```text
/data/rebel777-session.json
```

Then open:

```text
https://your-domain.com
```

Do not commit `rebel777-session.json`, `rebel777-profile`, or credentials to git.

If Rebel changes its login fields, set these optional selectors as env vars:

```env
REBEL777_USERNAME_SELECTOR=input[name="username"]
REBEL777_PASSWORD_SELECTOR=input[type="password"]
REBEL777_SUBMIT_SELECTOR=button[type="submit"]
REBEL777_BANNER_CLOSE_SELECTOR=div.close-home-modal
```

## Platform Notes

Use a service that supports:

- Long-running Node process
- WebSockets
- Docker image deploy
- Persistent disk mounted to `/data`
- At least 1 GB RAM, preferably 2 GB for Playwright

Good fits: Render, Railway, Fly.io, or a VPS.

## Railway Steps Without GitHub

In the Railway UI, choose:

```text
Empty Project
```

Then deploy from your local machine with Railway CLI:

```sh
npm install -g @railway/cli
railway login
cd "C:\Projects\live prod"
railway link
railway up
```

Railway will upload the local folder and build the `Dockerfile`.

Create a Railway Volume attached to the service with mount path:

```text
/data
```

In the service Variables page, add:

```env
REBEL777_USERNAME=your-rebel-login
REBEL777_PASSWORD=your-rebel-password
ADMIN_TOKEN=make-a-long-random-secret
AUTO_REFRESH_SESSION_ON_START=true
APP_USERNAME=Ravi
APP_PASSWORD=Ravi386
SESSION_FILE=/data/rebel777-session.json
USER_DATA_DIR=/data/rebel777-profile
SCRAPE_HEADLESS=true
```

Open the service Settings and enable Public Networking / Generate Domain.

On startup, the app will refresh the Rebel session automatically. Open the Railway public URL and log in with:

```text
Username: Ravi
Password: Ravi386
```

If the first login fails, check Deploy Logs. You can manually retry:

```text
https://your-railway-domain.up.railway.app/admin/refresh-session?token=make-a-long-random-secret
```

## Start Command

Docker uses:

```sh
npm start
```

The app listens on `process.env.PORT` when the platform provides it, otherwise `3000`.
