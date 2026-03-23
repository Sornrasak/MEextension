#!/usr/bin/env bun
/// <reference types="bun-types" />

/**
 * Shared Puppeteer runner for DOM-based (and API-based) handlers.
 *
 * Launches a real Chrome browser, navigates to the target URL,
 * injects the handler script, and intercepts the resulting download.
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { resolve, join, dirname } from "path";

export interface RunDomHandlerOptions {
  /** URL to navigate to */
  url: string;
  /** Absolute path to the built handler JS file */
  handlerScript: string;
  /** Directory where downloaded files will be saved */
  outputDir: string;
  /** Run headless (default true) */
  headless?: boolean;
  /** Chrome user-data-dir for reusing login sessions */
  userDataDir?: string;
  /** Maximum time to wait for extraction in ms (default 5 minutes) */
  timeout?: number;
  /** Path to a cookie JSON file for session persistence */
  cookieFile?: string;
  /** Cookie JSON injected via environment, usually for remote auth bootstrap */
  cookieJson?: string;
  /** Human-readable source label for cookieJson */
  cookieJsonSource?: string;
  /** If true, pause after navigation for manual login and save cookies */
  login?: boolean;
}

export interface RunResult {
  /** Files that appeared in the output directory */
  downloadedFiles: string[];
  /** Whether the handler completed (vs timed out) */
  completed: boolean;
}

/**
 * Launch Chrome, navigate to url, inject handlerScript, wait for download.
 */
export async function runDomHandler(
  opts: RunDomHandlerOptions
): Promise<RunResult> {
  const {
    url,
    handlerScript,
    outputDir,
    headless = true,
    userDataDir,
    timeout = 5 * 60 * 1000,
    cookieFile,
    cookieJson,
    cookieJsonSource,
    login = false,
  } = opts;

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Snapshot files already present so we can detect new ones
  const existingFiles = new Set(safeReaddir(outputDir));

  console.log("Launching browser...");

  const launchArgs: string[] = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
  ];
  const executablePath = resolveChromeExecutablePath();

  const browser: Browser = await puppeteer.launch({
    headless: headless ? true : false,
    args: launchArgs,
    defaultViewport: { width: 1280, height: 900 },
    ...(executablePath ? { executablePath } : {}),
    ...(userDataDir ? { userDataDir: resolve(userDataDir) } : {}),
  });

  const page: Page = await browser.newPage();

  // ---- Bypass Content Security Policy ----------------------------------
  // Handlers fetch images from domains (e.g. viewer.takecomic.jp) that the
  // page's CSP connect-src does not allow. Chrome extensions bypass CSP
  // automatically, but Puppeteer-injected scripts do not.
  await page.setBypassCSP(true);

  // ---- Download interception via CDP -----------------------------------
  const client = await page.createCDPSession();
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: resolve(outputDir),
  });

  // Also use the newer Browser.setDownloadBehavior if available
  try {
    await client.send("Browser.setDownloadBehavior" as any, {
      behavior: "allow",
      downloadPath: resolve(outputDir),
      eventsEnabled: true,
    });
  } catch {
    // Older Chrome versions may not support this; that's OK
  }

  // ---- Load saved cookies before navigation ------------------------------
  const cookiesToSet = mergeCookies([
    cookieFile && existsSync(cookieFile)
      ? {
          cookies: readCookiesFromFile(cookieFile),
          source: cookieFile,
        }
      : null,
    cookieJson
      ? {
          cookies: parseCookieJson(
            cookieJson,
            cookieJsonSource ?? "environment cookie JSON"
          ),
          source: cookieJsonSource ?? "environment cookie JSON",
        }
      : null,
  ]);

  if (cookiesToSet.length > 0) {
    await page.setCookie(...cookiesToSet);
    console.log(`Loaded ${cookiesToSet.length} cookies before navigation`);
  }

  if (cookieFile && cookieJson && cookiesToSet.length > 0) {
    ensureParentDir(cookieFile);
    writeFileSync(cookieFile, JSON.stringify(cookiesToSet, null, 2));
    console.log(
      `Persisted ${cookiesToSet.length} merged cookies to ${cookieFile} for reuse`
    );
  }

  // ---- Navigate --------------------------------------------------------
  console.log(`Navigating to ${url} ...`);
  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 60_000,
  });

  // ---- Login mode: pause for manual auth, then save cookies -------------
  if (login) {
    console.log("\n  ┌──────────────────────────────────────────────┐");
    console.log("  │  Log in to the site in the browser window.   │");
    console.log("  │  Press Enter here when done...               │");
    console.log("  └──────────────────────────────────────────────┘\n");
    await waitForEnter();

    if (cookieFile) {
      ensureParentDir(cookieFile);
      const cookies = await page.cookies();
      writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
      console.log(`Saved ${cookies.length} cookies to ${cookieFile}`);
    }

    // Reload to pick up the authenticated state
    console.log("Reloading page with authenticated session...");
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 60_000,
    });
  }

  console.log("Page loaded. Injecting handler script...");

  // ---- Capture page console output (MUST be before handler injection) ---
  page.on("console", (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === "error") {
      console.error(`[page] ${text}`);
    } else if (type === "warn") {
      console.warn(`[page] ${text}`);
    } else {
      console.log(`[page] ${text}`);
    }
  });

  // ---- Inject handler --------------------------------------------------
  // Override alert/confirm so they don't block headless execution
  await page.evaluate(() => {
    window.alert = (msg?: string) => console.warn("[alert]", msg);
    window.confirm = (_msg?: string) => true;
    window.prompt = (_msg?: string, def?: string) => def ?? "";
  });

  await page.addScriptTag({ path: handlerScript });
  console.log("Handler injected. Waiting for extraction to complete...");

  // ---- Wait for download -----------------------------------------------
  const completed = await waitForNewFiles(outputDir, existingFiles, timeout);

  // Give a little extra time for file-saver to finish writing
  await new Promise((r) => setTimeout(r, 2000));

  const allFiles = safeReaddir(outputDir);
  const newFiles = allFiles.filter((f) => !existingFiles.has(f));

  if (newFiles.length > 0) {
    console.log(`\nDownloaded ${newFiles.length} file(s):`);
    for (const f of newFiles) {
      const stat = statSync(join(outputDir, f));
      const sizeKB = (stat.size / 1024).toFixed(1);
      console.log(`  ${f}  (${sizeKB} KB)`);
    }
  } else {
    console.warn("\nNo new files detected in output directory.");
    console.log(
      "The handler may have written to a different location, or extraction failed."
    );
    console.log("Check the browser console output above for details.");
  }

  await browser.close();

  return {
    downloadedFiles: newFiles,
    completed,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readCookiesFromFile(path: string): puppeteer.Protocol.Network.CookieParam[] {
  return parseCookieJson(readFileSync(path, "utf-8"), path);
}

function parseCookieJson(
  rawJson: string,
  source: string
): puppeteer.Protocol.Network.CookieParam[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`Failed to parse cookies from ${source}: ${String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Cookie source ${source} must be a JSON array`);
  }

  return parsed.map((cookie, index) => {
    if (!cookie || typeof cookie !== "object") {
      throw new Error(`Cookie ${index + 1} from ${source} is not an object`);
    }

    return cookie as puppeteer.Protocol.Network.CookieParam;
  });
}

function mergeCookies(
  sources: Array<
    | {
        cookies: puppeteer.Protocol.Network.CookieParam[];
        source: string;
      }
    | null
  >
): puppeteer.Protocol.Network.CookieParam[] {
  const merged = new Map<string, puppeteer.Protocol.Network.CookieParam>();

  for (const source of sources) {
    if (!source || source.cookies.length === 0) {
      continue;
    }

    console.log(`Loaded ${source.cookies.length} cookies from ${source.source}`);

    for (const cookie of source.cookies) {
      merged.set(getCookieKey(cookie), cookie);
    }
  }

  return [...merged.values()];
}

function getCookieKey(cookie: puppeteer.Protocol.Network.CookieParam): string {
  return [
    cookie.name ?? "",
    cookie.domain ?? "",
    cookie.path ?? "",
    cookie.url ?? "",
  ].join("|");
}

function ensureParentDir(filePath: string): void {
  const parentDir = dirname(filePath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }
}

function resolveChromeExecutablePath(): string | undefined {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_EXECUTABLE_PATH,
    "/usr/local/bin/google-chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];

  return candidates.find((candidate) => candidate && existsSync(candidate));
}

/**
 * Poll the output directory for new files. Returns true if new files
 * appeared within the timeout, false if timed out.
 */
async function waitForNewFiles(
  dir: string,
  existingFiles: Set<string>,
  timeout: number
): Promise<boolean> {
  const pollInterval = 2000; // 2 seconds
  const deadline = Date.now() + timeout;
  let lastCount = 0;
  let stableChecks = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const current = safeReaddir(dir);
    const newFiles = current.filter(
      (f) => !existingFiles.has(f) && !f.endsWith(".crdownload") && !f.endsWith(".tmp")
    );

    if (newFiles.length > 0) {
      // Files appeared -- wait for them to stabilize (no new files for 3 checks)
      if (newFiles.length === lastCount) {
        stableChecks++;
        if (stableChecks >= 3) {
          return true;
        }
      } else {
        stableChecks = 0;
        lastCount = newFiles.length;
      }
    }
  }

  // Check one final time
  const finalFiles = safeReaddir(dir).filter(
    (f) => !existingFiles.has(f) && !f.endsWith(".crdownload") && !f.endsWith(".tmp")
  );
  return finalFiles.length > 0;
}

/**
 * Wait for the user to press Enter in the terminal.
 */
function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const onData = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      resolve();
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}
