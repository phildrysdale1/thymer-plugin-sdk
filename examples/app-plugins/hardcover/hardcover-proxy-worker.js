/**
 * Hardcover CORS Proxy — Cloudflare Worker
 *
 * Paste this code into the Cloudflare Worker inline editor (see instructions
 * in hardcover-plugin.js or the README).
 *
 * This uses the classic addEventListener syntax so it works directly in the
 * Cloudflare dashboard editor without any build step.
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  if (request.method !== 'POST') {
    return new Response('Only POST requests are supported.', { status: 405 });
  }

  // Forward to Hardcover, carrying the Authorization header from the plugin
  const upstream = await fetch('https://api.hardcover.app/v1/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': request.headers.get('Authorization') || '',
    },
    body: request.body,
  });

  const body = await upstream.arrayBuffer();

  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
