# @joecarver/media

Media storage for Astro (or any Node) sites on S3-compatible object storage — built against Hetzner Object Storage, with public reads served from `media.<site domain>` via a Cloudflare Worker.

- Store **object keys** in your database, not URLs; turn them into URLs at render time.
- Uploads get Content-Type and a one-year immutable Cache-Control. Keys are never reused for different content, so that's always safe.
- Form uploads are normalised: **images → WebP** (via sharp, shrunk to fit 2000px), **audio → Opus in WebM** (via the ffmpeg CLI, 96 kb/s VBR). Files already in the target format and size pass through untouched.

## Install

Requires Node 20+ and, for audio uploads, `ffmpeg` and `ffprobe` on the server. It isn't published to npm. Install it from GitHub, pinned to a release tag:

```sh
pnpm add github:joecarver/media#v0.1.0
```

The package manager builds `dist/` on install through the `prepare` script.

## Usage

```ts
import { mediaUrl, signedMediaUrl, uploadMedia, uploadMediaFile } from '@joecarver/media';

mediaUrl('releases/foo/artwork-1a2b3c4d.webp'); // → `${MEDIA_BASE_URL}/releases/foo/artwork-1a2b3c4d.webp`
mediaUrl(null);                                  // → null (handy for optional columns)
mediaUrl('https://elsewhere.com/x.jpg');         // absolute URLs pass through unchanged

await signedMediaUrl('private/invoice.pdf', 600); // presigned bucket URL, valid 10 minutes

await uploadMedia('some/key.json', buffer, { contentType: 'application/json', cacheControl: 'no-cache' });

// In an Astro API route handling a multipart form:
const form = await ctx.request.formData();
const uploaded = await uploadMediaFile('mixes/my-mix', 'cover', form.get('coverFile') as File);
// → { key: 'mixes/my-mix/cover-9f8e7d6c.webp', size: { width: 1200, height: 1200 } },
//   or null if the input was empty. `size` is only set for images.
```

Also exported: `deleteMedia`, `mediaExists`, `newMediaKey`, `imageSize`, `prepareMedia` / `toWebp` / `toOpusWebm` (the transcoders on their own), `contentTypeFor`, `extensionFor`.

## Image placeholders

Store each image's `size` next to its key, then render it with its `width` and `height` and the `media-placeholder` class. The browser reserves the image's box from those attributes and shows a slow grey shimmer in it until the image loads:

```css
/* in the app's global stylesheet */
@import "@joecarver/media/placeholder.css";
```

```astro
<img class="media-placeholder w-full" src={mediaUrl(key)} width={width} height={height} alt="" />
```

The img needs CSS `height: auto` (Tailwind's preflight sets it) so the attributes only set the aspect ratio. Fixed-size boxes such as thumbnails can use the class without dimensions. Tune the colours with `--media-placeholder-base` and `--media-placeholder-highlight`.

## Serving pattern

Every site follows the same setup:

```
browser → https://media.<site domain>/<key>  (Cloudflare Worker, edge-cached)
        → https://<bucket>.hel1.your-objectstorage.com/<key>
```

- One bucket per site, with the Worker on that site's `media.` subdomain. Set `MEDIA_BASE_URL` to that origin.
- Pages only ever link to the Worker domain, never to the bucket. That keeps Hetzner egress low, and the bucket can move without touching the database.
- The Worker must pass `Range` requests through and keep `206` / `Content-Range` / `Content-Type` intact, or audio won't seek.
- Media is cross-origin from the site. That's fine for `<img>` and `<audio>`. Anything reading bytes from JS (`fetch`, canvas pixels, Web Audio on the element) needs CORS headers from the Worker.
- Uploads, deletes and `signedMediaUrl` talk to the S3 endpoint directly. The Worker is read-only.

## Configuration

The top-level functions read env vars on first use (so importing never throws during builds):

| Var | Example |
| :-- | :-- |
| `S3_ENDPOINT` | `https://hel1.your-objectstorage.com` |
| `S3_REGION` | `eu-central` |
| `S3_BUCKET` | `my-site` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | |
| `MEDIA_BASE_URL` | `https://media.my-site.com` (the site's media Worker) |
| `MEDIA_CACHE_CONTROL` | optional override of the default Cache-Control |
| `FFMPEG_PATH` / `FFPROBE_PATH` | optional; default to `ffmpeg` / `ffprobe` on `PATH` |

For explicit config (e.g. two buckets in one app, or tuning transcoding), use the factory:

```ts
import { createMedia } from '@joecarver/media';

const media = createMedia({
  endpoint: 'https://hel1.your-objectstorage.com',
  region: 'eu-central',
  bucket: 'my-site',
  accessKeyId: '…',
  secretAccessKey: '…',
  publicBaseUrl: 'https://media.my-site.com',
  transcode: { images: { maxDimension: 1600, quality: 80 }, audio: { bitrate: '128k' } }, // or `false` to disable either
});
media.mediaUrl(key);
```

## Using it in an Astro app

1. Install it (see [Install](#install)).
2. Keep it out of the SSR bundle so sharp can find its native binary — in `astro.config.mjs`:
   ```js
   vite: { ssr: { external: ['@joecarver/media'] } }
   ```
3. Install ffmpeg wherever the server runs (`apk add ffmpeg` on Alpine, `brew install ffmpeg` locally) if you accept audio uploads.
4. In Docker, run the install inside the image so sharp gets binaries for the container's platform, and exclude `**/node_modules` in `.dockerignore` so host (e.g. macOS) binaries aren't copied in. The build stage needs `git` to fetch this package (`apk add git` on Alpine).
5. Only call it server-side (`.astro` frontmatter, API routes). Pass the resulting URLs to client components as props.

## Notes

- Uses the MinIO client rather than the AWS SDK, which has been unreliable against Hetzner.
- `signedMediaUrl` only adds privacy for keys the bucket policy doesn't already make public. A bucket with a blanket public-read policy (`arn:aws:s3:::bucket/*`) makes every object public regardless.
- Audio transcoding runs in the request. Long mixes take tens of seconds, so check proxy timeouts, and the request body limit if Cloudflare proxies your uploads (100 MB on the free plan).

## Development

```sh
pnpm install
pnpm test   # builds, type-checks the tests, then runs them with node --test
```

The tests use Node's built-in test runner against the compiled `dist/`, so they need Node 22.18+ (for TypeScript type stripping). The audio tests are skipped when `ffmpeg` isn't installed. Nothing talks to S3.

To release, bump `version` in `package.json`, commit, then tag and push:

```sh
git tag v0.2.0 && git push origin main v0.2.0
```

## License

[MIT](LICENSE)
