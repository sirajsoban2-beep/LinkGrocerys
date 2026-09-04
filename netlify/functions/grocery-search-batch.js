// netlify/functions/grocery-search-batch.js
// Bulk-list performance endpoint. Accepts an array of item queries and
// processes them as a GROUP:
//   1. Checks the cache for each item first (no API call for hits).
//   2. Sends every cache-miss to Gemini in ONE combined request instead
//      of one request per item — this is the main fix for bulk lists
//      being slow (100 items used to mean 100 sequential Gemini calls).
//   3. Fetches all images for the batch in PARALLEL (Promise.all).
//   4. Returns one array of results, in the same order as the input.
//
// The frontend calls this once per small chunk (e.g. 8 items at a time)
// so it can still show incremental progress while getting the benefit
// of batching within each chunk.
//
// Accepts: POST { "queries": ["milk", "eggs", "bananas", ...] }  (max 20)

const { connectLambda, getStore } = require('@netlify/blobs');

var CACHE_STORE = 'grocery-cache';
var CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — keep in sync with grocery-search.js
var MAX_BATCH_SIZE = 20;

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

// Same friendly fallback used by the single-item endpoint, for any item
// that Gemini fails to resolve within the batch.
function friendlyFallback(originalQuery) {
  return {
    originalQuery: originalQuery,
    brandName: null,
    correctedFrom: null,
    exactProductTitle: originalQuery,
    category: 'Pantry',
    dietaryTags: [],
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
    var body = JSON.parse(event.body || '{}');
    var queries = Array.isArray(body.queries) ? body.queries : [];
    queries = queries.map(function (q) { return String(q || '').trim(); }).filter(function (q) { return q.length > 0; });

    if (!queries.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'queries array is required' }) };
    }
    if (queries.length > MAX_BATCH_SIZE) {
      queries = queries.slice(0, MAX_BATCH_SIZE); // frontend should chunk, but guard here too
    }

    var geminiKey = (process.env.GEMINI_API_KEY || '').trim();
    var serpKey = (process.env.SERPAPI_KEY || '').trim();

    var store = null;
    try { store = getStore(CACHE_STORE); } catch (e) { store = null; }

    // ---- 1) Cache check for every item in the batch, in parallel ----
    var cacheChecks = await Promise.all(queries.map(async function (q) {
      if (!store) return null;
      try {
        var cached = await store.get(cacheKey(q), { type: 'json' });
        if (cached && cached.cachedAt && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
          return cached.payload;
        }
      } catch (e) { /* miss */ }
      return null;
    }));

    var uncachedIndexes = [];
    queries.forEach(function (q, i) { if (!cacheChecks[i]) uncachedIndexes.push(i); });

    // ---- 2) ONE Gemini call for every cache-miss in this batch ----
    var geminiResults = {}; // index -> parsed object
    if (uncachedIndexes.length && geminiKey) {
      var uncachedQueries = uncachedIndexes.map(function (i) { return queries[i]; });

      var batchPrompt = `
You are a grocery item parser for a professional delivery service.
You will receive a JSON array of shopper search queries. For EACH query,
produce one result object using the exact rules and structure below, and
return a single JSON array of results IN THE SAME ORDER as the input queries.

Queries: ${JSON.stringify(uncachedQueries)}

CATEGORY FRAMEWORK — apply per item:
1. BRAND & PROPRIETARY NAMES (including store/private-label brands like
   "Good & Gather", "Great Value", "Kirkland"): identify the brand and pick
   its most iconic product.
2. FRESH PRODUCE, MEAT & SEAFOOD: brandName null, realistic per-unit pricing,
   natural unit (lb/bunch/head/each).
3. STANDARD PACKAGED GOODS & PANTRY STAPLES: standard container size/price.
4. GENERIC / VAGUE INPUTS (e.g. "Milk", "Bread", "Chips", "Fish"): isVague
   true, suggestedVarieties = the real structural subtypes shoppers choose
   between. CRITICAL: exactProductTitle must stay NEUTRAL (e.g. "Fresh
   Fish", not "Atlantic Salmon Fillet") — never default the title to one
   specific variety/species/brand just because it's a common choice.

DIETARY & LIFESTYLE TAGS: never strip a qualifier like "Gluten-Free" or
"Vegan" — keep it in exactProductTitle and reflect it in dietaryTags.
UNIT OF MEASURE: produce uses lb/bunch/head/each; packaged items use oz.
ORGANIC VS CONVENTIONAL: keep these as distinct results with the organic
price premium reflected.
TAXONOMY CONSISTENCY: suggestedVarieties/suggestedSizes must stay within
the same physical form the query specifies — e.g. "Canned Black Beans"
must never offer "Dried" as a variety, "Frozen Broccoli" must never offer
"Fresh".
BARE BRAND NAME: if a query is only a brand with no product type, pick that
brand's flagship product yourself — never fail or ask for clarification.
FUZZY BRAND MATCHING: silently correct misspelled brands to the closest
real major brand (e.g. "Van Decamp" -> "Van de Kamp's") and record the
original text in correctedFrom.

Each result object must have this exact structure:
{
  "originalQuery": "the exact query string this result is for",
  "brandName": "string or null",
  "correctedFrom": "string or null",
  "exactProductTitle": "string",
  "category": "Produce | Dairy & Eggs | Meat & Seafood | Bakery | Pantry | Frozen | Beverages | Household",
  "dietaryTags": ["array of strings, empty if none"],
  "isVague": true,
  "clarifyingQuestion": "string or null",
  "detectedQuantity": "string or null",
  "detectedSize": "string or null",
  "defaultSmallestSize": "string",
  "suggestedSizes": ["array of strings"],
  "suggestedVarieties": ["array of strings"],
  "estimatedPriceRange": { "low": 0, "high": 0, "defaultSizePrice": 0, "formattedDisplay": "string" }
}

Output ONLY a raw JSON array of these objects, one per input query, in the
same order. No markdown fences, no commentary, no wrapper object — just the
array itself.
`;

      try {
        var res = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: batchPrompt }] }],
              generationConfig: { responseMimeType: 'application/json' }
            })
          },
          20000
        );

        if (res.ok) {
          var data = await res.json();
          if (data.candidates && data.candidates.length) {
            try {
              var arr = JSON.parse(data.candidates[0].content.parts[0].text);
              if (Array.isArray(arr)) {
                // Match results back to their original index by position.
                // If Gemini returns fewer/misaligned items, whatever is
                // missing just falls through to the friendly fallback below.
                uncachedIndexes.forEach(function (origIndex, pos) {
                  if (arr[pos]) geminiResults[origIndex] = arr[pos];
                });
              }
            } catch (parseErr) {
              console.error('Batch: failed to parse Gemini array JSON:', parseErr.message);
            }
          } else {
            console.error('Batch: Gemini returned no candidates', JSON.stringify(data));
          }
        } else {
          var errText = await res.text().catch(function () { return ''; });
          console.error('Batch: Gemini HTTP error', res.status, errText);
        }
      } catch (netErr) {
        console.error('Batch: Gemini request failed (timeout or network)', netErr.name, netErr.message);
      }
    }

    // ---- 3) Build the final per-item result list ----
    var finalResults = queries.map(function (q, i) {
      if (cacheChecks[i]) return Object.assign({}, cacheChecks[i], { cached: true });
      var fromGemini = geminiResults[i];
      if (fromGemini) return Object.assign({}, fromGemini, { cached: false });
      return Object.assign({}, friendlyFallback(q), { cached: false });
    });

    // ---- 4) Fetch images for every item that doesn't already have one,
    // all in PARALLEL rather than one at a time ----
    if (serpKey) {
      await Promise.all(finalResults.map(async function (item) {
        if (item.imageUrl) return; // cached items already have one
        try {
          var searchQuery = encodeURIComponent(item.originalQuery);
          var serpRes = await fetchWithTimeout(
            `https://serpapi.com/search.json?engine=google_shopping&q=${searchQuery}&num=3&gl=us&hl=en&api_key=${serpKey}`,
            {}, 6000
          );
          var serpData = await serpRes.json();
          if (serpData.shopping_results && serpData.shopping_results.length > 0) {
            item.imageUrl = serpData.shopping_results[0].thumbnail;
          } else {
            item.imageUrl = null;
          }
        } catch (e) {
          item.imageUrl = null;
        }
      }));
    }

    // Brand + image override, same rule as the single-item endpoint.
    finalResults.forEach(function (item) {
      if (item.brandName && item.imageUrl) {
        item.isVague = false;
        item.clarifyingQuestion = null;
      }
    });

    // ---- 5) Cache freshly-resolved (non-fallback) items, best-effort ----
    if (store) {
      await Promise.all(uncachedIndexes.map(async function (i) {
        if (!geminiResults[i]) return; // don't cache fallback results
        try {
          await store.setJSON(cacheKey(queries[i]), { cachedAt: Date.now(), payload: finalResults[i] });
        } catch (e) { /* non-fatal */ }
      }));
    }

    return { statusCode: 200, headers, body: JSON.stringify({ results: finalResults }) };

  } catch (err) {
    console.error('Unhandled error in grocery-search-batch:', err);
    // Last-resort: never fail the whole batch — return a friendly
    // fallback for every requested query instead of a hard error.
    var safeQueries = [];
    try { safeQueries = JSON.parse(event.body || '{}').queries || []; } catch (e) {}
    var results = safeQueries.map(function (q) { return Object.assign({}, friendlyFallback(String(q)), { cached: false }); });
    return { statusCode: 200, headers, body: JSON.stringify({ results: results }) };
  }
};