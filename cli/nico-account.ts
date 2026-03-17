#!/usr/bin/env bun
/// <reference types="bun-types" />

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { parseArgs } from "util";
import { randomInt } from "crypto";

import { ImapFlow } from "imapflow";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { runDomHandler } from "./puppeteer-runner";

type Command = "help" | "ensure" | "scrape";

type MailMatch = {
  mailbox: string;
  uid: number;
  verificationUrl: string;
  receivedAt: string;
};

type NicoAccountState = {
  email: string;
  password: string;
  nickname: string;
  sex: string;
  birthYear: string;
  birthMonth: string;
  birthDay: string;
  country: string;
  mailboxEmail: string;
  createdAt: string;
  lastLoginAt?: string;
  lastValidatedAt?: string;
  userId?: string;
};

type EnsureResult = {
  mode: "cookies" | "login" | "register";
  account: NicoAccountState;
  cookieFile: string;
  readerPageCount: number;
};

type NicoCliConfig = {
  command: Command;
  url?: string;
  watchUrl: string;
  outputDir: string;
  headed: boolean;
  help: boolean;
  verify: boolean;
  cookieFile: string;
  accountFile: string;
  registrationEmail?: string;
  mailboxEmail?: string;
  mailPasswordEnv: string;
  nickname: string;
  sex: string;
  birthYear: string;
  birthMonth: string;
  birthDay: string;
  country: string;
  accountPassword?: string;
  mailTimeoutMs: number;
  readerTimeoutMs: number;
  registrationAttempts: number;
};

type ReaderAccessResult = {
  accessible: boolean;
  pageCount: number;
  gated: boolean;
  url: string;
  title: string;
  snippet: string;
};

const DEFAULT_WATCH_URL = "https://manga.nicovideo.jp/watch/mg472312";
const DEFAULT_HANDLER_SCRIPT = resolve("build/handlers/nico-manga.js");
const DEFAULT_OUTPUT_DIR = resolve("./output/nico-manga");
const DEFAULT_COOKIE_FILE = resolve("cli/cookies/nico-manga.json");
const DEFAULT_ACCOUNT_FILE = resolve("cli/cookies/nico-manga-account.json");
const NICO_REGISTER_URL = "https://account.nicovideo.jp/register/email?site=niconico";
const NICO_LOGIN_URL = "https://account.nicovideo.jp/login?site=niconico";
const NICO_MAILBOXES = ["INBOX", "[Gmail]/Spam", "[Gmail]/All Mail"];
const NICO_MAIL_SUBJECT = "Niconico Account Registration Notice";
const NICO_MAIL_SENDER = "account@nicovideo.jp";
const READER_GATE_TEXT = "ご視聴にはniconicoアカウントが必要です";

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    url: { type: "string", short: "u" },
    out: { type: "string", short: "o", default: DEFAULT_OUTPUT_DIR },
    watchUrl: { type: "string", default: DEFAULT_WATCH_URL },
    headed: { type: "boolean", default: false },
    verify: { type: "boolean", default: false },
    cookieFile: { type: "string", default: DEFAULT_COOKIE_FILE },
    accountFile: { type: "string", default: DEFAULT_ACCOUNT_FILE },
    registrationEmail: { type: "string" },
    mailboxEmail: { type: "string" },
    mailPasswordEnv: { type: "string", default: "ME1_APP_PASS" },
    nickname: { type: "string", default: "ME Bot Nico" },
    sex: { type: "string", default: "unanswered" },
    birthYear: { type: "string", default: "1990" },
    birthMonth: { type: "string", default: "1" },
    birthDay: { type: "string", default: "1" },
    country: { type: "string", default: "United States" },
    password: { type: "string" },
    mailTimeout: { type: "string", default: "180" },
    readerTimeout: { type: "string", default: "30" },
    registrationAttempts: { type: "string", default: "20" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: true,
});

const command = ((positionals[0] ?? "help") as Command) satisfies Command;

const config: NicoCliConfig = {
  command,
  url: values.url,
  watchUrl: values.watchUrl ?? DEFAULT_WATCH_URL,
  outputDir: resolve(values.out ?? DEFAULT_OUTPUT_DIR),
  headed: values.headed ?? false,
  help: values.help ?? false,
  verify: values.verify ?? false,
  cookieFile: resolve(values.cookieFile ?? DEFAULT_COOKIE_FILE),
  accountFile: resolve(values.accountFile ?? DEFAULT_ACCOUNT_FILE),
  registrationEmail: values.registrationEmail,
  mailboxEmail: values.mailboxEmail ?? process.env.AUTOMATION_EMAIL,
  mailPasswordEnv: values.mailPasswordEnv ?? "ME1_APP_PASS",
  nickname: values.nickname ?? "ME Bot Nico",
  sex: values.sex ?? "unanswered",
  birthYear: values.birthYear ?? "1990",
  birthMonth: values.birthMonth ?? "1",
  birthDay: values.birthDay ?? "1",
  country: values.country ?? "United States",
  accountPassword: values.password ?? process.env.NICO_ACCOUNT_PASSWORD,
  mailTimeoutMs: Number(values.mailTimeout ?? "180") * 1000,
  readerTimeoutMs: Number(values.readerTimeout ?? "30") * 1000,
  registrationAttempts: Number(values.registrationAttempts ?? "20"),
};

if (config.help || command === "help" || !["ensure", "scrape"].includes(command)) {
  console.log(`Nico account helper
Usage:
  bun cli/nico-account.ts ensure [options]
  bun cli/nico-account.ts scrape --url "https://manga.nicovideo.jp/watch/mg472312" [options]

Commands:
  ensure    Ensure a reusable Nico account + cookie jar exist
  scrape    Ensure auth, then run the nico-manga extractor

Options:
  -u, --url                 Nico watch URL to extract (required for scrape)
  -o, --out                 Output directory for scrape (default: ${DEFAULT_OUTPUT_DIR})
      --watchUrl            Reader URL used to validate auth (default: ${DEFAULT_WATCH_URL})
      --headed              Show the browser during login/extraction
      --verify              Print a reminder to run cli/verify after scrape
      --cookieFile          Cookie jar path (default: ${DEFAULT_COOKIE_FILE})
      --accountFile         Stored Nico credentials path (default: ${DEFAULT_ACCOUNT_FILE})
      --registrationEmail   Explicit email to register instead of generating a Gmail dotted alias
      --mailboxEmail        Mailbox address used for IMAP polling (default: AUTOMATION_EMAIL)
      --mailPasswordEnv     Env var name containing the Gmail app password (default: ME1_APP_PASS)
      --password            Nico account password (default: generated once and stored in account file)
      --nickname            Nickname for newly created accounts (default: "ME Bot Nico")
      --sex                 One of: male, female, other, unanswered
      --birthYear           Birth year for new accounts (default: 1990)
      --birthMonth          Birth month for new accounts (default: 1)
      --birthDay            Birth day for new accounts (default: 1)
      --country             Country for new accounts (default: United States)
      --mailTimeout         Seconds to wait for Nico verification mail (default: 180)
      --readerTimeout       Seconds to wait for reader access checks (default: 30)
      --registrationAttempts Number of dotted-alias attempts before failing (default: 20)

Notes:
  - Newly created Nico credentials are stored in ${DEFAULT_ACCOUNT_FILE}
  - Cookie jars are stored in ${DEFAULT_COOKIE_FILE}
  - Both paths live under cli/cookies/, which is gitignored
`);
  process.exit(command === "help" || config.help ? 0 : 1);
}

if (config.command === "scrape" && !config.url) {
  console.error("Missing required --url for scrape");
  process.exit(1);
}

await main(config);

async function main(cliConfig: NicoCliConfig): Promise<void> {
  ensureParentDir(cliConfig.cookieFile);
  ensureParentDir(cliConfig.accountFile);
  ensureDir(cliConfig.outputDir);

  console.log(`Command:    ${cliConfig.command}`);
  console.log(`Watch URL:  ${cliConfig.watchUrl}`);
  if (cliConfig.url) {
    console.log(`Extract URL: ${cliConfig.url}`);
  }
  console.log(`Cookies:    ${cliConfig.cookieFile}`);
  console.log(`Account:    ${cliConfig.accountFile}`);
  console.log();

  const ensured = await ensureNicoSession(cliConfig);
  console.log(
    `Auth ready via ${ensured.mode}. Reader shows ${ensured.readerPageCount} page container(s).`
  );

  if (cliConfig.command !== "scrape") {
    return;
  }

  if (!existsSync(DEFAULT_HANDLER_SCRIPT)) {
    throw new Error(
      `Missing built handler at ${DEFAULT_HANDLER_SCRIPT}. Run "bun run build" first.`
    );
  }

  const result = await runDomHandler({
    url: cliConfig.url!,
    handlerScript: DEFAULT_HANDLER_SCRIPT,
    outputDir: cliConfig.outputDir,
    headless: !cliConfig.headed,
    cookieFile: cliConfig.cookieFile,
  });

  if (!result.completed) {
    throw new Error("Extraction did not complete before timing out");
  }

  if (cliConfig.verify) {
    console.log(
      `\nRun verification:\n  bun cli/verify.ts --input "${cliConfig.outputDir}"\n`
    );
  }
}

async function ensureNicoSession(cliConfig: NicoCliConfig): Promise<EnsureResult> {
  const account = readAccountFile(cliConfig.accountFile);

  if (existsSync(cliConfig.cookieFile)) {
    const cookieCheck = await validateSavedCookies(cliConfig);
    if (cookieCheck.accessible) {
      const activeAccount = account ?? {
        email: cliConfig.registrationEmail ?? cliConfig.mailboxEmail ?? "unknown",
        password: cliConfig.accountPassword ?? "(cookie-only)",
        nickname: cliConfig.nickname,
        sex: cliConfig.sex,
        birthYear: cliConfig.birthYear,
        birthMonth: cliConfig.birthMonth,
        birthDay: cliConfig.birthDay,
        country: cliConfig.country,
        mailboxEmail: cliConfig.mailboxEmail ?? "unknown",
        createdAt: new Date().toISOString(),
        lastValidatedAt: new Date().toISOString(),
      };
      activeAccount.lastValidatedAt = new Date().toISOString();
      writeAccountFile(cliConfig.accountFile, activeAccount);
      return {
        mode: "cookies",
        account: activeAccount,
        cookieFile: cliConfig.cookieFile,
        readerPageCount: cookieCheck.pageCount,
      };
    }
    console.warn("Saved Nico cookies are present but no longer grant reader access.");
  }

  if (account) {
    const loginResult = await loginWithSavedAccount(cliConfig, account);
    account.lastLoginAt = new Date().toISOString();
    account.lastValidatedAt = new Date().toISOString();
    writeAccountFile(cliConfig.accountFile, account);
    return {
      mode: "login",
      account,
      cookieFile: cliConfig.cookieFile,
      readerPageCount: loginResult.pageCount,
    };
  }

  const registeredAccount = await registerFreshAccount(cliConfig);
  writeAccountFile(cliConfig.accountFile, registeredAccount);
  return {
    mode: "register",
    account: registeredAccount,
    cookieFile: cliConfig.cookieFile,
    readerPageCount: await validateCookieFileOrThrow(cliConfig),
  };
}

async function validateSavedCookies(
  cliConfig: NicoCliConfig
): Promise<ReaderAccessResult> {
  const browser = await launchBrowser(true);
  try {
    const page = await browser.newPage();
    const cookies = parseCookieJson(readFileSync(cliConfig.cookieFile, "utf-8"), cliConfig.cookieFile);
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
    }
    const access = await inspectReaderAccess(page, cliConfig.watchUrl, cliConfig.readerTimeoutMs);
    if (access.accessible) {
      await saveNicoCookies(page, cliConfig.cookieFile);
    }
    return access;
  } finally {
    await browser.close();
  }
}

async function loginWithSavedAccount(
  cliConfig: NicoCliConfig,
  account: NicoAccountState
): Promise<ReaderAccessResult> {
  const browser = await launchBrowser(!cliConfig.headed);
  try {
    const page = await browser.newPage();
    await page.goto(NICO_LOGIN_URL, { waitUntil: "networkidle2", timeout: 60_000 });
    await page.waitForSelector("#input__mailtel", { timeout: 60_000 });

    await replaceInputValue(page, "#input__mailtel", account.email);
    await replaceInputValue(page, "#input__password", account.password);

    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60_000 }),
      page.click("#login__submit"),
    ]);

    const loginError = await page
      .$eval(".notice-error, .text-danger, .error", (el) => el.textContent?.trim() ?? "")
      .catch(() => "");
    if (loginError) {
      throw new Error(`Nico login rejected stored credentials: ${loginError}`);
    }

    const access = await inspectReaderAccess(page, cliConfig.watchUrl, cliConfig.readerTimeoutMs);
    if (!access.accessible) {
      throw new Error(`Stored account login completed but reader is still gated: ${access.snippet}`);
    }

    await saveNicoCookies(page, cliConfig.cookieFile);
    return access;
  } finally {
    await browser.close();
  }
}

async function registerFreshAccount(cliConfig: NicoCliConfig): Promise<NicoAccountState> {
  const mailboxEmail = requireValue(
    cliConfig.mailboxEmail,
    "mailboxEmail / AUTOMATION_EMAIL"
  );
  const mailboxPassword = requireEnv(cliConfig.mailPasswordEnv);
  const password = cliConfig.accountPassword ?? generateNicoPassword();

  const browser = await launchBrowser(false);

  try {
    const page = await browser.newPage();
    const candidateEmails = buildRegistrationEmailCandidates(
      mailboxEmail,
      cliConfig.registrationEmail,
      cliConfig.registrationAttempts
    );

    for (const email of candidateEmails) {
      console.log(`Trying Nico registration email: ${email}`);
      const submittedAt = Date.now();
      const registrationStepReached = await submitRegistrationEmail(page, email);

      if (!registrationStepReached) {
        console.warn(`Registration form did not accept ${email}; trying another candidate.`);
        continue;
      }

      const mail = await waitForVerificationMail({
        mailboxEmail,
        mailboxPassword,
        registeredEmail: email,
        afterMs: submittedAt,
        timeoutMs: cliConfig.mailTimeoutMs,
      });

      const userId = await completeRegistrationProfile(page, mail.verificationUrl, {
        nickname: cliConfig.nickname,
        sex: cliConfig.sex,
        birthYear: cliConfig.birthYear,
        birthMonth: cliConfig.birthMonth,
        birthDay: cliConfig.birthDay,
        country: cliConfig.country,
        password,
      });

      const access = await inspectReaderAccess(page, cliConfig.watchUrl, cliConfig.readerTimeoutMs);
      if (!access.accessible) {
        throw new Error(`Registration succeeded but reader is still gated: ${access.snippet}`);
      }

      await saveNicoCookies(page, cliConfig.cookieFile);

      return {
        email,
        password,
        nickname: cliConfig.nickname,
        sex: cliConfig.sex,
        birthYear: cliConfig.birthYear,
        birthMonth: cliConfig.birthMonth,
        birthDay: cliConfig.birthDay,
        country: cliConfig.country,
        mailboxEmail,
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
        lastValidatedAt: new Date().toISOString(),
        userId,
      };
    }

    throw new Error(
      `Failed to register a Nico account after ${candidateEmails.length} email attempt(s)`
    );
  } finally {
    await browser.close();
  }
}

async function submitRegistrationEmail(page: Page, email: string): Promise<boolean> {
  await page.goto(NICO_REGISTER_URL, { waitUntil: "networkidle2", timeout: 60_000 });
  await page.waitForSelector('input[name="email_address"]', { timeout: 60_000 });
  await replaceInputValue(page, 'input[name="email_address"]', email);

  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>("#button");
    return !!button && !button.disabled;
  }, { timeout: 45_000 });

  await page.click("#button");

  await Promise.race([
    page.waitForFunction(
      () => document.body.innerText.includes("Please check your email."),
      { timeout: 30_000 }
    ),
    page.waitForFunction(
      () => document.body.innerText.includes("メールアドレスを確認してください。"),
      { timeout: 30_000 }
    ),
  ]).catch(() => null);

  const bodyText = await page.evaluate(() => document.body.innerText);
  if (
    bodyText.includes("Please check your email.") ||
    bodyText.includes("メールアドレスを確認してください。")
  ) {
    return true;
  }

  if (bodyText.includes("Invalid email address")) {
    return false;
  }

  return false;
}

async function waitForVerificationMail(opts: {
  mailboxEmail: string;
  mailboxPassword: string;
  registeredEmail: string;
  afterMs: number;
  timeoutMs: number;
}): Promise<MailMatch> {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: opts.mailboxEmail,
      pass: opts.mailboxPassword,
    },
    logger: false,
  });

  await client.connect();

  try {
    const deadline = Date.now() + opts.timeoutMs;

    while (Date.now() < deadline) {
      for (const mailbox of NICO_MAILBOXES) {
        const lock = await client.getMailboxLock(mailbox);
        try {
          const start = Math.max(1, client.mailbox.exists - 50);
          for await (const message of client.fetch(
            `${start}:*`,
            {
              uid: true,
              internalDate: true,
              envelope: true,
              source: true,
            },
            { uid: false }
          )) {
            const decoded = decodeQuotedPrintable(message.source.toString("utf-8"));
            const receivedAt = message.internalDate?.getTime() ?? 0;
            if (receivedAt < opts.afterMs - 5_000) {
              continue;
            }
            if (!decoded.includes(opts.registeredEmail)) {
              continue;
            }
            if (
              !decoded.includes(NICO_MAIL_SENDER) &&
              message.envelope?.subject !== NICO_MAIL_SUBJECT
            ) {
              continue;
            }

            const verificationUrl =
              decoded.match(
                /https:\/\/account\.nicovideo\.jp\/register\/profile\?token=[^\s"'<>]+/
              )?.[0] ?? null;
            if (!verificationUrl) {
              continue;
            }

            return {
              mailbox,
              uid: message.uid,
              verificationUrl,
              receivedAt: message.internalDate?.toISOString() ?? new Date(receivedAt).toISOString(),
            };
          }
        } finally {
          lock.release();
        }
      }

      await delay(3_000);
    }
  } finally {
    await client.logout().catch(() => {});
  }

  throw new Error(
    `Timed out waiting for Nico verification mail for ${opts.registeredEmail}`
  );
}

async function completeRegistrationProfile(
  page: Page,
  verificationUrl: string,
  profile: {
    nickname: string;
    sex: string;
    birthYear: string;
    birthMonth: string;
    birthDay: string;
    country: string;
    password: string;
  }
): Promise<string | undefined> {
  await page.goto(verificationUrl, { waitUntil: "networkidle2", timeout: 60_000 });
  await page.waitForSelector("#nickname", { timeout: 60_000 });

  await replaceInputValue(page, "#nickname", profile.nickname);
  await page.select('select[name="sex"]', profile.sex);
  await page.select('select[name="month"]', profile.birthMonth);
  await page.select('select[name="day"]', profile.birthDay);
  await page.select('select[name="year"]', profile.birthYear);
  await page.select('select[name="country"]', profile.country);
  await delay(500);
  await replaceInputValue(page, "#password", profile.password);
  await replaceInputValue(page, "#repassword", profile.password);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60_000 }),
    page.click("#button"),
  ]);

  await page.waitForSelector("#turnstile-verified-submit", { timeout: 60_000 });

  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60_000 }),
    page.click("#turnstile-verified-submit"),
  ]);

  await page.waitForFunction(
    () =>
      location.pathname.includes("/register/commit") ||
      document.body.innerText.includes("Registration complete!"),
    { timeout: 60_000 }
  );

  const bodyText = await page.evaluate(() => document.body.innerText);
  const userIdMatch =
    bodyText.match(/User ID is\s+(\d+)/i) ??
    bodyText.match(/ユーザーIDは\s*(\d+)/);

  return userIdMatch?.[1];
}

async function inspectReaderAccess(
  page: Page,
  watchUrl: string,
  timeoutMs: number
): Promise<ReaderAccessResult> {
  await page.goto(watchUrl, { waitUntil: "networkidle2", timeout: 60_000 });
  await delay(2_000);

  await page
    .waitForFunction(
      () => {
        const pageCount = document.querySelectorAll("li.page").length;
        return (
          pageCount > 0 ||
          document.body.innerText.includes("ご視聴にはniconicoアカウントが必要です")
        );
      },
      { timeout: timeoutMs }
    )
    .catch(() => null);

  return page.evaluate((gateText) => {
    const pageCount = document.querySelectorAll("li.page").length;
    const bodyText = document.body.innerText.replace(/\s+/g, " ").trim();
    const gated = bodyText.includes(gateText);
    return {
      accessible: pageCount > 0 && !gated,
      pageCount,
      gated,
      url: location.href,
      title: document.title,
      snippet: bodyText.slice(0, 500),
    };
  }, READER_GATE_TEXT);
}

async function validateCookieFileOrThrow(cliConfig: NicoCliConfig): Promise<number> {
  const access = await validateSavedCookies(cliConfig);
  if (!access.accessible) {
    throw new Error(`Cookie validation failed after ensure flow: ${access.snippet}`);
  }
  return access.pageCount;
}

async function saveNicoCookies(page: Page, cookieFile: string): Promise<void> {
  const cookies = await page.cookies(
    "https://account.nicovideo.jp",
    "https://www.nicovideo.jp",
    "https://manga.nicovideo.jp"
  );
  ensureParentDir(cookieFile);
  writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
}

function readAccountFile(path: string): NicoAccountState | null {
  if (!existsSync(path)) {
    return null;
  }

  const parsed = JSON.parse(readFileSync(path, "utf-8")) as NicoAccountState;
  if (!parsed.email || !parsed.password) {
    return null;
  }
  return parsed;
}

function writeAccountFile(path: string, account: NicoAccountState): void {
  ensureParentDir(path);
  writeFileSync(path, JSON.stringify(account, null, 2));
}

function buildRegistrationEmailCandidates(
  mailboxEmail: string,
  explicitRegistrationEmail: string | undefined,
  attempts: number
): string[] {
  if (explicitRegistrationEmail) {
    return [explicitRegistrationEmail];
  }

  const [localPart, domain] = mailboxEmail.split("@");
  const normalizedLocal = localPart.replace(/\./g, "");
  const isGmail = /^(gmail|googlemail)\.com$/i.test(domain);
  if (!isGmail || normalizedLocal.length < 2) {
    return [mailboxEmail];
  }

  const maxMask = 1 << (normalizedLocal.length - 1);
  const seen = new Set<number>();
  const emails: string[] = [];

  while (emails.length < attempts && seen.size < maxMask - 1) {
    const mask = randomInt(1, maxMask);
    if (seen.has(mask)) {
      continue;
    }
    seen.add(mask);
    emails.push(applyDotMask(normalizedLocal, domain, mask));
  }

  return emails;
}

function applyDotMask(localPart: string, domain: string, mask: number): string {
  const chars = localPart.split("");
  const output = [chars[0]];
  let remainingMask = mask;

  for (let index = 1; index < chars.length; index++) {
    if (remainingMask & 1) {
      output.push(".");
    }
    output.push(chars[index]);
    remainingMask >>= 1;
  }

  return `${output.join("")}@${domain}`;
}

function generateNicoPassword(): string {
  return `Nico!${randomInt(100000, 999999)}Aa`;
}

function parseCookieJson(rawJson: string, source: string): puppeteer.Protocol.Network.CookieParam[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`Failed to parse cookie JSON from ${source}: ${String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Cookie JSON from ${source} must be an array`);
  }

  return parsed as puppeteer.Protocol.Network.CookieParam[];
}

function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=(\r?\n)/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    );
}

async function replaceInputValue(page: Page, selector: string, value: string): Promise<void> {
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type(selector, value, { delay: 15 });
}

async function launchBrowser(headless: boolean): Promise<Browser> {
  return puppeteer.launch({
    headless: headless ? true : false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
    defaultViewport: { width: 1280, height: 900 },
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`Missing required value: ${label}`);
  }
  return value;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function ensureParentDir(filePath: string): void {
  ensureDir(dirname(filePath));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
