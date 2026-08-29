// netlify/functions/grocery-search.js
// Milestone 1 — Netlify serverless bridge
// Gemini API (parse item attributes) + SerpApi Google Shopping (brand thumbnail)
//
// Runtime: Node 18+ on Netlify. `fetch` is a built-in global here.
//
// Accepts:
//   POST { "query": "Doritos" }            <- used by the widget
//   GET  ?query=Doritos                     <- convenient for browser testing

const fetchWithTimeout = async (url, options = {}, timeoutMs = 15000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Allow both GET (browser testing) and POST (the widget)
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    // Read the query from the URL (GET) or the JSON body (POST)
    let query;
    if (event.httpMethod === 'GET') {
      query = event.queryStringParameters && event.queryStringParameters.query;
    } else {
      query = JSON.parse(event.body || '{}').query;
    }

    if (!query || !query.trim()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Query parameter is required' }) };
    }

    // .trim() guards against a stray space/newline pasted into the env var.
    const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
    const serpKey = (process.env.SERPAPI_KEY || '').trim();

    if (!geminiKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'GEMINI_API_KEY is not set in Netlify environment variables' })
      };
    }

    // -- STEP 1: Gemini — structural analysis, brand detection & price estimation --
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
      20000 // 20s cap for Gemini
    );

    const geminiData = await geminiRes.json();

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
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: 'Failed to parse Gemini JSON',
          raw: geminiData.candidates[0].content.parts[0].text
        })
      };
    }

    // -- STEP 2: SerpApi Google Shopping — exact brand-matched thumbnail --
    let imageUrl = null;
    if (serpKey) {
      try {
        const searchQuery = encodeURIComponent(parsed.exactProductTitle || query);
        const serpRes = await fetchWithTimeout(
          `https://serpapi.com/search.json?engine=google_shopping&q=${searchQuery}&num=3&gl=us&hl=en&api_key=${serpKey}`,
          {},
          9000 // 9s cap for SerpApi
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