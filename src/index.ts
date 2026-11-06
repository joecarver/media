// Media storage on S3-compatible object storage (built against Hetzner Object
// Storage). Public reads go through `media.<site domain>`, a Cloudflare Worker
// proxying the bucket — see README.
//
// Form uploads via `uploadMediaFile` are normalised first (see transcode.ts):
// images → WebP, audio → Opus/WebM.
//
// Apps store bare object keys (e.g. `releases/foo/artwork-1a2b3c4d.jpg`) in
// their database, never full URLs, so the public host can change (bucket →
// Worker) without a data migration.
//
// Two ways to use it:
//   - the top-level functions (`mediaUrl`, `uploadMedia`, …) read their config
//     from environment variables on first use — see `configFromEnv`;
//   - `createMedia(config)` for explicit config, e.g. several buckets in one app.
//
// Uses the MinIO client rather than the AWS SDK, which has been unreliable
// against Hetzner's object storage.

import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Client } from 'minio';
import { imageSize, mediaKind, prepareMedia, type ImageSize, type TranscodeOptions } from './transcode.js';

export * from './transcode.js';

export interface MediaConfig {
  /** S3 API endpoint, e.g. `https://hel1.your-objectstorage.com`. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public base for `mediaUrl`: the site's media Worker, e.g. `https://media.example.com`. */
  publicBaseUrl: string;
  /** Cache-Control applied by `uploadMedia` when none is given. Defaults to one year + immutable. */
  defaultCacheControl?: string;
  /** How `uploadMediaFile` converts images and audio. Defaults to WebP + Opus/WebM. */
  transcode?: TranscodeOptions;
}

export interface UploadMediaOptions {
  /** Defaults to a type guessed from the key's extension. */
  contentType?: string;
  /** Defaults to the config's `defaultCacheControl`. */
  cacheControl?: string;
  /** Byte length; needed for efficient uploads when `body` is a stream. */
  size?: number;
}

export type MediaBody = Buffer | Uint8Array | Readable | Blob;

export interface UploadedMedia {
  key: string;
  /** Pixel size of the stored image; absent for other media and unreadable images. */
  size?: ImageSize;
}

export interface Media {
  /** Public URL for an object, served from `publicBaseUrl`. Null in, null out. */
  mediaUrl(key: string): string;
  mediaUrl(key: string | null | undefined): string | null;
  /**
   * Time-limited URL straight to the bucket, for objects that aren't publicly
   * readable. The bucket policy decides what's actually private: this only
   * adds anything for keys not already covered by a public-read rule.
   */
  signedMediaUrl(key: string, ttlSeconds?: number): Promise<string>;
  /** Uploads an object with Content-Type and Cache-Control set, returning its key. */
  uploadMedia(key: string, body: MediaBody, opts?: UploadMediaOptions): Promise<string>;
  /**
   * Uploads a `File` from a multipart form to a fresh key under `prefix`
   * (see `newMediaKey`), converting images to WebP and audio to Opus/WebM
   * first. Returns the key (plus the pixel size, for images), or null when
   * the input was left empty.
   */
  uploadMediaFile(prefix: string, name: string, file: File | null | undefined): Promise<UploadedMedia | null>;
  deleteMedia(key: string): Promise<void>;
  mediaExists(key: string): Promise<boolean>;
}

// Keys are never overwritten with different content (see newMediaKey), so
// objects are safe to cache forever at the edge and in browsers.
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
};

export function contentTypeFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export function extensionFor(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  return EXTENSIONS[contentType.split(';')[0].trim().toLowerCase()] ?? null;
}

function slugifySegment(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // é → e, ū → u
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Builds a fresh key like `releases/some-slug/artwork-1a2b3c4d.jpg`. The random
 * suffix means a replaced file always gets a new key, which is what makes the
 * immutable cache headers safe. Pass `suffix` to make it deterministic instead
 * (e.g. a hash of the source, so re-running an import doesn't duplicate objects).
 */
export function newMediaKey(prefix: string, name: string, ext: string, suffix = randomBytes(4).toString('hex')): string {
  const folder = prefix.split('/').map(slugifySegment).filter(Boolean).join('/');
  const file = `${slugifySegment(name) || 'file'}-${suffix}.${ext.replace(/^\./, '').toLowerCase()}`;
  return folder ? `${folder}/${file}` : file;
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

export function createMedia(config: MediaConfig): Media {
  let client: Client | undefined;

  function s3(): Client {
    if (!client) {
      // MinIO wants the host and TLS flag separately rather than a URL.
      const endpoint = new URL(config.endpoint);
      client = new Client({
        endPoint: endpoint.hostname,
        port: endpoint.port ? Number(endpoint.port) : undefined,
        useSSL: endpoint.protocol === 'https:',
        region: config.region,
        accessKey: config.accessKeyId,
        secretKey: config.secretAccessKey,
      });
    }
    return client;
  }

  const publicBase = config.publicBaseUrl.replace(/\/$/, '');

  function mediaUrl(key: string): string;
  function mediaUrl(key: string | null | undefined): string | null;
  function mediaUrl(key: string | null | undefined): string | null {
    if (!key) return null;
    // Absolute URLs (externally hosted or not-yet-migrated media) pass through.
    if (/^https?:\/\//i.test(key)) return key;
    return `${publicBase}/${encodeKey(key)}`;
  }

  async function uploadMedia(key: string, body: MediaBody, opts: UploadMediaOptions = {}): Promise<string> {
    const data = body instanceof Blob ? Buffer.from(await body.arrayBuffer()) : body;
    const size = opts.size ?? (data instanceof Uint8Array ? data.length : undefined);
    await s3().putObject(config.bucket, key, data as Buffer | Readable, size, {
      'Content-Type': opts.contentType || contentTypeFor(key),
      'Cache-Control': opts.cacheControl ?? config.defaultCacheControl ?? IMMUTABLE_CACHE_CONTROL,
    });
    return key;
  }

  return {
    mediaUrl,
    uploadMedia,

    signedMediaUrl(key, ttlSeconds = 60 * 60) {
      return s3().presignedGetObject(config.bucket, key, ttlSeconds);
    },

    async uploadMediaFile(prefix, name, file) {
      if (!file || file.size === 0) return null;
      const input = Buffer.from(await file.arrayBuffer());
      const prepared = await prepareMedia(input, file.name, file.type, config.transcode);
      if (prepared) {
        const key = newMediaKey(prefix, name, prepared.ext);
        await uploadMedia(key, prepared.body, { contentType: prepared.contentType });
        return { key, size: prepared.size };
      }
      const ext = file.name.includes('.') ? file.name.split('.').pop()! : (extensionFor(file.type) ?? 'bin');
      const key = newMediaKey(prefix, name, ext);
      await uploadMedia(key, input, {
        // Browsers send an empty or generic type for less common extensions.
        contentType: file.type && file.type !== 'application/octet-stream' ? file.type : contentTypeFor(key),
      });
      // Images uploaded untranscoded (`transcode.images: false`) still get measured.
      const size = mediaKind(file.name, file.type) === 'image' ? await imageSize(input) : null;
      return { key, size: size ?? undefined };
    },

    async deleteMedia(key) {
      await s3().removeObject(config.bucket, key);
    },

    async mediaExists(key) {
      try {
        await s3().statObject(config.bucket, key);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Reads config from:
 *   S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
 *   MEDIA_BASE_URL, and optionally MEDIA_CACHE_CONTROL.
 */
export function configFromEnv(env: Record<string, string | undefined> = process.env): MediaConfig {
  function required(name: string): string {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  }
  return {
    endpoint: required('S3_ENDPOINT'),
    region: required('S3_REGION'),
    bucket: required('S3_BUCKET'),
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    publicBaseUrl: required('MEDIA_BASE_URL'),
    defaultCacheControl: env.MEDIA_CACHE_CONTROL || undefined,
  };
}

// Created on first use rather than at import, so importing the package never
// throws in contexts that lack the env (builds, type-checks, client bundles).
let defaultMedia: Media | undefined;

function media(): Media {
  defaultMedia ??= createMedia(configFromEnv());
  return defaultMedia;
}

export function mediaUrl(key: string): string;
export function mediaUrl(key: string | null | undefined): string | null;
export function mediaUrl(key: string | null | undefined): string | null {
  return media().mediaUrl(key);
}

export const signedMediaUrl: Media['signedMediaUrl'] = (key, ttlSeconds) => media().signedMediaUrl(key, ttlSeconds);
export const uploadMedia: Media['uploadMedia'] = (key, body, opts) => media().uploadMedia(key, body, opts);
export const uploadMediaFile: Media['uploadMediaFile'] = (prefix, name, file) => media().uploadMediaFile(prefix, name, file);
export const deleteMedia: Media['deleteMedia'] = (key) => media().deleteMedia(key);
export const mediaExists: Media['mediaExists'] = (key) => media().mediaExists(key);
