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
          var isImageReady = !!cached.payload.imageUrl;
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify(Object.assign({}, cached.payload, { cached: true, imagePending: !isImageReady }))
          };
        }
      } catch (e) { /* cache miss or read error — fall through to APIs */ }
    }

    const geminiKey = (process.env.GEMINI_API_KEY || '').trim();

    if (!geminiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'GEMINI_API_KEY is not set in Netlify environment variables' }) };
    }

    // ---- 2) Gemini: parse + fuzzy brand correction ----
    // This prompt encodes category-level RULES rather than a static
    // database of brands — Gemini applies the same logic dynamically to
    // any brand or item it sees, instead of us maintaining a lookup table.
    const geminiSystemPrompt = `
You are a grocery item parser for a professional delivery service.
Analyze query: "${query}".

CATEGORY FRAMEWORK — apply the rule for whichever category the query falls into:

1. BRAND & PROPRIETARY NAMES (e.g. "Old Dutch", "Ore-Ida", "Kraft", "Doritos"):
   Dynamically identify the brand and pick its single most iconic product,
   drawing on your knowledge of that brand's real product line (top
   4-6 signature products/flavors exist for most brands — pick the best-known
   one, or reflect a couple of its known varieties in suggestedVarieties).
   This includes STORE-BRAND / PRIVATE LABEL names (e.g. "Good & Gather",
   "Great Value", "Kirkland", "365", "Simple Truth") — treat these exactly
   like any national brand, with their own typical product variants.

2. FRESH PRODUCE, MEAT & SEAFOOD (e.g. "Asparagus", "Gala Apples", "Ribeye",
   "Salmon fillet"): brandName is null. Use realistic per-unit pricing and
   the correct natural unit (see UNIT OF MEASURE below). isVague should
   usually be false — assume a standard cut/size unless the query is
   unusually ambiguous.

3. STANDARD PACKAGED GOODS & PANTRY STAPLES (e.g. "Canned Black Beans",
   "Olive Oil", "Pasta"): default to the standard container size for that
   product category and a realistic price for it.

4. GENERIC / VAGUE INPUTS (e.g. "Milk", "Chips", "Bread" with no other
   detail): set isVague to true and use suggestedVarieties to offer the
   real structural subtypes shoppers actually choose between — e.g. for
   "Milk": "Whole", "2%", "1%", "Skim", "Almond", "Oat"; for "Bread":
   "White", "Wheat", "Sourdough", "Multigrain". Do not just guess one
   subtype silently — surface the choice via suggestedVarieties AND set
   clarifyingQuestion.

DIETARY & LIFESTYLE TAGS: If the query includes a dietary/lifestyle
qualifier — "Gluten-Free", "Vegan", "Dairy-Free", "Keto", "Organic", "Sugar-
Free", etc. — that qualifier is the whole point of the search. Keep it
front and center in exactProductTitle and reflect it in
suggestedVarieties/dietaryTags. NEVER silently strip the qualifier and
return the generic version (e.g. "Gluten-Free Bread" must return an actual
gluten-free bread result, not regular wheat bread; "Vegan Cheese" must
return a plant-based cheese result, not dairy cheese).

UNIT OF MEASURE & SIZE LOGIC: Produce should default to the unit a shopper
actually thinks in — "1 lb", "1 bunch", "1 head", "each" — not a generic
count. Packaged/pantry items default to standard net weight or volume —
"12 oz", "16 oz", "32 oz", etc.

ORGANIC VS CONVENTIONAL: "Organic Bananas" and "Bananas" are different
results — when "Organic" (or a store's organic line) is specified, reflect
that explicitly in exactProductTitle and dietaryTags, and price it at the
realistic organic premium versus the conventional version. Never collapse
organic and conventional into the same generic result.

TAXONOMY CONSISTENCY: Every value in suggestedVarieties and suggestedSizes
must be physically valid for the item's actual form/preparation as stated
in the query. Do not mix attributes from a different form of the same
ingredient — e.g. a query for "Canned Black Beans" must only offer
canned-appropriate varieties (Low Sodium, Organic, Seasoned) and must NOT
include "Dried" as an option; a query for "Frozen Broccoli" must not offer
"Fresh" as a variety; a query for "Ground Coffee" must not offer "Whole
Bean" unless the query itself is ambiguous about grind. If the query
already specifies the preparation/form (canned, frozen, dried, fresh,
ground, whole, etc.), suggestedVarieties must stay within that same form.

Return ONLY a raw JSON object with this exact structure:
{
  "originalQuery": "${query}",
  "brandName": "Extracted brand name (including store/private-label brands), or null if this is a generic/unbranded item",
  "correctedFrom": "If you corrected a misspelled brand, put the user's original brand text here, otherwise null",
  "exactProductTitle": "Best commercial title for image search — must preserve any dietary/organic qualifier from the query",
  "category": "Produce | Dairy & Eggs | Meat & Seafood | Bakery | Pantry | Frozen | Beverages | Household",
  "dietaryTags": ["Array of applicable tags such as 'Organic', 'Gluten-Free', 'Vegan', 'Dairy-Free', 'Keto' — empty array if none apply"],
  "isVague": "boolean — true if this is a generic/structural query needing a subtype choice (milk, bread, chips, etc.), or if quantity/size is genuinely missing; false if a brand or specific product is already clear",
  "clarifyingQuestion": "If isVague is true, a short clear question in ALL CAPS asking what type/size/variety they want. If isVague is false, this must be null.",
  "detectedQuantity": "string or null (e.g., '1', '2')",
  "detectedSize": "string or null (e.g., '16 oz', '9.25 oz bag', '1 lb')",
  "defaultSmallestSize": "string — a sensible standard size/unit per the UNIT OF MEASURE rule above",
  "suggestedSizes": ["Array of standard size options appropriate to this item's category"],
  "suggestedVarieties": ["Array of real varieties/subtypes/flavors relevant to this exact item — for generic items these are the structural subtypes shoppers choose between (see GENERIC/VAGUE rule); empty array only if genuinely not applicable"],
  "estimatedPriceRange": {
    "low": 3.49, "high": 4.99, "defaultSizePrice": 3.99,
    "formattedDisplay": "$3.49 - $4.99 (Est. $3.99 for default size)"
  }
}

Rules:
- FUZZY BRAND MATCHING: If the brand looks misspelled or is a close variant of a real major brand (e.g. "Van Decamp" -> "Van de Kamp's", "Cheeze It" -> "Cheez-It", "Barila" -> "Barilla"), silently correct it to the closest well-known brand and use the corrected brand in brandName and exactProductTitle. Record the user's original text in correctedFrom. Never fail on a misspelling if a plausible major brand exists.
- BARE BRAND NAME: If the query is only a brand name with no product type given, do NOT ask for clarification and do NOT fail — pick that brand's most iconic/common product yourself (per the CATEGORY FRAMEWORK above) and return a complete result for it, exactly as if the user had typed the full product name.
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

    // ---- 3) Text-first: no image fetching here anymore ----
    // Image lookup used to run in parallel with Gemini and both had to
    // finish before the response went out. It's now a SEPARATE endpoint
    // (grocery-image.js) that the frontend calls right after this text
    // response lands, so the card (title, price, size/variety chips) can
    // render in ~1 second with a skeleton placeholder, and the photo pops
    // in once it's ready instead of holding up everything else.

    // Gemini gets a single attempt with a tight timeout — no automatic
    // retry. A retry that repeats the full ~10s call was doubling
    // worst-case latency and was the main reason fresh searches were
    // timing out at ~24s. One fast attempt plus an instant friendly
    // fallback keeps every response well under Netlify's function limit.
    const geminiResult = await tryGeminiOnce(geminiSystemPrompt, 14000);

    let parsed = geminiResult;

    if (!parsed) {
      // Gemini failed — respond with a friendly, shopper-facing fallback
      // instead of a raw error, so the UI never shows a dead end. Generic
      // size/variety chips are included (rather than empty arrays) so the
      // card still gives the shopper something to pick from instead of
      // showing "Standard retail sizes apply" with nothing to tap.
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
        defaultSmallestSize: '16 oz',
        suggestedSizes: ['8 oz', '16 oz', '32 oz'],
        suggestedVarieties: ['Original', 'Value size'],
        estimatedPriceRange: { low: null, high: null, defaultSizePrice: null, formattedDisplay: 'Price not available yet' }
      };
    }

    var payload = Object.assign({}, parsed, { imageUrl: null, imagePending: true });

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
      defaultSmallestSize: '16 oz',
      suggestedSizes: ['8 oz', '16 oz', '32 oz'],
      suggestedVarieties: ['Original', 'Value size'],
      estimatedPriceRange: { low: null, high: null, defaultSizePrice: null, formattedDisplay: 'Price not available yet' },
      imageUrl: null,
      cached: false
    };
    return { statusCode: 200, headers, body: JSON.stringify(fallbackPayload) };
  }
};