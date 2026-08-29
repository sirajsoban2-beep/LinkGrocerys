// netlify/functions/grocery-search.js
// Milestone 1 — Netlify serverless bridge
// Gemini API (parse item attributes) + SerpApi Google Shopping (brand thumbnail)
//
// Runtime: Node 18+ on Netlify. `fetch` is a built-in global here,
// so node-fetch is NOT required (and must not be used).

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { query } = JSON.parse(event.body || '{}');

    if (!query || !query.trim()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Query parameter is required' }) };
    }

    // Fail fast with a clear message if the key is missing.
    // (Missing env vars are the #1 cause of confusing 500 errors.)
    if (!process.env.GEMINI_API_KEY) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'GEMINI_API_KEY is not set in Netlify environment variables' })
      };
    }

    // ── STEP 1: Gemini — structural analysis, brand detection & price estimation ──
    const geminiSystemPrompt = `
You are a grocery item parser for a professional delivery service.
Analyze query: "${query}".

Return ONLY a raw JSON object with this exact structure:
{
  "originalQuery": "${query}",
  "brandName": "Extracted brand name or null (e.g., 'Doritos', 'Jif', 'Barilla', 'Pace')",
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
    "low": 3.49,
    "high": 4.99,
    "defaultSizePrice": 3.99,
    "formattedDisplay": "$3.49 - $4.99 (Est. $3.99 for default size)"
  }
}

Rules:
- Set isVague to true if quantity, ounces, size, or variety is missing; otherwise false.
- Make clarifyingQuestion clear, urgent, and in ALL CAPS.
- Output ONLY raw JSON. No markdown fences.
`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: geminiSystemPrompt }] }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      }
    );

    const geminiData = await geminiRes.json();

    // Guard: Gemini can return no candidates (API error, safety block, quota exceeded)
    if (!geminiData.candidates || geminiData.candidates.length === 0) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'Gemini returned no result', details: geminiData })
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(geminiData.candidates[0].content.parts[0].text);
    } catch (parseErr) {
      // Gemini occasionally wraps JSON in markdown fences despite instructions.
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: 'Failed to parse Gemini JSON',
          raw: geminiData.candidates[0].content.parts[0].text
        })
      };
    }

    // ── STEP 2: SerpApi Google Shopping — exact brand-matched thumbnail ──
    let imageUrl = null;
    if (process.env.SERPAPI_KEY) {
      try {
        const searchQuery = encodeURIComponent(parsed.exactProductTitle || query);
        // gl=us & hl=en → US Google Shopping locale returns reliable retail thumbnails
        const serpRes = await fetch(
          `https://serpapi.com/search.json?engine=google_shopping&q=${searchQuery}&num=3&gl=us&hl=en&api_key=${process.env.SERPAPI_KEY}`
        );
        const serpData = await serpRes.json();

        if (serpData.shopping_results && serpData.shopping_results.length > 0) {
          imageUrl = serpData.shopping_results[0].thumbnail;
        }
      } catch (serpErr) {
        // Thumbnail is non-critical — log and continue so the card still renders.
        console.error('SerpApi Google Shopping Error:', serpErr);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...parsed, imageUrl })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
