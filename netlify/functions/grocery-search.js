// netlify/functions/grocery-search.js
// Milestone 1/2 — Netlify serverless bridge
// Gemini (parse + fuzzy brand correction) + SerpApi (brand thumbnail)
// + Netlify Blobs cache (cache-first, manual TTL) to save API credits.
//
// Runtime: Node 18+ on Netlify. Requires the @netlify/blobs package.
// Accepts:  POST { "query": "Doritos" }   and   GET ?query=Doritos

const { connectLambda, getStore } = require('@netlify/blobs');

// ---- Cache settings -------------------------------------------------
var CACHE_STORE = 'grocery-cache';
var CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — change this one value to adjust TTL

// Helper: fetch with a hard timeout so a slow API can't hang the function.
const fetchWithTimeout = async (url, options = {}, timeoutMs = 15000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

// Normalize the query so "Doritos", "doritos " and "DORITOS" share one cache entry.
function cacheKey(q) {
  return q.toLowerCase().trim().replace(/\s+/g, ' ');
}

exports.handler = async (event) => {
  // Required for Netlify Blobs in Lambda-compatible functions.
  try { connectLambda(event); } catch (e) { /* Blobs optional; continue */ }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    let query;
    if (event.httpMethod === 'GET') {
      query = event.queryStringParameters && event.queryStringParameters.query;
    } else {
      query = JSON.parse(event.body || '{}').query;
    }

    if (!query || !query.trim()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Query parameter is required' }) };
    }

    var key = cacheKey(query);

    // ---- 1) CACHE-FIRST: try Netlify Blobs before any API call ----
    var store = null;
    try { store = getStore(CACHE_STORE); } catch (e) { store = null; }

    if (store) {
      try {
        var cached = await store.get(key, { type: 'json' });
        if (cached && cached.cachedAt && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify(Object.assign({}, cached.payload, { cached: true }))
          };
        }
      } catch (e) { /* cache miss or read error — fall through to APIs */ }
    }

    const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
    const serpKey = (process.env.SERPAPI_KEY || '').trim();

    if (!geminiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'GEMINI_API_KEY is not set in Netlify environment variables' }) };
    }

    // ---- 2) Gemini: parse + fuzzy brand correction ----
    const geminiSystemPrompt = `
You are a grocery item parser for a professional delivery service.
Analyze query: "${query}".

Return ONLY a raw JSON object with this exact structure:
{
  "originalQuery": "${query}",
  "brandName": "Extracted brand name or null (e.g., 'Doritos', 'Jif', 'Barilla', 'Pace')",
  "correctedFrom": "If you corrected a misspelled brand, put the user's original brand text here, otherwise null",
  "exactProductTitle": "Exact commercial title for image search (e.g., 'Jif Creamy Peanut Butter 16 oz')",
  "category": "Produce | Dairy & Eggs | Meat & Seafood | Bakery | Pantry | Frozen | Beverages | Household",
  "isVague": true,
  "clarifyingQuestion": "WHAT SIZE, WEIGHT (OUNCES/POUNDS), OR SPECIFIC VARIETY DO YOU PREFER?",
  "detectedQuantity": "string or null (e.g., '1', '2')",
  "detectedSize": "string or null (e.g., '16 oz', '9.25 oz bag', '1/2 gallon')",
  "defaultSmallestSize": "string (smallest standard supermarket size, e.g. '8 oz', '16 oz')",
  "suggestedSizes": ["Array of standard size options e.g. '9.25 oz bag', '14.5 oz Party Size'"],
  "suggestedVarieties": ["Array of brand varieties e.g. 'Nacho Cheese', 'Cool Ranch', 'Flamin Hot'"],
  "estimatedPriceRange": {
    "low": 3.49, "high": 4.99, "defaultSizePrice": 3.99,
    "formattedDisplay": "$3.49 - $4.99 (Est. $3.99 for default size)"
  }
}

Rules:
- FUZZY BRAND MATCHING: If the brand looks misspelled or is a close variant of a real major brand (e.g. "Van Decamp" -> "Van de Kamp's", "Cheeze It" -> "Cheez-It", "Barila" -> "Barilla"), silently correct it to the closest well-known brand and use the corrected brand in brandName and exactProductTitle. Record the user's original text in correctedFrom. Never fail on a misspelling if a plausible major brand exists.
- Set isVague to true if quantity, ounces, size, or variety is missing; otherwise false.
- Make clarifyingQuestion clear, urgent, and in ALL CAPS.
- Output ONLY raw JSON. No markdown fences.
`;

    const geminiRes = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: geminiSystemPrompt }] }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      },
      20000
    );

    const geminiData = await geminiRes.json();

    if (!geminiData.candidates || geminiData.candidates.length === 0) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Gemini returned no result', details: geminiData }) };
    }

    let parsed;
    try {
      parsed = JSON.parse(geminiData.candidates[0].content.parts[0].text);
    } catch (parseErr) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Failed to parse Gemini JSON', raw: geminiData.candidates[0].content.parts[0].text }) };
    }

    // ---- 3) SerpApi thumbnail (non-critical) ----
    let imageUrl = null;
    if (serpKey) {
      try {
        const searchQuery = encodeURIComponent(parsed.exactProductTitle || query);
        const serpRes = await fetchWithTimeout(
          `https://serpapi.com/search.json?engine=google_shopping&q=${searchQuery}&num=3&gl=us&hl=en&api_key=${serpKey}`,
          {}, 9000
        );
        const serpData = await serpRes.json();
        if (serpData.shopping_results && serpData.shopping_results.length > 0) {
          imageUrl = serpData.shopping_results[0].thumbnail;
        } else if (serpData.error) {
          console.error('SerpApi returned an error:', serpData.error);
        }
      } catch (serpErr) {
        console.error('SerpApi Google Shopping Error:', serpErr.name, serpErr.message);
      }
    }

    var payload = Object.assign({}, parsed, { imageUrl: imageUrl });

    // ---- 4) Save to cache (best-effort) ----
    if (store) {
      try { await store.setJSON(key, { cachedAt: Date.now(), payload: payload }); }
      catch (e) { /* cache write failure is non-fatal */ }
    }

    return { statusCode: 200, headers, body: JSON.stringify(Object.assign({}, payload, { cached: false })) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};