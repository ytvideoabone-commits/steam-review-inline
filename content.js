/*
 * Steam Search Review Inline - Content Script
 * Steam arama sonuç satırlarına puan satırı ekler.
 */

(() => {
  const DEBUG_PREFIX = "[SteamInlineScores:content]";
  const MAX_CONCURRENT_UI = 4;

  const uiQueue = [];
  const uiInFlight = new Set();
  let uiActive = 0;

  const rowState = new WeakMap();
  const observedRows = new WeakSet();

  init();

  function init() {
    injectStyles();
    watchRows();
    initialScan();
    console.log(`${DEBUG_PREFIX} initialized`);
  }

  function injectStyles() {
    if (document.getElementById("steam-inline-scores-style")) return;

    const style = document.createElement("style");
    style.id = "steam-inline-scores-style";
    style.textContent = `
      .steam-inline-scores {
        margin-top: 6px;
        font-size: 11px;
        color: #9fb0bf;
        line-height: 1.35;
      }
      .steam-inline-scores__line {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .steam-inline-scores__chip {
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 4px;
        padding: 1px 5px;
        color: #c7d5e0;
        white-space: nowrap;
      }
      .steam-inline-scores__chip--good {
        color: #8dd58d;
        border-color: rgba(141, 213, 141, 0.35);
      }
      .steam-inline-scores__chip--mid {
        color: #e6d47a;
        border-color: rgba(230, 212, 122, 0.35);
      }
      .steam-inline-scores__chip--low {
        color: #f08a8a;
        border-color: rgba(240, 138, 138, 0.35);
      }
      .steam-inline-scores__chip--loading {
        opacity: 0.8;
      }
      .steam-inline-scores__debug {
        margin-top: 3px;
        font-size: 10px;
        opacity: 0.75;
      }
    `;

    document.head.appendChild(style);
  }

  function watchRows() {
    const scanDebounced = debounce(initialScan, 300);

    const mutationObserver = new MutationObserver(() => {
      scanDebounced();
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const row = entry.target;
          const state = rowState.get(row);
          if (!state || state.loaded || state.loading) continue;
          enqueueRowLoad(row);
        }
      },
      {
        root: null,
        rootMargin: "250px 0px",
        threshold: 0.01
      }
    );

    window.__steamInlineIntersectionObserver = intersectionObserver;
  }

  function initialScan() {
    const rows = document.querySelectorAll("a.search_result_row");
    const io = window.__steamInlineIntersectionObserver;
    if (!io) return;

    rows.forEach((row) => {
      if (observedRows.has(row)) return;

      const appid = extractAppId(row);
      if (!appid) return;

      const name = extractGameName(row);
      const itemType = row.getAttribute("data-ds-itemtype") || "";

      const box = ensureScoreBox(row);
      if (!box) return;

      rowState.set(row, {
        appid,
        name,
        itemType,
        loaded: false,
        loading: false,
        box
      });

      renderLoading(box);

      observedRows.add(row);
      io.observe(row);
    });
  }

  function ensureScoreBox(row) {
    let box = row.querySelector(".steam-inline-scores");
    if (box) return box;

    const nameCol = row.querySelector(".col.search_name");
    if (!nameCol) return null;

    box = document.createElement("div");
    box.className = "steam-inline-scores";

    const tags = nameCol.querySelector("p");
    if (tags?.parentNode) {
      tags.parentNode.insertBefore(box, tags);
    } else {
      nameCol.appendChild(box);
    }

    return box;
  }

  function enqueueRowLoad(row) {
    const state = rowState.get(row);
    if (!state || state.loaded || state.loading) return;
    if (uiInFlight.has(state.appid)) return;

    uiQueue.push(row);
    drainUiQueue();
  }

  function drainUiQueue() {
    while (uiActive < MAX_CONCURRENT_UI && uiQueue.length > 0) {
      const row = uiQueue.shift();
      const state = rowState.get(row);
      if (!state || state.loaded || state.loading) continue;

      uiActive += 1;
      state.loading = true;
      uiInFlight.add(state.appid);

      fetchScores(state)
        .then((payload) => {
          state.loaded = true;
          state.loading = false;
          renderScores(state.box, payload?.data || null);
        })
        .catch((error) => {
          state.loaded = true;
          state.loading = false;
          console.error(`${DEBUG_PREFIX} row fetch failed`, state.appid, error);
          renderError(state.box);
        })
        .finally(() => {
          uiInFlight.delete(state.appid);
          uiActive -= 1;
          drainUiQueue();
        });
    }
  }

  function fetchScores(state) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "GET_SCORES",
          appid: state.appid,
          name: state.name,
          itemType: state.itemType
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (!response || !response.ok) {
            reject(new Error(response?.error || "Unknown background error"));
            return;
          }

          resolve(response);
        }
      );
    });
  }

  function renderLoading(box) {
    box.innerHTML = `
      <div class="steam-inline-scores__line">
        <span class="steam-inline-scores__chip steam-inline-scores__chip--loading">MC: …</span>
        <span class="steam-inline-scores__chip steam-inline-scores__chip--loading">OC: …</span>
        <span class="steam-inline-scores__chip steam-inline-scores__chip--loading">SDB: …</span>
        <span class="steam-inline-scores__chip steam-inline-scores__chip--loading">Steam: …</span>
      </div>
    `;
  }

  function renderError(box) {
    box.innerHTML = `
      <div class="steam-inline-scores__line">
        <span class="steam-inline-scores__chip">MC: —</span>
        <span class="steam-inline-scores__chip">OC: —</span>
        <span class="steam-inline-scores__chip">SDB: —</span>
        <span class="steam-inline-scores__chip">Steam: —</span>
      </div>
      <div class="steam-inline-scores__debug">veri alınamadı (console)</div>
    `;
  }

  function renderScores(box, data) {
    const mc = asDisplayScore(data?.mc);
    const oc = asDisplayScore(data?.oc);
    const sdb = asDisplayScore(data?.sdb);
    const steam = asDisplayPercent(data?.steam);

    box.innerHTML = `
      <div class="steam-inline-scores__line">
        <span class="steam-inline-scores__chip ${scoreClass(data?.mc)}">MC: ${mc}</span>
        <span class="steam-inline-scores__chip ${scoreClass(data?.oc)}">OC: ${oc}</span>
        <span class="steam-inline-scores__chip ${scoreClass(data?.sdb)}">SDB: ${sdb}</span>
        <span class="steam-inline-scores__chip ${scoreClass(data?.steam)}">Steam: ${steam}</span>
      </div>
    `;

    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      box.innerHTML += `<div class="steam-inline-scores__debug">partial: ${escapeHtml(data.errors.join(" | "))}</div>`;
    }
  }

  function asDisplayScore(value) {
    return isValidScore(value) ? String(value) : "—";
  }

  function asDisplayPercent(value) {
    return isValidScore(value) ? `%${value}` : "—";
  }

  function scoreClass(value) {
    if (!isValidScore(value)) return "";
    if (value >= 75) return "steam-inline-scores__chip--good";
    if (value >= 50) return "steam-inline-scores__chip--mid";
    return "steam-inline-scores__chip--low";
  }

  function isValidScore(value) {
    return typeof value === "number" && value >= 1 && value <= 100;
  }

  function extractAppId(row) {
    const ds = row.getAttribute("data-ds-appid");
    if (ds) {
      const match = ds.match(/\d+/);
      if (match) return match[0];
    }

    const href = row.getAttribute("href") || "";
    const hrefMatch = href.match(/\/app\/(\d+)/);
    if (hrefMatch) return hrefMatch[1];

    return null;
  }

  function extractGameName(row) {
    const title = row.querySelector(".title")?.textContent?.trim();
    if (title) return title;

    const aria = row.getAttribute("aria-label") || "";
    return aria.trim();
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
})();
