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
var CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — change this one value to adjust TTL

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
    // Explicitly covers generic/unbranded items (produce, bakery, etc. —
    // "bananas", "tomato soup") since brandName is null for these and the
    // model needs to know that's expected, not an error case.
    const geminiSystemPrompt = `
You are a grocery item parser for a professional delivery service.
Analyze query: "${query}".

The query may be a BRANDED item (e.g. "Doritos", "Jif peanut butter") or a
GENERIC/unbranded item with no brand at all (e.g. "bananas", "tomato soup",
"granola bars", "milk", "eggs"). Generic items are completely normal and
common — always return a full, valid result for them. Do not treat the
absence of a brand as an error.

Return ONLY a raw JSON object with this exact structure:
{
  "originalQuery": "${query}",
  "brandName": "Extracted brand name, or null if this is a generic/unbranded item (e.g. 'Doritos', or null for 'bananas')",
  "correctedFrom": "If you corrected a misspelled brand, put the user's original brand text here, otherwise null",
  "exactProductTitle": "Best commercial title for image search — for generic items use a plain descriptive title (e.g. 'Bananas, per lb' or 'Tomato Soup, canned')",
  "category": "Produce | Dairy & Eggs | Meat & Seafood | Bakery | Pantry | Frozen | Beverages | Household",
  "isVague": "boolean — true only if quantity, size, or variety is genuinely missing and needed to price the item; false if you can reasonably assume a standard default (most generic items like 'bananas' or 'milk' should be false with a sensible default size)",
  "clarifyingQuestion": "If isVague is true, a short clear question in ALL CAPS asking what size/weight/variety they want. If isVague is false, this must be null.",
  "detectedQuantity": "string or null (e.g., '1', '2')",
  "detectedSize": "string or null (e.g., '16 oz', '9.25 oz bag', '1 lb')",
  "defaultSmallestSize": "string (a sensible standard size/unit — e.g. '1 lb' for bananas, '8 oz' for a can of soup, '16 oz' for a bag of chips)",
  "suggestedSizes": ["Array of standard size options appropriate to this item — for produce this can be weight options like '1 lb', '2 lb', '5 lb bag'"],
  "suggestedVarieties": ["Array of common varieties, e.g. 'Nacho Cheese', 'Cool Ranch' for chips, or 'Organic', 'Regular' for produce — empty array if not applicable"],
  "estimatedPriceRange": {
    "low": 3.49, "high": 4.99, "defaultSizePrice": 3.99,
    "formattedDisplay": "$3.49 - $4.99 (Est. $3.99 for default size)"
  }
}

Rules:
- FUZZY BRAND MATCHING: If the brand looks misspelled or is a close variant of a real major brand (e.g. "Van Decamp" -> "Van de Kamp's", "Cheeze It" -> "Cheez-It", "Barila" -> "Barilla"), silently correct it to the closest well-known brand and use the corrected brand in brandName and exactProductTitle. Record the user's original text in correctedFrom. Never fail on a misspelling if a plausible major brand exists.
- For GENERIC items with no brand, still return a complete, realistic result — never return an error or empty fields just because there's no brand.
- Always provide a realistic estimatedPriceRange, even for generic produce/pantry items, based on typical US supermarket pricing.
- Output ONLY raw JSON. No markdown fences, no commentary.
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

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => '');
      console.error('Gemini HTTP error:', geminiRes.status, errText);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Gemini request failed', status: geminiRes.status }) };
    }

    const geminiData = await geminiRes.json();

    if (!geminiData.candidates || geminiData.candidates.length === 0) {
      console.error('Gemini returned no candidates for query:', query, JSON.stringify(geminiData));
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Gemini returned no result' }) };
    }

    let parsed;
    try {
      parsed = JSON.parse(geminiData.candidates[0].content.parts[0].text);
    } catch (parseErr) {
      // Log the raw text so we can see EXACTLY why a query like "bananas" failed.
      console.error('Failed to parse Gemini JSON for query:', query, 'Raw text:', geminiData.candidates[0].content.parts[0].text);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Failed to parse Gemini JSON' }) };
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
    console.error('Unhandled error in grocery-search:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};