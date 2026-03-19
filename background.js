const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 saat
const pageCache = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "FETCH_APP_PAGE") {
    return;
  }

  const appidMatch = String(message.appid || "").match(/\d+/);
  if (!appidMatch) {
    sendResponse({ ok: false, error: "Geçersiz app id" });
    return;
  }

  const appid = appidMatch[0];
  const lang = message.lang || "turkish";
  const cacheKey = `${appid}:${lang}`;
  const now = Date.now();

  const cached = pageCache.get(cacheKey);
  if (cached && now - cached.time < CACHE_TTL) {
    sendResponse({
      ok: true,
      html: cached.html,
      cached: true
    });
    return;
  }

  (async () => {
    try {
      const url = `https://store.steampowered.com/app/${appid}/?l=${encodeURIComponent(lang)}`;
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        credentials: "omit"
      });

      const html = await response.text();

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      pageCache.set(cacheKey, {
        html,
        time: now
      });

      sendResponse({
        ok: true,
        html
      });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error?.message || String(error)
      });
    }
  })();

  return true;
});