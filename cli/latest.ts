#!/usr/bin/env bun
/// <reference types="bun-types" />

import { parseArgs } from "util";

type OutputFormat = "text" | "json" | "shell";

type ReaderKey = "nico-manga";

type EpisodeSummary = {
  url: string;
  title: string;
  index: number;
  accessLabel: string;
};

type ResolverResult = {
  reader: ReaderKey;
  seriesUrl: string;
  seriesTitle: string;
  latestListed: EpisodeSummary | null;
  latestFree: EpisodeSummary | null;
  latestFreeShortcutUrl: string | null;
  resolvedAt: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    reader: { type: "string", short: "r", default: "nico-manga" },
    seriesUrl: { type: "string", short: "u" },
    format: { type: "string", short: "f", default: "text" },
    timeout: { type: "string", default: String(DEFAULT_TIMEOUT_MS / 1000) },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help || !values.seriesUrl) {
  console.log(`Latest episode resolver
Usage:
  bun cli/latest.ts --reader nico-manga --seriesUrl "https://manga.nicovideo.jp/comic/47265" [options]

Options:
  -r, --reader      Reader to resolve (currently: nico-manga)
  -u, --seriesUrl   Series URL to inspect (required)
  -f, --format      Output format: text, json, shell (default: text)
      --timeout     Request timeout in seconds (default: ${DEFAULT_TIMEOUT_MS / 1000})
  -h, --help        Show this help
`);
  process.exit(values.help ? 0 : 1);
}

const reader = values.reader as ReaderKey;
const format = values.format as OutputFormat;

if (reader !== "nico-manga") {
  console.error(`Unsupported reader "${values.reader}". Available: nico-manga`);
  process.exit(1);
}

if (!["text", "json", "shell"].includes(format)) {
  console.error(`Unsupported format "${values.format}". Available: text, json, shell`);
  process.exit(1);
}

const seriesUrl = new URL(values.seriesUrl).toString();
const timeoutMs = Number(values.timeout) * 1000;

const result = await resolveNicoMangaSeries(seriesUrl, timeoutMs);

if (format === "json") {
  console.log(JSON.stringify(result, null, 2));
} else if (format === "shell") {
  printShell(result);
} else {
  printText(result);
}

async function resolveNicoMangaSeries(
  seriesUrl: string,
  timeoutMs: number
): Promise<ResolverResult> {
  const html = await fetchText(seriesUrl, timeoutMs);
  const seriesTitle = extractSeriesTitle(html);
  const episodes = parseNicoEpisodes(html, seriesUrl);

  if (episodes.length === 0) {
    throw new Error(`No Nico episode entries found on ${seriesUrl}`);
  }

  const latestListed = episodes[episodes.length - 1] ?? null;
  const latestFreeShortcutUrl = extractLatestFreeShortcutUrl(html, seriesUrl);
  const latestFreeUrl = latestFreeShortcutUrl
    ? await resolveFinalUrl(latestFreeShortcutUrl, timeoutMs)
    : null;
  const latestFree = latestFreeUrl
    ? episodes.find((episode) => normalizeEpisodeUrl(episode.url) === normalizeEpisodeUrl(latestFreeUrl)) ??
      {
        url: latestFreeUrl,
        title: extractLatestTitleFromMeta(html),
        index: episodes.length - 1,
        accessLabel: "web",
      }
    : null;

  return {
    reader: "nico-manga",
    seriesUrl,
    seriesTitle,
    latestListed,
    latestFree,
    latestFreeShortcutUrl,
    resolvedAt: new Date().toISOString(),
  };
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
      },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`Request failed (${response.status}) for ${url}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveFinalUrl(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
      },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`Failed to resolve redirect (${response.status}) for ${url}`);
    }

    return response.url;
  } finally {
    clearTimeout(timeout);
  }
}

function parseNicoEpisodes(html: string, seriesUrl: string): EpisodeSummary[] {
  const matches = [...html.matchAll(/<li class="episode_item">([\s\S]*?)<\/li>/g)];
  const episodes: EpisodeSummary[] = [];

  for (const [_, block] of matches) {
    const href = block.match(/href="(\/watch\/mg\d+(?:\?[^"]*)?)"/)?.[1];
    const title = block.match(/<div class="title"><a [^>]*>([^<]+)<\/a><\/div>/)?.[1];
    if (!href || !title) {
      continue;
    }

    const idx = Number(block.match(/data-idx="(\d+)"/)?.[1] ?? episodes.length);
    const label = block.match(/<span class="selling_label [^"]*">\s*([^<]+)\s*<\/span>/)?.[1];

    episodes.push({
      url: new URL(href, seriesUrl).toString(),
      title: decodeHtml(title.trim()),
      index: idx,
      accessLabel: label ? decodeHtml(label.trim()) : "web",
    });
  }

  episodes.sort((left, right) => left.index - right.index);
  return episodes;
}

function extractLatestFreeShortcutUrl(html: string, seriesUrl: string): string | null {
  const href = html.match(
    /<a class="last" href="([^"]+)">最新の無料話を読む<\/a>/
  )?.[1];
  return href ? new URL(href, seriesUrl).toString() : null;
}

function extractSeriesTitle(html: string): string {
  const title =
    html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ??
    html.match(/<title>([^<]+)<\/title>/)?.[1] ??
    "Unknown series";
  return decodeHtml(title.replace(/\s*-\s*ニコニコ漫画.*$/u, "").trim());
}

function extractLatestTitleFromMeta(html: string): string {
  const latestMeta = html.match(/最新話:([^ \n。]+)/u)?.[1];
  return decodeHtml(latestMeta?.trim() || "Unknown latest episode");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/");
}

function normalizeEpisodeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function printText(result: ResolverResult): void {
  console.log(`Reader:        ${result.reader}`);
  console.log(`Series URL:    ${result.seriesUrl}`);
  console.log(`Series Title:  ${result.seriesTitle}`);
  if (result.latestListed) {
    console.log(
      `Latest listed: ${result.latestListed.title} (${result.latestListed.url}) [${result.latestListed.accessLabel}]`
    );
  }
  if (result.latestFree) {
    console.log(
      `Latest free:   ${result.latestFree.title} (${result.latestFree.url}) [${result.latestFree.accessLabel}]`
    );
  } else {
    console.log("Latest free:   Not found");
  }
}

function printShell(result: ResolverResult): void {
  const latestListed = result.latestListed;
  const latestFree = result.latestFree;
  const pairs: Array<[string, string]> = [
    ["RESOLVED_READER", result.reader],
    ["SERIES_URL", result.seriesUrl],
    ["SERIES_TITLE", result.seriesTitle],
    ["LATEST_FREE_SHORTCUT_URL", result.latestFreeShortcutUrl ?? ""],
    ["LATEST_LISTED_URL", latestListed?.url ?? ""],
    ["LATEST_LISTED_TITLE", latestListed?.title ?? ""],
    ["LATEST_LISTED_ACCESS_LABEL", latestListed?.accessLabel ?? ""],
    ["LATEST_FREE_URL", latestFree?.url ?? ""],
    ["LATEST_FREE_TITLE", latestFree?.title ?? ""],
    ["LATEST_FREE_ACCESS_LABEL", latestFree?.accessLabel ?? ""],
    [
      "LATEST_FREE_IS_LATEST_LISTED",
      latestListed && latestFree
        ? String(normalizeEpisodeUrl(latestListed.url) === normalizeEpisodeUrl(latestFree.url))
        : "false",
    ],
    ["RESOLVED_AT", result.resolvedAt],
  ];

  for (const [key, value] of pairs) {
    console.log(`${key}=${shellEscape(value)}`);
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
