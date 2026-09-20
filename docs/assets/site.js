// opencode-gui download site — live release wiring, no deps.
// ponytail: GitHub API 60 req/hr unauthenticated; FALLBACK_* covers rate-limit/offline.
(function () {
  "use strict";
  var OWNER = "Brainrot-Corp";
  var REPO = "Opencode-GUI";
  var API = "https://api.github.com/repos/" + OWNER + "/" + REPO;
  var WEB = "https://github.com/" + OWNER + "/" + REPO;
  var FALLBACK_VERSION = "2.2.5"; // bump alongside package.json
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function displayTag(tag) { return String(tag || "").replace(/^Version-/, ""); }
  function fmtDate(iso) { try { return new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }); } catch (e) { return ""; } }
  function fmtSize(n) { if (!n && n !== 0) return ""; var u = ["B", "KB", "MB", "GB"]; var i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (n >= 100 ? Math.round(n) : n.toFixed(1)) + " " + u[i]; }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  function getJSON(url) {
    var c = new AbortController();
    var t = setTimeout(function () { c.abort(); }, 8000);
    return fetch(url, { signal: c.signal, headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }

  // substring matchers mirror .github/workflows/release.yml artifact globs
  function findAsset(assets, pred) {
    for (var i = 0; i < assets.length; i++) { var n = assets[i].name.toLowerCase(); if (pred(n, assets[i])) return assets[i]; }
    return null;
  }
  function matchAssets(assets) {
    assets = assets || [];
    return {
      win11: findAsset(assets, function (n) { return n.indexOf("win11") > -1 && n.slice(-4) === ".zip"; }),
      win10: findAsset(assets, function (n) { return n.indexOf("win10") > -1 && n.slice(-4) === ".zip"; }),
      dmg: findAsset(assets, function (n) { return n.slice(-4) === ".dmg"; }),
      macTar: findAsset(assets, function (n) { return n.indexOf(".app.tar.gz") > -1; }),
      debX64: findAsset(assets, function (n) { return n.slice(-4) === ".deb" && n.indexOf("arm64") === -1 && n.indexOf("aarch64") === -1; }),
      debArm: findAsset(assets, function (n) { return n.slice(-4) === ".deb" && (n.indexOf("arm64") > -1 || n.indexOf("aarch64") > -1); }),
      imgX64: findAsset(assets, function (n) { return n.indexOf(".appimage") > -1 && n.indexOf("arm64") === -1 && n.indexOf("aarch64") === -1; }),
      imgArm: findAsset(assets, function (n) { return n.indexOf(".appimage") > -1 && (n.indexOf("arm64") > -1 || n.indexOf("aarch64") > -1); })
    };
  }

  function detectOS() {
    var p = "";
    try { p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || ""; } catch (e) { p = navigator.userAgent || ""; }
    p = String(p).toLowerCase();
    var archArm = p.indexOf("arm") > -1 || p.indexOf("aarch64") > -1 || /mac.*arm/i.test(navigator.userAgent || "");
    if (p.indexOf("mac") > -1 || p.indexOf("darwin") > -1) return { id: "mac", label: "macOS" };
    if (p.indexOf("linux") > -1) return { id: archArm ? "linux-arm64" : "linux-x64", label: archArm ? "Linux (arm64)" : "Linux (x64)" };
    return { id: "win", label: "Windows 11" }; // default: largest audience
  }

  function assetRow(a, fallbackHref, fallbackName) {
    var href = a ? a.browser_download_url : fallbackHref;
    var name = a ? a.name : fallbackName;
    var size = a && a.size ? '<span class="size">' + esc(fmtSize(a.size)) + "</span>" : "";
    return '<a class="asset" href="' + esc(href) + '"><span class="name">' + esc(name) + "</span>" + size + "</a>";
  }

  function hydrateLanding(rel) {
    var hasApi = !!rel;
    var tag = rel ? rel.tag_name : "Version-" + FALLBACK_VERSION;
    var ver = displayTag(tag);
    var date = rel ? fmtDate(rel.published_at) : "";
    var page = rel ? rel.html_url : WEB + "/releases/latest";
    var m = matchAssets(rel ? rel.assets : []);
    var os = detectOS();
    var primary = { href: page, label: "Download" };
    if (m.win11 && os.id === "win") primary = { href: m.win11.browser_download_url, label: "Download for Windows 11" };
    else if (m.dmg && os.id === "mac") primary = { href: m.dmg.browser_download_url, label: "Download for macOS" };
    else if (m.debX64 && os.id === "linux-x64") primary = { href: m.debX64.browser_download_url, label: "Download for Linux (x64)" };
    else if (m.debArm && os.id === "linux-arm64") primary = { href: m.debArm.browser_download_url, label: "Download for Linux (arm64)" };
    else if (m.win11) primary = { href: m.win11.browser_download_url, label: "Download for Windows 11" };

    var cta = $("#cta-primary");
    if (cta) { cta.setAttribute("href", primary.href); var lbl = $("#cta-label"); if (lbl) lbl.textContent = primary.label; }
    var vl = $("#cta-version");
    if (vl) vl.innerHTML = "v" + esc(ver) + '<span class="dot"></span>' + (hasApi && date ? esc(date) + '<span class="dot"></span>' : "") + '<a href="' + esc(page) + '">release notes</a>' + (hasApi ? "" : " · offline list");

    var rows = $("#dl-rows");
    if (rows) {
      var html = "";
      html += '<div class="dl-card"><h3><span class="os-dot"></span>Windows x64</h3>' + (os.id === "win" ? '<span class="rec">Detected — ' + esc(os.label) + "</span>" : "") +
        assetRow(m.win11, page, "opencode-gui-win11-x64.zip") + assetRow(m.win10, page, "opencode-gui-win10-x64.zip") +
        '<p class="note">Win11 build uses glass/acrylic. Win10 build is opaque (no-glass).</p></div>';
      html += '<div class="dl-card"><h3><span class="os-dot"></span>macOS arm64</h3>' + (os.id === "mac" ? '<span class="rec">Detected — macOS</span>' : "") +
        assetRow(m.dmg, page, "disk image (.dmg)") + assetRow(m.macTar, page, "app archive (.app.tar.gz)") +
        '<p class="note">Unsigned — right-click → Open on first launch. macOS 13+.</p></div>';
      var lin = '<div class="dl-card"><h3><span class="os-dot"></span>Linux</h3>';
      if (os.id.indexOf("linux") === 0) lin += '<span class="rec">Detected — ' + esc(os.label) + "</span>";
      lin += assetRow(m.debX64, page, ".deb (x64)") + assetRow(m.imgX64, page, ".AppImage (x64)") + assetRow(m.debArm, page, ".deb (arm64)") + assetRow(m.imgArm, page, ".AppImage (arm64)") +
        '<p class="note">Ubuntu 22.04+. AppImage runs anywhere.</p></div>';
      rows.innerHTML = html + lin;
    }
  }

  function linkify(s) {
    return esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  }
  function hydrateChangelog(list) {
    var box = $("#releases");
    if (!box) return;
    if (!list || !list.length) {
      box.innerHTML = '<div class="error-box">Couldn\'t reach the GitHub API (rate-limit or offline).<br><a href="' + esc(WEB + "/releases") + '">See all releases on GitHub →</a></div>';
      return;
    }
    box.innerHTML = list.map(function (rel, i) {
      var assets = (rel.assets || []).map(function (a) {
        return '<a class="chip" href="' + esc(a.browser_download_url) + '">' + esc(a.name) + (a.size ? " · " + esc(fmtSize(a.size)) : "") + "</a>";
      }).join("");
      return '<article class="rel-card' + (i === 0 ? " latest" : "") + '"><h2><span class="tag">' + esc(rel.tag_name) + "</span>" +
        (i === 0 ? '<span class="badge">Latest</span>' : "") + '</h2><p class="rel-date">' + esc(fmtDate(rel.published_at)) + ' · <a href="' + esc(rel.html_url) + '">view on GitHub</a></p>' +
        (rel.body ? '<p class="rel-notes">' + linkify(String(rel.body).slice(0, 2000)) + "</p>" : "") +
        (assets ? '<div class="rel-assets">' + assets + "</div>" : "") + "</article>";
    }).join("");
  }

  function boot() {
    var needChangelog = !!$("#releases");
    if ($("#cta-primary") || $("#dl-rows")) {
      getJSON(API + "/releases/latest").then(hydrateLanding, function () { hydrateLanding(null); });
    }
    if (needChangelog) {
      getJSON(API + "/releases?per_page=20").then(hydrateChangelog, function () { hydrateChangelog(null); });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
