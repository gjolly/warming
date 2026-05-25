(() => {
  const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
  const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
  const YEARS = 50;
  const ARCHIVE_LAG_DAYS = 5;
  const HEATWAVE_WINDOW = 10;
  const MIN_DAYS_PER_YEAR = 360;

  // Storage keys + cache policy.
  const CACHE_PREFIX = "warming:archive:";
  const CACHE_MANIFEST = "warming:cache_manifest";
  const LAST_PLACE_KEY = "warming:last_place";
  const THEME_KEY = "warming:theme";
  const MAX_CACHE_ENTRIES = 6;

  // Default place if nothing is saved yet. Lyon picked because its
  // summer-peak warming trend is dramatic on both metrics we plot
  // (~+0.9 °C/decade for both hottest day and peak 10-day heatwave),
  // and it captures the 2003/2022/2025 European heatwaves cleanly.
  const DEFAULT_PLACE = {
    name: "Lyon",
    admin1: "Auvergne-Rhône-Alpes",
    country: "France",
    latitude: 45.764,
    longitude: 4.8357,
  };

  const $q = document.getElementById("q");
  const $results = document.getElementById("results");
  const $status = document.getElementById("status");
  const $chart = document.getElementById("chart");
  const $kpis = document.getElementById("kpis");
  const $kpiHottest = document.getElementById("kpi-hottest");
  const $kpiPeak = document.getElementById("kpi-peak");
  const $resetZoom = document.getElementById("reset-zoom");
  const $themeToggle = document.getElementById("theme-toggle");

  let geoAbort = null;
  let archiveAbort = null;
  let debounceTimer = null;
  let activeIdx = -1;
  let currentResults = [];
  let plot = null;
  let lastYearly = null;

  // --- Theme ------------------------------------------------------------

  function applyStoredTheme() {
    let stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch {}
    if (stored === "light" || stored === "dark") {
      document.documentElement.dataset.theme = stored;
    } else {
      delete document.documentElement.dataset.theme;
    }
  }

  function currentTheme() {
    const set = document.documentElement.dataset.theme;
    if (set === "light" || set === "dark") return set;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  $themeToggle.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch {}
    if (lastYearly) renderChart(lastYearly);
  });

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    // Only act on OS change if user hasn't picked an override.
    let stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch {}
    if (!stored && lastYearly) renderChart(lastYearly);
  });

  applyStoredTheme();

  // --- Autocomplete -----------------------------------------------------

  $q.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const q = $q.value.trim();
    if (q.length < 2) {
      hideResults();
      return;
    }
    debounceTimer = setTimeout(() => searchPlaces(q), 250);
  });

  $q.addEventListener("keydown", (e) => {
    if ($results.hidden) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "Enter") {
      if (activeIdx >= 0 && currentResults[activeIdx]) {
        e.preventDefault();
        selectPlace(currentResults[activeIdx]);
      }
    } else if (e.key === "Escape") {
      hideResults();
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search")) hideResults();
  });

  async function searchPlaces(q) {
    if (geoAbort) geoAbort.abort();
    geoAbort = new AbortController();
    const url = `${GEO_URL}?name=${encodeURIComponent(q)}&count=8&language=en&format=json`;
    try {
      const r = await fetch(url, { signal: geoAbort.signal });
      if (!r.ok) throw new Error(`Geocoding ${r.status}`);
      const data = await r.json();
      renderResults(data.results || []);
    } catch (e) {
      if (e.name === "AbortError") return;
      setStatus(`Search failed: ${e.message}`, { error: true });
    }
  }

  function renderResults(results) {
    currentResults = results;
    activeIdx = -1;
    if (results.length === 0) {
      $results.innerHTML = '<li class="empty">No matches</li>';
      showResults();
      return;
    }
    $results.innerHTML = "";
    results.forEach((r, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.id = `result-${i}`;
      li.dataset.idx = String(i);
      const name = document.createElement("span");
      name.className = "place-name";
      name.textContent = r.name;
      const meta = document.createElement("span");
      meta.className = "place-meta";
      meta.textContent = [r.admin1, r.country].filter(Boolean).join(", ");
      li.appendChild(name);
      li.appendChild(meta);
      li.addEventListener("click", () => selectPlace(r));
      li.addEventListener("mouseenter", () => setActive(i));
      $results.appendChild(li);
    });
    showResults();
  }

  function showResults() {
    $results.hidden = false;
    $q.setAttribute("aria-expanded", "true");
  }

  function hideResults() {
    $results.hidden = true;
    $q.setAttribute("aria-expanded", "false");
    $q.removeAttribute("aria-activedescendant");
    activeIdx = -1;
  }

  function moveActive(delta) {
    if (currentResults.length === 0) return;
    activeIdx = (activeIdx + delta + currentResults.length) % currentResults.length;
    setActive(activeIdx);
  }

  function setActive(i) {
    activeIdx = i;
    [...$results.children].forEach((el, idx) => {
      el.classList.toggle("active", idx === i);
    });
    const el = $results.children[i];
    if (el) {
      if (el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
      if (el.id) $q.setAttribute("aria-activedescendant", el.id);
    }
  }

  // --- Cache + last-place (localStorage) -------------------------------
  // Cache key by lat/lon (3 decimals ≈ 110m). Manifest stores keys in
  // LRU order so we can evict the oldest when over quota.

  function cacheKey(place) {
    return `${CACHE_PREFIX}${place.latitude.toFixed(3)},${place.longitude.toFixed(3)}`;
  }

  function loadCache(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function saveCache(key, payload) {
    let manifest = [];
    try { manifest = JSON.parse(localStorage.getItem(CACHE_MANIFEST) || "[]"); } catch {}
    manifest = manifest.filter((k) => k !== key);
    manifest.push(key);
    while (manifest.length > MAX_CACHE_ENTRIES) {
      localStorage.removeItem(manifest.shift());
    }
    const json = JSON.stringify(payload);
    for (let i = 0; i < 5; i++) {
      try {
        localStorage.setItem(key, json);
        localStorage.setItem(CACHE_MANIFEST, JSON.stringify(manifest));
        return;
      } catch {
        // Quota — drop the oldest other entry and retry.
        const victim = manifest.find((k) => k !== key);
        if (!victim) return;
        manifest = manifest.filter((k) => k !== victim);
        localStorage.removeItem(victim);
      }
    }
  }

  function saveLastPlace(place) {
    try { localStorage.setItem(LAST_PLACE_KEY, JSON.stringify(place)); } catch {}
  }

  function loadLastPlace() {
    try {
      const raw = localStorage.getItem(LAST_PLACE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  // --- Fetch + render ---------------------------------------------------

  function placeLabel(place) {
    return [place.name, place.admin1, place.country].filter(Boolean).join(", ");
  }

  function renderTemps(label, times, temps, opts = {}) {
    const yearly = aggregateByYear(times, temps, HEATWAVE_WINDOW);
    if (yearly.length === 0) {
      setStatus(`Not enough complete years of data for ${label}.`, { error: true });
      return false;
    }
    renderChart(yearly);
    setStatus(
      `${label} — ${yearly.length} full years (${yearly[0].year}–${yearly[yearly.length-1].year})`,
      opts
    );
    return true;
  }

  async function selectPlace(place) {
    $q.value = place.name;
    hideResults();
    const label = placeLabel(place);
    saveLastPlace(place);

    const key = cacheKey(place);
    const cached = loadCache(key);
    if (cached && cached.times && cached.temps) {
      if (renderTemps(label, cached.times, cached.temps, { cached: true })) {
        // Touch manifest so this entry becomes most-recent.
        saveCache(key, cached);
        return;
      }
    }

    setStatus(`Loading temperatures for ${label}…`, { loading: true });
    if (archiveAbort) archiveAbort.abort();
    archiveAbort = new AbortController();

    const [start, end] = dateRange();
    const url = `${ARCHIVE_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&start_date=${start}&end_date=${end}` +
      `&daily=temperature_2m_mean&timezone=auto`;

    const t0 = performance.now();
    try {
      const r = await fetch(url, { signal: archiveAbort.signal });
      if (!r.ok) throw new Error(`Archive ${r.status}`);
      const data = await r.json();
      const times = data?.daily?.time;
      const temps = data?.daily?.temperature_2m_mean;
      if (!times?.length || !temps?.length) {
        setStatus(`No historical data available for ${label}.`, { error: true });
        return;
      }
      saveCache(key, { times, temps, fetchedAt: Date.now() });
      const dt = ((performance.now() - t0) / 1000).toFixed(1);
      renderTemps(label, times, temps, { timing: `${dt}s` });
    } catch (e) {
      if (e.name === "AbortError") return;
      setStatus(`Failed to load data: ${e.message}`, { error: true });
    }
  }

  function dateRange() {
    const end = new Date();
    end.setUTCDate(end.getUTCDate() - ARCHIVE_LAG_DAYS);
    const start = new Date(end);
    start.setUTCFullYear(start.getUTCFullYear() - YEARS);
    const fmt = (d) => d.toISOString().slice(0, 10);
    return [fmt(start), fmt(end)];
  }

  // --- Per-year aggregation --------------------------------------------
  // Group daily values by calendar year, then for each complete year
  // compute the hottest single day and the hottest 10-consecutive-day
  // window mean (peak heatwave).

  function aggregateByYear(times, temps, windowSize) {
    const byYear = new Map();
    for (let i = 0; i < times.length; i++) {
      const v = temps[i];
      if (v == null || Number.isNaN(v)) continue;
      const year = +times[i].slice(0, 4);
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push(v);
    }

    const out = [];
    for (const [year, values] of byYear) {
      if (values.length < MIN_DAYS_PER_YEAR) continue;
      let hottest = -Infinity;
      for (const v of values) if (v > hottest) hottest = v;

      let peak = -Infinity;
      if (values.length >= windowSize) {
        let sum = 0;
        for (let i = 0; i < windowSize; i++) sum += values[i];
        peak = sum;
        for (let i = windowSize; i < values.length; i++) {
          sum += values[i] - values[i - windowSize];
          if (sum > peak) peak = sum;
        }
        peak /= windowSize;
      }
      out.push({ year, hottest, peak });
    }
    out.sort((a, b) => a.year - b.year);
    return out;
  }

  // --- Linear regression (ordinary least squares) ----------------------
  // Returns slope and intercept of y = slope*x + intercept, computed
  // against the integer year on the x-axis so slope is in °C/year.

  function regress(years, values) {
    const n = years.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      sx += years[i];
      sy += values[i];
      sxx += years[i] * years[i];
      sxy += years[i] * values[i];
    }
    const denom = n * sxx - sx * sx;
    const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    return { slope, intercept };
  }

  function fmtSlope(slopePerYear) {
    const perDecade = slopePerYear * 10;
    const sign = perDecade >= 0 ? "+" : "−";
    return `${sign}${Math.abs(perDecade).toFixed(2)} °C/decade`;
  }

  // --- KPI cards -------------------------------------------------------

  function renderKpis(yearly, regH, regP) {
    const yrStart = yearly[0].year;
    const yrEnd = yearly[yearly.length - 1].year;
    const range = `${yrStart}–${yrEnd}`;

    $kpiHottest.innerHTML = "";
    const lh = document.createElement("p");
    lh.className = "kpi-label";
    lh.textContent = "Hottest day trend";
    const vh = document.createElement("div");
    vh.className = "kpi-value";
    vh.textContent = fmtSlope(regH.slope);
    const sh = document.createElement("p");
    sh.className = "kpi-sub";
    sh.textContent = `Annual maximum, ${range}`;
    $kpiHottest.append(lh, vh, sh);

    $kpiPeak.innerHTML = "";
    const lp = document.createElement("p");
    lp.className = "kpi-label";
    lp.textContent = "Peak 10-day mean trend";
    const vp = document.createElement("div");
    vp.className = "kpi-value";
    vp.textContent = fmtSlope(regP.slope);
    const sp = document.createElement("p");
    sp.className = "kpi-sub";
    sp.textContent = `Hottest 10-day window, ${range}`;
    $kpiPeak.append(lp, vp, sp);

    $kpis.hidden = false;
  }

  // --- Chart -----------------------------------------------------------

  function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    return {
      accent: cs.getPropertyValue("--accent").trim() || "#d4421e",
      accentSoft: cs.getPropertyValue("--accent-soft").trim() || "rgba(80,130,200,0.95)",
      muted: cs.getPropertyValue("--muted").trim() || "#6b6b6b",
      border: cs.getPropertyValue("--border").trim() || "#d8d6d0",
    };
  }

  function renderChart(yearly) {
    lastYearly = yearly;
    const colors = themeColors();
    const years = yearly.map((r) => r.year);
    const xs = new Float64Array(yearly.length);
    const hottest = new Array(yearly.length);
    const peak = new Array(yearly.length);
    for (let i = 0; i < yearly.length; i++) {
      xs[i] = Date.UTC(yearly[i].year, 6, 1) / 1000; // mid-year timestamp
      hottest[i] = yearly[i].hottest;
      peak[i] = yearly[i].peak;
    }
    const regH = regress(years, hottest);
    const regP = regress(years, peak);
    const hottestTrend = years.map((y) => regH.intercept + regH.slope * y);
    const peakTrend = years.map((y) => regP.intercept + regP.slope * y);
    const data = [xs, hottest, hottestTrend, peak, peakTrend];

    renderKpis(yearly, regH, regP);

    if (plot) {
      plot.destroy();
      plot = null;
    }

    const sz = chartSize();
    const isNarrow = window.innerWidth <= 720;
    const opts = {
      width: sz.width,
      height: sz.height,
      scales: { x: { time: true } },
      legend: { show: true },
      cursor: {
        drag: { x: true, y: false, uni: 10 },
        // uPlot 1.6: enable single-finger touch drag for X-axis zoom.
        touch: { x: true, y: false },
      },
      series: [
        { label: "Year" },
        {
          label: "Hottest day (°C)",
          stroke: colors.accent,
          width: 1.5,
          points: { show: true, size: 5, fill: colors.accent },
        },
        {
          label: `Hottest day trend (${fmtSlope(regH.slope)})`,
          stroke: colors.accent,
          width: 2,
          dash: [6, 4],
          points: { show: false },
        },
        {
          label: "Peak 10-day mean (°C)",
          stroke: colors.accentSoft,
          width: 2,
          points: { show: true, size: 6, fill: colors.accentSoft },
        },
        {
          label: `Peak 10-day trend (${fmtSlope(regP.slope)})`,
          stroke: colors.accentSoft,
          width: 2,
          dash: [6, 4],
          points: { show: false },
        },
      ],
      axes: [
        { stroke: colors.muted, grid: { stroke: colors.border } },
        isNarrow
          ? { stroke: colors.muted, grid: { stroke: colors.border }, size: 36, gap: 2 }
          : { label: "Temperature (°C)", stroke: colors.muted, grid: { stroke: colors.border } },
      ],
    };

    plot = new uPlot(opts, data, $chart);
    $resetZoom.hidden = false;
    return { hottest: regH.slope, peak: regP.slope };
  }

  $resetZoom.addEventListener("click", () => {
    if (plot) plot.setScale("x", { min: null, max: null });
  });

  function chartSize() {
    // Fit the canvas into the visible viewport (visualViewport handles
    // iOS Safari's collapsing URL bar correctly). Measure where .chart
    // starts and subtract the footer plus fixed reserves for the
    // chart-card padding, uPlot's legend, and breathing room.
    // $chart fills the inner content box of .chart-card (which has the
    // padding), so clientWidth is already the usable width. uPlot draws
    // its axes inside that — no extra horizontal subtraction needed.
    const top = $chart.getBoundingClientRect().top;
    const footer = document.querySelector("footer");
    const footerH = footer ? footer.offsetHeight + 12 : 32;
    const LEGEND_RESERVE = 56;
    const BREATHE = 16;
    const viewportH = window.visualViewport?.height ?? window.innerHeight;
    const isNarrow = window.innerWidth <= 720;
    const minH = isNarrow ? 260 : 300;
    const w = Math.max(280, $chart.clientWidth);
    const h = Math.max(
      minH,
      Math.floor(viewportH - top - footerH - LEGEND_RESERVE - BREATHE)
    );
    return { width: w, height: h };
  }

  let resizeRaf = 0;
  function onViewportChange() {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      if (plot) plot.setSize(chartSize());
    });
  }
  window.addEventListener("resize", onViewportChange);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", onViewportChange);
  }

  // --- Status ----------------------------------------------------------

  function setStatus(msg, opts = {}) {
    const isError = !!opts.error;
    const isLoading = !!opts.loading;
    const cached = !!opts.cached;
    const timing = opts.timing || null;

    $status.innerHTML = "";
    const text = document.createElement("span");
    text.textContent = msg;
    $status.appendChild(text);

    if (cached) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = "cached";
      $status.appendChild(b);
    }
    if (timing) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = timing;
      $status.appendChild(b);
    }
    $status.classList.toggle("error", isError);
    $chart.classList.toggle("loading", isLoading);
  }

  // --- Boot ------------------------------------------------------------

  const initial = loadLastPlace() || DEFAULT_PLACE;
  selectPlace(initial);
})();
