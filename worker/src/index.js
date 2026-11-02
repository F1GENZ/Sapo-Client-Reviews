const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const VIDEO_MAX_BYTES = 2 * 1024 * 1024;

const EXTENSION_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

const OBJECT_KEY_RE = /^reviews\/[A-Za-z0-9.-]{1,253}\/\d{1,20}\/[A-Za-z0-9_-]{16,64}\.(jpg|png|webp|mp4)$/;
const LIST_PREFIX_RE = /^reviews\/[A-Za-z0-9._/-]{0,300}$/;
const LIST_DEFAULT_LIMIT = 200;
const LIST_MAX_LIMIT = 1000;
const LIST_MAX_CURSOR_LENGTH = 2000;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'PUT' && request.method !== 'DELETE' && request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed', code: 'method_not_allowed' }, 405);
    }

    if (!(await tokenMatches(request.headers.get('X-Upload-Token'), env.UPLOAD_SECRET))) {
      return jsonResponse({ error: 'Unauthorized', code: 'unauthorized' }, 401);
    }

    const url = new URL(request.url);
    if (request.method === 'GET') return handleList(url, env);

    const key = url.pathname.slice(1);
    if (!key) return jsonResponse({ error: 'Missing object key', code: 'missing_key' }, 400);
    if (!OBJECT_KEY_RE.test(key)) return jsonResponse({ error: 'Invalid object key', code: 'invalid_key' }, 400);
    if (!env.MEDIA) return jsonResponse({ error: 'R2 bucket is not configured', code: 'bucket_not_configured' }, 500);

    if (request.method === 'DELETE') return handleDelete(key, env);
    return handlePut(request, key, env);
  },
};

async function handlePut(request, key, env) {
  const contentType = request.headers.get('Content-Type') || '';
  const extension = Object.hasOwn(EXTENSION_BY_TYPE, contentType) ? EXTENSION_BY_TYPE[contentType] : null;
  if (!extension) return jsonResponse({ error: `Unsupported type: ${contentType}`, code: 'unsupported_type' }, 400);
  if (!key.endsWith(`.${extension}`)) {
    return jsonResponse({ error: 'Object key does not match content type', code: 'key_type_mismatch' }, 400);
  }

  const maxBytes = contentType.startsWith('video/') ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;
  const contentLength = Number(request.headers.get('Content-Length'));
  if (!Number.isInteger(contentLength) || contentLength <= 0) {
    return jsonResponse({ error: 'Content-Length required', code: 'length_required' }, 411);
  }
  if (contentLength > maxBytes) return jsonResponse({ error: 'File too large', code: 'file_too_large' }, 413);

  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > maxBytes) return jsonResponse({ error: 'File too large', code: 'file_too_large' }, 413);
    if (body.byteLength === 0) return jsonResponse({ error: 'Empty file', code: 'empty_file' }, 400);

    await env.MEDIA.put(key, body, { httpMetadata: { contentType } });
    return jsonResponse({ success: true, cdnUrl: `https://${env.CDN_DOMAIN}/${key}` }, 200);
  } catch {
    return jsonResponse({ error: 'Upload failed', code: 'upload_failed' }, 500);
  }
}

async function handleDelete(key, env) {
  try {
    await env.MEDIA.delete(key);
    return jsonResponse({ success: true }, 200);
  } catch {
    return jsonResponse({ error: 'Delete failed', code: 'delete_failed' }, 500);
  }
}

async function handleList(url, env) {
  if (url.pathname !== '/list') return jsonResponse({ error: 'Not found', code: 'not_found' }, 404);
  if (!env.MEDIA) return jsonResponse({ error: 'R2 bucket is not configured', code: 'bucket_not_configured' }, 500);

  const prefix = url.searchParams.get('prefix') || 'reviews/';
  if (!LIST_PREFIX_RE.test(prefix) || prefix.includes('..')) {
    return jsonResponse({ error: 'Invalid prefix', code: 'invalid_prefix' }, 400);
  }
  const cursor = url.searchParams.get('cursor') || '';
  if (cursor.length > LIST_MAX_CURSOR_LENGTH) {
    return jsonResponse({ error: 'Invalid cursor', code: 'invalid_cursor' }, 400);
  }
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? LIST_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) {
    return jsonResponse({ error: 'Invalid limit', code: 'invalid_limit' }, 400);
  }

  try {
    const listed = await env.MEDIA.list({ prefix, limit, ...(cursor ? { cursor } : {}) });
    return jsonResponse({
      objects: listed.objects.map((object) => ({
        key: object.key,
        uploaded: object.uploaded.getTime(),
        size: object.size,
      })),
      cursor: listed.truncated ? listed.cursor : null,
    }, 200);
  } catch {
    return jsonResponse({ error: 'List failed', code: 'list_failed' }, 500);
  }
}

async function tokenMatches(provided, secret) {
  if (!provided || !secret) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(secret)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Upload-Token',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
