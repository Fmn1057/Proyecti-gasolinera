const FUEL_LABELS = {
  gasolina_93: "Gasolina 93",
  gasolina_95: "Gasolina 95",
  gasolina_97: "Gasolina 97",
  petroleo_diesel: "Diésel",
  glp_vehicular: "GLP vehicular",
};

const TREND_ICON = { up: "↑", down: "↓", same: "→", new: "" };
const TREND_COLOR = { up: "#f4a261", down: "#2ecc71", same: "#8b9cb3", new: "" };

const statusEl = document.getElementById("status");
const metaEl = document.getElementById("meta");
const stationListEl = document.getElementById("stationList");
const fuelFilterEl = document.getElementById("fuelFilter");
const radiusEl = document.getElementById("radius");
const radiusValueEl = document.getElementById("radiusValue");
const btnRefresh = document.getElementById("btnRefresh");
const btnGeo = document.getElementById("btnGeo");
const autoRefreshEl = document.getElementById("autoRefresh");
const detailEl = document.getElementById("detail");
const detailClose = document.getElementById("detailClose");
const detailTitle = document.getElementById("detailTitle");
const detailAddr = document.getElementById("detailAddr");
const detailDist = document.getElementById("detailDist");
const detailPrices = document.getElementById("detailPrices");
const detailGoogleMaps = document.getElementById("detailGoogleMaps");
const brandSelectRow = document.getElementById("brandSelectRow");
const brandSelectEl = document.getElementById("brandSelect");

// Address search
const addressSearchEl = document.getElementById("addressSearch");
const btnSearchGeo = document.getElementById("btnSearchGeo");
const searchResultsEl = document.getElementById("searchResults");

// AI panel
const aiPanelEl = document.getElementById("aiPanel");
const btnAiOpen = document.getElementById("btnAiOpen");
const btnAiClose = document.getElementById("btnAiClose");
const aiMessagesEl = document.getElementById("aiMessages");
const aiFormEl = document.getElementById("aiForm");
const aiInputEl = document.getElementById("aiInput");

const BRAND_OTROS_KEY = "OTROS";
const LAST_LOCATION_KEY = "bencinas_last_location";

const MARCAS_INFERIR_CLIENT = [
  "PETRONEXT", "PETROBRAS", "ABASTIBLE", "COPEC", "SHELL", "TERPEL",
  "LIPIGAS", "FULLPRIX", "MAXPETRO", "AXION", "ESSO", "GULF",
  "NACIONAL", "BRAED", "FULL", "SIN BANDERA", "ENEX", "ARAMCO", "GASCO",
];

function inferMarcaDesdeTextoCliente(...textos) {
  const u = textos.filter(Boolean).join(" ").toUpperCase();
  if (!u) return "";
  for (const m of MARCAS_INFERIR_CLIENT) {
    if (u.includes(m)) return m;
  }
  return "";
}

function inferMarcaDesdeCodigoCliente(codigo) {
  const s = String(codigo || "").toLowerCase();
  if (!s) return "";
  if (/^co\d/.test(s)) return "COPEC";
  if (/^ab\d/.test(s)) return "ABASTIBLE";
  if (/^li\d/.test(s)) return "LIPIGAS";
  if (/^sh\d/.test(s)) return "SHELL";
  if (/^te\d/.test(s)) return "TERPEL";
  if (/^pe\d/.test(s)) return "PETROBRAS";
  if (/^pp\d/.test(s)) return "PETROPrix";
  if (/^hn\d/.test(s)) return "HN";
  if (/^ag\d/.test(s)) return "Gasco Autogas";
  return "";
}

function resolvedMarcaForStation(s) {
  let m = (s.marca || "").trim();
  if (!m && s.name) {
    const sep = " · ";
    const i = s.name.indexOf(sep);
    if (i > 0) {
      const first = s.name.slice(0, i).trim();
      if (first.length >= 2 && first.length <= 40) m = first;
    }
  }
  if (!m) m = inferMarcaDesdeTextoCliente(s.name, s.address, s.comuna);
  if (!m) m = inferMarcaDesdeCodigoCliente(s.codigo || s.id);
  return m;
}

let map;
let userMarker;
let accuracyCircle;
const stationMarkers = new Map();
let userLat;
let userLng;
let lastPayload = null;
let sortMode = "price";
let selectedId = null;
let refreshTimer = null;
let geocodeTimer = null;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("is-error", isError);
}

function googleMapsUrl(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return "#";
  return `https://www.google.com/maps?q=${la},${ln}`;
}

function invalidateMapSize() {
  if (!map) return;
  requestAnimationFrame(() => map.invalidateSize());
  setTimeout(() => map.invalidateSize(), 200);
}

function initMap(lat, lng, accuracyM) {
  if (map) {
    map.setView([lat, lng], 13);
    userMarker.setLatLng([lat, lng]);
    if (accuracyCircle) {
      if (accuracyM && accuracyM > 0) {
        accuracyCircle.setLatLng([lat, lng]).setRadius(accuracyM);
        accuracyCircle.addTo(map);
      } else {
        map.removeLayer(accuracyCircle);
      }
    }
    invalidateMapSize();
    return;
  }
  map = L.map("map", { zoomControl: true }).setView([lat, lng], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    maxZoom: 19,
  }).addTo(map);

  userMarker = L.marker([lat, lng], { title: "Tu ubicación" }).addTo(map);
  userMarker.bindPopup("<strong>Tu ubicación</strong>").openPopup();

  accuracyCircle = L.circle([lat, lng], {
    radius: accuracyM || 0,
    color: "#3dd6c3",
    fillColor: "#3dd6c3",
    fillOpacity: 0.08,
    weight: 1.5,
  });
  if (accuracyM && accuracyM > 0) accuracyCircle.addTo(map);

  invalidateMapSize();
}

function applyUserPosition(lat, lng, statusText, isError = false, accuracyM) {
  userLat = lat;
  userLng = lng;
  setStatus(statusText, isError);
  initMap(userLat, userLng, accuracyM);
  loadStations();
}

function clearStationMarkers() {
  stationMarkers.forEach((m) => map.removeLayer(m));
  stationMarkers.clear();
}

function priceForFuel(station, key) {
  const p = station.prices?.[key];
  return typeof p === "number" ? p : null;
}

function sortedStations(stations, fuelKey, mode) {
  const copy = [...stations];
  if (mode === "distance") {
    copy.sort((a, b) => a.distanceKm - b.distanceKm);
    return copy;
  }
  copy.sort((a, b) => {
    const pa = priceForFuel(a, fuelKey);
    const pb = priceForFuel(b, fuelKey);
    if (pa == null && pb == null) return a.distanceKm - b.distanceKm;
    if (pa == null) return 1;
    if (pb == null) return -1;
    if (pa !== pb) return pa - pb;
    return a.distanceKm - b.distanceKm;
  });
  return copy;
}

function cheapestIdForFuel(stations, fuelKey) {
  let best = null;
  let bestPrice = Infinity;
  for (const s of stations) {
    const p = priceForFuel(s, fuelKey);
    if (p != null && p < bestPrice) {
      bestPrice = p;
      best = s.id;
    }
  }
  return best;
}

function averagePriceForFuel(stations, fuelKey) {
  const prices = stations.map((s) => priceForFuel(s, fuelKey)).filter((p) => p != null);
  if (!prices.length) return null;
  return Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
}

function formatMoney(clp) {
  return `$${clp.toLocaleString("es-CL")}`;
}

function stationMarcaKey(s) {
  const m = resolvedMarcaForStation(s);
  return m ? m.toUpperCase() : BRAND_OTROS_KEY;
}

function passesBrandFilter(s) {
  if (!brandSelectEl) return true;
  const v = (brandSelectEl.value || "").trim().toUpperCase();
  if (!v) return true;
  return stationMarcaKey(s) === v;
}

function getVisibleStations() {
  const all = lastPayload?.stations || [];
  return all.filter(passesBrandFilter);
}

function resetBrandSelectUi() {
  if (!brandSelectEl || !brandSelectRow) return;
  brandSelectEl.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "Todas las marcas";
  brandSelectEl.appendChild(allOpt);
  brandSelectRow.hidden = true;
}

function populateBrandSelect(stations) {
  if (!brandSelectEl || !brandSelectRow) return;
  const prev = (brandSelectEl.value || "").trim().toUpperCase();
  brandSelectEl.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "Todas las marcas";
  brandSelectEl.appendChild(allOpt);

  const keys = [...new Set(stations.map(stationMarcaKey))].sort((a, b) => a.localeCompare(b, "es"));
  for (const key of keys) {
    const stFirst = stations.find((s) => stationMarcaKey(s) === key);
    const label =
      key === BRAND_OTROS_KEY
        ? "Otras / sin marca identificada"
        : resolvedMarcaForStation(stFirst) || stFirst?.name?.split(" · ")[0] || key;
    const o = document.createElement("option");
    o.value = key;
    o.textContent = label;
    brandSelectEl.appendChild(o);
  }

  if (prev && keys.includes(prev)) {
    brandSelectEl.value = prev;
  } else {
    brandSelectEl.value = "";
  }

  brandSelectRow.hidden = stations.length === 0;
}

function syncBrandFilterUi() {
  const vis = getVisibleStations();
  if (selectedId && !vis.some((s) => s.id === selectedId)) {
    detailEl.hidden = true;
    selectedId = null;
    stationMarkers.forEach((m) => {
      const el = m.getElement?.();
      if (el) el.classList.remove("is-selected-marker");
    });
  }
  renderList();
  updateMarkers();
  invalidateMapSize();
}

function renderTrendBadge(priceChanges, fuelKey) {
  if (!priceChanges) return null;
  const change = priceChanges[fuelKey];
  if (!change || change.direction === "new" || change.direction === "same") return null;
  const span = document.createElement("span");
  span.className = "price-trend";
  span.style.color = TREND_COLOR[change.direction] || "";
  span.title = change.direction === "up"
    ? `Subió $${change.delta} desde la última consulta`
    : `Bajó $${change.delta} desde la última consulta`;
  span.textContent = `${TREND_ICON[change.direction]}$${change.delta}`;
  return span;
}

function renderList() {
  const all = lastPayload?.stations || [];
  if (!all.length) {
    stationListEl.innerHTML = "";
    return;
  }

  const visible = getVisibleStations();
  if (!visible.length) {
    stationListEl.innerHTML = "";
    const li = document.createElement("li");
    li.className = "station-list-empty";
    li.textContent =
      "Ninguna estación para este distribuidor. Elige «Todas las marcas» u otra marca en el menú «Distribuidor».";
    stationListEl.appendChild(li);
    return;
  }

  const fuelKey = fuelFilterEl.value;
  const ordered = sortedStations(visible, fuelKey, sortMode);
  const cheapest = cheapestIdForFuel(visible, fuelKey);
  const avgPrice = averagePriceForFuel(visible, fuelKey);

  stationListEl.innerHTML = "";
  for (const s of ordered) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "station-card";
    if (selectedId === s.id) btn.classList.add("is-selected");
    if (cheapest && s.id === cheapest) btn.classList.add("is-cheapest");

    const pf = priceForFuel(s, fuelKey);
    if (cheapest && s.id === cheapest && pf != null) {
      const badge = document.createElement("span");
      badge.className = "station-card__badge";
      badge.textContent = "Más barata";
      btn.appendChild(badge);
    }

    const name = document.createElement("h3");
    name.className = "station-card__name";
    name.textContent = s.name;

    const addr = document.createElement("p");
    addr.className = "station-card__addr";
    addr.textContent = [s.address, s.comuna].filter(Boolean).join(" · ");

    const row = document.createElement("div");
    row.className = "station-card__row";

    const dist = document.createElement("span");
    dist.textContent = `${s.distanceKm.toFixed(2)} km`;

    const priceWrap = document.createElement("span");
    priceWrap.className = "station-card__price";
    if (pf != null) {
      const strong = document.createElement("strong");
      strong.textContent = `${FUEL_LABELS[fuelKey] || fuelKey}: `;
      priceWrap.appendChild(strong);
      priceWrap.append(formatMoney(pf));

      const trend = renderTrendBadge(s.priceChanges, fuelKey);
      if (trend) priceWrap.appendChild(trend);

      if (avgPrice && s.id !== cheapest && pf > avgPrice) {
        const diff = pf - avgPrice;
        const saveSpan = document.createElement("span");
        saveSpan.className = "price-vs-avg price-vs-avg--above";
        saveSpan.textContent = `+$${diff.toLocaleString("es-CL")} vs prom.`;
        priceWrap.appendChild(saveSpan);
      } else if (avgPrice && s.id !== cheapest && pf < avgPrice) {
        const diff = avgPrice - pf;
        const saveSpan = document.createElement("span");
        saveSpan.className = "price-vs-avg price-vs-avg--below";
        saveSpan.textContent = `-$${diff.toLocaleString("es-CL")} vs prom.`;
        priceWrap.appendChild(saveSpan);
      }
    } else {
      priceWrap.innerHTML = `<strong>${FUEL_LABELS[fuelKey] || fuelKey}:</strong> —`;
    }

    const mini = document.createElement("div");
    mini.className = "station-card__row station-card__mini";
    const parts = [];
    for (const [k, label] of Object.entries(FUEL_LABELS)) {
      const v = s.prices?.[k];
      if (v != null) {
        const change = s.priceChanges?.[k];
        const trendStr = change && (change.direction === "up" || change.direction === "down")
          ? ` ${TREND_ICON[change.direction]}`
          : "";
        parts.push(`${label.split(" ")[0]} ${formatMoney(v)}${trendStr}`);
      }
    }
    mini.textContent = parts.join(" · ");

    row.appendChild(dist);
    row.appendChild(priceWrap);

    const mapsActions = document.createElement("div");
    mapsActions.className = "station-card__maps-actions";
    const gUrl = googleMapsUrl(s.lat, s.lng);
    const btnGm = document.createElement("button");
    btnGm.type = "button";
    btnGm.className = "btn btn--card-maps";
    btnGm.textContent = "Google Maps";
    btnGm.disabled = gUrl === "#";
    btnGm.setAttribute("aria-label", "Abrir ubicación en Google Maps");
    btnGm.addEventListener("click", (e) => {
      e.stopPropagation();
      if (gUrl !== "#") window.open(gUrl, "_blank", "noopener,noreferrer");
    });
    mapsActions.appendChild(btnGm);

    btn.appendChild(name);
    if (s.marca) {
      const marcaTag = document.createElement("p");
      marcaTag.className = "station-card__marca";
      marcaTag.textContent = s.marca;
      btn.appendChild(marcaTag);
    }
    btn.appendChild(addr);
    btn.appendChild(row);
    btn.appendChild(mini);
    btn.appendChild(mapsActions);

    btn.addEventListener("click", () => selectStation(s));
    li.appendChild(btn);
    stationListEl.appendChild(li);
  }
}

function showDetail(s) {
  detailEl.hidden = false;
  detailTitle.textContent = s.name;
  const marcaLine = s.marca ? `${s.marca} · ` : "";
  detailAddr.textContent = marcaLine + [s.address, s.comuna].filter(Boolean).join(" · ");
  detailDist.textContent = `Distancia: ${s.distanceKm.toFixed(2)} km`;

  if (detailGoogleMaps) {
    const gUrl = googleMapsUrl(s.lat, s.lng);
    detailGoogleMaps.disabled = gUrl === "#";
    detailGoogleMaps.onclick = () => {
      if (gUrl !== "#") window.open(gUrl, "_blank", "noopener,noreferrer");
    };
  }

  detailPrices.innerHTML = "";
  for (const [k, label] of Object.entries(FUEL_LABELS)) {
    const v = s.prices?.[k];
    if (v == null) continue;
    const li = document.createElement("li");
    const labelSpan = document.createElement("span");
    labelSpan.textContent = label;
    const priceSpan = document.createElement("span");
    priceSpan.className = "detail-price-val";
    priceSpan.textContent = formatMoney(v);

    const change = s.priceChanges?.[k];
    if (change && (change.direction === "up" || change.direction === "down")) {
      const t = document.createElement("span");
      t.className = "price-trend";
      t.style.color = TREND_COLOR[change.direction];
      t.textContent = ` ${TREND_ICON[change.direction]}$${change.delta}`;
      priceSpan.appendChild(t);
    }

    li.appendChild(labelSpan);
    li.appendChild(priceSpan);
    detailPrices.appendChild(li);
  }
}

function hideDetail() {
  detailEl.hidden = true;
  selectedId = null;
  renderList();
  stationMarkers.forEach((m) => {
    const el = m.getElement?.();
    if (el) el.classList.remove("is-selected-marker");
  });
}

function selectStation(s) {
  selectedId = s.id;
  showDetail(s);
  renderList();
  if (map) {
    map.setView([s.lat, s.lng], Math.max(map.getZoom(), 15));
    const m = stationMarkers.get(s.id);
    if (m) {
      m.openPopup();
      stationMarkers.forEach((mk) => {
        const el = mk.getElement?.();
        if (el) el.classList.toggle("is-selected-marker", mk === m);
      });
    }
  }
}

function stationIcon(isCheapest) {
  const color = isCheapest ? "#2ecc71" : "#e74c3c";
  return L.divIcon({
    className: "station-marker",
    html: `<span style="display:block;width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function updateMarkers() {
  if (!map || !lastPayload?.stations) return;
  clearStationMarkers();
  const fuelKey = fuelFilterEl.value;
  const visible = getVisibleStations();
  const cheapest = cheapestIdForFuel(visible, fuelKey);

  for (const s of visible) {
    const isCh = cheapest === s.id;
    const m = L.marker([s.lat, s.lng], { icon: stationIcon(isCh) }).addTo(map);
    const pf = priceForFuel(s, fuelKey);
    const priceLine =
      pf != null
        ? `<div><strong>${FUEL_LABELS[fuelKey]}:</strong> ${formatMoney(pf)}</div>`
        : "";
    const gUrl = googleMapsUrl(s.lat, s.lng);
    const gLink =
      gUrl !== "#"
        ? `<div style="margin-top:0.45rem"><a href="${escapeAttr(gUrl)}" target="_blank" rel="noopener noreferrer">Google Maps</a></div>`
        : "";
    m.bindPopup(
      `<div style="min-width:160px"><strong>${escapeHtml(s.name)}</strong><br/>${priceLine}<small>${s.distanceKm.toFixed(2)} km</small>${gLink}</div>`
    );
    m.on("click", () => selectStation(s));
    stationMarkers.set(s.id, m);
  }
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function escapeAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

async function loadStations() {
  const radiusKm = Number(radiusEl.value);
  setStatus("Cargando precios desde la API CNE…");
  try {
    const url = `/api/stations?lat=${encodeURIComponent(userLat)}&lng=${encodeURIComponent(userLng)}&radiusKm=${radiusKm}`;
    const res = await fetch(url);
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    if (!res.ok || data.source === "error" || data.ok === false) {
      const msg =
        data.error ||
        (res.status === 502 || res.status === 503
          ? "Error al obtener precios oficiales. Revisa credenciales CNE en el servidor y la conexión."
          : `Error al cargar precios (HTTP ${res.status}).`);
      setStatus(msg, true);
      const metaParts = [];
      if (data.errorCode) metaParts.push(`Código: ${data.errorCode}`);
      if (data.hint) metaParts.push(data.hint);
      if (data.diagnostic && typeof data.diagnostic === "object") {
        const d = data.diagnostic;
        if (d.rawStationCount != null) {
          metaParts.push(`CNE: ${d.rawStationCount} filas → ${d.normalizedCount ?? 0} con coordenadas válidas`);
        }
      }
      metaEl.textContent = metaParts.join(" · ");
      lastPayload = { stations: [], source: "error" };
      resetBrandSelectUi();
      hideDetail();
      updateMarkers();
      renderList();
      invalidateMapSize();
      return;
    }

    lastPayload = data;
    const u = lastPayload.user;
    const metaParts = [];
    if (lastPayload.fromBackup) {
      metaParts.push("Lista desde respaldo local (la API CNE no respondió en este momento)");
    }
    if (lastPayload.cneCatalog) {
      const c = lastPayload.cneCatalog;
      metaParts.push(`${c.tiposCombustibleCount} tipos · ${c.distribuidoresCount} distribuidores (CNE)`);
    }
    if (u && typeof u.lat === "number" && typeof u.lng === "number") {
      metaParts.push(`${u.lat.toFixed(5)}, ${u.lng.toFixed(5)}`);
    }
    metaParts.push(`Actualizado: ${new Date(lastPayload.updatedAt).toLocaleString("es-CL")}`);
    metaEl.textContent = metaParts.join(" · ");

    populateBrandSelect(lastPayload.stations);

    if (!lastPayload.stations.length) {
      setStatus(
        "No hay estaciones con datos CNE dentro del radio. Sube el radio (km) o comprueba tu ubicación.",
        true
      );
    } else {
      const v = getVisibleStations().length;
      const n = lastPayload.stations.length;
      setStatus(
        v === n
          ? `${n} estaciones en ${radiusKm} km. Filtra por «Distribuidor» arriba.`
          : `${v} de ${n} estaciones con el distribuidor elegido. Radio ${radiusKm} km.`
      );
    }

    updateMarkers();
    renderList();
    invalidateMapSize();
  } catch (e) {
    setStatus("No se pudo contactar el servidor. ¿Está en marcha (npm start)?", true);
    metaEl.textContent = "";
    lastPayload = { stations: [], source: "error" };
    resetBrandSelectUi();
    hideDetail();
    updateMarkers();
    renderList();
    console.error(e);
  }
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  if (!autoRefreshEl.checked) return;
  refreshTimer = setInterval(() => loadStations(), 5 * 60 * 1000);
}

// ─── Address Geocoding ────────────────────────────────────────────────────────

function hideSearchResults() {
  searchResultsEl.hidden = true;
  searchResultsEl.innerHTML = "";
}

async function runGeocode(query) {
  if (!query.trim()) { hideSearchResults(); return; }
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
    if (!res.ok) { hideSearchResults(); return; }
    const results = await res.json();
    if (!Array.isArray(results) || !results.length) {
      searchResultsEl.hidden = false;
      searchResultsEl.innerHTML = `<li class="search-result search-result--empty">Sin resultados para "${escapeHtml(query)}"</li>`;
      return;
    }
    searchResultsEl.innerHTML = "";
    searchResultsEl.hidden = false;
    for (const r of results) {
      const li = document.createElement("li");
      li.className = "search-result";
      li.textContent = r.short_name || r.display_name;
      li.title = r.display_name;
      li.addEventListener("click", () => {
        addressSearchEl.value = r.short_name || r.display_name;
        hideSearchResults();
        applyUserPosition(r.lat, r.lng, `Ubicación: ${r.short_name || r.display_name}. Cargando precios…`);
        saveLastLocation(r.lat, r.lng);
      });
      searchResultsEl.appendChild(li);
    }
  } catch {
    hideSearchResults();
  }
}

addressSearchEl.addEventListener("input", () => {
  clearTimeout(geocodeTimer);
  const q = addressSearchEl.value.trim();
  if (q.length < 3) { hideSearchResults(); return; }
  geocodeTimer = setTimeout(() => runGeocode(q), 450);
});

btnSearchGeo.addEventListener("click", () => {
  const q = addressSearchEl.value.trim();
  if (q) runGeocode(q);
});

addressSearchEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { hideSearchResults(); return; }
  if (e.key === "Enter") {
    e.preventDefault();
    const q = addressSearchEl.value.trim();
    if (q) runGeocode(q);
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-bar")) hideSearchResults();
});

// ─── Last Known Location ──────────────────────────────────────────────────────

function saveLastLocation(lat, lng) {
  try {
    localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify({ lat, lng, ts: Date.now() }));
  } catch {}
}

function loadLastLocation() {
  try {
    const raw = localStorage.getItem(LAST_LOCATION_KEY);
    if (!raw) return null;
    const { lat, lng, ts } = JSON.parse(raw);
    if (!lat || !lng) return null;
    if (Date.now() - ts > 24 * 3600 * 1000) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

// ─── Geolocation ─────────────────────────────────────────────────────────────

function geolocationGetCurrent(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function geolocationWatchOnce(options, timeoutMs) {
  return new Promise((resolve, reject) => {
    let watchId = null;
    const timer = setTimeout(() => {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      reject(Object.assign(new Error("timeout"), { code: 3 }));
    }, timeoutMs);

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        clearTimeout(timer);
        if (watchId != null) navigator.geolocation.clearWatch(watchId);
        resolve(pos);
      },
      (err) => {
        clearTimeout(timer);
        if (watchId != null) navigator.geolocation.clearWatch(watchId);
        reject(err);
      },
      options
    );
  });
}

function geoErrorMessage(code) {
  switch (code) {
    case 1:
      return "Ubicación denegada: permita el acceso a la ubicación en ajustes del navegador.";
    case 2:
      return "Ubicación no disponible: active el GPS e intente al aire libre.";
    case 3:
      return "Tiempo agotado esperando el GPS: pulse «Pedir ubicación» de nuevo.";
    default:
      return "No se pudo obtener la ubicación.";
  }
}

function isLikelyInsecureGeoBlocked() {
  if (typeof window === "undefined" || window.isSecureContext) return false;
  const h = window.location.hostname;
  return h !== "localhost" && h !== "127.0.0.1" && h !== "[::1]";
}

async function tryAllGeoStrategies() {
  const attempts = [
    () => geolocationGetCurrent({ enableHighAccuracy: true, timeout: 36000, maximumAge: 0 }),
    () => geolocationGetCurrent({ enableHighAccuracy: false, timeout: 28000, maximumAge: 0 }),
    () => geolocationGetCurrent({ enableHighAccuracy: false, timeout: 22000, maximumAge: 180000 }),
    () => geolocationWatchOnce({ enableHighAccuracy: true, maximumAge: 0 }, 30000),
    () => geolocationWatchOnce({ enableHighAccuracy: false, maximumAge: 120000 }, 25000),
  ];
  let lastErr = null;
  for (const run of attempts) {
    try {
      return await run();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("geo");
}

async function getLocation() {
  if (!navigator.geolocation) {
    const last = loadLastLocation();
    if (last) {
      applyUserPosition(last.lat, last.lng, "GPS no disponible. Usando última ubicación conocida.", true);
    } else {
      applyUserPosition(-33.4489, -70.6693, "Este navegador no soporta geolocalización. Referencia: Santiago.", true);
    }
    return;
  }

  const insecure = isLikelyInsecureGeoBlocked();
  if (insecure) {
    setStatus("Página en HTTP (sin HTTPS): el GPS puede estar bloqueado en el celular. Intentando…", true);
    await new Promise((r) => setTimeout(r, 500));
  } else {
    setStatus("Buscando ubicación (GPS + red, varios intentos)…");
  }

  try {
    if (navigator.permissions?.query) {
      const r = await navigator.permissions.query({ name: "geolocation" });
      if (r.state === "denied") {
        const extra = insecure ? " Sin HTTPS el navegador bloquea ubicación desde la red local." : "";
        const last = loadLastLocation();
        if (last) {
          applyUserPosition(last.lat, last.lng, `${geoErrorMessage(1)}${extra} Usando última ubicación guardada.`, true);
        } else {
          applyUserPosition(-33.4489, -70.6693, `${geoErrorMessage(1)}${extra} Referencia: Santiago centro.`, true);
        }
        return;
      }
    }
  } catch {}

  try {
    const pos = await tryAllGeoStrategies();
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const acc = pos.coords.accuracy;
    const accStr = acc != null ? ` ±${Math.round(acc)} m` : "";
    saveLastLocation(lat, lng);
    applyUserPosition(lat, lng, `Ubicación obtenida${accStr}. Cargando precios…`, false, acc);
  } catch (err) {
    const code = err && typeof err.code === "number" ? err.code : 0;
    const extra = insecure ? " Configure HTTPS o un túnel (ngrok) para el celular." : "";
    const last = loadLastLocation();
    if (last) {
      applyUserPosition(last.lat, last.lng, `${geoErrorMessage(code)}${extra} Usando última ubicación guardada.`, true);
    } else {
      applyUserPosition(-33.4489, -70.6693, `${geoErrorMessage(code)}${extra} Referencia: Santiago centro.`, true);
    }
  }
}

// ─── AI Chat ─────────────────────────────────────────────────────────────────

function aiPanelOpen() {
  aiPanelEl.hidden = false;
  aiInputEl.focus();
}

function aiPanelClose() {
  aiPanelEl.hidden = true;
}

function appendAiMessage(text, role) {
  const div = document.createElement("div");
  div.className = `ai-msg ai-msg--${role}`;
  const span = document.createElement("span");
  span.textContent = text;
  div.appendChild(span);
  aiMessagesEl.appendChild(div);
  aiMessagesEl.scrollTop = aiMessagesEl.scrollHeight;
  return div;
}

function appendAiThinking() {
  const div = document.createElement("div");
  div.className = "ai-msg ai-msg--bot ai-msg--thinking";
  div.innerHTML = `<span><span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span></span>`;
  aiMessagesEl.appendChild(div);
  aiMessagesEl.scrollTop = aiMessagesEl.scrollHeight;
  return div;
}

aiFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = aiInputEl.value.trim();
  if (!message) return;
  aiInputEl.value = "";
  aiInputEl.disabled = true;

  appendAiMessage(message, "user");
  const thinking = appendAiThinking();

  try {
    const res = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        stations: lastPayload?.stations || [],
        userLocation: userLat != null ? { lat: userLat, lng: userLng } : null,
        fuelType: fuelFilterEl.value,
      }),
    });
    const data = await res.json();
    thinking.remove();
    if (data.ok && data.reply) {
      appendAiMessage(data.reply, "bot");
    } else {
      appendAiMessage(data.error || "No pude obtener respuesta.", "bot");
    }
  } catch {
    thinking.remove();
    appendAiMessage("Error de conexión con el asistente.", "bot");
  } finally {
    aiInputEl.disabled = false;
    aiInputEl.focus();
  }
});

btnAiOpen.addEventListener("click", aiPanelOpen);
btnAiClose.addEventListener("click", aiPanelClose);

// ─── Controls ─────────────────────────────────────────────────────────────────

document.querySelectorAll(".segmented__btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    sortMode = btn.dataset.sort;
    document.querySelectorAll(".segmented__btn").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    renderList();
    updateMarkers();
  });
});

fuelFilterEl.addEventListener("change", () => {
  renderList();
  updateMarkers();
});

brandSelectEl?.addEventListener("change", () => {
  syncBrandFilterUi();
});

radiusEl.addEventListener("input", () => {
  radiusValueEl.textContent = `${radiusEl.value} km`;
});

radiusEl.addEventListener("change", () => {
  loadStations();
});

btnRefresh.addEventListener("click", () => loadStations());
btnGeo.addEventListener("click", () => getLocation());
autoRefreshEl.addEventListener("change", scheduleRefresh);

window.addEventListener("resize", () => invalidateMapSize());
detailClose.addEventListener("click", hideDetail);

getLocation();
scheduleRefresh();
