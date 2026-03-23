#!/usr/bin/env bun
/// <reference types="bun-types" />

import { spawnSync } from "child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, extname, join, resolve } from "path";
import { parseArgs } from "util";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif"]);
const DEFAULT_SECONDS_PER_PAGE = 1.2;
const DEFAULT_WIDTH = 1080;
const DEFAULT_HEIGHT = 1920;
const DEFAULT_BACKGROUND = "white";
const collator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    input: { type: "string", short: "i" },
    output: { type: "string", short: "o" },
    htmlOutput: { type: "string" },
    secondsPerPage: { type: "string", default: String(DEFAULT_SECONDS_PER_PAGE) },
    width: { type: "string", default: String(DEFAULT_WIDTH) },
    height: { type: "string", default: String(DEFAULT_HEIGHT) },
    background: { type: "string", default: DEFAULT_BACKGROUND },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help || !values.input) {
  console.log(`Manga Preview Video
Usage:
  bun cli/preview.ts --input <zip-or-dir> [options]

Options:
  -i, --input            ZIP file or directory containing page images (required)
  -o, --output           Output video path (default: <input>.preview.mp4)
      --htmlOutput       Output HTML slideshow path (default: <video>.html)
      --secondsPerPage   Seconds to show each page (default: ${DEFAULT_SECONDS_PER_PAGE})
      --width            Output video width (default: ${DEFAULT_WIDTH})
      --height           Output video height (default: ${DEFAULT_HEIGHT})
      --background       Pad color used behind pages (default: ${DEFAULT_BACKGROUND})
  -h, --help             Show this help
`);
  process.exit(values.help ? 0 : 1);
}

const inputPath = resolve(values.input);
const outputPath = resolve(values.output ?? defaultOutputPath(inputPath));
const htmlOutputPath = resolve(values.htmlOutput ?? defaultHtmlOutputPath(outputPath));
const secondsPerPage = Number(values.secondsPerPage ?? DEFAULT_SECONDS_PER_PAGE);
const width = Number(values.width ?? DEFAULT_WIDTH);
const height = Number(values.height ?? DEFAULT_HEIGHT);
const background = values.background ?? DEFAULT_BACKGROUND;

if (!existsSync(inputPath)) {
  console.error(`Input not found: ${inputPath}`);
  process.exit(1);
}

if (!Number.isFinite(secondsPerPage) || secondsPerPage <= 0) {
  console.error(`Invalid --secondsPerPage value: ${values.secondsPerPage}`);
  process.exit(1);
}

if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
  console.error(`Invalid output size: ${width}x${height}`);
  process.exit(1);
}

ensureFfmpeg();

const workspace = mkdtempSync(join(tmpdir(), "manga-preview-"));

try {
  const imageDir = await resolveImageDirectory(inputPath, workspace);
  const images = collectImages(imageDir).sort(naturalCompare);

  if (images.length === 0) {
    console.error(`No image files found in ${imageDir}`);
    process.exit(1);
  }

  const framesDir = join(workspace, "frames");
  mkdirSync(framesDir, { recursive: true });

  const stagedFrames = stageFrames(images, framesDir);
  const concatFile = join(workspace, "frames.txt");
  writeConcatFile(concatFile, stagedFrames, secondsPerPage);

  mkdirSync(dirname(outputPath), { recursive: true });

  console.log(`Rendering preview from ${images.length} page(s)...`);
  renderPreviewVideo({
    concatFile,
    outputPath,
    width,
    height,
    background,
  });

  console.log(`Preview video written to ${outputPath}`);
  writeHtmlPreview({
    images,
    htmlOutputPath,
    title: basename(outputPath, extname(outputPath)),
    secondsPerPage,
  });
  console.log(`Preview HTML written to ${htmlOutputPath}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

function defaultOutputPath(input: string): string {
  const stats = statSync(input);
  if (stats.isDirectory()) {
    return join(input, "preview.mp4");
  }

  if (input.endsWith(".zip")) {
    return join(dirname(input), `${basename(input, ".zip")}.preview.mp4`);
  }

  return join(dirname(input), `${basename(input)}.preview.mp4`);
}

function defaultHtmlOutputPath(videoOutput: string): string {
  return join(dirname(videoOutput), `${basename(videoOutput, extname(videoOutput))}.html`);
}

function ensureFfmpeg(): void {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (result.status === 0) {
    return;
  }

  console.error("ffmpeg is required to render preview videos.");
  process.exit(1);
}

async function resolveImageDirectory(input: string, workspace: string): Promise<string> {
  const stats = statSync(input);
  if (stats.isDirectory()) {
    return input;
  }

  if (!input.endsWith(".zip")) {
    console.error("Input must be a directory or a .zip file.");
    process.exit(1);
  }

  const extractDir = join(workspace, "extracted");
  mkdirSync(extractDir, { recursive: true });

  const JSZip = (await import("jszip")).default;
  const zipData = readFileSync(input);
  const zip = await JSZip.loadAsync(zipData);

  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) {
      continue;
    }

    const safeName = name.replace(/[|<>"?*]/g, "_");
    const outPath = join(extractDir, safeName);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, await entry.async("nodebuffer"));
  }

  return extractDir;
}

function collectImages(dir: string): string[] {
  const images: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      images.push(...collectImages(fullPath));
      continue;
    }

    if (IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      images.push(fullPath);
    }
  }

  return images;
}

function naturalCompare(left: string, right: string): number {
  return collator.compare(left, right);
}

function stageFrames(images: string[], framesDir: string): string[] {
  return images.map((imagePath, index) => {
    const extension = extname(imagePath).toLowerCase() || ".png";
    const stagedPath = join(framesDir, `frame-${String(index + 1).padStart(6, "0")}${extension}`);

    try {
      symlinkSync(imagePath, stagedPath);
    } catch {
      copyFileSync(imagePath, stagedPath);
    }

    return stagedPath;
  });
}

function writeConcatFile(concatFile: string, frames: string[], secondsPerPage: number): void {
  const lines: string[] = [];

  for (const frame of frames) {
    lines.push(`file '${frame}'`);
    lines.push(`duration ${secondsPerPage}`);
  }

  const lastFrame = frames[frames.length - 1];
  if (lastFrame) {
    lines.push(`file '${lastFrame}'`);
  }

  writeFileSync(concatFile, `${lines.join("\n")}\n`, "utf-8");
}

function renderPreviewVideo(options: {
  concatFile: string;
  outputPath: string;
  width: number;
  height: number;
  background: string;
}): void {
  const { concatFile, outputPath, width, height, background } = options;
  const filter = [
    "fps=30",
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:${background}`,
  ].join(",");

  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatFile,
      "-vf",
      filter,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { stdio: "inherit" }
  );

  if (result.status !== 0) {
    throw new Error(`ffmpeg exited with status ${result.status ?? "unknown"}`);
  }
}

function writeHtmlPreview(options: {
  images: string[];
  htmlOutputPath: string;
  title: string;
  secondsPerPage: number;
}): void {
  const { images, htmlOutputPath, title, secondsPerPage } = options;
  const slides = images.map((imagePath, index) => ({
    index: index + 1,
    name: basename(imagePath),
    dataUrl: toDataUrl(imagePath),
  }));

  mkdirSync(dirname(htmlOutputPath), { recursive: true });

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, sans-serif;
      background: #111827;
      color: #f9fafb;
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
    }
    header, footer {
      padding: 16px 20px;
      background: rgba(17, 24, 39, 0.96);
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    footer {
      border-top: 1px solid rgba(255,255,255,0.08);
      border-bottom: 0;
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }
    .stage {
      display: grid;
      place-items: center;
      padding: 16px;
    }
    img {
      max-width: min(96vw, 900px);
      max-height: calc(100vh - 210px);
      width: auto;
      height: auto;
      border-radius: 10px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.45);
      background: white;
    }
    button {
      border: 0;
      border-radius: 999px;
      padding: 10px 16px;
      background: #2563eb;
      color: white;
      font: inherit;
      cursor: pointer;
    }
    button.secondary {
      background: #374151;
    }
    .meta {
      opacity: 0.85;
      font-size: 14px;
    }
    input[type="range"] {
      width: min(360px, 80vw);
    }
  </style>
</head>
<body>
  <header>
    <h1 style="margin:0 0 6px 0; font-size: 20px;">${escapeHtml(title)}</h1>
    <div class="meta">Self-contained slideshow demo. Use arrow keys or space to play/pause.</div>
  </header>
  <main class="stage">
    <img id="slide" alt="preview slide" />
  </main>
  <footer>
    <button id="prev" class="secondary" type="button">Prev</button>
    <button id="play" type="button">Pause</button>
    <button id="next" class="secondary" type="button">Next</button>
    <input id="scrub" type="range" min="1" max="${slides.length}" value="1" />
    <span id="status" class="meta"></span>
  </footer>
  <script>
    const slides = ${JSON.stringify(slides)};
    const secondsPerPage = ${JSON.stringify(secondsPerPage)};
    let current = 0;
    let playing = true;
    let timer = null;

    const slideEl = document.getElementById("slide");
    const statusEl = document.getElementById("status");
    const scrubEl = document.getElementById("scrub");
    const playEl = document.getElementById("play");

    function render() {
      const slide = slides[current];
      slideEl.src = slide.dataUrl;
      slideEl.alt = slide.name;
      statusEl.textContent = slide.index + " / " + slides.length + " - " + slide.name;
      scrubEl.value = String(slide.index);
      playEl.textContent = playing ? "Pause" : "Play";
    }

    function restartTimer() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (!playing || slides.length <= 1) {
        return;
      }
      timer = setInterval(() => {
        current = (current + 1) % slides.length;
        render();
      }, secondsPerPage * 1000);
    }

    function go(delta) {
      current = (current + delta + slides.length) % slides.length;
      render();
      restartTimer();
    }

    document.getElementById("prev").addEventListener("click", () => go(-1));
    document.getElementById("next").addEventListener("click", () => go(1));
    playEl.addEventListener("click", () => {
      playing = !playing;
      render();
      restartTimer();
    });
    scrubEl.addEventListener("input", (event) => {
      current = Number(event.target.value) - 1;
      render();
      restartTimer();
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") go(-1);
      if (event.key === "ArrowRight") go(1);
      if (event.key === " ") {
        event.preventDefault();
        playing = !playing;
        render();
        restartTimer();
      }
    });

    render();
    restartTimer();
  </script>
</body>
</html>`;

  writeFileSync(htmlOutputPath, html, "utf-8");
}

function toDataUrl(imagePath: string): string {
  const ext = extname(imagePath).toLowerCase();
  const mimeType = getMimeType(ext);
  const encoded = readFileSync(imagePath).toString("base64");
  return `data:${mimeType};base64,${encoded}`;
}

function getMimeType(ext: string): string {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    default:
      return "application/octet-stream";
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
