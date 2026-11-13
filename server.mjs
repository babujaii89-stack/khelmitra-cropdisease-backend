import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 8080);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY || '';

const DATA_GOV_IN_API_KEY = (process.env.DATA_GOV_IN_API_KEY || '').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const CROP_DISEASE_MODEL = process.env.CROP_DISEASE_MODEL || 'gpt-4o-mini';

const DATA_GOV_IN_MANDI_RESOURCE_ID =
  process.env.DATA_GOV_IN_MANDI_RESOURCE_ID ||
  '9ef84268-d588-465a-a308-a864a43d0070';

const MANDI_STATE = process.env.MANDI_STATE || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const CROPS = [
  { id:'tomato', name:'Tomato', seasons:['Rabi','Zaid'], terrains:['plains','hilly','plateau'], phRange:[6,7], nNeed:'high', durationDays:120, family:'Solanaceae', basePrice:1500 },
  { id:'onion', name:'Onion', seasons:['Rabi','Kharif'], terrains:['plains','plateau'], phRange:[6,7.5], nNeed:'medium', durationDays:130, family:'Amaryllidaceae', basePrice:1800 },
  { id:'potato', name:'Potato', seasons:['Rabi'], terrains:['plains','hilly'], phRange:[5.2,6.5], nNeed:'high', durationDays:100, family:'Solanaceae', basePrice:1200 },
  { id:'wheat', name:'Wheat', seasons:['Rabi'], terrains:['plains','plateau'], phRange:[6,7.5], nNeed:'medium', durationDays:140, family:'Poaceae', basePrice:2350 },
  { id:'mustard', name:'Mustard', seasons:['Rabi'], terrains:['plains','plateau'], phRange:[6,8], nNeed:'low', durationDays:120, family:'Brassicaceae', basePrice:5650 },
  { id:'ginger', name:'Ginger', seasons:['Kharif'], terrains:['hilly'], phRange:[5.5,6.5], nNeed:'medium', durationDays:240, family:'Zingiberaceae', basePrice:4200 },
  { id:'capsicum', name:'Capsicum', seasons:['Rabi','Zaid'], terrains:['hilly','plains'], phRange:[6,7], nNeed:'high', durationDays:110, family:'Solanaceae', basePrice:2800 },
  { id:'cabbage', name:'Cabbage', seasons:['Rabi'], terrains:['hilly','plains'], phRange:[6,6.8], nNeed:'high', durationDays:90, family:'Brassicaceae', basePrice:900 },
  { id:'soybean', name:'Soybean', seasons:['Kharif'], terrains:['plateau','plains'], phRange:[6,7.5], nNeed:'low', durationDays:100, family:'Fabaceae', basePrice:4600 },
  { id:'paddy', name:'Paddy', seasons:['Kharif'], terrains:['plains','hilly'], phRange:[5,7], nNeed:'high', durationDays:130, family:'Poaceae', basePrice:2300 },
];

const seasonNow = () => {
  const m = new Date().getMonth() + 1;
  return m >= 6 && m <= 9 ? 'Kharif' : m >= 10 || m <= 2 ? 'Rabi' : 'Zaid';
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function normalizeLocation(value) {
  return String(value || '')
    .replace(/\b(district|dist\.?)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreCrops(profile, season) {
  const soil = profile.soil || {};
  const n = Number(soil.nitrogen ?? 280);
  const nLevel = n < 280 ? 'low' : n > 560 ? 'high' : 'medium';

  return CROPS.map(crop => {
    let score = 40;
    const reasons = [];
    const warnings = [];

    const [lo, hi] = crop.phRange;
    const ph = Number(soil.ph ?? 6.5);

    if (ph >= lo && ph <= hi) {
      score += 22;
      reasons.push(`Soil pH ${ph} is within ideal ${lo}–${hi}`);
    } else {
      score -= Math.round(Math.min(Math.abs(ph-lo), Math.abs(ph-hi)) * 15);
      warnings.push(`pH ${ph} outside ideal ${lo}–${hi}`);
    }

    if (crop.terrains.includes(profile.terrain)) {
      score += 15;
      reasons.push(`Suited to ${profile.terrain} terrain`);
    } else {
      score -= 15;
      warnings.push(`Not ideal for ${profile.terrain} terrain`);
    }

    if (crop.seasons.includes(season)) {
      score += 18;
      reasons.push(`${season} season crop`);
    } else {
      score -= 25;
      warnings.push(`Off-season for ${season}`);
    }

    if (crop.nNeed === nLevel || (crop.nNeed === 'low' && nLevel !== 'low')) {
      score += 6;
      reasons.push(`Nitrogen level (${nLevel}) matches demand`);
    } else if (crop.nNeed === 'high' && nLevel === 'low') {
      score -= 6;
      warnings.push('Needs extra nitrogen top-dressing');
    }

    if (Number(soil.phosphorus ?? 22) < 22) {
      score -= 4;
      warnings.push('Low soil phosphorus — plan a soil-test-based basal phosphorus dose');
    } else {
      reasons.push('Soil phosphorus is not in the low range');
    }

    if (Number(soil.potassium ?? 140) < 140) {
      score -= 4;
      warnings.push('Low soil potassium — plan a soil-test-based potash dose');
    } else {
      reasons.push('Soil potassium is not in the low range');
    }

    if (Number(soil.organicCarbon ?? 0.5) < 0.5) {
      score -= 3;
      warnings.push('Low organic carbon — improve soil organic matter');
    } else {
      reasons.push('Soil organic carbon is adequate for the screening rule');
    }

    const last = CROPS.find(
      c => c.name.toLowerCase() ===
      (profile.previousCrops?.[0] || '').toLowerCase()
    );

    if (last && last.family === crop.family) {
      score -= 12;
      warnings.push(`Same family as last crop (${last.name}) — rotation risk`);
    } else if (last?.family === 'Fabaceae') {
      score += 5;
      reasons.push('Benefits from legume residue nitrogen');
    }

    return {
      crop,
      score: clamp(score, 5, 98),
      reasons,
      warnings
    };
  }).sort((a, b) => b.score - a.score);
}

function fertilizerPlan(crop, soil = {}) {
  const lowN = Number(soil.nitrogen ?? 280) < 280;
  const lowP = Number(soil.phosphorus ?? 22) < 22;
  const lowK = Number(soil.potassium ?? 140) < 140;

  const days = crop.durationDays;
  const nRate = crop.nNeed === 'high'
    ? (lowN ? 35 : 22)
    : crop.nNeed === 'medium'
      ? (lowN ? 25 : 15)
      : (lowN ? 15 : 8);

  const plan = [
    {
      day:0,
      product:'Well-decomposed farmyard manure',
      type:'Organic',
      dosePerAcre:4000,
      unit:'kg',
      method:'Incorporate into soil before planting; use mature, well-decomposed manure.'
    },
    {
      day:0,
      product:lowP ? 'DAP (soil-test adjusted basal phosphorus)' : 'Balanced basal NPK (soil-test based)',
      type:'Phosphate',
      dosePerAcre:lowP ? 45 : 35,
      unit:'kg',
      method:'Basal placement at planting; confirm exact nutrient requirement with local soil-test guidance.'
    },
    {
      day:Math.max(14, Math.round(days * .2)),
      product:'Urea (first nitrogen split)',
      type:'Nitrogen',
      dosePerAcre:+(nRate * .55).toFixed(1),
      unit:'kg',
      method:'Side-dress near the root zone; irrigate after application.'
    },
    {
      day:Math.max(28, Math.round(days * .4)),
      product:'Urea (second nitrogen split)',
      type:'Nitrogen',
      dosePerAcre:+(nRate * .45).toFixed(1),
      unit:'kg',
      method:'Apply only if crop condition supports it; avoid application before heavy rain.'
    },
    {
      day:Math.round(days * .55),
      product:lowK ? 'MOP (potash; soil-test adjusted)' : 'MOP/SOP (potash split)',
      type:'Potash',
      dosePerAcre:lowK ? 22 : 12,
      unit:'kg',
      method:'Apply as a split dose according to soil-test potassium and crop stage.'
    },
  ];

  if (['tomato','potato','onion','capsicum','cabbage'].includes(crop.id)) {
    plan.push({
      day:Math.round(days * .65),
      product:'Micronutrient mix (only if deficiency confirmed)',
      type:'Micronutrient',
      dosePerAcre:1,
      unit:'kg',
      method:'Apply only after confirming deficiency; follow label dilution and local extension advice.'
    });
  }

  plan.push({
    day:Math.round(days * .82),
    product:'Potassium finishing dose (only if crop/soil test requires)',
    type:'Potash',
    dosePerAcre:8,
    unit:'kg',
    method:'For fruit, tuber or bulb filling only where recommended; avoid late application without local agronomist guidance.'
  });

  return plan
    .filter(t => t.day < days)
    .sort((a, b) => a.day - b.day)
    .map((t, i) => ({ ...t, id:`${crop.id}-${i}` }));
}

// Parse Indian (DD/MM/YYYY) and ISO date formats safely.
function parseMandiDate(value) {
  if (!value) return 0;

  const s = String(value).trim();

  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);

  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);

    const date = new Date(Date.UTC(year, month - 1, day));

    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      return date.getTime();
    }

    return 0;
  }

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (iso) {
    return Date.UTC(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3])
    );
  }

  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Fetch and select the latest available AGMARKNET price.
async function mandi(crops, district, state) {
  if (!DATA_GOV_IN_API_KEY) {
    return {
      quotes: crops.map(crop => ({
        crop,
        price: null,
        market: null,
        arrivalDate: null,
        source:'data.gov.in'
      })),
      live:false,
      message:'Mandi API key is missing in Render.'
    };
  }

  const cleanState = normalizeLocation(state || MANDI_STATE);
  const cleanDistrict = normalizeLocation(district);

  const quotes = await Promise.all(
    crops.map(async crop => {
      try {
        const allRecords = [];
        const limit = 500;
        const maxPages = 6;

        for (let page = 0; page < maxPages; page++) {
          const url = new URL(
            `https://api.data.gov.in/resource/${DATA_GOV_IN_MANDI_RESOURCE_ID}`
          );

          url.searchParams.set('api-key', DATA_GOV_IN_API_KEY);
          url.searchParams.set('format', 'json');
          url.searchParams.set('limit', String(limit));
          url.searchParams.set('offset', String(page * limit));

          if (cleanState) {
            url.searchParams.set('filters[state]', cleanState);
          }
          url.searchParams.set('filters[district]', cleanDistrict);
          url.searchParams.set('filters[commodity]', crop.trim());

          // Note: Do NOT pass sort[arrival_date]=desc to data.gov.in because arrival_date
          // is stored as a DD/MM/YYYY string and sorts alphabetically instead of chronologically.

          const response = await fetch(url, {
            signal:AbortSignal.timeout(15000),
            headers:{ Accept:'application/json' }
          });

          if (!response.ok) {
            if (page === 0) {
              console.error('AGMARKNET HTTP error:', response.status);
              return {
                crop,
                price:null,
                market:null,
                arrivalDate:null,
                source:'data.gov.in',
                note:`Mandi API returned HTTP ${response.status}`
              };
            }
            break;
          }

          const body = await response.json();
          const pageRecords = body.records || [];

          allRecords.push(...pageRecords);

          if (
            pageRecords.length < limit ||
            (typeof body.total === 'number' && (page + 1) * limit >= body.total)
          ) {
            break;
          }
        }

        const records = allRecords
          .map(record => ({
            price:Number(
              record.modal_price ??
              record.modalprice ??
              record.modalPrice
            ),
            market:String(
              record.market ??
              record.market_name ??
              ''
            ).trim(),
            arrivalDate:String(
              record.arrival_date ??
              record.arrivalDate ??
              ''
            ).trim()
          }))
          .filter(record =>
            record.price > 0 &&
            Number.isFinite(record.price) &&
            parseMandiDate(record.arrivalDate) > 0
          )
          .sort((a, b) =>
            parseMandiDate(b.arrivalDate) -
            parseMandiDate(a.arrivalDate)
          );

        if (!records.length) {
          return {
            crop,
            price:null,
            market:null,
            arrivalDate:null,
            source:'AGMARKNET via data.gov.in',
            note:`No valid matching market records found for ${crop} in ${cleanDistrict}.`
          };
        }

        const latestTs = parseMandiDate(records[0].arrivalDate);
        const latestDayRecords = records.filter(
          r => parseMandiDate(r.arrivalDate) === latestTs
        );

        const avgPrice = Math.round(
          latestDayRecords.reduce((sum, r) => sum + r.price, 0) /
          latestDayRecords.length
        );

        const uniqueMarkets = Array.from(
          new Set(latestDayRecords.map(r => r.market).filter(Boolean))
        );

        const marketLabel =
          uniqueMarkets.length > 1
            ? `${uniqueMarkets[0]} (+${uniqueMarkets.length - 1} mandis)`
            : uniqueMarkets[0] || null;

        return {
          crop,
          price:avgPrice,
          market:marketLabel,
          arrivalDate:latestDayRecords[0].arrivalDate || null,
          source:'AGMARKNET via data.gov.in'
        };

      } catch (error) {
        console.error(`Mandi lookup failed for ${crop}:`, error);

        return {
          crop,
          price:null,
          market:null,
          arrivalDate:null,
          source:'data.gov.in',
          note:'Mandi service unavailable; retry later.'
        };
      }
    })
  );

  return {
    quotes,
    live:quotes.some(q => q.price !== null),
    message:'Latest available matching AGMARKNET market prices.'
  };
}

function send(res, status, body) {
  res.writeHead(status, {
    'content-type':'application/json; charset=utf-8',
    'access-control-allow-origin':ALLOWED_ORIGIN,
    'access-control-allow-headers':'authorization,content-type',
    'access-control-allow-methods':'GET,POST,OPTIONS',
    'vary':'Origin'
  });

  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes = 100_000) {
  let s = '';

  for await (const c of req) {
    s += c;

    if (s.length > maxBytes) {
      throw Object.assign(new Error('Request body too large'), { status:413 });
    }
  }

  return s ? JSON.parse(s) : {};
}

function extractOpenAIText(result) {
  if (typeof result.output_text === 'string') return result.output_text;
  for (const item of result.output || []) {
    for (const part of item.content || []) {
      if (part.type === 'output_text' && typeof part.text === 'string') return part.text;
    }
  }
  return '';
}

async function analyzeCropDisease(image, symptoms = [], cropName = 'unknown crop') {
  if (!OPENAI_API_KEY) {
    throw Object.assign(new Error('Crop disease analysis is not configured. Set OPENAI_API_KEY on the backend.'), { status:503 });
  }
  if (typeof image !== 'string' || image.length > 5_500_000) {
    throw Object.assign(new Error('Upload a smaller leaf image (maximum 4 MB).'), { status:413 });
  }
  const match = image.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) throw Object.assign(new Error('Upload a valid JPEG, PNG, WebP, or GIF image.'), { status:400 });
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 4 * 1024 * 1024) throw Object.assign(new Error('Upload a smaller leaf image (maximum 4 MB).'), { status:413 });
  const signatureOK = match[1].toLowerCase() === 'image/png'
    ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : match[1].toLowerCase() === 'image/jpeg'
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : match[1].toLowerCase() === 'image/gif'
        ? ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString())
        : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP';
  if (!signatureOK) throw Object.assign(new Error('The uploaded file is not a valid image.'), { status:400 });

  const schema = {
    type:'object', additionalProperties:false,
    properties:{
      isLeaf:{type:'boolean'},
      verdict:{type:'string',enum:['Biological disease','Pest attack','Chemical burn / toxicity']},
      name:{type:'string'}, confidence:{type:'integer',minimum:0,maximum:100},
      scores:{type:'object',additionalProperties:false,properties:{biological:{type:'integer'},pest:{type:'integer'},chemical:{type:'integer'}},required:['biological','pest','chemical']},
      remedy:{type:'array',items:{type:'string'}}, avoid:{type:'array',items:{type:'string'}},
      fertilizer:{type:'object',additionalProperties:false,properties:{product:{type:'string'},application:{type:'string'},reason:{type:'string'}},required:['product','application','reason']},
      message:{type:'string'}
    },required:['isLeaf','verdict','name','confidence','scores','remedy','avoid','fertilizer','message']
  };
  const observedSymptoms = Array.isArray(symptoms) ? symptoms.filter(s => typeof s === 'string').slice(0, 7) : [];
  const prompt = `Analyze this crop photo for a farmer. Crop (if known): ${cropName}. Farmer observations: ${observedSymptoms.join(', ') || 'none'}. First determine whether the main subject clearly includes a real plant leaf. Set isLeaf=false for objects, people, animals, landscapes, or images where a leaf cannot be identified; do not diagnose those. For a clear leaf, assess visible symptoms conservatively. Do not claim certainty from an unclear image; say so in message and lower confidence. Pick verdict from the allowed values. scores must sum to 100. Give 2-4 practical, locally cautious remedies; avoid unsupported chemical rates and advise following local product labels. Give an appropriate fertilizer/nutrient recommendation for this crop and condition, but do not claim fertilizer cures infectious disease. If no fertilizer is indicated, recommend no extra fertilizer and explain why. Set fertilizer.application to actionable timing/application guidance. Return only the required structured result.`;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method:'POST',
    headers:{ authorization:`Bearer ${OPENAI_API_KEY}`, 'content-type':'application/json' },
    body:JSON.stringify({ model:CROP_DISEASE_MODEL, input:[{ role:'user', content:[{ type:'input_text', text:prompt },{ type:'input_image', image_url:image }] }], text:{ format:{ type:'json_schema', name:'crop_disease_analysis', strict:true, schema } } })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Crop disease model request failed:', response.status, result.error?.message || '');
    throw Object.assign(new Error('Crop image analysis is temporarily unavailable.'), { status:502 });
  }
  let analysis;
  try { analysis = JSON.parse(extractOpenAIText(result)); } catch { /* handled below */ }
  if (!analysis || typeof analysis.isLeaf !== 'boolean') throw Object.assign(new Error('Could not read the image analysis. Please try another clear leaf photo.'), { status:502 });
  if (!analysis.isLeaf) throw Object.assign(new Error('This image does not appear to show a clear leaf. Please upload a close, well-lit photo of one crop leaf.'), { status:422 });
  const scores = analysis.scores;
  if (!scores || ['biological','pest','chemical'].some(k => !Number.isFinite(scores[k]))) throw Object.assign(new Error('Could not validate the image analysis. Please try again.'), { status:502 });
  const total = scores.biological + scores.pest + scores.chemical;
  if (total <= 0 || !Number.isFinite(total)) throw Object.assign(new Error('Could not validate the image analysis. Please try again.'), { status:502 });
  analysis.scores = Object.fromEntries(['biological','pest','chemical'].map(k => [k, Math.round(scores[k] / total * 100)]));
  return { ...analysis, scores:analysis.scores, fertilizer:analysis.fertilizer, advisory:'Image-based screening can be wrong. Confirm diagnosis and product choice with your local KVK/agriculture officer; fertilizer supports crop nutrition and does not cure infectious disease.' };
}

async function authenticate(req) {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw Object.assign(
      new Error('Backend missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY'),
      { status:500 }
    );
  }

  const token = (req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '');

  if (!token || token.split('.').length !== 3) {
    throw Object.assign(
      new Error('Sign in is required.'),
      { status:401 }
    );
  }

  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers:{
      apikey:SUPABASE_PUBLISHABLE_KEY,
      authorization:`Bearer ${token}`
    }
  });

  if (!r.ok) {
    throw Object.assign(
      new Error('Your session is invalid or expired. Please sign in again.'),
      { status:401 }
    );
  }

  return {
    token,
    user:await r.json()
  };
}

async function profileFor(token, uid, select='farm_profile,onboarded,active_crop_id,tasks') {
  const u = new URL(`${SUPABASE_URL}/rest/v1/profiles`);

  u.searchParams.set('select', select);
  u.searchParams.set('id', `eq.${uid}`);
  u.searchParams.set('limit', '1');

  const r = await fetch(u, {
    headers:{
      apikey:SUPABASE_PUBLISHABLE_KEY,
      authorization:`Bearer ${token}`
    }
  });

  if (!r.ok) {
    throw Object.assign(
      new Error(`Could not load saved farm profile (${r.status}).`),
      { status:502 }
    );
  }

  const rows = await r.json();
  return rows[0] || null;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    send(res, 204, {});
    return;
  }

  const path = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'GET' && path === '/health') {
    send(res, 200, {
      ok:true,
      service:'khetmitra-api'
    });
    return;
  }

  try {
    const { token, user } = await authenticate(req);
    const uid = user.id;

    if (req.method === 'POST' && path === '/api/crop-disease') {
      const body = await readJson(req, 7_500_000);
      const profileRow = await profileFor(token, uid, 'farm_profile,active_crop_id');
      const cropName = CROPS.find(c => c.id === profileRow?.active_crop_id)?.name || 'unknown crop';
      const analysis = await analyzeCropDisease(body.image, body.symptoms, cropName);
      send(res, 200, analysis);
      return;
    }

    if (req.method === 'POST' && path === '/api/crop-advice') {
      const row = await profileFor(token, uid, 'farm_profile,onboarded');

      if (!row?.farm_profile || !row.onboarded) {
        throw Object.assign(
          new Error('Complete your farm profile before requesting crop advice.'),
          { status:400 }
        );
      }

      const season = seasonNow();
      const profile = row.farm_profile;

      const cropNames = CROPS.map(c =>
        c.id === 'soybean' ? 'Soyabean' : c.name
      );

      const market = profile.district
        ? await mandi(cropNames, profile.district, profile.state)
        : {
            quotes:[],
            live:false,
            message:'Add your district in farm profile to retrieve local mandi prices.'
          };

      const quoteByName = new Map(
        market.quotes.map(q => [q.crop.toLowerCase(), q])
      );

      const recommendations = scoreCrops(profile, season)
        .map(item => {
          const key = item.crop.id === 'soybean'
            ? 'soyabean'
            : item.crop.name.toLowerCase();

          const q = quoteByName.get(key);

          const marketAdjustment = q?.price
            ? clamp(
                Math.round(((q.price / item.crop.basePrice) - 1) * 12),
                -8,
                8
              )
            : 0;

          return {
            ...item,
            score:clamp(item.score + marketAdjustment, 5, 98)
          };
        })
        .sort((a, b) => b.score - a.score);

      send(res, 200, {
        season,
        recommendations,
        quotes:market.quotes,
        live:market.live,
        message:market.message,
        profileSummary:{
          district:profile.district,
          state:profile.state || null,
          soil:profile.soil,
          previousCrops:profile.previousCrops || []
        }
      });

      return;
    }

    if (req.method === 'POST' && path === '/api/crop-validation') {
      const body = await readJson(req);
      const crop = CROPS.find(c => c.id === body.cropId);

      if (!crop) {
        throw Object.assign(
          new Error('Choose a valid crop.'),
          { status:400 }
        );
      }

      const row = await profileFor(token, uid, 'farm_profile,onboarded');

      if (!row?.farm_profile || !row.onboarded) {
        throw Object.assign(
          new Error('Complete your farm profile first.'),
          { status:400 }
        );
      }

      const result = scoreCrops(
        row.farm_profile,
        seasonNow()
      ).find(x => x.crop.id === crop.id);

      const commodity = crop.id === 'soybean'
        ? 'Soyabean'
        : crop.name;

      const market = row.farm_profile.district
        ? await mandi(
            [commodity],
            row.farm_profile.district,
            row.farm_profile.state
          )
        : { quotes:[], live:false };

      const quote = market.quotes[0];

      const adjustment = quote?.price
        ? clamp(
            Math.round(((quote.price / crop.basePrice) - 1) * 12),
            -8,
            8
          )
        : 0;

      const score = clamp(result.score + adjustment, 5, 98);

      send(res, 200, {
        ...result,
        score,
        quote:quote || null,
        season:seasonNow(),
        valid:score >= 55 &&
          !result.warnings.some(w => w.startsWith('Off-season'))
      });

      return;
    }

    if (req.method === 'POST' && path === '/api/mandi-prices') {
      const b = await readJson(req);

      if (
        typeof b.district !== 'string' ||
        b.district.trim().length < 2
      ) {
        throw Object.assign(
          new Error('District is required.'),
          { status:400 }
        );
      }

      const crops = Array.isArray(b.crops)
        ? b.crops.slice(0, 10)
        : [];

      if (!crops.length) {
        throw Object.assign(
          new Error('At least one crop is required.'),
          { status:400 }
        );
      }

      send(
        res,
        200,
        await mandi(crops, b.district.trim(), b.state)
      );

      return;
    }

    if (req.method === 'POST' && path === '/api/fertilizer-plan') {
      const row = await profileFor(token, uid);

      if (!row) {
        throw Object.assign(
          new Error('Farm profile not found.'),
          { status:404 }
        );
      }

      const p = row.farm_profile || {};
      const crop = CROPS.find(c => c.id === row.active_crop_id) || CROPS[0];

      const stored = Array.isArray(row.tasks) ? row.tasks : [];

      const done = new Map(
        stored
          .filter(t => t && t.done)
          .map(t => [String(t.id), t.done])
      );

      const tasks = fertilizerPlan(crop, p.soil || {})
        .map(t => ({
          ...t,
          ...(done.has(t.id) ? { done:done.get(t.id) } : {})
        }));

      send(res, 200, {
        cropId:crop.id,
        cropName:crop.name,
        durationDays:crop.durationDays,
        startedAt:p.cropStartedAt || new Date().toISOString(),
        tasks,
        advisory:'Planning estimates only. Confirm rates and products against a complete soil test and local KVK/Agriculture Department advice.'
      });

      return;
    }

    send(res, 404, {
      error:'Route not found.'
    });

  } catch (e) {
    console.error('Backend request error:', e);

    send(res, e.status || 500, {
      error:e.message || 'Unexpected backend error.'
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`KhetMitra API listening on ${PORT}`);
});
