#!/usr/bin/env node
/**
 * Usage:
 *   node tools/create_session_browser.js <username> <password> [totp_seed] [--append sessions.jsonl] [--headless]
 *
 * Examples:
 *   node tools/create_session_browser.js myuser mypass TOTP_SECRET
 *   node tools/create_session_browser.js myuser mypass TOTP_SECRET --append sessions.jsonl
 *   node tools/create_session_browser.js myuser mypass TOTP_SECRET --headless
 *
 * Output:
 *   {"kind":"cookie","username":"...","id":"...","auth_token":"...","ct0":"..."}
 *
 * Notes:
 * - Headless mode can increase detection risk.
 * - If running as root and Chrome refuses to launch, the script already passes
 *   no-sandbox flags like the Python version.
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { authenticator } = require('otplib');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function hardenPage(page) {
  const userAgent =
    process.env.PUPPETEER_UA ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

  await page.setUserAgent(userAgent);
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });
}

async function waitForSelectorAny(page, selectors, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const sel of selectors) {
      const found = await page.$(sel);
      if (found) return sel;
    }
    await sleep(200);
  }
  throw new Error(`Timeout waiting for selectors: ${selectors.join(', ')}`);
}

function extractUserIdFromTwid(twid) {
  if (!twid) return null;
  if (twid.includes('u%3D')) return twid.split('u%3D')[1].split('&')[0].replace(/"/g, '');
  if (twid.includes('u=')) return twid.split('u=')[1].split('&')[0].replace(/"/g, '');
  return null;
}

async function performLogin(page, { username, password, totpSeed }) {
  await page.goto('https://x.com/i/flow/login', { waitUntil: 'networkidle2', timeout: 60000 });

  // Username
  await page.waitForSelector('input[autocomplete="username"]', { visible: true, timeout: 20000 });
  await page.type('input[autocomplete="username"]', username, { delay: 80 });
  await page.keyboard.press('Enter');
  await sleep(800);

  // Handle possible double username prompt
  const nextSel = await waitForSelectorAny(page, ['input[type="password"]', 'input[autocomplete="username"]'], 20000);
  if (nextSel === 'input[autocomplete="username"]') {
    await page.type('input[autocomplete="username"]', username, { delay: 80 });
    await page.keyboard.press('Enter');
    await sleep(800);
    await page.waitForSelector('input[type="password"]', { visible: true, timeout: 20000 });
  }

  // Password
  await page.type('input[type="password"]', password, { delay: 40 });
  // Try to click login, fall back to Enter
  const loginButton = await page.$('[data-testid="LoginForm_Login_Button"]');
  if (loginButton) {
    await loginButton.click().catch(() => {});
  } else {
    await page.keyboard.press('Enter');
  }

  // 2FA
  try {
    await page.waitForSelector('[data-testid="ocfEnterTextTextInput"]', { visible: true, timeout: 8000 });
    if (!totpSeed) throw new Error('2FA required but no TOTP seed provided');
    const code = authenticator.generate(totpSeed);
    await page.type('[data-testid="ocfEnterTextTextInput"]', code, { delay: 30 });
    const nextBtn = await page.$('[data-testid="ocfEnterTextNextButton"]');
    if (nextBtn) await nextBtn.click().catch(() => {});
  } catch (err) {
    // If selector not found, no 2FA prompt; rethrow only if it was a missing TOTP
    if (err?.message?.includes('TOTP')) throw err;
  }
}

async function waitForAuthCookies(page, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const cookies = await page.cookies('https://x.com');
    const map = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
    if (map.auth_token && map.ct0) {
      const userId = extractUserIdFromTwid(map.twid);
      return { ...map, id: userId };
    }
    await sleep(1000);
  }
  throw new Error('Timeout waiting for auth_token/ct0 cookies');
}

async function loginAndGetCookies({ username, password, totpSeed, headless }) {
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH || (fsSync.existsSync(macChrome) ? macChrome : undefined);

  const browser = await puppeteer.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--lang=en-US,en',
    ],
    executablePath,
  });

  try {
    const page = await browser.newPage();
    await hardenPage(page);
    await performLogin(page, { username, password, totpSeed });
    return await waitForAuthCookies(page);
  } finally {
    await browser.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.error('Usage: node tools/create_session_browser.js <username> <password> [totp_seed] [--append file.jsonl] [--headless]');
    process.exit(1);
  }

  const username = argv[0];
  const password = argv[1];
  let totpSeed = null;
  let appendFile = null;
  let headless = false;

  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--append') {
      if (i + 1 >= argv.length) {
        console.error('[!] Error: --append requires a filename');
        process.exit(1);
      }
      appendFile = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg === '--headless') {
      headless = true;
      i += 1;
      continue;
    }
    if (!arg.startsWith('--') && totpSeed === null) {
      totpSeed = arg;
    } else {
      console.error(`[!] Warning: Unknown argument: ${arg}`);
    }
    i += 1;
  }

  try {
    const cookies = await loginAndGetCookies({ username, password, totpSeed, headless });
    const session = {
      kind: 'cookie',
      username,
      id: cookies.id,
      auth_token: cookies.auth_token,
      ct0: cookies.ct0,
    };
    const output = JSON.stringify(session);

    if (appendFile) {
      const dest = path.resolve(process.cwd(), appendFile);
      await fs.appendFile(dest, `${output}\n`, 'utf8');
      console.error(`✓ Session appended to ${dest}`);
    } else {
      console.log(output);
    }
    process.exit(0);
  } catch (err) {
    console.error(`[!] Error: ${err?.message || err}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}


