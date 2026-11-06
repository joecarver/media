// Normalises uploads before they hit the bucket:
//   - raster images → WebP (via sharp), shrunk to fit `maxDimension`
//   - audio → Opus in a WebM container (via the ffmpeg CLI)
// Anything else (SVGs, PDFs, …) passes through untouched.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

export interface ImageTranscodeOptions {
  /** Longest edge in px; smaller images are never enlarged. Default 2000. */
  maxDimension?: number;
  /** WebP quality 1–100. Default 82. */
  quality?: number;
}

export interface AudioTranscodeOptions {
  /** Opus target bitrate (VBR), in ffmpeg syntax. Default `96k`. */
  bitrate?: string;
  /** Default `$FFMPEG_PATH` or `ffmpeg` on PATH. */
  ffmpegPath?: string;
  /** Default `$FFPROBE_PATH` or `ffprobe` on PATH. */
  ffprobePath?: string;
}

export interface TranscodeOptions {
  /** `false` uploads images as-is. */
  images?: ImageTranscodeOptions | false;
  /** `false` uploads audio as-is. */
  audio?: AudioTranscodeOptions | false;
}

export interface ImageSize {
  width: number;
  height: number;
}

export interface PreparedMedia {
  body: Buffer;
  /** File extension for the key, without the dot. */
  ext: string;
  contentType: string;
  /** Pixel size of `body`, for images. */
  size?: ImageSize;
}

export type MediaKind = 'image' | 'audio' | 'other';

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'tif', 'tiff', 'heic', 'heif']);
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'webm', 'weba']);

function extOf(filename: string): string {
  return filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
}

/** Classifies by MIME type first, falling back to the file extension. */
export function mediaKind(filename: string, contentType?: string | null): MediaKind {
  const type = contentType?.split(';')[0].trim().toLowerCase() ?? '';
  if (type === 'image/svg+xml') return 'other';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  const ext = extOf(filename);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'other';
}

/**
 * Pixel size of an image, or null if sharp can't read it. Store it alongside
 * the key so pages can reserve the image's box (and show a placeholder) before
 * it loads.
 */
export async function imageSize(input: Buffer): Promise<ImageSize | null> {
  try {
    const meta = await sharp(input).metadata();
    // Animated images report the height of all frames stacked.
    const height = meta.pageHeight ?? meta.height;
    return meta.width && height ? { width: meta.width, height } : null;
  } catch {
    return null;
  }
}

/**
 * Converts to WebP, shrinking to fit `maxDimension`. A WebP that already fits
 * is returned as-is, to avoid a pointless generation of lossy re-encoding.
 */
export async function toWebp(input: Buffer, opts: ImageTranscodeOptions = {}): Promise<Buffer> {
  const max = opts.maxDimension ?? 2000;
  const meta = await sharp(input).metadata();
  if (meta.format === 'webp' && (meta.width ?? Infinity) <= max && (meta.pageHeight ?? meta.height ?? Infinity) <= max) {
    return input;
  }
  // animated: true keeps GIFs animated (they come out as animated WebP).
  return sharp(input, { animated: true })
    .rotate() // apply EXIF orientation before metadata is stripped
    .resize(max, max, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: opts.quality ?? 82 })
    .toBuffer();
}

async function isOpusWebm(path: string, ffprobe: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_name:format=format_name',
      '-of', 'json',
      path,
    ]);
    const probe = JSON.parse(stdout) as { streams?: { codec_name?: string }[]; format?: { format_name?: string } };
    const audio = probe.streams ?? [];
    return audio.length === 1 && audio[0].codec_name === 'opus' && !!probe.format?.format_name?.includes('webm');
  } catch {
    return false;
  }
}

/**
 * Transcodes to Opus/WebM. Input that's already Opus/WebM is returned as-is,
 * to avoid a pointless generation of lossy re-encoding. `input` is a Buffer or
 * a path on disk (avoids holding long mixes in memory twice).
 */
export async function toOpusWebm(input: Buffer | string, opts: AudioTranscodeOptions = {}): Promise<Buffer> {
  const ffmpeg = opts.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
  const ffprobe = opts.ffprobePath ?? process.env.FFPROBE_PATH ?? 'ffprobe';
  const workDir = await mkdtemp(join(tmpdir(), 'media-audio-'));
  try {
    let inputPath: string;
    if (typeof input === 'string') {
      inputPath = input;
    } else {
      inputPath = join(workDir, 'input');
      await writeFile(inputPath, input);
    }

    if (await isOpusWebm(inputPath, ffprobe)) {
      return typeof input === 'string' ? readFile(input) : input;
    }

    const outputPath = join(workDir, 'output.webm');
    await execFileAsync(
      ffmpeg,
      [
        '-v', 'error',
        '-i', inputPath,
        '-vn', // drop embedded cover art
        '-map_metadata', '0',
        '-c:a', 'libopus',
        '-b:a', opts.bitrate ?? '96k',
        '-vbr', 'on',
        '-f', 'webm',
        outputPath,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return await readFile(outputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Converts an upload according to its kind, returning what to store. */
export async function prepareMedia(
  input: Buffer | string,
  filename: string,
  contentType: string | null | undefined,
  opts: TranscodeOptions = {},
): Promise<PreparedMedia | null> {
  const kind = mediaKind(filename, contentType);
  if (kind === 'image' && opts.images !== false) {
    const buffer = typeof input === 'string' ? await readFile(input) : input;
    const body = await toWebp(buffer, opts.images);
    return { body, ext: 'webp', contentType: 'image/webp', size: (await imageSize(body)) ?? undefined };
  }
  if (kind === 'audio' && opts.audio !== false) {
    return { body: await toOpusWebm(input, opts.audio), ext: 'webm', contentType: 'audio/webm' };
  }
  return null;
}
