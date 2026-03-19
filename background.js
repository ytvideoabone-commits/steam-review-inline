/*
 * Steam Search Review Inline - Background Service Worker
 * - Cross-origin fetch
 * - Queue + concurrency limiting
 * - Shared cache (chrome.storage.local)
 */

const CACHE_PREFIX = "score-cache-v1:";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 saat
const MAX_CONCURRENT = 3;
const DEBUG_PREFIX = "[SteamInlineScores:bg]";

const memoryCache = new Map();
const inFlight = new Map();
const taskQueue = [];
let activeTasks = 0;

chrome.runtime.onInstalled.addListener(() => {
  console.log(`${DEBUG_PREFIX} installed`);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "GET_SCORES") return;

  const appid = String(message.appid || "").match(/\d+/)?.[0];
  const name = String(message.name || "").trim();
  const itemType = String(message.itemType || "").toLowerCase();

  if (!appid) {
    sendResponse({ ok: false, error: "Geçersiz appid" });
    return;
  }

  const cacheKey = `${CACHE_PREFIX}${appid}`;

  enqueue(async () => {
    try {
      const data = await getScoresWithCache({ appid, name, itemType, cacheKey });
      return { ok: true, data };
    } catch (error) {
      console.error(`${DEBUG_PREFIX} GET_SCORES failed`, { appid, name, error });
      return { ok: false, error: error?.message || String(error) };
    }
  })
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });

  return true;
});

function enqueue(taskFn) {
  return new Promise((resolve, reject) => {
    taskQueue.push({ taskFn, resolve, reject });
    runQueue();
  });
}

function runQueue() {
  while (activeTasks < MAX_CONCURRENT && taskQueue.length > 0) {
    const job = taskQueue.shift();
    activeTasks += 1;

    Promise.resolve()
      .then(job.taskFn)
      .then(job.resolve)
      .catch(job.reject)
      .finally(() => {
        activeTasks -= 1;
        runQueue();
      });
  }
}

async function getScoresWithCache({ appid, name, itemType, cacheKey }) {
  const now = Date.now();

  const hot = memoryCache.get(cacheKey);
  if (hot && now - hot.time < CACHE_TTL_MS) {
    return hot.data;
  }

  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  const promise = (async () => {
    const persisted = await storageGet(cacheKey);
    if (persisted && now - persisted.time < CACHE_TTL_MS && persisted.data) {
      memoryCache.set(cacheKey, persisted);
      return persisted.data;
    }

    const fresh = await gatherScores({ appid, name, itemType });
    const payload = { time: now, data: fresh };

    memoryCache.set(cacheKey, payload);
    await storageSet(cacheKey, payload);

    return fresh;
  })().finally(() => {
    inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, promise);
  return promise;
}

async function gatherScores({ appid, name, itemType }) {
  const normalizedName = normalizeName(name);
  const isPrimaryGame = !isLikelyNonMainGame(name, itemType);

  const result = {
    appid,
    gameName: name,
    updatedAt: Date.now(),
    meta: {
      itemType,
      isPrimaryGame
    },
    steam: null,
    sdb: null,
    oc: null,
    mc: null,
    errors: []
  };

  let steamDetails = null;

  // 1) SteamDB
  try {
    result.sdb = await fetchSteamDbScore(appid);
  } catch (error) {
    result.errors.push(`steamdb:${error?.message || error}`);
    console.warn(`${DEBUG_PREFIX} steamdb failed`, appid, error);
  }

  // 2) Steam
  try {
    steamDetails = await fetchSteamScores(appid);
    result.steam = steamDetails.steam;
    if (steamDetails.metacriticFromSteam != null) {
      result.mc = steamDetails.metacriticFromSteam;
    }
  } catch (error) {
    result.errors.push(`steam:${error?.message || error}`);
    console.warn(`${DEBUG_PREFIX} steam failed`, appid, error);
  }

  // 3) OpenCritic (sadece ana oyunda dene)
  if (isPrimaryGame) {
    try {
      result.oc = await fetchOpenCriticScore({ name, normalizedName });
    } catch (error) {
      result.errors.push(`opencritic:${error?.message || error}`);
      console.warn(`${DEBUG_PREFIX} opencritic failed`, appid, error);
    }
  }

  // 4) Metacritic (Steam'den gelmediyse ve ana oyunsa dene)
  if (result.mc == null && isPrimaryGame) {
    try {
      result.mc = await fetchMetacriticScore({ name, normalizedName });
    } catch (error) {
      result.errors.push(`metacritic:${error?.message || error}`);
      console.warn(`${DEBUG_PREFIX} metacritic failed`, appid, error);
    }
  }

  return result;
}

async function fetchSteamScores(appid) {
  const detailsUrl = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=english&cc=us`;
  const detailsResponse = await fetchText(detailsUrl, {
    headers: { Accept: "application/json" }
  });

  let metacriticFromSteam = null;
  try {
    const parsed = JSON.parse(detailsResponse);
    const node = parsed?.[appid];
    const score = node?.data?.metacritic?.score;
    if (typeof score === "number" && score >= 1 && score <= 100) {
      metacriticFromSteam = score;
    }
  } catch (error) {
    console.warn(`${DEBUG_PREFIX} appdetails parse failed`, appid, error);
  }

  const reviewsUrl = `https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0&filter=all`;
  const reviewsResponse = await fetchText(reviewsUrl, {
    headers: { Accept: "application/json" }
  });

  let steam = null;
  try {
    const parsed = JSON.parse(reviewsResponse);
    const pct = Number(parsed?.query_summary?.review_score);
    if (!Number.isNaN(pct) && pct >= 1 && pct <= 100) {
      steam = pct;
    }
  } catch (error) {
    console.warn(`${DEBUG_PREFIX} appreviews parse failed`, appid, error);
  }

  return { steam, metacriticFromSteam };
}

async function fetchSteamDbScore(appid) {
  const url = `https://steamdb.info/app/${appid}/`;
  const html = await fetchText(url, {
    headers: {
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  const ratingValue = findFirstIntMatch(html, [
    /"rating"\s*:\s*(\d{1,3})/i,
    /data-rating="(\d{1,3})"/i,
    /SteamDB[^\n<]{0,80}rating[^\d]{0,20}(\d{1,3})\s*%/i,
    /Review[^\n<]{0,80}(\d{1,3})\s*%/i
  ]);

  if (ratingValue != null && ratingValue >= 1 && ratingValue <= 100) {
    return ratingValue;
  }

  return null;
}

async function fetchOpenCriticScore({ name, normalizedName }) {
  if (!name) return null;

  const searchUrl = `https://opencritic.com/search/${encodeURIComponent(name)}`;
  const html = await fetchText(searchUrl, {
    headers: {
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  const candidates = [];
  const re = /\/game\/(\d+)\/([a-z0-9-]+)/gi;
  let match;
  while ((match = re.exec(html))) {
    candidates.push({ id: match[1], slug: match[2] });
  }

  const unique = dedupeBy(candidates, (c) => `${c.id}:${c.slug}`);

  let best = null;
  let bestScore = 0;
  for (const c of unique.slice(0, 8)) {
    const score = nameSimilarity(normalizedName, normalizeName(c.slug));
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  if (!best || bestScore < 0.72) {
    return null;
  }

  const pageUrl = `https://opencritic.com/game/${best.id}/${best.slug}`;
  const pageHtml = await fetchText(pageUrl, {
    headers: { "Accept-Language": "en-US,en;q=0.9" }
  });

  const ocScore = findFirstIntMatch(pageHtml, [
    /"topCriticScore"\s*:\s*(\d{1,3})/i,
    /Top Critic Average[^\d]{0,20}(\d{1,3})/i,
    /itemprop="ratingValue"[^>]*content="(\d{1,3})"/i
  ]);

  if (ocScore != null && ocScore >= 1 && ocScore <= 100) {
    return ocScore;
  }

  return null;
}

async function fetchMetacriticScore({ name, normalizedName }) {
  const slugCandidates = buildMetacriticSlugs(name);

  for (const slug of slugCandidates) {
    const url = `https://www.metacritic.com/game/${slug}/`;
    try {
      const html = await fetchText(url, {
        headers: {
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"
        }
      });

      const titleMatch = html.match(/<title>([^<]+)<\/title>/i)?.[1] || "";
      const titleNorm = normalizeName(titleMatch.replace(/\s*\|.*$/, ""));
      if (titleNorm && nameSimilarity(normalizedName, titleNorm) < 0.7) {
        continue;
      }

      const score = findFirstIntMatch(html, [
        /"metascore"\s*:\s*(\d{1,3})/i,
        /"critic_score"\s*:\s*(\d{1,3})/i,
        /c-siteReviewScore[^\d]{0,20}(\d{1,3})/i,
        /Metascore[^\d]{0,30}(\d{1,3})/i
      ]);

      if (score != null && score >= 1 && score <= 100) {
        return score;
      }
    } catch (error) {
      // 404 vb durumlarda diğer slug denensin.
      continue;
    }
  }

  return null;
}

function buildMetacriticSlugs(name) {
  const clean = slugify(name);
  const candidates = [clean];

  if (clean.includes("-")) {
    candidates.push(clean.replace(/-/g, ""));
  }

  // Yaygın sürüm eklerini sadeleştir
  candidates.push(clean.replace(/-(definitive|ultimate|complete|game-of-the-year|goty|remastered|redux|edition)$/i, ""));

  return Array.from(new Set(candidates.filter(Boolean))).slice(0, 4);
}

function isLikelyNonMainGame(name, itemType) {
  const text = `${name} ${itemType}`.toLowerCase();
  return /(dlc|soundtrack|demo|test server|beta|expansion pass|season pass|bundle)/i.test(text);
}

function normalizeName(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(str) {
  return normalizeName(str).replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const aTokens = new Set(a.split(" "));
  const bTokens = new Set(b.split(" "));

  const intersection = [...aTokens].filter((x) => bTokens.has(x)).length;
  const union = new Set([...aTokens, ...bTokens]).size;

  if (union === 0) return 0;
  return intersection / union;
}

function dedupeBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    map.set(keyFn(item), item);
  }
  return [...map.values()];
}

function findFirstIntMatch(text, regexes) {
  for (const regex of regexes) {
    const m = text.match(regex);
    if (m && m[1] != null) {
      const value = Number(m[1]);
      if (!Number.isNaN(value)) return value;
    }
  }
  return null;
}

async function fetchText(url, init = {}) {
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    redirect: "follow",
    ...init
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} @ ${url}`);
  }

  return response.text();
}

function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => resolve(result[key] || null));
  });
}

function storageSet(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => resolve());
  });
}
