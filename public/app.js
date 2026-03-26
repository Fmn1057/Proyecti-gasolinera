const FUEL_LABELS = {
  gasolina_93: "Gasolina 93",
  gasolina_95: "Gasolina 95",
  gasolina_97: "Gasolina 97",
  petroleo_diesel: "Diésel",
  glp_vehicular: "GLP vehicular",
};

const statusEl = document.getElementById("status");
const metaEl = document.getElementById("meta");
const stationListEl = document.getElementById("stationList");
const fuelFilterEl = document.getElementById("fuelFilter");
const radiusEl = document.getElementById("radius");
const radiusValueEl = document.getElementById("radiusValue");
const btnRefresh = document.getElementById("btnRefresh");
const btnGeo = document.getElementById("btnGeo");
const btnManualGeo = document.getElementById("btnManualGeo");
const manualLatEl = document.getElementById("manualLat");
const manualLngEl = document.getElementById("manualLng");
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

const BRAND_OTROS_KEY = "OTROS";

/** Mismo criterio que server.js (orden: cadenas largas antes que subcadenas ambiguas). */
const MARCAS_INFERIR_CLIENT = [
  "PETRONEXT",
  "PETROBRAS",
  "ABASTIBLE",
  "COPEC",
  "SHELL",
  "TERPEL",
  "LIPIGAS",
  "FULLPRIX",
  "MAXPETRO",
  "AXION",
  "ESSO",
  "GULF",
  "NACIONAL",
  "BRAED",
  "FULL",
  "SIN BANDERA",
  "ENEX",
  "ARAMCO",
  "GASCO",
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

/** Marca usable para filtro y etiqueta (respaldos si el API no envía `marca`). */
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
const stationMarkers = new Map();
let userLat;
let userLng;
let lastPayload = null;
let sortMode = "price";
let selectedId = null;
let refreshTimer = null;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("is-error", isError);
}

/** Google Maps con las coordenadas CNE (sin API key). */
function googleMapsUrl(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return "#";
  return `https://www.google.com/maps?q=${la},${ln}`;
}

function invalidateMapSize() {
  if (!map) return;
  requestAnimationFrame(() => {
    map.invalidateSize();
  });
  setTimeout(() => map.invalidateSize(), 200);
}

function initMap(lat, lng) {
  if (map) {
    map.setView([lat, lng], 13);
    userMarker.setLatLng([lat, lng]);
    invalidateMapSize();
    return;
  }
  map = L.map("map", { zoomControl: true }).setView([lat, lng], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    maxZoom: 19,
  }).addTo(map);

  userMarker = L.marker([lat, lng], {
    title: "Tu ubicación",
  }).addTo(map);
  userMarker.bindPopup("<strong>Tu ubicación</strong>").openPopup();
  invalidateMapSize();
}

function applyUserPosition(lat, lng, statusText, isError = false) {
  userLat = lat;
  userLng = lng;
  setStatus(statusText, isError);
  initMap(userLat, userLng);
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

    const priceSpan = document.createElement("span");
    priceSpan.className = "station-card__price";
    if (pf != null) {
      priceSpan.innerHTML = `<strong>${FUEL_LABELS[fuelKey] || fuelKey}:</strong> ${formatMoney(pf)}`;
    } else {
      priceSpan.innerHTML = `<strong>${FUEL_LABELS[fuelKey] || fuelKey}:</strong> —`;
    }

    const mini = document.createElement("div");
    mini.className = "station-card__row";
    mini.style.fontSize = "0.78rem";
    mini.style.marginTop = "0.35rem";
    const parts = [];
    for (const [k, label] of Object.entries(FUEL_LABELS)) {
      const v = s.prices?.[k];
      if (v != null) parts.push(`${label.split(" ")[0]} ${formatMoney(v)}`);
    }
    mini.textContent = parts.join(" · ");

    row.appendChild(dist);
    row.appendChild(priceSpan);

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
    li.innerHTML = `<span>${label}</span><span>${formatMoney(v)}</span>`;
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

/** Para atributo `href` en HTML generado (p. ej. popups Leaflet). */
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
      metaParts.push(`${c.tiposCombustibleCount} tipos de combustible, ${c.distribuidoresCount} distribuidores (catálogo CNE)`);
    }
    if (u && typeof u.lat === "number" && typeof u.lng === "number") {
      metaParts.push(`Mapa/lista: ${u.lat.toFixed(5)}, ${u.lng.toFixed(5)}`);
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
          ? `${n} estaciones en ${radiusKm} km. Filtra por «Distribuidor» (COPEC, Shell, etc.) arriba.`
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
  refreshTimer = setInterval(() => {
    loadStations();
  }, 5 * 60 * 1000);
}

function geolocationGetCurrent(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

/** Una lectura con watchPosition; se cancela al primer fix o al timeout (mejor en algunos Android). */
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
      return "Ubicación denegada: en el celular, permita el permiso de ubicación para este sitio (icono de candado o ajustes del navegador).";
    case 2:
      return "Ubicación no disponible: active el GPS y los servicios de ubicación; pruebe al aire libre o cerca de una ventana.";
    case 3:
      return "Tiempo agotado esperando el GPS: pulse «Pedir ubicación» de nuevo o use coordenadas manuales.";
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
    applyUserPosition(
      -33.4489,
      -70.6693,
      "Este navegador no expone geolocalización. Use «Ubicación manual» abajo.",
      true
    );
    return;
  }

  const insecure = isLikelyInsecureGeoBlocked();
  if (insecure) {
    setStatus(
      "Página en HTTP (sin HTTPS): en el celular el GPS suele estar bloqueado si entra por http://192.168… Intentando ubicación; si falla, use coordenadas manuales o un túnel HTTPS (ngrok).",
      true
    );
    await new Promise((r) => setTimeout(r, 500));
  } else {
    setStatus("Buscando ubicación (GPS + red, varios intentos)…");
  }

  try {
    if (navigator.permissions?.query) {
      const r = await navigator.permissions.query({ name: "geolocation" });
      if (r.state === "denied") {
        const extra = insecure
          ? " Además, sin HTTPS el navegador suele no permitir ubicación desde la red local."
          : "";
        applyUserPosition(
          -33.4489,
          -70.6693,
          `${geoErrorMessage(1)}${extra} Referencia: Santiago centro; use coordenadas manuales si lo necesita.`,
          true
        );
        return;
      }
    }
  } catch {
    /* Permissions API no disponible o falla en algunos móviles */
  }

  try {
    const pos = await tryAllGeoStrategies();
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const acc = pos.coords.accuracy != null ? ` ±${Math.round(pos.coords.accuracy)} m` : "";
    applyUserPosition(lat, lng, `Ubicación obtenida${acc}. Cargando precios…`);
  } catch (err) {
    const code = err && typeof err.code === "number" ? err.code : 0;
    const extra = insecure
      ? " Si entra por http://192.168… en el celular, configure HTTPS o use lat/lng manuales."
      : "";
    applyUserPosition(
      -33.4489,
      -70.6693,
      `${geoErrorMessage(code)}${extra} Referencia temporal: Santiago centro.`,
      true
    );
  }
}

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
btnManualGeo.addEventListener("click", () => {
  const lat = parseFloat(String(manualLatEl.value).replace(",", "."));
  const lng = parseFloat(String(manualLngEl.value).replace(",", "."));
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    setStatus("Ingrese latitud y longitud numéricas (ej. Chile: -33.45 y -70.67).", true);
    return;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    setStatus("Latitud debe estar entre -90 y 90; longitud entre -180 y 180.", true);
    return;
  }
  applyUserPosition(lat, lng, "Usando coordenadas manuales. Cargando precios…");
});
autoRefreshEl.addEventListener("change", scheduleRefresh);

window.addEventListener("resize", () => invalidateMapSize());

detailClose.addEventListener("click", hideDetail);

getLocation();
scheduleRefresh();
