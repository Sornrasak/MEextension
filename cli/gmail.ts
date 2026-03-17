#!/usr/bin/env bun
/// <reference types="bun-types" />

import { createServer } from "http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { parseArgs } from "util";

import puppeteer, { type Browser, type Page } from "puppeteer";

type GmailTokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

type StoredToken = GmailTokenResponse & {
  obtained_at: number;
  automation_email: string;
};

type GmailMessageListResponse = {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

type GmailMessageResponse = {
  id: string;
  snippet: string;
  internalDate: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<GmailMessagePart>;
  };
};

type GmailMessagePart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: Array<GmailMessagePart>;
};

const DEFAULT_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify";
const DEFAULT_TOKEN_FILE = resolve("cli/tokens/gmail.json");
const NICO_VERIFICATION_SENDER = "info@account.nicovideo.jp";

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    headed: { type: "boolean", default: false },
    browser: { type: "boolean", default: false },
    port: { type: "string", default: "8765" },
    query: { type: "string" },
    max: { type: "string", default: "10" },
    timeout: { type: "string", default: "180" },
    tokenFile: { type: "string", default: DEFAULT_TOKEN_FILE },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: true,
});

const command = positionals[0] ?? "help";
const tokenFile = resolve(values.tokenFile!);

if (values.help || command === "help") {
  console.log(`Gmail helper
Usage:
  bun cli/gmail.ts auth [--browser] [--headed] [--port 8765]
  bun cli/gmail.ts profile
  bun cli/gmail.ts list [--query "from:foo@example.com"] [--max 10]
  bun cli/gmail.ts latest-nico

Env:
  AUTOMATION_EMAIL   Gmail address
  GGL_CLIENT_ID      Google OAuth client id
  GGL_SECRET         Google OAuth client secret
  GMAIL_TOKEN_JSON   Optional full stored token bundle for fresh-machine reuse

Notes:
  - If an env var exists whose NAME is the value of AUTOMATION_EMAIL,
    its value is treated as the Google account password for browser login.
  - Otherwise, AUTOMATION_EMAIL_PASSWORD is used when present.
  - Successful auth writes a token bundle to ${tokenFile}
  - To reuse auth on fresh machines, save that file's full JSON as GMAIL_TOKEN_JSON
`);
  process.exit(0);
}

switch (command) {
  case "auth":
    await runAuthFlow({
      tokenFile,
      port: Number(values.port),
      openBrowser: values.browser ?? false,
      headed: values.headed ?? false,
    });
    break;
  case "profile":
    await printProfile(tokenFile);
    break;
  case "list":
    await listMessages(tokenFile, values.query, Number(values.max));
    break;
  case "latest-nico":
    await printLatestNicoVerification(tokenFile);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}

async function runAuthFlow(opts: {
  tokenFile: string;
  port: number;
  openBrowser: boolean;
  headed: boolean;
}): Promise<void> {
  const clientId = requiredEnv("GGL_CLIENT_ID");
  const clientSecret = requiredEnv("GGL_SECRET");
  const automationEmail = requiredEnv("AUTOMATION_EMAIL");
  const redirectUri = `http://127.0.0.1:${opts.port}/callback`;
  const authUrl = buildAuthUrl(clientId, redirectUri, DEFAULT_SCOPE);

  console.log(`Starting Gmail OAuth flow for ${automationEmail}`);
  console.log(`Callback: ${redirectUri}`);
  console.log(`Auth URL: ${authUrl}`);

  const code = await waitForAuthCode({
    authUrl,
    redirectUri,
    port: opts.port,
    openBrowser: opts.openBrowser,
    headed: opts.headed,
    automationEmail,
  });

  console.log("Received authorization code. Exchanging for tokens...");
  const token = await exchangeAuthCode({
    clientId,
    clientSecret,
    code,
    redirectUri,
  });

  ensureParentDir(opts.tokenFile);
  const storedToken: StoredToken = {
    ...token,
    obtained_at: Date.now(),
    automation_email: automationEmail,
  };
  writeFileSync(opts.tokenFile, JSON.stringify(storedToken, null, 2));
  console.log(`Saved Gmail token response to ${opts.tokenFile}`);
  console.log(
    `For fresh-machine reuse, save the full JSON from ${opts.tokenFile} as GMAIL_TOKEN_JSON`
  );

  const profile = await gmailApiRequest(token.access_token, "/users/me/profile");
  console.log(JSON.stringify(profile, null, 2));
}

async function printProfile(tokenFilePath: string): Promise<void> {
  const accessToken = await getAccessToken(tokenFilePath);
  const profile = await gmailApiRequest(accessToken, "/users/me/profile");
  console.log(JSON.stringify(profile, null, 2));
}

async function listMessages(
  tokenFilePath: string,
  query: string | undefined,
  max: number
): Promise<void> {
  const accessToken = await getAccessToken(tokenFilePath);
  const params = new URLSearchParams();
  params.set("maxResults", String(max));
  if (query) {
    params.set("q", query);
  }

  const list = (await gmailApiRequest(
    accessToken,
    `/users/me/messages?${params.toString()}`
  )) as GmailMessageListResponse;

  console.log(JSON.stringify(list, null, 2));
}

async function printLatestNicoVerification(tokenFilePath: string): Promise<void> {
  const accessToken = await getAccessToken(tokenFilePath);
  const query = `from:${NICO_VERIFICATION_SENDER} newer_than:14d`;
  const params = new URLSearchParams({
    maxResults: "5",
    q: query,
  });
  const list = (await gmailApiRequest(
    accessToken,
    `/users/me/messages?${params.toString()}`
  )) as GmailMessageListResponse;

  if (!list.messages?.length) {
    console.log("No recent Nico verification messages found.");
    return;
  }

  const latest = await gmailApiRequest(
    accessToken,
    `/users/me/messages/${list.messages[0].id}?format=full`
  );
  const message = latest as GmailMessageResponse;
  const headers = indexHeaders(message.payload?.headers ?? []);
  const text = extractTextContent(message.payload);
  const verificationUrl = text.match(/https:\/\/account\.nicovideo\.jp\/[^\s>"']+/)?.[0];

  console.log(
    JSON.stringify(
      {
        id: message.id,
        internalDate: message.internalDate,
        from: headers.from,
        subject: headers.subject,
        snippet: message.snippet,
        verificationUrl,
      },
      null,
      2
    )
  );
}

async function waitForAuthCode(opts: {
  authUrl: string;
  redirectUri: string;
  port: number;
  openBrowser: boolean;
  headed: boolean;
  automationEmail: string;
}): Promise<string> {
  const password = resolveAutomationPassword(opts.automationEmail);
  let browser: Browser | null = null;

  const codePromise = new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for Gmail OAuth callback"));
    }, 5 * 60_000);

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", opts.redirectUri);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`OAuth error: ${error}`);
        clearTimeout(timeoutId);
        server.close();
        reject(new Error(`OAuth callback returned error: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Missing code");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Gmail auth complete. You can close this tab.");
      clearTimeout(timeoutId);
      server.close();
      resolve(code);
    });

    server.listen(opts.port, "127.0.0.1", () => {
      console.log(`Listening for OAuth callback on ${opts.redirectUri}`);
    });
  });

  if (opts.openBrowser) {
    browser = await puppeteer.launch({
      headless: opts.headed ? false : true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
      defaultViewport: { width: 1280, height: 900 },
    });
    const page = await browser.newPage();
    await page.goto(opts.authUrl, { waitUntil: "networkidle2", timeout: 60_000 });

    if (password) {
      await autoFillGoogleLogin(page, opts.automationEmail, password);
    } else {
      console.log(
        "No password env found for the automation email; complete login manually in the opened browser."
      );
    }
  } else {
    console.log("Open the auth URL in a browser to continue.");
  }

  try {
    return await codePromise;
  } finally {
    await browser?.close();
  }
}

async function autoFillGoogleLogin(
  page: Page,
  email: string,
  password: string
): Promise<void> {
  console.log("Attempting automated Google login...");

  await page.waitForSelector('input[type="email"]', { timeout: 60_000 });
  await page.type('input[type="email"]', email, { delay: 50 });
  await clickGoogleButton(page, "#identifierNext button, #identifierNext");

  await page.waitForSelector('input[type="password"]', { timeout: 60_000 });
  await page.type('input[type="password"]', password, { delay: 50 });
  await clickGoogleButton(page, "#passwordNext button, #passwordNext");

  console.log(
    "Submitted Google credentials. Additional verification/consent may still require manual completion."
  );
}

async function clickGoogleButton(
  page: Page,
  selector: string
): Promise<void> {
  await page.waitForSelector(selector, { timeout: 60_000 });
  await page.click(selector);
}

function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  scope: string
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeAuthCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<GmailTokenResponse> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      grant_type: "authorization_code",
      redirect_uri: opts.redirectUri,
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}): ${body}`);
  }

  return JSON.parse(body) as GmailTokenResponse;
}

async function getAccessToken(tokenFilePath: string): Promise<string> {
  const stored = readStoredToken(tokenFilePath);
  if (!stored.expires_in) {
    return stored.access_token;
  }

  const expiresAt = stored.obtained_at + stored.expires_in * 1000 - 60_000;
  if (Date.now() < expiresAt) {
    return stored.access_token;
  }

  if (!stored.refresh_token) {
    throw new Error(
      `Stored token at ${tokenFilePath} is expired and does not include refresh_token`
    );
  }

  const refreshed = await refreshAccessToken(stored.refresh_token);
  const updated: StoredToken = {
    ...stored,
    ...refreshed,
    refresh_token: refreshed.refresh_token ?? stored.refresh_token,
    obtained_at: Date.now(),
  };
  writeFileSync(tokenFilePath, JSON.stringify(updated, null, 2));
  return updated.access_token;
}

async function refreshAccessToken(refreshToken: string): Promise<GmailTokenResponse> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: requiredEnv("GGL_CLIENT_ID"),
      client_secret: requiredEnv("GGL_SECRET"),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status}): ${body}`);
  }

  return JSON.parse(body) as GmailTokenResponse;
}

async function gmailApiRequest(
  accessToken: string,
  path: string
): Promise<unknown> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Gmail API request failed (${response.status}): ${body}`);
  }
  return JSON.parse(body);
}

function readStoredToken(path: string): StoredToken {
  if (process.env.GMAIL_TOKEN_JSON) {
    const storedFromEnv = parseStoredToken(
      process.env.GMAIL_TOKEN_JSON,
      "GMAIL_TOKEN_JSON"
    );
    ensureParentDir(path);
    writeFileSync(path, JSON.stringify(storedFromEnv, null, 2));
    console.log(`Loaded Gmail token bundle from GMAIL_TOKEN_JSON into ${path}`);
    return storedFromEnv;
  }

  if (!existsSync(path)) {
    throw new Error(
      `Token file not found: ${path}. Provide GMAIL_TOKEN_JSON or run \`bun cli/gmail.ts auth --browser --headed\` first.`
    );
  }
  return parseStoredToken(readFileSync(path, "utf-8"), path);
}

function indexHeaders(
  headers: Array<{ name: string; value: string }>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of headers) {
    out[header.name.toLowerCase()] = header.value;
  }
  return out;
}

function extractTextContent(
  payload: GmailMessageResponse["payload"] | undefined
): string {
  if (!payload) {
    return "";
  }

  const chunks: string[] = [];
  collectTextParts(payload, chunks);
  return chunks.join("\n");
}

function collectTextParts(
  part: GmailMessagePart | { body?: { data?: string }; parts?: GmailMessagePart[] },
  chunks: string[]
): void {
  if (part.body?.data) {
    chunks.push(decodeBase64Url(part.body.data));
  }

  if (part.parts) {
    for (const child of part.parts) {
      collectTextParts(child, chunks);
    }
  }
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
    "utf-8"
  );
}

function parseStoredToken(rawJson: string, source: string): StoredToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(
      `Failed to parse Gmail token bundle from ${source}: ${String(error)}`
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Gmail token bundle from ${source} must be a JSON object`);
  }

  const token = parsed as Partial<StoredToken>;
  if (!token.access_token || typeof token.access_token !== "string") {
    throw new Error(`Gmail token bundle from ${source} is missing access_token`);
  }

  return token as StoredToken;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function resolveAutomationPassword(automationEmail: string): string | undefined {
  if (process.env[automationEmail]) {
    return process.env[automationEmail];
  }

  if (process.env.AUTOMATION_EMAIL_PASSWORD) {
    return process.env.AUTOMATION_EMAIL_PASSWORD;
  }

  const emailNamedSecrets = Object.entries(process.env).filter(
    ([key, value]) => key.includes("@") && !!value
  );

  if (emailNamedSecrets.length === 1) {
    console.log(
      `Using sole email-keyed secret ${emailNamedSecrets[0][0]} for Google password input`
    );
    return emailNamedSecrets[0][1];
  }

  return undefined;
}

function ensureParentDir(filePath: string): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}
