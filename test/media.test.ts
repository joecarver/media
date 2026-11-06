import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  configFromEnv,
  contentTypeFor,
  createMedia,
  extensionFor,
  IMMUTABLE_CACHE_CONTROL,
  newMediaKey,
} from '../dist/index.js';

const config = {
  endpoint: 'https://hel1.example.com',
  region: 'eu-central',
  bucket: 'bucket',
  accessKeyId: 'id',
  secretAccessKey: 'secret',
  publicBaseUrl: 'https://media.example.com/',
};

describe('newMediaKey', () => {
  it('slugifies the prefix and name and adds a random hex suffix', () => {
    const key = newMediaKey('Releases/Café Mix', 'Cover Art!', 'JPG');
    assert.match(key, /^releases\/cafe-mix\/cover-art-[0-9a-f]{8}\.jpg$/);
  });

  it('gives a different key each time', () => {
    assert.notEqual(newMediaKey('a', 'b', 'webp'), newMediaKey('a', 'b', 'webp'));
  });

  it('uses a given suffix and strips a leading dot from the extension', () => {
    assert.equal(newMediaKey('mixes/x', 'cover', '.webp', 'abc'), 'mixes/x/cover-abc.webp');
  });

  it('handles empty prefix segments and names', () => {
    assert.equal(newMediaKey('', '', 'pdf', 'abc'), 'file-abc.pdf');
    assert.equal(newMediaKey('/a//b/', 'n', 'pdf', 'abc'), 'a/b/n-abc.pdf');
  });
});

describe('contentTypeFor / extensionFor', () => {
  it('maps extensions to content types', () => {
    assert.equal(contentTypeFor('a/b/c.WEBP'), 'image/webp');
    assert.equal(contentTypeFor('mix.webm'), 'video/webm');
    assert.equal(contentTypeFor('noext'), 'application/octet-stream');
  });

  it('maps content types to extensions, ignoring parameters and case', () => {
    assert.equal(extensionFor('Audio/MPEG; charset=binary'), 'mp3');
    assert.equal(extensionFor('audio/x-m4a'), 'm4a');
    assert.equal(extensionFor('application/x-unknown'), null);
    assert.equal(extensionFor(undefined), null);
  });
});

describe('mediaUrl', () => {
  const { mediaUrl } = createMedia(config);

  it('joins the key onto the public base, without a double slash', () => {
    assert.equal(mediaUrl('releases/foo/a.webp'), 'https://media.example.com/releases/foo/a.webp');
  });

  it('encodes each path segment but keeps the slashes', () => {
    assert.equal(mediaUrl('a b/c#d?.webp'), 'https://media.example.com/a%20b/c%23d%3F.webp');
  });

  it('passes absolute URLs and empty values through', () => {
    assert.equal(mediaUrl('https://elsewhere.com/x.jpg'), 'https://elsewhere.com/x.jpg');
    assert.equal(mediaUrl('HTTP://elsewhere.com/x.jpg'), 'HTTP://elsewhere.com/x.jpg');
    assert.equal(mediaUrl(null), null);
    assert.equal(mediaUrl(undefined), null);
    assert.equal(mediaUrl(''), null);
  });
});

describe('configFromEnv', () => {
  const env = {
    S3_ENDPOINT: 'https://hel1.example.com',
    S3_REGION: 'eu-central',
    S3_BUCKET: 'bucket',
    S3_ACCESS_KEY_ID: 'id',
    S3_SECRET_ACCESS_KEY: 'secret',
    MEDIA_BASE_URL: 'https://media.example.com',
  };

  it('reads every field', () => {
    assert.deepEqual(configFromEnv({ ...env, MEDIA_CACHE_CONTROL: 'no-cache' }), {
      endpoint: 'https://hel1.example.com',
      region: 'eu-central',
      bucket: 'bucket',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      publicBaseUrl: 'https://media.example.com',
      defaultCacheControl: 'no-cache',
    });
  });

  it('treats an empty MEDIA_CACHE_CONTROL as unset', () => {
    assert.equal(configFromEnv({ ...env, MEDIA_CACHE_CONTROL: '' }).defaultCacheControl, undefined);
  });

  it('names the missing variable', () => {
    assert.throws(() => configFromEnv({ ...env, S3_BUCKET: undefined }), /S3_BUCKET is not set/);
  });
});

it('exports the immutable cache header', () => {
  assert.equal(IMMUTABLE_CACHE_CONTROL, 'public, max-age=31536000, immutable');
});
