// Cloudflare Worker สำหรับ proxy HLS แบบจำกัดโดเมน
// Deploy ไฟล์นี้เป็น Worker แล้วใช้ URL /proxy เป็น HLS_PROXY_URL ใน index.html

const ALLOWED_HOSTS = new Set([
  'hls.iptv-th.workers.dev',
  '45.154.24.214.nip.io'
]);

const ALLOWED_HOST_SUFFIXES = ['.retromovie.tv'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, Content-Type',
  'Vary': 'Origin'
};

function isAllowedUrl(url) {
  const hostname = url.hostname.toLowerCase();
  return ['http:', 'https:'].includes(url.protocol)
    && (ALLOWED_HOSTS.has(hostname)
      || ALLOWED_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix)));
}

function withCors(response, extraHeaders = {}) {
  const headers = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => headers.set(key, value));
  Object.entries(extraHeaders).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function proxyUrl(rawUrl, baseUrl, workerOrigin) {
  try {
    const resolvedUrl = new URL(rawUrl, baseUrl);
    if (!isAllowedUrl(resolvedUrl)) return rawUrl;

    const url = new URL('/proxy', workerOrigin);
    url.searchParams.set('url', resolvedUrl.toString());
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function rewritePlaylist(playlist, upstreamUrl, workerOrigin) {
  return playlist.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Rewrite URI="..." ใน EXT-X-KEY, EXT-X-MAP และ tag อื่น ๆ
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
        return `URI="${proxyUrl(uri, upstreamUrl, workerOrigin)}"`;
      });
    }

    // Rewrite URI ของ variant playlist และ media segment
    return proxyUrl(trimmed, upstreamUrl, workerOrigin);
  }).join('\n');
}

function isPlaylist(url, response) {
  const contentType = response.headers.get('content-type') || '';
  return url.pathname.toLowerCase().includes('.m3u8')
    || contentType.includes('mpegurl');
}

async function handleProxy(request) {
  const requestUrl = new URL(request.url);
  const rawTarget = requestUrl.searchParams.get('url');

  if (!rawTarget) {
    return withCors(new Response('Missing url parameter', { status: 400 }));
  }

  let targetUrl;
  try {
    targetUrl = new URL(rawTarget);
  } catch {
    return withCors(new Response('Invalid upstream URL', { status: 400 }));
  }

  if (!isAllowedUrl(targetUrl)) {
    return withCors(new Response('Upstream host is not allowed', { status: 403 }));
  }

  const upstreamHeaders = new Headers();
  for (const headerName of ['range', 'if-none-match', 'if-modified-since']) {
    const value = request.headers.get(headerName);
    if (value) upstreamHeaders.set(headerName, value);
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: upstreamHeaders,
      redirect: 'manual'
    });
  } catch {
    return withCors(new Response('Unable to reach upstream stream', { status: 502 }));
  }

  if (!isPlaylist(targetUrl, upstreamResponse) || request.method === 'HEAD') {
    return withCors(upstreamResponse, { 'Cache-Control': 'no-store' });
  }

  const playlist = await upstreamResponse.text();
  const rewritten = rewritePlaylist(playlist, targetUrl, requestUrl.origin);

  return withCors(new Response(rewritten, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: {
      'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    }
  }));
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/') {
      return new Response('HLS proxy is running', {
        headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    if (url.pathname !== '/proxy' || !['GET', 'HEAD'].includes(request.method)) {
      return withCors(new Response('Not found', { status: 404 }));
    }

    return handleProxy(request);
  }
};
