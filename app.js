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

  let geoAbort = null;
  let archiveAbort = null;
  let debounceTimer = null;
  let activeIdx = -1;
  let currentResults = [];
  let plot = null;

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
      setStatus(`Search failed: ${e.message}`, true);
    }
  }

  function renderResults(results) {
    currentResults = results;
    activeIdx = -1;
    if (results.length === 0) {
      $results.innerHTML = '<li class="empty">No matches</li>';
      $results.hidden = false;
      return;
    }
    $results.innerHTML = "";
    results.forEach((r, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
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
    $results.hidden = false;
  }

  function hideResults() {
    $results.hidden = true;
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
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
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

  function renderTemps(label, times, temps, suffix) {
    const yearly = aggregateByYear(times, temps, HEATWAVE_WINDOW);
    if (yearly.length === 0) {
      setStatus(`Not enough complete years of data for ${label}.`, true);
      return false;
    }
    const trends = renderChart(yearly);
    setStatus(
      `${label} — ${yearly.length} full years (${yearly[0].year}–${yearly[yearly.length-1].year}). ` +
      `Trends: hottest day ${fmtSlope(trends.hottest)}, peak 10-day ${fmtSlope(trends.peak)}${suffix}.`
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
      if (renderTemps(label, cached.times, cached.temps, " (cached)")) {
        // Touch manifest so this entry becomes most-recent.
        saveCache(key, cached);
        return;
      }
    }

    setStatus(`Loading temperatures for ${label}…`);
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
        setStatus(`No historical data available for ${label}.`, true);
        return;
      }
      saveCache(key, { times, temps, fetchedAt: Date.now() });
      const dt = ((performance.now() - t0) / 1000).toFixed(1);
      renderTemps(label, times, temps, ` (${dt}s)`);
    } catch (e) {
      if (e.name === "AbortError") return;
      setStatus(`Failed to load data: ${e.message}`, true);
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

  // --- Chart -----------------------------------------------------------

  function renderChart(yearly) {
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

    if (plot) {
      plot.destroy();
      plot = null;
    }

    const sz = chartSize();
    const opts = {
      width: sz.width,
      height: sz.height,
      scales: { x: { time: true } },
      legend: { show: true },
      cursor: {
        drag: { x: true, y: false, uni: 10 },
      },
      series: [
        { label: "Year" },
        {
          label: "Hottest day (°C)",
          stroke: "#d4421e",
          width: 1.5,
          points: { show: true, size: 5, fill: "#d4421e" },
        },
        {
          label: `Hottest day trend (${fmtSlope(regH.slope)})`,
          stroke: "#d4421e",
          width: 2,
          dash: [6, 4],
          points: { show: false },
        },
        {
          label: "Peak 10-day mean (°C)",
          stroke: "rgba(80, 130, 200, 0.85)",
          width: 2,
          points: { show: true, size: 6, fill: "rgba(80, 130, 200, 0.85)" },
        },
        {
          label: `Peak 10-day trend (${fmtSlope(regP.slope)})`,
          stroke: "rgba(80, 130, 200, 0.95)",
          width: 2,
          dash: [6, 4],
          points: { show: false },
        },
      ],
      axes: [
        {},
        { label: "Temperature (°C)" },
      ],
    };

    plot = new uPlot(opts, data, $chart);
    return { hottest: regH.slope, peak: regP.slope };
  }

  function chartSize() {
    // Fit the canvas into the remaining viewport: measure where .chart
    // starts, subtract the footer's actual height, plus fixed reserves
    // for chart-card padding, uPlot's legend, and breathing room.
    const top = $chart.getBoundingClientRect().top;
    const footer = document.querySelector("footer");
    const footerH = footer ? footer.offsetHeight + 12 : 32;
    const CHART_PADDING = 24;
    const LEGEND_RESERVE = 56;
    const BREATHE = 16;
    const w = Math.max(320, $chart.clientWidth - CHART_PADDING);
    const h = Math.max(
      300,
      Math.floor(window.innerHeight - top - footerH - LEGEND_RESERVE - BREATHE)
    );
    return { width: w, height: h };
  }

  window.addEventListener("resize", () => {
    if (plot) plot.setSize(chartSize());
  });

  // --- Status ----------------------------------------------------------

  function setStatus(msg, isError = false) {
    $status.textContent = msg;
    $status.classList.toggle("error", !!isError);
  }

  // --- Boot ------------------------------------------------------------

  const initial = loadLastPlace() || DEFAULT_PLACE;
  selectPlace(initial);
})();
