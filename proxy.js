// ── IPL ARB PROXY SERVER v4 ──
// Fixes: session persistence so rebel777 login survives across runs.
//
// FIRST TIME SETUP:
//   1. node proxy.js
//   2. Open http://localhost:3000/login  ← opens a VISIBLE browser window
//   3. Log into rebel777 manually in that window
//   4. Click "Done" or visit http://localhost:3000/save-session
//   5. Session saved to rebel777-session.json — all future runs reuse it
//
// NORMAL USAGE (after first login):
//   node proxy.js  →  open http://localhost:3000

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : (process.env.PUBLIC_URL || `http://localhost:${PORT}`);
let SCRAPE_INTERVAL = 500;
const RENDER_WAIT_MS = 20000;
const SESSION_FILE = process.env.SESSION_FILE || path.join(__dirname, 'rebel777-session.json');
const USER_DATA_DIR = process.env.USER_DATA_DIR || path.join(__dirname, 'rebel777-profile');
const LOGIN_ORIGIN = 'https://rebel777.co';
const SCRAPE_HEADLESS = String(process.env.SCRAPE_HEADLESS || 'false').toLowerCase() === 'true';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const REBEL777_USERNAME = process.env.REBEL777_USERNAME || '';
const REBEL777_PASSWORD = process.env.REBEL777_PASSWORD || '';
const AUTO_REFRESH_SESSION_ON_START = String(process.env.AUTO_REFRESH_SESSION_ON_START || 'true').toLowerCase() !== 'false';
const APP_USERNAME = process.env.APP_USERNAME || 'Ravi';
const APP_PASSWORD = process.env.APP_PASSWORD || 'Ravi386';
const APP_COOKIE_NAME = 'decimal_app_auth';
const APP_COOKIE_VALUE = Buffer.from(`${APP_USERNAME}:${APP_PASSWORD}`).toString('base64url');
const RESTART_EVERY_HOURS = Number(process.env.RESTART_EVERY_HOURS || 4);
const LOGIN_DEBUG_FILE = process.env.LOGIN_DEBUG_FILE || path.join(path.dirname(SESSION_FILE), 'auto-login-debug.html');

const USERNAME_SELECTORS = (process.env.REBEL777_USERNAME_SELECTOR || [
    'input[name="username"]',
    'input[name="userName"]',
    'input[name="login"]',
    'input[type="text"]',
    'input[placeholder*="User" i]',
    'input[placeholder*="Mobile" i]',
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

const PASSWORD_SELECTORS = (process.env.REBEL777_PASSWORD_SELECTOR || [
    'input[name="password"]',
    'input[type="password"]',
    'input[placeholder*="Password" i]',
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

const SUBMIT_SELECTORS = (process.env.REBEL777_SUBMIT_SELECTOR || [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign In")',
    'button:has-text("Login")',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

const BANNER_CLOSE_SELECTORS = (process.env.REBEL777_BANNER_CLOSE_SELECTOR || [
    'div.close-home-modal',
    'button:has-text("×")',
    'button:has-text("x")',
    'button:has-text("X")',
    '[aria-label*="close" i]',
    '.close',
    '.btn-close',
    '.modal button',
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

// ─────────────────────────────────────────────────────────
// DEPENDENCIES
// ─────────────────────────────────────────────────────────
let WebSocketServer;
try { WebSocketServer = require('ws').Server; }
catch { console.error('[FATAL] Run: npm install ws'); process.exit(1); }

let playwright;
try { playwright = require('playwright'); }
catch { console.error('[FATAL] Run: npm install playwright && npx playwright install chromium'); process.exit(1); }

// ─────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────
let browser = null;   // headless persistent browser context
let loginBrowser = null;   // visible persistent browser context (temporary)
let loginPage = null;
let page = null;
let currentUrl = '';
let lastOdds = null;
let scrapeTimer = null;
let isScraping = false;
let wsClients = new Set();

// ─────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────
function broadcast(data) {
    const msg = JSON.stringify(data);
    wsClients.forEach(ws => { try { if (ws.readyState === 1) ws.send(msg); } catch { } });
}
function log(tag, msg) {
    console.log(`[${tag}] ${new Date().toLocaleTimeString()} — ${msg}`);
}
function hasSession() {
    return fs.existsSync(SESSION_FILE);
}

function parseCookies(header = '') {
    return Object.fromEntries(header.split(';').map(part => {
        const idx = part.indexOf('=');
        if (idx === -1) return null;
        return [part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim())];
    }).filter(Boolean));
}

function isAppAuthed(req) {
    return parseCookies(req.headers.cookie || '')[APP_COOKIE_NAME] === APP_COOKIE_VALUE;
}

function sendAppLogin(res, error = '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Decimal Arbitrage Login</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090d13;color:#e7eef8;font-family:Inter,system-ui,Segoe UI,Arial,sans-serif}
    form{width:min(380px,calc(100vw - 36px));background:#111823;border:1px solid #283548;border-radius:8px;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.42)}
    h1{margin:0 0 18px;font-size:22px;font-weight:700}
    label{display:block;margin:14px 0 6px;color:#92a2b8;font-size:13px}
    input{box-sizing:border-box;width:100%;border:1px solid #314056;background:#0b1119;color:#e7eef8;border-radius:6px;padding:12px 13px;font-size:15px;outline:none}
    input:focus{border-color:#56a6ff}
    button{width:100%;margin-top:20px;border:0;border-radius:6px;padding:12px 14px;background:#19b979;color:#04110b;font-weight:800;font-size:15px;cursor:pointer}
    .err{margin:0 0 14px;color:#ff7a7a;font-size:13px}
  </style>
</head>
<body>
  <form method="post" action="/login">
    <h1>Decimal Arbitrage</h1>
    ${error ? `<p class="err">${error}</p>` : ''}
    <label>Username</label>
    <input name="username" autocomplete="username" autofocus>
    <label>Password</label>
    <input name="password" type="password" autocomplete="current-password">
    <button type="submit">Login</button>
  </form>
</body>
</html>`);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 10000) {
                reject(new Error('Request body too large'));
                req.destroy();
            }
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

async function handleAppLogin(req, res) {
    if (req.method === 'GET') {
        sendAppLogin(res);
        return;
    }
    if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
    }

    const params = new URLSearchParams(await readBody(req));
    const username = params.get('username') || '';
    const password = params.get('password') || '';
    if (username === APP_USERNAME && password === APP_PASSWORD) {
        res.writeHead(302, {
            Location: '/',
            'Set-Cookie': `${APP_COOKIE_NAME}=${encodeURIComponent(APP_COOKIE_VALUE)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
            'Cache-Control': 'no-store',
        });
        res.end();
        return;
    }

    sendAppLogin(res, 'Invalid username or password');
}

// ─────────────────────────────────────────────────────────
// SESSION: save & load
// ─────────────────────────────────────────────────────────
async function saveSession(ctx) {
    const storage = await ctx.storageState();
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(storage, null, 2));
    log('SESSION', `Saved to ${SESSION_FILE}`);
}

function loadSessionState() {
    if (!hasSession()) return {};
    try {
        return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    } catch {
        return {};
    }
}

async function restoreSessionState(ctx, pg) {
    const storage = loadSessionState();
    if (Array.isArray(storage.cookies) && storage.cookies.length) {
        await ctx.addCookies(storage.cookies);
    }

    if (Array.isArray(storage.origins) && storage.origins.length) {
        await pg.addInitScript(origins => {
            const origin = origins.find(item => item.origin === location.origin);
            if (!origin || !Array.isArray(origin.localStorage)) return;
            for (const entry of origin.localStorage) {
                localStorage.setItem(entry.name, entry.value);
            }
        }, storage.origins);
    }
}

function isAuthorized(reqUrl) {
    if (!ADMIN_TOKEN) return false;
    return reqUrl.searchParams.get('token') === ADMIN_TOKEN;
}

async function firstVisible(pg, selectors, timeout = 12000) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < deadline) {
        for (const selector of selectors) {
            try {
                const loc = pg.locator(selector).first();
                await loc.waitFor({ state: 'visible', timeout: 800 });
                return loc;
            } catch (e) {
                lastError = e;
            }
        }
    }
    throw new Error(`No visible selector found: ${selectors.join(', ')}${lastError ? ` (${lastError.message})` : ''}`);
}

async function clickIfVisible(pg, selectors) {
    for (const selector of selectors) {
        try {
            const loc = pg.locator(selector).first();
            if (await loc.isVisible({ timeout: 800 })) {
                await loc.click({ timeout: 3000 });
                return true;
            }
        } catch { }
    }
    return false;
}

async function saveLoginDebug(pg, reason) {
    try {
        fs.mkdirSync(path.dirname(LOGIN_DEBUG_FILE), { recursive: true });
        const html = await pg.content();
        fs.writeFileSync(LOGIN_DEBUG_FILE, `<!-- ${new Date().toISOString()} ${reason} URL=${pg.url()} -->\n${html}`);
        log('AUTO-LOGIN', `Saved debug HTML to ${LOGIN_DEBUG_FILE}`);
    } catch (e) {
        log('AUTO-LOGIN-DEBUG-ERR', e.message);
    }
}

async function findLoginInputs(pg) {
    const username = await firstVisible(pg, USERNAME_SELECTORS).catch(() => null);
    const password = await firstVisible(pg, PASSWORD_SELECTORS).catch(() => null);
    if (username && password) return { username, password };

    const inputs = await pg.locator('input:visible').all();
    let visiblePassword = password;
    let visibleUsername = username;
    for (const input of inputs) {
        const type = ((await input.getAttribute('type').catch(() => '')) || '').toLowerCase();
        if (!visiblePassword && type === 'password') {
            visiblePassword = input;
        } else if (!visibleUsername && ['text', 'email', 'tel', 'number', ''].includes(type)) {
            visibleUsername = input;
        }
    }
    if (!visibleUsername || !visiblePassword) {
        throw new Error(`Could not find login inputs. Visible input count: ${inputs.length}`);
    }
    return { username: visibleUsername, password: visiblePassword };
}

// Selectors for overlays that appear BEFORE login (cookie consent, age check, promo banners)
const PRE_LOGIN_OVERLAY_SELECTORS = [
    // Cookie / consent
    'button:has-text("Accept")',
    'button:has-text("Accept All")',
    'button:has-text("I Accept")',
    'button:has-text("Agree")',
    'button:has-text("OK")',
    'button:has-text("Got it")',
    // Age verification
    'button:has-text("I am 18")',
    'button:has-text("Yes, I am")',
    'button:has-text("Enter")',
    // Generic close/dismiss
    '[aria-label*="close" i]',
    '[aria-label*="dismiss" i]',
    '.close',
    '.btn-close',
    'button:has-text("×")',
    'button:has-text("✕")',
    // Promo/welcome modal close
    'div.close-home-modal',
    '.modal-close',
    '.popup-close',
    '[class*="close" i][class*="modal" i]',
    '[class*="close" i][class*="popup" i]',
];

async function saveScreenshot(pg, label) {
    try {
        const screenshotPath = path.join(path.dirname(LOGIN_DEBUG_FILE), `${label}.png`);
        await pg.screenshot({ path: screenshotPath, fullPage: false });
        log('DEBUG', `Screenshot saved → ${screenshotPath}`);
    } catch (e) {
        log('DEBUG', `Screenshot failed: ${e.message}`);
    }
}

async function openLoginForm(pg) {
    // Always start from homepage — rebel777 uses a modal, not a /login page
    await pg.goto(LOGIN_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pg.waitForTimeout(4000);

    // Dismiss any pre-login overlays (cookie consent, age check, promo banners)
    // that could be covering the Login button
    await clickIfVisible(pg, PRE_LOGIN_OVERLAY_SELECTORS);
    await pg.waitForTimeout(1000);
    // Try once more in case a second overlay appeared
    await clickIfVisible(pg, PRE_LOGIN_OVERLAY_SELECTORS);
    await pg.waitForTimeout(500);

    // If the password field is already visible (e.g. direct /login page), we're done
    if (await pg.locator('input[type="password"]:visible').count().catch(() => 0)) return;

    // Click the Login button to open the modal — prefer header/nav buttons over footer links
    const loginBtnSelectors = [
        'header button:has-text("Login")',
        'header a:has-text("Login")',
        'nav button:has-text("Login")',
        'nav a:has-text("Login")',
        'button:has-text("Login")',
        'a:has-text("Login")',
        'button:has-text("Log in")',
        'a:has-text("Log in")',
        'button:has-text("Sign In")',
        'a:has-text("Sign In")',
        'button:has-text("SIGN IN")',
        'button:has-text("LOG IN")',
        'button:has-text("LOGIN")',
        '[class*="login-btn" i]',
        '[class*="loginBtn" i]',
        '[class*="sign-in" i]',
        '[href*="/login" i]',
    ];

    await saveScreenshot(pg, 'before-login-click');

    const clicked = await clickIfVisible(pg, loginBtnSelectors);
    if (!clicked) {
        log('LOGIN', 'Could not find Login button — saving debug HTML + screenshot');
        await saveLoginDebug(pg, 'login-button-not-found');
        await saveScreenshot(pg, 'login-button-not-found');
        throw new Error('Login button not found on homepage. Check auto-login-debug.html and before-login-click.png for the page state.');
    }

    // Wait for the modal to appear with the password field
    try {
        await pg.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 10000 });
        log('LOGIN', 'Login modal appeared');
    } catch {
        // Modal did not appear — dismiss any overlay and try once more
        log('LOGIN', 'Modal did not appear after first click — dismissing overlays and retrying');
        await clickIfVisible(pg, PRE_LOGIN_OVERLAY_SELECTORS);
        await pg.waitForTimeout(1000);
        await clickIfVisible(pg, loginBtnSelectors);
        await pg.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 8000 });
    }
}

async function autoRefreshSession() {
    if (!REBEL777_USERNAME || !REBEL777_PASSWORD) {
        throw new Error('Missing REBEL777_USERNAME or REBEL777_PASSWORD env var');
    }

    if (loginBrowser) { await loginBrowser.close().catch(() => { }); loginBrowser = null; loginPage = null; }
    if (browser) { await browser.close().catch(() => { }); browser = null; page = null; }

    const loginDataDir = path.join(path.dirname(USER_DATA_DIR), `rebel777-login-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    log('AUTO-LOGIN', 'Starting headless Rebel login with a fresh browser profile...');
    const ctx = await playwright.chromium.launchPersistentContext(loginDataDir, {
        headless: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
    });

    try {
        await ctx.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        const pg = ctx.pages()[0] || await ctx.newPage();
        try {
            await openLoginForm(pg);
            const inputs = await findLoginInputs(pg);

            // Type credentials with a small human-like delay
            await inputs.username.click();
            await pg.waitForTimeout(300);
            await inputs.username.fill(REBEL777_USERNAME);
            await pg.waitForTimeout(400);
            await inputs.password.click();
            await pg.waitForTimeout(300);
            await inputs.password.fill(REBEL777_PASSWORD);
            await pg.waitForTimeout(500);

            log('AUTO-LOGIN', 'Credentials entered — looking for Login button in modal');

            // Look for the submit/login button inside the modal first, then fall back to generic
            const modalSubmitSelectors = [
                '.modal button:has-text("Login")',
                '.modal button:has-text("Log in")',
                '.modal button:has-text("Sign In")',
                '.modal button[type="submit"]',
                '.modal input[type="submit"]',
                '[role="dialog"] button:has-text("Login")',
                '[role="dialog"] button:has-text("Log in")',
                '[role="dialog"] button:has-text("Sign In")',
                '[role="dialog"] button[type="submit"]',
                '.popup button:has-text("Login")',
                '.popup button[type="submit"]',
                ...SUBMIT_SELECTORS,
            ];

            const submit = await firstVisible(pg, modalSubmitSelectors).catch(() => null);
            if (submit) {
                log('AUTO-LOGIN', 'Clicking Login button in modal');
                await submit.click();
            } else {
                log('AUTO-LOGIN', 'Submit button not found — pressing Enter on password field');
                await inputs.password.press('Enter');
            }

            // Wait for login to complete — URL change or networkidle, whichever comes first
            await Promise.race([
                pg.waitForURL(url => !url.includes('/login'), { timeout: 20000 }).catch(() => {}),
                pg.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {}),
            ]);

            await pg.waitForTimeout(4000);

            // Dismiss any post-login banner/popup
            await clickIfVisible(pg, BANNER_CLOSE_SELECTORS);
            await pg.waitForTimeout(1000);

            await saveSession(ctx);
        } catch (e) {
            await saveLoginDebug(pg, e.message);
            throw e;
        }

        return {
            ok: true,
            hasSession: hasSession(),
            sessionFile: SESSION_FILE,
            finalUrl: pg.url(),
            cookieCount: (await ctx.cookies()).length,
        };
    } finally {
        await ctx.close().catch(() => { });
        fs.rmSync(loginDataDir, { recursive: true, force: true });
    }
}

function refreshSessionOnStartup() {
    if (!AUTO_REFRESH_SESSION_ON_START) {
        log('AUTO-LOGIN', 'Startup session refresh disabled');
        return;
    }
    if (!REBEL777_USERNAME || !REBEL777_PASSWORD) {
        log('AUTO-LOGIN', 'Startup session refresh skipped: credentials not configured');
        return;
    }

    setTimeout(() => {
        autoRefreshSession()
            .then(result => log('AUTO-LOGIN', `Startup session refreshed (${result.cookieCount} cookies)`))
            .catch(e => log('AUTO-LOGIN-ERR', `Startup refresh failed: ${e.message}`));
    }, 1000);
}

// ─────────────────────────────────────────────────────────
// LOGIN FLOW — opens a visible browser window
// ─────────────────────────────────────────────────────────
async function startLogin(res) {
    // Close any existing login browser
    if (loginBrowser) { await loginBrowser.close().catch(() => { }); loginBrowser = null; loginPage = null; }
    if (browser) { await browser.close().catch(() => { }); browser = null; page = null; }

    log('LOGIN', 'Opening visible browser for manual login...');
    loginBrowser = await playwright.chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
    });

    await loginBrowser.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    loginPage = loginBrowser.pages()[0] || await loginBrowser.newPage();
    await loginPage.goto(LOGIN_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 20000 });

    log('LOGIN', 'Browser opened — log in, then visit http://localhost:3000/save-session');

    if (res) {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
        res.end(`
            <html><body style="font-family:monospace;background:#07090f;color:#b8cae8;padding:30px">
            <h2 style="color:#00d47e">✓ Login browser opened</h2>
            <p>A Chromium window has opened. Log into rebel777 in that window.</p>
            <p>When you are fully logged in and can see the odds, click below:</p>
            <br>
            <a href="/save-session" style="background:#6c63ff;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;font-size:14px">
                ✓ I'm logged in — Save Session
            </a>
            <br><br>
            <p style="color:#4a5a72;font-size:12px">Session will be saved to rebel777-session.json and reused automatically.</p>
            </body></html>
        `);
    }
}

async function saveSessionAndClose(res) {
    if (!loginBrowser || !loginPage) {
        if (res) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'No login browser open. Visit /login first.' })); }
        return;
    }

    try {
        const ctx = loginPage.context();
        await saveSession(ctx);
        log('SESSION', 'Session saved successfully ✓');

        if (res) {
            res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
            res.end(`
                <html><body style="font-family:monospace;background:#07090f;color:#b8cae8;padding:30px">
                <h2 style="color:#00d47e">✓ Session Saved!</h2>
                <p>rebel777-session.json written. You can close this tab.</p>
                <p>Now go to your tool and click <b style="color:#ffd44a">START</b> — it will use your saved login.</p>
                <br>
                <p style="color:#4a5a72;font-size:12px">You won't need to log in again unless your session expires.</p>
                </body></html>
            `);
        }

        browser = loginBrowser;
        page = loginPage;
        loginBrowser = null;
        loginPage = null;
        log('LOGIN', 'Login browser promoted to active scrape browser');

    } catch (e) {
        log('SESSION-ERR', e.message);
        if (res) { res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: e.message })); }
    }
}

// ─────────────────────────────────────────────────────────
// CORE SCRAPER — tuned to rebel777 DOM
// ─────────────────────────────────────────────────────────
async function scrapeOdds(pg) {
    return await pg.evaluate(() => {

        function parseCell(div) {
            const span = div.querySelector('[class="d-block odds"], [class*="d-block"][class*="odds"], span.odds');
            if (!span) return null;
            const odds = parseFloat(span.innerText.trim());
            if (isNaN(odds) || odds <= 1 || odds > 1000) return null;
            const lines = div.innerText.trim().split(/\s*\n\s*/);
            const size = lines.length > 1 ? parseFloat(lines[lines.length - 1].replace(/[^0-9.]/g, '')) || 0 : 0;
            return { odds, size };
        }

        const results = [];

        // Strategy 1: runner rows with bl-box cells
        const runnerRows = document.querySelectorAll(
            '[class*="runner-row"], [class*="brow"], [class*="market-runner"], [class*="runnerRow"]'
        );
        runnerRows.forEach(row => {
            const cells = row.querySelectorAll('[class*="bl-box"]');
            if (!cells.length) return;
            const nameEl = row.querySelector(
                '[class*="runner-name"], [class*="runnerName"], [class*="team-name"], [class*="teamName"], .btn, b, strong'
            );
            const name = nameEl?.innerText.trim().slice(0, 60);
            if (!name || name.length < 2) return;
            const back = [], lay = [];
            cells.forEach(cell => {
                const cls = cell.className || '';
                const c = parseCell(cell);
                if (!c) return;
                if (cls.includes('lay')) lay.push(c);
                else if (cls.includes('back')) back.push(c);
            });
            if (back.length || lay.length)
                results.push({ name, back: back.slice(0, 3), lay: lay.slice(0, 3) });
        });
        if (results.length >= 2) return results.slice(0, 2);

        // Strategy 2: global bl-box scan grouped by team name
        const allCells = Array.from(document.querySelectorAll('[class*="bl-box"]'));
        if (!allCells.length) return [];
        const nameEls = Array.from(document.querySelectorAll(
            '[class*="team"], [class*="runner"], [class*="selection"], [class*="player"]'
        )).map(el => el.innerText.trim()).filter(t => t.length > 2 && t.length < 60 && !/^\d/.test(t));
        const teams = [...new Set(nameEls)].slice(0, 6);
        for (let i = 0; i < (teams.length || 2); i++) {
            const chunk = allCells.slice(i * 6, i * 6 + 6);
            if (!chunk.length) break;
            const back = [], lay = [];
            chunk.forEach(cell => {
                const cls = cell.className || '';
                const c = parseCell(cell);
                if (!c) return;
                if (cls.includes('lay')) lay.push(c);
                else if (cls.includes('back')) back.push(c);
                else if (back.length < 3) back.push(c);
                else lay.push(c);
            });
            if (back.length || lay.length)
                results.push({ name: teams[i] || `Runner ${i + 1}`, back: back.slice(0, 3), lay: lay.slice(0, 3) });
        }
        if (results.length >= 2) return results.slice(0, 2);

        // Strategy 3: bare odds spans
        const oddsSpans = Array.from(document.querySelectorAll('[class="d-block odds"], [class*="d-block"][class*="odds"]'));
        if (!oddsSpans.length) return [];
        const fallbackNames = Array.from(document.querySelectorAll('h4,h5,h6,[class*="title"]'))
            .map(el => el.innerText.trim()).filter(t => t.length > 2 && !/^\d/.test(t)).slice(0, 4);
        const perRunner = Math.floor(oddsSpans.length / Math.max(fallbackNames.length, 2));
        for (let i = 0; i < Math.max(fallbackNames.length, 2); i++) {
            const chunk = oddsSpans.slice(i * perRunner, (i + 1) * perRunner);
            const parsed = chunk.map(sp => {
                const odds = parseFloat(sp.innerText.trim());
                const lines = sp.parentElement?.innerText?.trim().split(/\n/) || [];
                const size = lines.length > 1 ? parseFloat(lines[lines.length - 1].replace(/[^0-9.]/g, '')) || 0 : 0;
                return { odds, size };
            }).filter(o => o.odds > 1 && o.odds < 1000);
            const mid = Math.floor(parsed.length / 2);
            if (parsed.slice(0, mid).length)
                results.push({ name: fallbackNames[i] || `Runner ${i + 1}`, back: parsed.slice(0, mid), lay: parsed.slice(mid) });
        }
        return results.slice(0, 2);
    });
}

// ─────────────────────────────────────────────────────────
// WS FRAME PARSERS — Sprint platform formats
// ─────────────────────────────────────────────────────────

// Ladder format: rc = [ { id, batb: [[price,size],...], batl: [[price,size],...] } ]
// Runner names come from MarketDefinition — we cache them
let _runnerNames = {};
function parseLadder(rc) {
    if (!rc || rc.length < 2) return null;
    const runners = rc.slice(0, 2).map((r, i) => {
        const name = _runnerNames[r.id] || _runnerNames[String(r.id)] || `Runner ${i + 1}`;
        const back = (r.batb || []).slice(0, 3).map(([odds, size]) => ({ odds, size }));
        const lay = (r.batl || []).slice(0, 3).map(([odds, size]) => ({ odds, size }));
        if (!back.length && !lay.length) return null;
        return { name, back, lay };
    }).filter(Boolean);
    return runners.length >= 2 ? runners : null;
}

// Runners array format: [ { runnerName, ex: { availableToBack, availableToLay } } ]
function parseRunners(arr) {
    if (!Array.isArray(arr) || arr.length < 2) return null;
    const runners = arr.slice(0, 2).map(r => {
        const name = r.runnerName || r.name || r.teamName || r.selectionName || 'Runner';
        // Cache name→id for ladder parser
        if (r.selectionId) _runnerNames[r.selectionId] = name;
        const back = (r.ex?.availableToBack || r.back || r.availableToBack || []).slice(0, 3)
            .map(x => ({ odds: x.price ?? x.odds, size: x.size }));
        const lay = (r.ex?.availableToLay || r.lay || r.availableToLay || []).slice(0, 3)
            .map(x => ({ odds: x.price ?? x.odds, size: x.size }));
        return { name, back, lay };
    });
    return runners;
}

// ─────────────────────────────────────────────────────────
// POLL LOOP
// ─────────────────────────────────────────────────────────
async function doPoll() {
    if (!page || isScraping) return;
    isScraping = true;
    try {
        const runners = await scrapeOdds(page);

        if (!runners || runners.length < 2) {
            const snap = await page.evaluate(() => {
                const boxes = document.querySelectorAll('[class*="bl-box"]');
                const spans = document.querySelectorAll('[class="d-block odds"]');
                return {
                    blBoxCount: boxes.length,
                    oddsSpanCount: spans.length,
                    firstBoxHtml: boxes[0]?.outerHTML?.slice(0, 300) || 'none',
                    pageTitle: document.title,
                    url: location.href,
                    bodyClass: document.body?.className || '',
                    hasLoginFlag: localStorage.getItem('isLoggedin'),
                    hasUserDetails: !!localStorage.getItem('userDetails'),
                    // FIX: only treat as login page if a visible password field exists
                    // AND there are no odds elements — avoids nuking session on nav links
                    isLoginPage: !!document.querySelector('input[type="password"]:not([style*="display: none"])')
                        && !document.querySelector('[class*="odds"], [class*="bl-box"]'),
                };
            });
            log('POLL', `No odds — bl-boxes:${snap.blBoxCount} spans:${snap.oddsSpanCount} title:"${snap.pageTitle}" loginPage:${snap.isLoginPage}`);

            // FIX: dump page HTML so you can open debug-page.html and see exactly what headless got
            if (snap.blBoxCount === 0 && snap.oddsSpanCount === 0) {
                try {
                    const html = await page.content();
                    fs.writeFileSync(path.join(__dirname, 'debug-page.html'), html);
                    log('DEBUG', 'Dumped → debug-page.html (open in browser to see what headless got)');
                } catch { }
            }

            if (snap.isLoginPage) {
                broadcast({ type: 'error', msg: `⚠️ Session expired — visit ${PUBLIC_URL}/login to re-authenticate` });
                // Clear saved session so next start triggers fresh login
                if (hasSession()) { fs.unlinkSync(SESSION_FILE); log('SESSION', 'Expired session deleted'); }
            } else {
                broadcast({ type: 'debug', data: snap });
            }
            isScraping = false;
            return;
        }

        const changed = JSON.stringify(runners) !== JSON.stringify(lastOdds);
        if (changed) {
            lastOdds = runners;
            broadcast({ type: 'odds', data: { runners, _source: 'rebel777', _ts: Date.now() } });
            log('POLL', `✓ ${runners.map(r => r.name).join(' vs ')} → ${wsClients.size} client(s)`);
        } else {
            broadcast({ type: 'ping', ts: Date.now() });
        }
    } catch (e) {
        log('POLL-ERR', e.message);
        broadcast({ type: 'error', msg: e.message });
    }
    isScraping = false;
}

// ─────────────────────────────────────────────────────────
// START SCRAPING BROWSER (headless, with saved session)
// ─────────────────────────────────────────────────────────
async function startBrowser(targetUrl) {
    // Check session first
    if (!hasSession()) {
        broadcast({ type: 'error', msg: `⚠️ No session found. Visit ${PUBLIC_URL}/login to log in first.` });
        log('SESSION', 'No rebel777-session.json — login required');
        return;
    }

    if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = null; }
    if (loginBrowser && !browser) {
        browser = loginBrowser;
        loginBrowser = null;
        page = page || loginPage;
        loginPage = null;
        log('LOGIN', 'Reusing live login browser for scraping');
    }
    if (currentUrl !== targetUrl && page) {
        try {
            if (page.url() && page.url() !== 'about:blank') {
                await page.goto(LOGIN_ORIGIN, { waitUntil: 'load', timeout: 30000 }).catch(() => { });
            }
        } catch { }
        page = null;
    }
    currentUrl = targetUrl;

    if (!browser) {
        log('BROWSER', `Launching Chromium (${SCRAPE_HEADLESS ? 'headless' : 'visible'})...`);
        browser = await playwright.chromium.launchPersistentContext(USER_DATA_DIR, {
            headless: SCRAPE_HEADLESS,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            viewport: { width: 1366, height: 768 },
            locale: 'en-IN',
            timezoneId: 'Asia/Kolkata',
            extraHTTPHeaders: {
                'Accept-Language': 'en-IN,en;q=0.9',
                'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
            },
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security',
            ],
            ignoreDefaultArgs: ['--enable-automation'],
        });
        browser.on('disconnected', () => {
            log('BROWSER', 'Crashed — will relaunch on next call');
            browser = null; page = null;
        });
    }

    if (!page) {
        log('BROWSER', `Opening: ${targetUrl}`);
        broadcast({ type: 'status', msg: 'Opening rebel777 with saved session...', state: 'loading' });

        page = browser.pages()[0] || await browser.newPage();

        // FIX: anti-detection — hide webdriver flag from the site
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
            window.chrome = { runtime: {} };
        });
        await restoreSessionState(browser, page).catch(e => log('SESSION-RESTORE-ERR', e.message));

        // ── STRATEGY 1: Intercept rebel777's own WebSocket feed directly ──
        // Sprint platform pushes odds as JSON frames — parse them here instead of
        // scraping the DOM (which the fingerprint challenge blocks in headless).
        page.on('websocket', ws => {
            log('WS-INTERCEPT', `Opened: ${ws.url().slice(0, 100)}`);

            ws.on('framereceived', event => {
                try {
                    const raw = event.payload;
                    if (!raw || typeof raw !== 'string') return;

                    // Sprint/Betfair WS frames: try to find runners/odds arrays
                    const data = JSON.parse(raw);

                    // Cache runner names from MarketDefinition frames
                    if (data.MarketDefinition?.runners) {
                        data.MarketDefinition.runners.forEach(r => {
                            if (r.id && r.name) _runnerNames[r.id] = r.name;
                        });
                    }

                    // Common Sprint platform shapes:
                    // { t: 'ou', d: { mid: ..., runners: [...] } }
                    // { MarketDefinition: { runners: [...] } }
                    // { rc: [ { id, batb, batl } ] }   ← ladder format
                    let runners = null;

                    // Shape A: { rc: [...] } ladder — batb=back, batl=lay
                    if (data.rc && Array.isArray(data.rc)) {
                        runners = parseLadder(data.rc);
                    }
                    // Shape B: nested runners array
                    if (!runners && data.d?.runners) runners = parseRunners(data.d.runners);
                    if (!runners && data.runners) runners = parseRunners(data.runners);
                    // Shape C: { data: { market: { runners: [...] } } }
                    if (!runners && data.data?.market?.runners) runners = parseRunners(data.data.market.runners);
                    // Shape D: array of market objects
                    if (!runners && Array.isArray(data)) {
                        for (const item of data) {
                            if (item.runners) { runners = parseRunners(item.runners); break; }
                        }
                    }

                    if (runners && runners.length >= 2) {
                        const changed = JSON.stringify(runners) !== JSON.stringify(lastOdds);
                        if (changed) {
                            lastOdds = runners;
                            broadcast({ type: 'odds', data: { runners, _source: 'rebel777-ws', _ts: Date.now() } });
                            log('WS-ODDS', `✓ ${runners.map(r => r.name).join(' vs ')} → ${wsClients.size} client(s)`);
                        }
                    }
                } catch { /* non-JSON frames, ignore */ }
            });

            ws.on('framereceived', () => setTimeout(doPoll, 250)); // DOM fallback still runs
        });

        // FIX: all page interaction inside one try/catch, waitForSelector no longer orphaned outside
        try {
            // Warm the authenticated SPA first. Rebel777 sometimes drops deep links
            // back to "/" on a fresh context before auth state finishes hydrating.
            await page.goto(LOGIN_ORIGIN, { waitUntil: 'load', timeout: 30000 });
            await page.waitForLoadState('networkidle', { timeout: 15000 })
                .catch(() => log('WAIT', 'Warm-up networkidle timeout — continuing anyway'));

            const warmState = await page.evaluate(() => ({
                url: location.href,
                bodyClass: document.body?.className || '',
                isLoggedin: localStorage.getItem('isLoggedin'),
                hasUserDetails: !!localStorage.getItem('userDetails'),
                hasToken: !!localStorage.getItem('token'),
                hasPasswordInput: !!document.querySelector('input[type="password"]'),
            }));
            log('SESSION', `Warm-up → url:${warmState.url} body:"${warmState.bodyClass}" logged:${warmState.isLoggedin} user:${warmState.hasUserDetails} token:${warmState.hasToken}`);

            // FIX: 'load' instead of 'domcontentloaded' — waits for SPA JS to execute
            await page.evaluate(() => {
                const clickIfVisible = (el) => {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    const visible = style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                    if (!visible) return false;
                    el.click();
                    return true;
                };
                const selectors = [
                    '[aria-label="Close"]',
                    '[aria-label="close"]',
                    '.close',
                    '.btn-close',
                    '.modal .close',
                    '.popup .close',
                    '.banner .close',
                    '.swal2-close',
                    'button[class*="close"]',
                    'div[class*="close"]',
                    'span[class*="close"]',
                ];
                for (const selector of selectors) {
                    const nodes = Array.from(document.querySelectorAll(selector));
                    for (const node of nodes) {
                        if (clickIfVisible(node)) return;
                    }
                }
                const nodes = Array.from(document.querySelectorAll('button, div, span, a'));
                const fallback = nodes.find(el => /^(x|close|skip)$/i.test((el.textContent || '').trim()));
                if (fallback) clickIfVisible(fallback);
            }).catch(() => { });
            await page.waitForTimeout(1500).catch(() => { });
            await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
            await page.waitForLoadState('networkidle', { timeout: 15000 })
                .catch(() => log('WAIT', 'Target networkidle timeout — continuing anyway'));

            await page.evaluate(() => {
                const clickIfVisible = (el) => {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    const visible = style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                    if (!visible) return false;
                    el.click();
                    return true;
                };
                const selectors = [
                    '[aria-label="Close"]',
                    '[aria-label="close"]',
                    '.close',
                    '.btn-close',
                    '.modal .close',
                    '.popup .close',
                    '.banner .close',
                    '.swal2-close',
                    'button[class*="close"]',
                    'div[class*="close"]',
                    'span[class*="close"]',
                ];
                for (const selector of selectors) {
                    const nodes = Array.from(document.querySelectorAll(selector));
                    for (const node of nodes) {
                        if (clickIfVisible(node)) return;
                    }
                }
                const nodes = Array.from(document.querySelectorAll('button, div, span, a'));
                const fallback = nodes.find(el => /^(x|close|skip)$/i.test((el.textContent || '').trim()));
                if (fallback) clickIfVisible(fallback);
            }).catch(() => { });
            await page.waitForTimeout(1500).catch(() => { });

            const landed = await page.evaluate(() => ({
                url: location.href,
                bodyClass: document.body?.className || '',
                hasOdds: !!document.querySelector('span.odds, [class*="odds"], [class*="bl-box"], [class*="bet-btn"], [class*="back-price"], [class*="lay-price"]'),
            }));

            if (!landed.hasOdds && (landed.url === LOGIN_ORIGIN || landed.url === `${LOGIN_ORIGIN}/`)) {
                log('NAV', `Deep link bounced to home (${landed.url}) — retrying once after SPA warm-up`);
                await page.evaluate((url) => { location.href = url; }, targetUrl);
                await page.waitForLoadState('load', { timeout: 30000 }).catch(() => { });
            }

            log('BROWSER', `Loaded — waiting for odds elements (up to ${RENDER_WAIT_MS / 1000}s)...`);
            broadcast({ type: 'status', msg: 'Page loaded — waiting for odds to render...', state: 'loading' });

            // Wait for network to settle — SPA fetches session/markets after load.
            // WS interception above catches odds frames as soon as the site opens its feed.
            if (page) {
                await page.waitForLoadState('networkidle', { timeout: 15000 })
                    .catch(() => log('WAIT', 'networkidle timeout — continuing anyway'));
                // DOM selector as a bonus — works when session is healthy and site renders
                await page.waitForSelector(
                    'span.odds, [class*="odds"], [class*="bl-box"], [class*="bet-btn"], [class*="back-price"], [class*="lay-price"]',
                    { timeout: 8000 }
                ).then(() => {
                    broadcast({ type: 'status', msg: 'Odds elements detected — live!', state: 'ready' });
                }).catch(() => {
                    log('WAIT', 'DOM odds selector not found — relying on WS interception');
                    broadcast({ type: 'status', msg: 'Connected — waiting for WS odds feed...', state: 'ready' });
                });
            }
        } catch (e) {
            log('BROWSER-ERR', `Page load failed: ${e.message}`);
            broadcast({ type: 'error', msg: `Page load failed: ${e.message}` });
            // FIX: safely close page before nulling to avoid resource leak
            if (page) { await page.close().catch(() => { }); }
            page = null;
            return;
        }
    }

    await doPoll();
    scrapeTimer = setInterval(doPoll, SCRAPE_INTERVAL);
    log('POLL', `Running every ${SCRAPE_INTERVAL / 1000}s`);
}

async function stopScraper() {
    if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = null; }
    if (page) { await page.close().catch(() => { }); page = null; }
    lastOdds = null;
    broadcast({ type: 'status', msg: 'Scraper stopped', state: 'idle' });
    log('SCRAPER', 'Stopped');
}

// ─────────────────────────────────────────────────────────
// CHROMIUM FETCH — uses real Chrome TLS fingerprint (bypasses Cloudflare)
// Spins up a minimal context, does fetch() inside the page, returns JSON
// ─────────────────────────────────────────────────────────
const POLY_WORKER = 'https://ravi.ravisainagendra386-rs.workers.dev';

function workerFetch(targetUrl, res) {

    log('WORKER INPUT', targetUrl);

    try {
        const parsed = new URL(targetUrl);

        // 🚫 BLOCK SELF CALL (CRITICAL FIX)
        if (
            parsed.hostname.includes('workers.dev') ||
            parsed.hostname === 'localhost' ||
            parsed.hostname === '127.0.0.1'
        ) {
            log('BLOCKED SELF CALL', targetUrl);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Blocked unsafe URL' }));
        }

    } catch (e) {
        log('INVALID URL', targetUrl);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid URL' }));
    }
    const relayUrl = `${POLY_WORKER}?url=${encodeURIComponent(targetUrl)}`;
    const parsed = new URL(relayUrl);
    const req = https.request({
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Connection': 'close' },
        timeout: 10000,
    }, apiRes => {
        res.writeHead(apiRes.statusCode || 200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
        });
        apiRes.pipe(res);
        apiRes.on('error', () => { try { res.end(); } catch { } });
    });
    req.on('timeout', () => { req.destroy(); try { res.writeHead(504, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Worker timeout' })); } catch { } });
    req.on('error', e => { log('WORKER-ERR', e.message); try { res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: e.message })); } catch { } });
    req.end();
}

let chromiumFetchBrowser = null;

async function chromiumFetch(targetUrl, res) {
    try {
        // Launch or reuse a separate lightweight browser for API fetches
        if (!chromiumFetchBrowser) {
            chromiumFetchBrowser = await playwright.chromium.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
                ignoreDefaultArgs: ['--enable-automation'],
            });
            chromiumFetchBrowser.on('disconnected', () => { chromiumFetchBrowser = null; });
        }
        const ctx = await chromiumFetchBrowser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            locale: 'en-US',
        });
        const pg = await ctx.newPage();
        // Use page.evaluate to run fetch() inside Chrome — real TLS fingerprint
        const result = await pg.evaluate(async (url) => {
            try {
                const r = await fetch(url, {
                    headers: {
                        'Accept': 'application/json',
                        'Accept-Language': 'en-US,en;q=0.9',
                    }
                });
                const text = await r.text();
                return { ok: r.ok, status: r.status, body: text };
            } catch (e) {
                return { ok: false, status: 0, body: JSON.stringify({ error: e.message }) };
            }
        }, targetUrl);
        await ctx.close();

        res.writeHead(result.ok ? 200 : result.status, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
        });
        res.end(result.body);
        log('CHROME-FETCH', `✓ ${targetUrl.slice(0, 70)}`);
    } catch (e) {
        log('CHROME-FETCH-ERR', e.message);
        try {
            res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: e.message }));
        } catch { }
    }
}

// ─────────────────────────────────────────────────────────
// PROXY FETCH (Polymarket / direct JSON APIs)
// ─────────────────────────────────────────────────────────
function proxyFetch(targetUrl, res) {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const agent = isHttps ? new https.Agent({
        rejectUnauthorized: false,
        keepAlive: false,
        timeout: 15000,
        servername: parsed.hostname,   // SNI — required by Cloudflare/Polymarket
    }) : null;

    const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept-Encoding': 'identity',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'close',
        },
        timeout: 15000,
        ...(agent ? { agent } : {}),
    };

    const req = lib.request(options, apiRes => {
        res.writeHead(apiRes.statusCode || 200, {
            'Content-Type': apiRes.headers['content-type'] || 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
        });
        apiRes.pipe(res);
        apiRes.on('error', () => { try { res.end(); } catch { } });
    });
    req.on('timeout', () => {
        req.destroy();
        try { res.writeHead(504, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Upstream timeout' })); } catch { }
    });
    req.on('error', e => {
        log('PROXY-ERR', `${targetUrl.slice(0, 80)} — ${e.message}`);
        try { res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: e.message })); } catch { }
    });
    req.end();
}

// ─────────────────────────────────────────────────────────
// HTTP SERVER
// ─────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
        res.end(); return;
    }

    // ── /login — open visible browser for manual login ──
    if (parsed.pathname === '/login') {
        handleAppLogin(req, res).catch(e => { log('APP-LOGIN-ERR', e.message); res.writeHead(500); res.end(e.message); });
        return;
    }

    if (parsed.pathname === '/logout') {
        res.writeHead(302, {
            Location: '/login',
            'Set-Cookie': `${APP_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
            'Cache-Control': 'no-store',
        });
        res.end();
        return;
    }

    const isAdminPath = parsed.pathname === '/admin/refresh-session' || parsed.pathname === '/admin/login-debug';
    if (!isAppAuthed(req) && !isAdminPath) {
        if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
            res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
            res.end();
        } else {
            res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Login required' }));
        }
        return;
    }

    if (parsed.pathname === '/rebel-login') {
        startLogin(res).catch(e => { log('LOGIN-ERR', e.message); res.writeHead(500); res.end(e.message); });
        return;
    }

    // ── /save-session — save cookies after manual login ──
    if (parsed.pathname === '/save-session') {
        saveSessionAndClose(res).catch(e => { log('SAVE-ERR', e.message); res.writeHead(500); res.end(e.message); });
        return;
    }

    // ── /admin/refresh-session?token=... — headless prod login using env credentials ──
    if (parsed.pathname === '/admin/refresh-session') {
        if (!isAuthorized(parsed)) {
            res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
            return;
        }

        res.writeHead(202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        autoRefreshSession()
            .then(result => broadcast({ type: 'status', msg: 'Session refreshed', state: 'ready', result }))
            .catch(e => {
                log('AUTO-LOGIN-ERR', e.message);
                broadcast({ type: 'error', msg: `Auto login failed: ${e.message}` });
            });
        res.end(JSON.stringify({ ok: true, msg: 'Session refresh started. Check /session-status or server logs.' }));
        return;
    }

    // ── /session-status — check if session exists ──
    if (parsed.pathname === '/admin/login-debug') {
        if (!isAuthorized(parsed)) {
            res.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            res.end('Unauthorized');
            return;
        }
        if (!fs.existsSync(LOGIN_DEBUG_FILE)) {
            res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            res.end(`No debug file yet: ${LOGIN_DEBUG_FILE}`);
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(LOGIN_DEBUG_FILE, 'utf8'));
        return;
    }

    if (parsed.pathname === '/session-status') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ hasSession: hasSession(), file: SESSION_FILE }));
        return;
    }

    // ── /start-rebel777?url=... ──
    if (parsed.pathname === '/start-rebel777') {
        const target = parsed.searchParams.get('url');
        if (!target) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Missing ?url=' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, msg: 'Starting...' }));
        startBrowser(target).catch(e => log('ERR', e.message));
        return;
    }

    // ── /stop-rebel777 ──
    if (parsed.pathname === '/stop-rebel777') {
        stopScraper().catch(() => { });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // ── /set-interval?ms=5000 ──
    if (parsed.pathname === '/set-interval') {
        const ms = parseInt(parsed.searchParams.get('ms'));
        if (ms >= 250 && ms <= 60000) {
            SCRAPE_INTERVAL = ms;
            if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = page ? setInterval(doPoll, ms) : null; }
            log('INTERVAL', `Poll rate → ${ms}ms`);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ ok: true, ms }));
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'ms must be 1000–60000' }));
        }
        return;
    }

    // ── /debug ──
    if (parsed.pathname === '/debug') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ hasSession: hasSession(), lastOdds, wsClients: wsClients.size, currentUrl, isScraping, scrapeInterval: SCRAPE_INTERVAL }, null, 2));
        return;
    }

    // ── /debug-screenshot?name=before-login-click ──
    if (parsed.pathname === '/debug-screenshot') {
        const name = parsed.searchParams.get('name') || 'before-login-click';
        const imgPath = path.join(path.dirname(LOGIN_DEBUG_FILE), `${name}.png`);
        if (fs.existsSync(imgPath)) {
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
            fs.createReadStream(imgPath).pipe(res);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end(`Screenshot not found: ${imgPath}. Available names: before-login-click, login-button-not-found`);
        }
        return;
    }

    // ── /debug-html ──
    if (parsed.pathname === '/debug-html') {
        if (fs.existsSync(LOGIN_DEBUG_FILE)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            fs.createReadStream(LOGIN_DEBUG_FILE).pipe(res);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Debug HTML not found — login failure has not occurred yet.');
        }
        return;
    }

    // ── /poly-fetch?url=... — uses headless Chrome TLS fingerprint to bypass Cloudflare ──
    if (parsed.pathname === '/poly-fetch') {
        const target = parsed.searchParams.get('url');
        if (!target) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Missing ?url=' })); return;
        }
        workerFetch(target, res); return;
    }

    // ── /proxy?url=... ──
    if (parsed.pathname === '/proxy') {
        const target = parsed.searchParams.get('url');
        if (!target) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Missing ?url=' })); return; }
        proxyFetch(target, res); return;
    }

    // ── / → serve HTML ──
    if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
        const htmlPath = path.join(__dirname, 'decimal-bot.html');
        if (fs.existsSync(htmlPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' });
            res.end(fs.readFileSync(htmlPath));
        } else {
            res.writeHead(404);
            res.end('decimal-bot.html not found in the same folder');
        }
        return;
    }
    res.writeHead(404); res.end('Not found');
});

// ─────────────────────────────────────────────────────────
// WEBSOCKET SERVER
// ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
    if (!isAppAuthed(req)) {
        ws.close(1008, 'Login required');
        return;
    }

    wsClients.add(ws);
    log('WS', `Client connected (${wsClients.size} total)`);

    // Tell client immediately if session is missing
    if (!hasSession()) {
        ws.send(JSON.stringify({ type: 'error', msg: `⚠️ No session — visit ${PUBLIC_URL}/login first` }));
    } else if (lastOdds) {
        ws.send(JSON.stringify({ type: 'odds', data: { runners: lastOdds, _source: 'rebel777', _ts: Date.now() } }));
    } else {
        ws.send(JSON.stringify({ type: 'status', msg: 'Connected — paste rebel777 URL and click START', state: 'idle' }));
    }

    ws.on('close', () => { wsClients.delete(ws); log('WS', `Disconnected (${wsClients.size} total)`); });
    ws.on('error', () => wsClients.delete(ws));
});

// ─────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
    console.log('\n[SHUTDOWN] Closing...');
    if (scrapeTimer) clearInterval(scrapeTimer);
    if (browser) await browser.close().catch(() => { });
    if (loginBrowser) await loginBrowser.close().catch(() => { });
    process.exit(0);
});

// ─────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    const sessionStatus = hasSession() ? '✓ Session found — ready to scrape' : '⚠ No session — open /login first';
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║   IPL Arb Proxy v4  —  Session-Persistent Edition            ║
╠══════════════════════════════════════════════════════════════╣
║  UI:            ${PUBLIC_URL}
║  Login:         ${PUBLIC_URL}/login
║  Save session:  ${PUBLIC_URL}/save-session
║  Debug:         ${PUBLIC_URL}/debug
╠══════════════════════════════════════════════════════════════╣
║  ${sessionStatus.padEnd(58)}║
╚══════════════════════════════════════════════════════════════╝
`);

    if (!hasSession()) {
        console.log(`  👉 First time setup: open ${PUBLIC_URL}/login in your browser\n`);
    }
});



// ─────────────────────────────────────────────────────────

refreshSessionOnStartup();

if (RESTART_EVERY_HOURS > 0) {
    const restartMs = RESTART_EVERY_HOURS * 60 * 60 * 1000;
    setTimeout(() => {
        log('RESTART', `Scheduled restart after ${RESTART_EVERY_HOURS} hour(s)`);
        process.exit(0);
    }, restartMs);
}

//1. node proxy.js
//2. Open http://localhost:3000/login  ← opens a VISIBLE Chromium window
//3. Log into rebel777 in that window normally
//4. Once you can see match odds, go to http://localhost:3000/save-session
//5. Done — rebel777-session.json is saved to disk

// ─────────────────────────────────────────────────────────
