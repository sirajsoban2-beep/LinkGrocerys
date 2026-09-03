// netlify/functions/grocery-image.js
// Text-first / async image loading — part 2.
// grocery-search.js now returns text (title, price, chips) WITHOUT
// waiting for an image. The frontend renders that immediately, shows a
// skeleton placeholder, then calls THIS endpoint separately to fetch the
// photo. Once found, the image is also patched into the existing cache
// entry for that item so a future cache hit returns text + image together
// with no skeleton needed at all.
//
// Accepts: POST { "query": "Doritos" }

const { connectLambda, getStore } = require('@netlify/blobs');

var CACHE_STORE = 'grocery-cache'; // same store as grocery-search.js
var CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // keep in sync

const fetchWithTimeout = async (url, options = {}, timeoutMs = 15000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

function cacheKey(q) {
  return q.toLowerCase().trim().replace(/\s+/g, ' ');
}

exports.handler = async (event) => {
  try { connectLambda(event); } catch (e) { /* Blobs optional; continue */ }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    var query = JSON.parse(event.body || '{}').query;
    if (!query || !String(query).trim()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'query is required' }) };
    }
    query = String(query).trim();

    var serpKey = (process.env.SERPAPI_KEY || '').trim();
    var imageUrl = null;

    if (serpKey) {
      try {
        var searchQuery = encodeURIComponent(query);
        var serpRes = await fetchWithTimeout(
          `https://serpapi.com/search.json?engine=google_shopping&q=${searchQuery}&num=3&gl=us&hl=en&api_key=${serpKey}`,
          {}, 8000
        );
        var serpData = await serpRes.json();
        if (serpData.shopping_results && serpData.shopping_results.length > 0) {
          imageUrl = serpData.shopping_results[0].thumbnail;
        } else if (serpData.error) {
          console.error('SerpApi returned an error:', serpData.error);
        }
      } catch (serpErr) {
        console.error('SerpApi Google Shopping Error:', serpErr.name, serpErr.message);
      }
    }

    var responseBody = { imageUrl: imageUrl };

    // ---- Patch the existing text cache entry with this image, so a
    // future cache-hit for the same item returns text + image together. ----
    if (imageUrl) {
      var store = null;
      try { store = getStore(CACHE_STORE); } catch (e) { store = null; }

      if (store) {
        try {
          var key = cacheKey(query);
          var cached = await store.get(key, { type: 'json' });
          if (cached && cached.payload) {
            var patched = Object.assign({}, cached.payload, { imageUrl: imageUrl });

            // Same brand+image override rule as the text endpoint: once
            // we have both a recognized brand and a confirmed image, that
            // combination is specific enough — clear the vague banner.
            if (patched.brandName && patched.imageUrl) {
              patched.isVague = false;
              patched.clarifyingQuestion = null;
            }

            await store.setJSON(key, { cachedAt: cached.cachedAt, payload: patched });

            // Let the frontend know if the banner should now be cleared
            // on the card that's already on screen.
            responseBody.isVague = patched.isVague;
            responseBody.clarifyingQuestion = patched.clarifyingQuestion;
          }
        } catch (e) { /* patch failure is non-fatal — image still returns below */ }
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify(responseBody) };

  } catch (err) {
    console.error('Unhandled error in grocery-image:', err);
    // Never a hard error to the frontend — worst case, no image loads.
    return { statusCode: 200, headers, body: JSON.stringify({ imageUrl: null }) };
  }
};