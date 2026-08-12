// Floating toolbar injected into the tab-preview window (see open_tab_page in
// lib.rs). The preview deliberately has no Tauri IPC — it shows a remote site —
// so the buttons talk to the native side the only way a sandboxed page can:
// by starting a navigation to a ukejam:// URL, which the window's
// on_navigation hook intercepts as a command and cancels.
(function () {
  "use strict";
  if (window.top !== window.self) return; // top frame only — skip ad iframes

  function signal(action, params) {
    window.location.href = "ukejam://" + action + (params ? "?" + params : "");
  }

  function makeButton(label, title, bg, fg, border) {
    var b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.style.cssText =
      "all:initial;cursor:pointer;padding:10px 16px;border-radius:10px;" +
      "font:600 14px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.45);" +
      "background:" + bg + ";color:" + fg + ";border:1px solid " + border + ";";
    return b;
  }

  function mount() {
    if (document.getElementById("ukejam-preview-bar")) return;
    var bar = document.createElement("div");
    bar.id = "ukejam-preview-bar";
    bar.style.cssText =
      "position:fixed;right:18px;bottom:18px;z-index:2147483647;display:flex;gap:10px;";

    var use = makeButton(
      "⇣ Use this tab",
      "Pull this tab's text into ukejam's add-a-song box",
      "#19e3c4",
      "#060a0c",
      "#19e3c4"
    );
    use.addEventListener("click", function () {
      signal("extract", "url=" + encodeURIComponent(window.location.href));
    });

    var close = makeButton(
      "✕ Close",
      "Close this preview window (Esc)",
      "rgba(10,15,18,.92)",
      "#cfe8e6",
      "#16242a"
    );
    close.addEventListener("click", function () {
      signal("close");
    });

    bar.appendChild(use);
    bar.appendChild(close);
    (document.body || document.documentElement).appendChild(bar);
  }

  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape") signal("close");
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
