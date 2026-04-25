/**
 * Hardcover CORS Proxy — Cloudflare Worker
 *
 * Deploy this as a Cloudflare Worker to allow the Thymer Hardcover plugin
 * to reach the Hardcover GraphQL API from the browser.
 *
 * Deploy steps:
 *   1. Go to https://dash.cloudflare.com and sign in (free account is fine)
 *   2. Click "Workers & Pages" in the left sidebar
 *   3. Click "Create" -> "Create Worker"
 *   4. Replace all the default code with this file's contents
 *   5. Click "Deploy"
 *   6. Copy the worker URL shown (e.g. https://hardcover-proxy.yourname.workers.dev)
 *   7. Paste that URL into the "Proxy URL" field in the Thymer Hardcover plugin setup
 *
 * The worker only forwards POST requests. Your API key is sent in the
 * Authorization header and is never stored by the worker.
 */

export default {
  async fetch(request) {
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

    // Forward to Hardcover
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
  },
};
