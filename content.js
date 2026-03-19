(() => {
  const LANG = "turkish";
  const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 saat
  const MAX_CONCURRENT = 4;

  const pendingPromises = new Map();
  const queue = [];
  let activeCount = 0;

  injectStyles();
  scanRows();

  const observer = new MutationObserver(debounce(scanRows, 500));
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  function injectStyles() {
    if (document.getElementById("steam-inline-review-style")) return;

    const style = document.createElement("style");
    style.id = "steam-inline-review-style";
    style.textContent = `
      .steam-inline-review-box {
        margin-top: 6px;
        font-size: 12px;
        line-height: 1.35;
        color: #8f98a0;
        white-space: normal;
      }

      .steam-inline-review-line {
        margin-top: 2px;
      }

      .steam-inline-review-label {
        display: inline-block;
        min-width: 42px;
        color: #c7d5e0;
        font-weight: 600;
      }

      .steam-inline-review-value {
        color: #8f98a0;
      }

      .steam-inline-review-loading,
      .steam-inline-review-empty,
      .steam-inline-review-error {
        color: #8f98a0;
        margin-top: 4px;
      }
    `;
    document.head.appendChild(style);
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function scanRows() {
    const rows = document.querySelectorAll("a.search_result_row");
    rows.forEach((row) => {
      ensureRowProcessed(row);
    });
  }

  function ensureRowProcessed(row) {
    const box = getOrCreateBox(row);
    if (!box) return;

    const appid = extractAppId(row);

    if (!appid) {
      renderEmpty(box, "Sadece uygulama sayfalarında gösterilir");
      return;
    }

    if (box.dataset.loaded === "1") {
      return;
    }

    renderLoading(box);

    getReviewData(appid)
      .then((data) => {
        renderData(box, data);
      })
      .catch((error) => {
        console.error("Steam inline review error:", error);
        renderError(box, "Yüklenemedi");
      });
  }

  function getOrCreateBox(row) {
    let box = row.querySelector(".steam-inline-review-box");
    if (box) return box;

    const nameCol = row.querySelector(".col.search_name");
    if (!nameCol) return null;

    box = document.createElement("div");
    box.className = "steam-inline-review-box";

    const tags = nameCol.querySelector("p");
    if (tags) {
      tags.parentNode.insertBefore(box, tags);
    } else {
      nameCol.appendChild(box);
    }

    return box;
  }

  function extractAppId(row) {
    const dataId = row.getAttribute("data-ds-appid");
    if (dataId) {
      const match = dataId.match(/\d+/);
      if (match) return match[0];
    }

    const href = row.getAttribute("href") || "";
    const match = href.match(/\/app\/(\d+)/);
    if (match) return match[1];

    return null;
  }

  function renderLoading(box) {
    box.innerHTML = `<div class="steam-inline-review-loading">İncelemeler yükleniyor...</div>`;
    box.dataset.loaded = "0";
  }

  function renderEmpty(box, text = "İnceleme verisi yok") {
    box.innerHTML = `<div class="steam-inline-review-empty">${escapeHtml(text)}</div>`;
    box.dataset.loaded = "1";
  }

  function renderError(box, text = "Hata") {
    box.innerHTML = `<div class="steam-inline-review-error">${escapeHtml(text)}</div>`;
    box.dataset.loaded = "1";
  }

  function renderData(box, data) {
    const recent = data?.recent || "—";
    const all = data?.all || "—";

    if (!data?.recent && !data?.all) {
      renderEmpty(box, "İnceleme verisi bulunamadı");
      return;
    }

    box.innerHTML = `
      <div class="steam-inline-review-line">
        <span class="steam-inline-review-label">Son:</span>
        <span class="steam-inline-review-value">${escapeHtml(recent)}</span>
      </div>
      <div class="steam-inline-review-line">
        <span class="steam-inline-review-label">Tümü:</span>
        <span class="steam-inline-review-value">${escapeHtml(all)}</span>
      </div>
    `;
    box.dataset.loaded = "1";
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function getReviewData(appid) {
    const cached = loadCache(appid);
    if (cached) {
      return Promise.resolve(cached);
    }

    if (pendingPromises.has(appid)) {
      return pendingPromises.get(appid);
    }

    const promise = enqueue(async () => {
      const html = await fetchAppPage(appid);
      const parsed = parseReviewSummary(html);
      saveCache(appid, parsed);
      return parsed;
    }).finally(() => {
      pendingPromises.delete(appid);
    });

    pendingPromises.set(appid, promise);
    return promise;
  }

  function enqueue(taskFn) {
    return new Promise((resolve, reject) => {
      queue.push({ taskFn, resolve, reject });
      runQueue();
    });
  }

  function runQueue() {
    while (activeCount < MAX_CONCURRENT && queue.length > 0) {
      const item = queue.shift();
      activeCount++;

      Promise.resolve()
        .then(item.taskFn)
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
          activeCount--;
          runQueue();
        });
    }
  }

  function fetchAppPage(appid) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "FETCH_APP_PAGE",
          appid,
          lang: LANG
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (!response || !response.ok) {
            reject(new Error(response?.error || "İstek başarısız"));
            return;
          }

          resolve(response.html);
        }
      );
    });
  }

  function parseReviewSummary(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const rows = Array.from(doc.querySelectorAll(".user_reviews_summary_row"));

    let recent = null;
    let all = null;

    for (const row of rows) {
      const subtitle =
        row.querySelector(".subtitle")?.textContent?.trim().toLowerCase() ||
        row.textContent.trim().toLowerCase();

      const summaryEl = row.querySelector(".game_review_summary");
      if (!summaryEl) continue;

      const summaryText = summaryEl.textContent.trim();

      let countText = "";
      const spans = Array.from(row.querySelectorAll("span"));
      for (const span of spans) {
        const txt = span.textContent.trim();
        if (/^\(\s*[\d.,]+\s*\)$/.test(txt)) {
          countText = txt;
          break;
        }
      }

      const finalText = `${summaryText}${countText ? " " + countText : ""}`.trim();

      if (
        subtitle.includes("en son incelemeler") ||
        subtitle.includes("recent reviews")
      ) {
        recent = finalText;
      }

      if (
        subtitle.includes("bütün incelemeler") ||
        subtitle.includes("all reviews")
      ) {
        all = finalText;
      }
    }

    return { recent, all };
  }

  function loadCache(appid) {
    try {
      const raw = sessionStorage.getItem(`steam-inline-review:${appid}`);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.time || !parsed.data) return null;

      if (Date.now() - parsed.time > CACHE_TTL) {
        sessionStorage.removeItem(`steam-inline-review:${appid}`);
        return null;
      }

      return parsed.data;
    } catch {
      return null;
    }
  }

  function saveCache(appid, data) {
    try {
      sessionStorage.setItem(
        `steam-inline-review:${appid}`,
        JSON.stringify({
          time: Date.now(),
          data
        })
      );
    } catch {
      // sessiz geç
    }
  }
})();