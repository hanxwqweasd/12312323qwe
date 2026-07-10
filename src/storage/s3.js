const crypto = require('crypto');
const path = require('path');
const { optionalRequire, logger } = require('../infra/logger');

const s3Pkg = optionalRequire('@aws-sdk/client-s3');
const presigner = optionalRequire('@aws-sdk/s3-request-presigner');

function isS3Enabled() {
  return !!(process.env.S3_BUCKET || process.env.MINIO_BUCKET) && !!s3Pkg;
}

function bucket() {
  return process.env.S3_BUCKET || process.env.MINIO_BUCKET || 'nyx-media';
}

function createClient() {
  if (!isS3Enabled()) return null;
  return new s3Pkg.S3Client({
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    credentials: process.env.S3_ACCESS_KEY_ID || process.env.MINIO_ACCESS_KEY
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.MINIO_ACCESS_KEY,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.MINIO_SECRET_KEY,
        }
      : undefined,
  });
}

function safeExt(name, mime) {
  const ext = path.extname(name || '').replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12);
  if (ext) return ext;
  if ((mime || '').includes('png')) return '.png';
  if ((mime || '').includes('jpeg')) return '.jpg';
  if ((mime || '').includes('gif')) return '.gif';
  if ((mime || '').includes('mp4')) return '.mp4';
  return '.bin';
}

function objectKey({ userId, originalName, mimeType, prefix = 'media' }) {
  const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const ext = safeExt(originalName, mimeType);
  return `${prefix}/u${userId}/${new Date().toISOString().slice(0, 10)}/${id}${ext}`;
}

async function uploadBuffer({ buffer, userId, originalName, mimeType, encrypted = false, meta = {}, prefix = 'media' }) {
  if (!isS3Enabled()) return null;
  const client = createClient();
  const Key = objectKey({ userId, originalName, mimeType, prefix });
  await client.send(new s3Pkg.PutObjectCommand({
    Bucket: bucket(),
    Key,
    Body: buffer,
    ContentType: mimeType || 'application/octet-stream',
    Metadata: {
      encrypted: encrypted ? '1' : '0',
      owner: String(userId || ''),
      ...Object.fromEntries(Object.entries(meta || {}).map(([k, v]) => [k, String(v).slice(0, 512)])),
    },
    ServerSideEncryption: process.env.S3_SERVER_SIDE_ENCRYPTION || undefined,
  }));
  return {
    provider: 's3',
    bucket: bucket(),
    key: Key,
    cdnUrl: process.env.CDN_BASE_URL ? `${process.env.CDN_BASE_URL.replace(/\/$/, '')}/${Key}` : null,
  };
}

async function signedGetUrl(key, expiresIn = 900) {
  if (!isS3Enabled() || !presigner) return null;
  const client = createClient();
  return presigner.getSignedUrl(
    client,
    new s3Pkg.GetObjectCommand({ Bucket: bucket(), Key: key }),
    { expiresIn: Number(expiresIn || 900) }
  );
}

async function storageHealth() {
  if (!isS3Enabled()) return { enabled: false, ok: false, reason: 's3_or_minio_disabled' };
  try {
    const client = createClient();
    await client.send(new s3Pkg.HeadBucketCommand({ Bucket: bucket() }));
    return { enabled: true, ok: true, bucket: bucket(), cdn: process.env.CDN_BASE_URL || null };
  } catch (err) {
    logger.warn({ err }, 'S3/MinIO health failed');
    return { enabled: true, ok: false, error: err.message };
  }
}

module.exports = { isS3Enabled, uploadBuffer, signedGetUrl, storageHealth, bucket };
