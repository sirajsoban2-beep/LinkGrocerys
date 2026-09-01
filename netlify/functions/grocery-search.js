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

The query may be:
- A BRANDED item with a specific product (e.g. "Doritos", "Jif peanut butter")
- A GENERIC/unbranded item with no brand at all (e.g. "bananas", "tomato soup",
  "granola bars", "milk", "eggs")
- Just a BRAND NAME on its own, with no product type mentioned (e.g. "Van Decamp",
  "Doritos" with nothing else, "Barilla"). This is normal — when this happens,
  pick that brand's single most common, best-known flagship product and return
  a full result for that product (e.g. "Van Decamp" alone -> treat it as "Van de
  Kamp's Fish Sticks", their signature product).

All three cases are completely normal and common — always return a full, valid
result. Never treat a missing product type, or a missing brand, as an error.

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
- BARE BRAND NAME: If the query is only a brand name with no product type given, do NOT ask for clarification and do NOT fail — pick that brand's most iconic/common product yourself and return a complete result for it, exactly as if the user had typed the full product name.
- For GENERIC items with no brand, still return a complete, realistic result — never return an error or empty fields just because there's no brand.
- Always provide a realistic estimatedPriceRange, even for generic produce/pantry items, based on typical US supermarket pricing.
- Output ONLY raw JSON. No markdown fences, no commentary.
`;

    // Runs one Gemini call + JSON parse attempt. Returns the parsed object,
    // or null if anything about that attempt failed (bad HTTP status, empty
    // candidates, unparsable text, timeout, or network error). Wrapped in
    // try/catch so a slow/cold-start call that hits the timeout is caught
    // here and turned into a graceful fallback instead of crashing the
    // whole request with a raw 500 — this was the cause of intermittent
    // "Couldn't load that item" on the first search of a cold function.
    async function tryGeminiOnce(promptText, timeoutMs) {
      try {
        const res = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: promptText }] }],
              generationConfig: { responseMimeType: 'application/json' }
            })
          },
          timeoutMs
        );

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          console.error('Gemini HTTP error:', res.status, errText);
          return null;
        }

        const data = await res.json();

        if (!data.candidates || data.candidates.length === 0) {
          console.error('Gemini returned no candidates for query:', query, JSON.stringify(data));
          return null;
        }

        try {
          return JSON.parse(data.candidates[0].content.parts[0].text);
        } catch (parseErr) {
          console.error('Failed to parse Gemini JSON for query:', query, 'Raw text:', data.candidates[0].content.parts[0].text);
          return null;
        }
      } catch (netErr) {
        // Covers timeout aborts and any other network-level failure.
        console.error('Gemini request failed (timeout or network) for query:', query, netErr.name, netErr.message);
        return null;
      }
    }

    // ---- 3) SerpApi thumbnail (non-critical) ----
    // Fired in PARALLEL with Gemini below (not after it) using the raw
    // query — this used to wait for Gemini's exactProductTitle first,
    // which stacked both API calls back to back and was the main cause
    // of slow/timing-out fresh searches. Running them side by side roughly
    // halves total wait time. Trade-off: the image search uses the user's
    // raw text instead of Gemini's cleaned-up title, so a corrected brand
    // (e.g. "Van Decamp" -> "Van de Kamp's") may occasionally get a
    // slightly less precise photo — an acceptable trade for reliability.
    async function fetchImage(rawQuery) {
      if (!serpKey) return null;
      try {
        const searchQuery = encodeURIComponent(rawQuery);
        const serpRes = await fetchWithTimeout(
          `https://serpapi.com/search.json?engine=google_shopping&q=${searchQuery}&num=3&gl=us&hl=en&api_key=${serpKey}`,
          {}, 6000
        );
        const serpData = await serpRes.json();
        if (serpData.shopping_results && serpData.shopping_results.length > 0) {
          return serpData.shopping_results[0].thumbnail;
        }
        if (serpData.error) console.error('SerpApi returned an error:', serpData.error);
        return null;
      } catch (serpErr) {
        console.error('SerpApi Google Shopping Error:', serpErr.name, serpErr.message);
        return null;
      }
    }

    // Gemini gets a single attempt with a tight timeout — no automatic
    // retry. A retry that repeats the full ~10s call was doubling
    // worst-case latency and was the main reason fresh searches were
    // timing out at ~24s. One fast attempt plus an instant friendly
    // fallback keeps every response well under Netlify's function limit.
    const [geminiResult, imageUrlFromParallelCall] = await Promise.all([
      tryGeminiOnce(geminiSystemPrompt, 14000),
      fetchImage(query)
    ]);

    let parsed = geminiResult;

    if (!parsed) {
      // Gemini failed — respond with a friendly, shopper-facing fallback
      // instead of a raw error, so the UI never shows a dead end.
      parsed = {
        originalQuery: query,
        brandName: null,
        correctedFrom: null,
        exactProductTitle: query,
        category: 'Pantry',
        isVague: true,
        clarifyingQuestion: 'WE COULDN\'T PIN DOWN AN EXACT MATCH \u2014 TRY ADDING A BRAND, SIZE, OR PRODUCT TYPE.',
        detectedQuantity: null,
        detectedSize: null,
        defaultSmallestSize: '',
        suggestedSizes: [],
        suggestedVarieties: [],
        estimatedPriceRange: { low: null, high: null, defaultSizePrice: null, formattedDisplay: 'Price not available yet' }
      };
    }

    var payload = Object.assign({}, parsed, { imageUrl: imageUrlFromParallelCall });

    // ---- 4) Save to cache (best-effort) ----
    // Only cache a REAL Gemini result. If Gemini failed and we're serving
    // the friendly fallback, we deliberately do NOT cache it — otherwise
    // one bad/slow attempt would lock that item into a failed result for
    // the full 7-day TTL, even after Gemini would have succeeded on a
    // later try.
    if (store && geminiResult) {
      try { await store.setJSON(key, { cachedAt: Date.now(), payload: payload }); }
      catch (e) { /* cache write failure is non-fatal */ }
    }

    return { statusCode: 200, headers, body: JSON.stringify(Object.assign({}, payload, { cached: false })) };

  } catch (err) {
    // Last-resort safety net: whatever went wrong, the shopper should
    // never see a raw technical error. Log it for debugging, but respond
    // with the same friendly fallback card used for a Gemini failure —
    // statusCode 200 so the frontend renders it as a normal (just vague)
    // result instead of the red "Couldn't load" message.
    console.error('Unhandled error in grocery-search:', err);
    var safeQuery = (typeof query === 'string' && query) ? query : 'that item';
    var fallbackPayload = {
      originalQuery: safeQuery,
      brandName: null,
      correctedFrom: null,
      exactProductTitle: safeQuery,
      category: 'Pantry',
      isVague: true,
      clarifyingQuestion: 'WE COULDN\'T PIN DOWN AN EXACT MATCH \u2014 TRY ADDING A BRAND, SIZE, OR PRODUCT TYPE.',
      detectedQuantity: null,
      detectedSize: null,
      defaultSmallestSize: '',
      suggestedSizes: [],
      suggestedVarieties: [],
      estimatedPriceRange: { low: null, high: null, defaultSizePrice: null, formattedDisplay: 'Price not available yet' },
      imageUrl: null,
      cached: false
    };
    return { statusCode: 200, headers, body: JSON.stringify(fallbackPayload) };
  }
};