/*
 * Steam Search Diagnostic Content Script
 * Amaç: Steam search satırlarında görünür "TEST PUAN" etiketi basmak.
 */

(() => {
  const LOG_PREFIX = "[SteamDiagBadge]";
  const BADGE_CLASS = "steam-diag-test-badge";
  const STYLE_ID = "steam-diag-test-badge-style";

  try {
    console.log(`${LOG_PREFIX} content script yüklendi`, {
      url: location.href,
      readyState: document.readyState
    });

    injectStyle();
    scanAndApply();

    const observer = new MutationObserver(() => {
      safeScan("mutation");
    });

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });

    window.addEventListener("load", () => safeScan("window.load"), { once: true });
    document.addEventListener("readystatechange", () => safeScan(`readyState:${document.readyState}`));
  } catch (err) {
    console.error(`${LOG_PREFIX} init error`, err);
  }

  function safeScan(reason) {
    try {
      scanAndApply(reason);
    } catch (err) {
      console.error(`${LOG_PREFIX} scan error`, { reason, err });
    }
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .search_result_row {
        position: relative !important;
      }

      .${BADGE_CLASS} {
        position: absolute;
        top: 6px;
        right: 8px;
        z-index: 99999;
        pointer-events: none;

        background: rgba(0, 0, 0, 0.88);
        color: #9cff9c;
        border: 2px solid #48d148;
        border-radius: 999px;

        padding: 2px 8px;
        font-size: 11px;
        font-weight: 800;
        line-height: 1.2;
        letter-spacing: 0.3px;

        box-shadow: 0 0 0 1px rgba(0,0,0,0.6), 0 2px 10px rgba(0,0,0,0.55);
        white-space: nowrap;
      }
    `;

    document.documentElement.appendChild(style);
  }

  function scanAndApply(reason = "initial") {
    const rows = document.querySelectorAll("a.search_result_row");
    console.log(`${LOG_PREFIX} scan`, {
      reason,
      rowCount: rows.length,
      url: location.href
    });

    if (!rows.length) return;

    let added = 0;
    rows.forEach((row) => {
      if (!(row instanceof HTMLElement)) return;

      const existing = row.querySelector(`.${BADGE_CLASS}`);
      if (existing) return;

      const badge = document.createElement("div");
      badge.className = BADGE_CLASS;
      badge.textContent = "TEST PUAN";
      badge.setAttribute("data-steam-diag", "1");

      row.appendChild(badge);
      added += 1;
    });

    if (added > 0) {
      console.log(`${LOG_PREFIX} rozet eklendi`, { added, totalRows: rows.length });
    }
  }
})();
