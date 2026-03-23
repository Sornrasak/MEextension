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
