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

  // CBS parallax fractal galaxy (Shadertoy-inspired). iChannel0 audio has no
  // equivalent here, so freqs breathe on timers; mouse adds parallax drift.
  // Returns true when accelerated rendering is on, false → CSS orb fallback.
  function glbg(host) {
    var cv = document.createElement("canvas");
    cv.className = "glbg";
    var gl = null;
    try { gl = cv.getContext("webgl", { antialias: false, alpha: false, depth: false, stencil: false }) || cv.getContext("experimental-webgl"); } catch (e) { gl = null; }
    if (!gl) return false;
    var fsrc = [
      "precision highp float;",
      "uniform vec2 u_res; uniform float u_time; uniform vec2 u_mouse;",
      "float field(in vec3 p, float s) {",
      "  float strength = 7. + .03 * log(1.e-6 + fract(sin(u_time) * 4373.11));",
      "  float accum = s / 4.; float prev = 0.; float tw = 0.;",
      "  for (int i = 0; i < 26; ++i) {",
      "    float mag = dot(p, p);",
      "    p = abs(p) / mag + vec3(-.5, -.4, -1.5);",
      "    float w = exp(-float(i) / 7.);",
      "    accum += w * exp(-strength * pow(abs(mag - prev), 2.2));",
      "    tw += w; prev = mag;",
      "  }",
      "  return max(0., 5. * accum / tw - .7);",
      "}",
      "float field2(in vec3 p, float s) {",
      "  float strength = 7. + .03 * log(1.e-6 + fract(sin(u_time) * 4373.11));",
      "  float accum = s / 4.; float prev = 0.; float tw = 0.;",
      "  for (int i = 0; i < 18; ++i) {",
      "    float mag = dot(p, p);",
      "    p = abs(p) / mag + vec3(-.5, -.4, -1.5);",
      "    float w = exp(-float(i) / 7.);",
      "    accum += w * exp(-strength * pow(abs(mag - prev), 2.2));",
      "    tw += w; prev = mag;",
      "  }",
      "  return max(0., 5. * accum / tw - .7);",
      "}",
      "vec3 nrand3(vec2 co) {",
      "  vec3 a = fract(cos(co.x * 8.3e-3 + co.y) * vec3(1.3e5, 4.7e5, 2.9e5));",
      "  vec3 b = fract(sin(co.x * 0.3e-3 + co.y) * vec3(8.1e5, 1.0e5, 0.1e5));",
      "  return mix(a, b, 0.5);",
      "}",
      "void main() {",
      "  vec2 uv = 2. * gl_FragCoord.xy / u_res - 1.;",
      "  vec2 uvs = uv * u_res / max(u_res.x, u_res.y);",
      "  vec2 m = u_mouse - 0.5;",
      "  vec3 p = vec3(uvs / 4., 0.) + vec3(1., -1.3, 0.);",
      "  p.xy += m * 0.25;",
      "  p += .2 * vec3(sin(u_time / 16.), sin(u_time / 12.), sin(u_time / 128.));",
      "  float f0 = .55 + .15 * sin(u_time * .23);",
      "  float f1 = .60 + .15 * sin(u_time * .31 + 1.7);",
      "  float f2 = .65 + .15 * sin(u_time * .27 + 3.1);",
      "  float f3 = .75 + .15 * sin(u_time * .19 + 5.0);",
      "  float t = field(p, f2);",
      "  float v = (1. - exp((abs(uv.x) - 1.) * 6.)) * (1. - exp((abs(uv.y) - 1.) * 6.));",
      "  vec3 p2 = vec3(uvs / (4. + sin(u_time * .11) * .2 + .2 + sin(u_time * .15) * .3 + .4), 1.5) + vec3(2., -1.3, -1.);",
      "  p2.xy += m * 0.35;",
      "  p2 += .25 * vec3(sin(u_time / 16.), sin(u_time / 12.), sin(u_time / 128.));",
      "  float t2 = field2(p2, f3);",
      "  vec4 c2 = mix(.4, 1., v) * vec4(1.3 * t2 * t2 * t2, 1.8 * t2 * t2, t2 * f0, t2);",
      "  vec2 seed = floor(p.xy * 2.0 * u_res.x);",
      "  vec4 starcolor = vec4(pow(nrand3(seed).y, 40.0));",
      "  vec2 seed2 = floor(p2.xy * 2.0 * u_res.x);",
      "  starcolor += vec4(pow(nrand3(seed2).y, 40.0));",
      "  gl_FragColor = mix(f3 - .3, 1., v) * vec4(1.5 * f2 * t * t * t, 1.2 * f1 * t * t, f3 * t, 1.0) + c2 + starcolor;",
      "}"
    ].join("\n");
    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    }
    var vs = sh(gl.VERTEX_SHADER, "attribute vec2 p; void main() { gl_Position = vec4(p, 0., 1.); }");
    var fs = sh(gl.FRAGMENT_SHADER, fsrc);
    if (!vs || !fs) return false;
    var pr = gl.createProgram();
    gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return false;
    gl.useProgram(pr);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(pr, "p");
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var uRes = gl.getUniformLocation(pr, "u_res"), uTime = gl.getUniformLocation(pr, "u_time"), uMouse = gl.getUniformLocation(pr, "u_mouse");
    var mx = 0.5, my = 0.5, t0 = performance.now();
    function size() {
      var w = Math.max(2, Math.floor(host.clientWidth * 0.55)), h = Math.max(2, Math.floor(host.clientHeight * 0.55));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; gl.viewport(0, 0, w, h); }
    }
    host.insertBefore(cv, host.firstChild);
    var blur = document.createElement("div");
    blur.className = "glblur"; blur.setAttribute("aria-hidden", "true");
    document.body.insertBefore(blur, host.nextSibling);
    window.addEventListener("resize", size);
    document.addEventListener("mousemove", function (e) {
      mx = e.clientX / window.innerWidth; my = 1 - e.clientY / window.innerHeight;
    }, { passive: true });
    size();
    (function frame() {
      if (!document.hidden) {
        gl.uniform2f(uRes, cv.width, cv.height);
        gl.uniform1f(uTime, (performance.now() - t0) / 1000);
        gl.uniform2f(uMouse, mx, my);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      requestAnimationFrame(frame);
    })();
    return true;
  }

  function ambient() {
    if (!window.matchMedia("(hover:hover) and (pointer:fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var root = document.documentElement;
    var aur = document.createElement("div");
    aur.className = "aurora"; aur.setAttribute("aria-hidden", "true");
    document.body.insertBefore(aur, document.body.firstChild);
    if (!glbg(aur)) aur.innerHTML = '<span class="orb o1"></span><span class="orb o2"></span><span class="orb o3"></span>';
    var dot = document.createElement("div"); dot.className = "cursor-dot"; dot.setAttribute("aria-hidden", "true");
    var ring = document.createElement("div"); ring.className = "cursor-ring"; ring.setAttribute("aria-hidden", "true");
    document.body.appendChild(dot); document.body.appendChild(ring);
    root.classList.add("has-cursor");
    var tx = -100, ty = -100, rx = -100, ry = -100;
    function place(el, x, y) { el.style.transform = "translate3d(" + x + "px," + y + "px,0) translate(-50%,-50%)"; }
    document.addEventListener("mousemove", function (e) {
      tx = e.clientX; ty = e.clientY;
      var nx = e.clientX / window.innerWidth - 0.5, ny = e.clientY / window.innerHeight - 0.5;
      root.style.setProperty("--px", (-nx * 24).toFixed(1) + "px");
      root.style.setProperty("--py", (-ny * 24).toFixed(1) + "px");
      place(dot, tx, ty);
    }, { passive: true });
    document.addEventListener("mouseover", function (e) {
      if (e.target.closest("a,button,.card,.asset,.chip,.dl-card")) ring.classList.add("is-hover");
    });
    document.addEventListener("mouseout", function (e) {
      if (e.target.closest("a,button,.card,.asset,.chip,.dl-card")) ring.classList.remove("is-hover");
    });
    place(dot, tx, ty); place(ring, rx, ry);
    (function loop() {
      rx += (tx - rx) * 0.16; ry += (ty - ry) * 0.16;
      place(ring, rx, ry);
      requestAnimationFrame(loop);
    })();
  }

  function boot() {
    ambient();
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
