import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import sharp from 'sharp';
import { imageSize, mediaKind, prepareMedia, toOpusWebm, toWebp } from '../dist/index.js';

function image(width: number, height: number, format: 'png' | 'webp' | 'jpeg' = 'png', background = '#c33'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } })[format]().toBuffer();
}

async function animatedGif(): Promise<Buffer> {
  // Frames must differ, or the GIF encoder merges them into one.
  const frames = await Promise.all([image(4, 3, 'png', '#c33'), image(4, 3, 'png', '#33c')]);
  return sharp(frames, { join: { animated: true } }).gif().toBuffer();
}

describe('mediaKind', () => {
  it('prefers the MIME type', () => {
    assert.equal(mediaKind('x.bin', 'image/png'), 'image');
    assert.equal(mediaKind('x.bin', 'audio/mpeg; foo=bar'), 'audio');
  });

  it('treats SVGs as other, so they are never rasterised', () => {
    assert.equal(mediaKind('logo.svg', 'image/svg+xml'), 'other');
    assert.equal(mediaKind('logo.svg'), 'other');
  });

  it('falls back to the extension for missing or generic types', () => {
    assert.equal(mediaKind('photo.HEIC', ''), 'image');
    assert.equal(mediaKind('mix.flac', 'application/octet-stream'), 'audio');
    assert.equal(mediaKind('doc.pdf', null), 'other');
    assert.equal(mediaKind('noext'), 'other');
  });
});

describe('imageSize', () => {
  it('reads the pixel size', async () => {
    assert.deepEqual(await imageSize(await image(30, 20)), { width: 30, height: 20 });
  });

  it('reports one frame of an animated image', async () => {
    assert.deepEqual(await imageSize(await animatedGif()), { width: 4, height: 3 });
  });

  it('returns null for non-images', async () => {
    assert.equal(await imageSize(Buffer.from('not an image')), null);
  });
});

describe('toWebp', () => {
  it('shrinks to fit maxDimension, keeping the aspect ratio', async () => {
    const out = await toWebp(await image(3000, 1500));
    const meta = await sharp(out).metadata();
    assert.equal(meta.format, 'webp');
    assert.deepEqual([meta.width, meta.height], [2000, 1000]);
  });

  it('never enlarges', async () => {
    const meta = await sharp(await toWebp(await image(100, 50))).metadata();
    assert.deepEqual([meta.width, meta.height], [100, 50]);
  });

  it('honours a custom maxDimension', async () => {
    const meta = await sharp(await toWebp(await image(400, 800), { maxDimension: 100 })).metadata();
    assert.deepEqual([meta.width, meta.height], [50, 100]);
  });

  it('returns a WebP that already fits untouched', async () => {
    const input = await image(100, 50, 'webp');
    assert.equal(await toWebp(input), input);
  });

  it('applies EXIF orientation', async () => {
    const rotated = await sharp(await image(40, 20, 'jpeg')).withMetadata({ orientation: 6 }).toBuffer();
    const meta = await sharp(await toWebp(rotated)).metadata();
    assert.deepEqual([meta.width, meta.height], [20, 40]);
  });

  it('keeps animation', async () => {
    const meta = await sharp(await toWebp(await animatedGif())).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.pages, 2);
  });
});

describe('prepareMedia (images and other files)', () => {
  it('converts images to WebP and reports the stored size', async () => {
    const prepared = await prepareMedia(await image(3000, 1500), 'photo.png', 'image/png');
    assert.ok(prepared);
    assert.equal(prepared.ext, 'webp');
    assert.equal(prepared.contentType, 'image/webp');
    assert.deepEqual(prepared.size, { width: 2000, height: 1000 });
  });

  it('returns null for files it does not convert', async () => {
    assert.equal(await prepareMedia(Buffer.from('<svg/>'), 'logo.svg', 'image/svg+xml'), null);
    assert.equal(await prepareMedia(Buffer.from('%PDF'), 'doc.pdf', 'application/pdf'), null);
  });

  it('returns null when that kind of transcoding is disabled', async () => {
    assert.equal(await prepareMedia(await image(10, 10), 'a.png', 'image/png', { images: false }), null);
    assert.equal(await prepareMedia(Buffer.alloc(0), 'a.mp3', 'audio/mpeg', { audio: false }), null);
  });
});

function hasFfmpeg(): boolean {
  try {
    execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync(process.env.FFPROBE_PATH ?? 'ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('audio', { skip: !hasFfmpeg() && 'ffmpeg/ffprobe not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-test-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  function tone(file: string, ...codec: string[]): string {
    const path = join(dir, file);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', ...codec, '-y', path]);
    return path;
  }

  function probe(buffer: Buffer): { codec: string; format: string } {
    const path = join(dir, `probe-${Math.random().toString(36).slice(2)}`);
    writeFileSync(path, buffer);
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_name:format=format_name', '-of', 'json', path,
    ]).toString();
    const json = JSON.parse(out) as { streams: { codec_name: string }[]; format: { format_name: string } };
    return { codec: json.streams[0].codec_name, format: json.format.format_name };
  }

  it('transcodes to Opus in WebM, from a buffer or a path', async () => {
    const wav = tone('tone.wav');
    for (const input of [readFileSync(wav), wav]) {
      const { codec, format } = probe(await toOpusWebm(input));
      assert.equal(codec, 'opus');
      assert.match(format, /webm/);
    }
  });

  it('returns Opus/WebM input untouched', async () => {
    const input = readFileSync(tone('tone.webm', '-c:a', 'libopus'));
    assert.equal(await toOpusWebm(input), input);
  });

  it('is what prepareMedia does for audio', async () => {
    const prepared = await prepareMedia(readFileSync(tone('tone.mp3')), 'tone.mp3', 'audio/mpeg');
    assert.ok(prepared);
    assert.equal(prepared.ext, 'webm');
    assert.equal(prepared.contentType, 'audio/webm');
    assert.equal(prepared.size, undefined);
  });

  it('rejects when ffmpeg fails', async () => {
    await assert.rejects(toOpusWebm(Buffer.from('not audio')));
  });
});
