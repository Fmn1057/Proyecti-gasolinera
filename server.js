/**
 * Servidor Express: estaciones cercanas con precios.
 * - CNE_API_TOKEN: Bearer fijo hacia https://api.cne.cl/api/v4/estaciones
 * - O CNE_EMAIL + CNE_PASSWORD: POST https://api.cne.cl/api/login (form urlencoded) → token
 * - Sin credenciales o error al consultar la CNE: respuesta de error (no hay precios inventados).
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
/** Renovación proactiva del token de login (minutos). No aplica si usas solo CNE_API_TOKEN. */
const CNE_TOKEN_REFRESH_MS = Math.max(
  5 * 60 * 1000,
  (Number(process.env.CNE_TOKEN_REFRESH_MINUTES) > 0
    ? Number(process.env.CNE_TOKEN_REFRESH_MINUTES)
    : 45) *
    60 *
    1000
);
const CNE_BASE = "https://api.cne.cl";
const CNE_LOGIN_URL = `${CNE_BASE}/api/login`;
const CNE_ESTACIONES_URL = `${CNE_BASE}/api/v4/estaciones`;
const CNE_TIPOS_URL = `${CNE_BASE}/api/v4/combustible/vehicular/tiposcombustibles`;
const CNE_DISTRIBUIDORES_URL = `${CNE_BASE}/api/v4/combustible/vehicular/distribuidores`;
/** División político-administrativa (documentación CNE). */
const CNE_REGION_PATH = "/api/region";
const cneComunaPath = (idRegion) => `/api/comuna/${encodeURIComponent(String(idRegion).trim())}`;

/** Token obtenido por login (se reutiliza en memoria; se renueva si la API rechaza el Bearer o por temporizador). */
let cneTokenFromLogin = null;
let cneLoginInFlight = null;
let cneLastTokenRefreshAt = null;
let cneTokenRefreshTimer = null;

/** Catálogos CNE (tipos y distribuidores), cache en memoria. */
let cneCatalogCache = null;
let cneCatalogInFlight = null;

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const EARTH_KM = 6371;

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}

function extractStationArray(body) {
  if (!body || typeof body !== "object") return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.estaciones)) return body.estaciones;
  if (Array.isArray(body.results)) return body.results;
  return [];
}

/**
 * La CNE a veces envía números como string con coma decimal ("-33,4478").
 * parseFloat("-33,4478") en JS devuelve -33 → posiciones muy erróneas.
 */
function parseCoordLatLng(v) {
  if (v == null || v === "") return NaN;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  let s = String(v).trim().replace(/\s/g, "");
  if (!s) return NaN;
  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(",", ".");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

/** Par [a,b]: GeoJSON suele ser [longitud, latitud]; en Chile |lon| suele ser mayor que |lat|. */
function latLngFromCoordPair(a, b) {
  const lon = parseCoordLatLng(a);
  const lat = parseCoordLatLng(b);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  const absLat = Math.abs(lat);
  const absLon = Math.abs(lon);
  if (absLat <= 90 && absLon <= 180) {
    if (absLon > 45 && absLat < 45) return { lat, lng: lon };
    if (absLat > 45 && absLon < 45) return { lat: lon, lng: lat };
    return { lat, lng: lon };
  }
  return null;
}

function readLatLngFromObject(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const lat = parseCoordLatLng(
    o.latitud ?? o.Latitud ?? o.latitude ?? o.lat ?? o.Latitude ?? o.LAT
  );
  const lng = parseCoordLatLng(
    o.longitud ??
      o.Longitud ??
      o.longitude ??
      o.lng ??
      o.lon ??
      o.Lng ??
      o.Lon ??
      o.LONGITUD
  );
  if (!Number.isNaN(lat) && !Number.isNaN(lng)) return { lat, lng };
  return null;
}

/** Objeto ubicación para dirección/comuna (no arrays ni string suelto). */
function getUbicacionRecord(raw) {
  let u = raw?.ubicacion ?? raw?.Ubicacion ?? raw?.ubicacion_estacion;
  if (typeof u === "string") {
    const t = u.trim();
    if (t.startsWith("{")) {
      try {
        u = JSON.parse(t);
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }
  if (!u || typeof u !== "object" || Array.isArray(u)) return null;
  return u;
}

function extractStationLatLng(raw) {
  const rec = getUbicacionRecord(raw);
  if (rec) {
    const p = readLatLngFromObject(rec);
    if (p) return p;
  }

  const uRoot = raw?.ubicacion ?? raw?.Ubicacion ?? raw?.ubicacion_estacion;
  if (Array.isArray(uRoot) && uRoot.length >= 2) {
    const p = latLngFromCoordPair(uRoot[0], uRoot[1]);
    if (p) return p;
  }

  const coords = raw?.geometry?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) {
    const p = latLngFromCoordPair(coords[0], coords[1]);
    if (p) return p;
  }

  const flat = readLatLngFromObject(raw);
  if (flat) return flat;

  return null;
}

function normalizePrices(ppc) {
  const keys = [
    "gasolina_93",
    "gasolina_95",
    "gasolina_97",
    "petroleo_diesel",
    "glp_vehicular",
  ];
  const out = {};
  if (!ppc || typeof ppc !== "object") return out;
  for (const k of keys) {
    const v = ppc[k];
    if (v == null || v === "") continue;
    const n = Number(v);
    if (!Number.isNaN(n) && n > 0) out[k] = Math.round(n);
  }
  return out;
}

/** Precio numérico desde objeto precio CNE v4 (`precio` suele ser string "1249.000"). */
function parseCnePrecioEntry(entry) {
  if (entry == null || typeof entry !== "object") return null;
  const raw = entry.precio;
  if (raw == null || raw === "") return null;
  const n = parseFloat(String(raw).replace(/[^\d.-]/g, ""));
  if (Number.isNaN(n) || n <= 0) return null;
  return Math.round(n);
}

/**
 * API v4 usa claves como 93, A93, 95, DI, GLP, etc.
 * Variantes con prefijo A suelen ser autodespacho; para comparar precios usamos el menor disponible.
 */
const CNE_PRECIO_KEYS_A_CANON = [
  ["gasolina_93", ["93", "A93"]],
  ["gasolina_95", ["95", "A95"]],
  ["gasolina_97", ["97", "A97"]],
  ["petroleo_diesel", ["DI", "ADI"]],
  ["glp_vehicular", ["GLP"]],
];

function normalizePreciosCneV4(precios) {
  const out = {};
  if (!precios || typeof precios !== "object") return out;
  for (const [canon, cneKeys] of CNE_PRECIO_KEYS_A_CANON) {
    let best = null;
    for (const ck of cneKeys) {
      const v = parseCnePrecioEntry(precios[ck]);
      if (v != null && (best === null || v < best)) best = v;
    }
    if (best != null) out[canon] = best;
  }
  return out;
}

function usesStaticCneToken() {
  return Boolean(String(process.env.CNE_API_TOKEN || "").trim());
}

function hasCneLoginCredentials() {
  const email = String(process.env.CNE_EMAIL || "").trim();
  const pw = process.env.CNE_PASSWORD;
  return Boolean(email && pw !== undefined && pw !== "");
}

async function obtainCneTokenViaLogin() {
  const email = String(process.env.CNE_EMAIL || "").trim();
  const password = process.env.CNE_PASSWORD;
  if (!email || password === undefined || password === "") return null;

  const res = await fetch(CNE_LOGIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ email, password: String(password) }).toString(),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }

  const token = data?.token;
  if (!res.ok || typeof token !== "string" || !token.trim()) return null;
  return token.trim();
}

/** Si el token es JWT, devuelve la fecha de expiración (ISO); si no, null. */
function jwtExpiresAtIso(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    if (payload.exp != null && Number.isFinite(Number(payload.exp))) {
      return new Date(Number(payload.exp) * 1000).toISOString();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Vuelve a llamar POST /api/login y actualiza el token en memoria.
 * Limpia caché de catálogo CNE para la próxima petición.
 */
async function refreshCneLoginTokenSilent() {
  if (usesStaticCneToken() || !hasCneLoginCredentials()) return false;
  if (cneLoginInFlight) return false;
  const t = await obtainCneTokenViaLogin();
  if (!t) {
    console.warn("[CNE] Renovación automática de token: login no devolvió token.");
    return false;
  }
  cneTokenFromLogin = t;
  cneLastTokenRefreshAt = new Date().toISOString();
  cneCatalogCache = null;
  console.log("[CNE] Token renovado automáticamente.");
  return true;
}

function startCneTokenAutoRefresh() {
  if (usesStaticCneToken() || !hasCneLoginCredentials()) return;
  if (cneTokenRefreshTimer) clearInterval(cneTokenRefreshTimer);
  refreshCneLoginTokenSilent().catch((e) => console.warn("[CNE] Primer refresh token:", e));
  cneTokenRefreshTimer = setInterval(() => {
    refreshCneLoginTokenSilent().catch((e) => console.warn("[CNE] Refresh token:", e));
  }, CNE_TOKEN_REFRESH_MS);
}

async function getCneBearerToken() {
  const envToken = String(process.env.CNE_API_TOKEN || "").trim();
  if (envToken) return envToken;

  if (cneTokenFromLogin) return cneTokenFromLogin;

  if (cneLoginInFlight) return cneLoginInFlight;

  cneLoginInFlight = (async () => {
    try {
      const t = await obtainCneTokenViaLogin();
      if (t) cneTokenFromLogin = t;
      return cneTokenFromLogin;
    } finally {
      cneLoginInFlight = null;
    }
  })();

  return cneLoginInFlight;
}

function isCneAuthFailure(res, body) {
  if (res.status === 401 || res.status === 403) return true;
  const st = body?.status;
  if (st == null) return false;
  return String(st).toLowerCase().includes("token");
}

async function fetchCneAuthorizedJson(url, bearer) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = {
      _noJson: true,
      status: res.status,
      snippet: text.slice(0, 400),
    };
  }
  return { res, body };
}

/** GET recurso CNE con token; reintenta login si el token en memoria caducó. */
async function getCneJsonWithRetry(cneUrl) {
  let bearer = await getCneBearerToken();
  if (!bearer) {
    return { ok: false, noToken: true, res: null, body: null };
  }

  let { res, body } = await fetchCneAuthorizedJson(cneUrl, bearer);

  if (isCneAuthFailure(res, body) && hasCneLoginCredentials() && !usesStaticCneToken()) {
    cneTokenFromLogin = null;
    const fresh = await obtainCneTokenViaLogin();
    if (fresh) {
      cneTokenFromLogin = fresh;
      ({ res, body } = await fetchCneAuthorizedJson(cneUrl, fresh));
    }
  }

  return { ok: true, res, body };
}

/** Marcas frecuentes en Chile (orden: nombres largos primero para coincidencia). */
const MARCAS_INFERIR = [
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
];

function inferMarcaDesdeTexto(...textos) {
  const u = textos.filter(Boolean).join(" ").toUpperCase();
  if (!u) return "";
  for (const m of MARCAS_INFERIR) {
    if (u.includes(m)) return m;
  }
  return "";
}

function parseDistribuidor(raw) {
  let d = raw.distribuidor ?? raw.Distribuidor ?? raw.distribuidor_estacion;
  if (typeof d === "string") {
    const t = d.trim();
    if (t.startsWith("{")) {
      try {
        d = JSON.parse(t);
      } catch {
        return null;
      }
    } else if (t) {
      return { marca: t };
    } else {
      return null;
    }
  }
  return d;
}

/** Prefijos de código CNE (codigo) → marca cuando el objeto distribuidor falla. */
function inferMarcaDesdeCodigo(codigo) {
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

function extractMarcaDistribuidor(raw, razon) {
  const d = parseDistribuidor(raw);
  let marca = "";

  if (d != null && typeof d === "object" && !Array.isArray(d)) {
    marca = String(d.marca ?? d.nombre ?? d.Nombre ?? d.nombre_marca ?? "").trim();
  } else if (Array.isArray(d) && d.length && typeof d[0] === "object") {
    marca = String(d[0].marca ?? d[0].nombre ?? "").trim();
  } else if (typeof d === "string") {
    marca = d.trim();
  }

  if (!marca) {
    marca = String(raw.nombre_distribuidor ?? raw.marca_distribuidor ?? raw.marca ?? "").trim();
  }

  if (!marca) {
    marca = inferMarcaDesdeTexto(razon, raw.nombre, raw.nombre_distribuidor);
  }

  if (!marca) {
    marca = inferMarcaDesdeCodigo(raw.codigo ?? raw.id);
  }

  return marca;
}

function normalizeStation(raw) {
  const pos = extractStationLatLng(raw);
  if (!pos) return null;
  const { lat, lng } = pos;

  const u = getUbicacionRecord(raw);
  let address = "";
  let comuna = "";
  if (u) {
    address = String(u.direccion ?? u.Direccion ?? "").trim();
    comuna = u.nombre_comuna ?? u.NombreComuna ?? u.comuna ?? "";
  }
  if (!address) {
    const calle = raw.direccion_calle ?? raw.calle ?? "";
    const num = raw.direccion_numero ?? raw.numero ?? "";
    address = [calle, num].filter(Boolean).join(" ").trim() || String(raw.direccion || "").trim();
  }
  if (!comuna) comuna = raw.nombre_comuna || raw.comuna || "";

  const razon = String(raw.razon_social || "").trim();
  const marca = extractMarcaDistribuidor(raw, razon);
  const name =
    [marca, razon].filter(Boolean).join(" · ") ||
    raw.nombre_distribuidor ||
    raw.nombre ||
    "Estación de servicio";

  const fromV4 = normalizePreciosCneV4(raw.precios);
  const legacyPpc = raw.precio_por_combustible;
  const fromLegacy = normalizePrices(typeof legacyPpc === "object" && legacyPpc !== null ? legacyPpc : {});
  const prices = { ...fromLegacy, ...fromV4 };

  const id = String(raw.codigo ?? raw.id ?? `${lat},${lng}`);
  const marcaNorm = typeof marca === "string" ? marca.trim() : String(marca || "").trim();

  return {
    id,
    codigo: id,
    name,
    marca: marcaNorm,
    address,
    comuna,
    lat,
    lng,
    prices,
    enMantenimiento: Boolean(Number(raw.en_mantenimiento)),
  };
}

async function fetchCneCatalog(bearer) {
  if (cneCatalogCache) return cneCatalogCache;
  if (cneCatalogInFlight) return cneCatalogInFlight;

  cneCatalogInFlight = (async () => {
    try {
      const [tiposRes, distRes] = await Promise.all([
        fetch(CNE_TIPOS_URL, {
          headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
        }),
        fetch(CNE_DISTRIBUIDORES_URL, {
          headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
        }),
      ]);
      const tipos = await tiposRes.json().catch(() => []);
      const distribuidores = await distRes.json().catch(() => []);
      cneCatalogCache = {
        tiposCombustible: Array.isArray(tipos) ? tipos : [],
        distribuidores: Array.isArray(distribuidores) ? distribuidores : [],
        cachedAt: new Date().toISOString(),
      };
    } catch {
      cneCatalogCache = { tiposCombustible: [], distribuidores: [], cachedAt: null };
    } finally {
      cneCatalogInFlight = null;
    }
    return cneCatalogCache;
  })();

  return cneCatalogInFlight;
}

async function fetchCneStationsWithToken(bearer) {
  const res = await fetch(CNE_ESTACIONES_URL, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json",
    },
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { res, body: null, reason: "invalid_json" };
  }

  return { res, body, reason: null };
}

async function fetchCneStations() {
  let bearer = await getCneBearerToken();
  if (!bearer) return { ok: false, reason: "no_token", stations: [], catalog: null };

  const [, firstTry] = await Promise.all([fetchCneCatalog(bearer), fetchCneStationsWithToken(bearer)]);
  let { res, body, reason } = firstTry;

  if (reason === "invalid_json") {
    return { ok: false, reason: "invalid_json", stations: [], catalog: cneCatalogCache };
  }

  if (isCneAuthFailure(res, body) && hasCneLoginCredentials() && !usesStaticCneToken()) {
    cneTokenFromLogin = null;
    const fresh = await obtainCneTokenViaLogin();
    if (fresh) {
      cneTokenFromLogin = fresh;
      ({ res, body, reason } = await fetchCneStationsWithToken(fresh));
    }
  }

  if (reason === "invalid_json") {
    return { ok: false, reason: "invalid_json", stations: [], catalog: cneCatalogCache };
  }

  if (isCneAuthFailure(res, body)) {
    return { ok: false, reason: "auth", stations: [], catalog: cneCatalogCache };
  }

  if (!res.ok) {
    return { ok: false, reason: `http_${res.status}`, stations: [], catalog: cneCatalogCache };
  }

  const arr = extractStationArray(body);
  const stations = [];
  for (const raw of arr) {
    const s = normalizeStation(raw);
    if (s) stations.push(s);
  }
  return {
    ok: true,
    stations,
    catalog: cneCatalogCache,
    rawStationCount: arr.length,
  };
}

function attachDistance(stations, lat, lng) {
  return stations.map((s) => ({
    ...s,
    distanceKm: Math.round(haversineKm(lat, lng, s.lat, s.lng) * 100) / 100,
  }));
}

function stationsErrorPayload(lat, lng, radiusKm, errorCode, error, extra = {}) {
  const hints = {
    no_token:
      "Ejecuta npm start desde la carpeta del proyecto (donde está server.js) y verifica que exista el archivo .env con CNE_EMAIL/CNE_PASSWORD o CNE_API_TOKEN.",
    auth: "Vuelve a iniciar sesión: revisa email y contraseña en .env, o genera un token nuevo en api.cne.cl.",
    invalid_json: "Puede ser un fallo temporal de la CNE o un cambio de formato; revisa la consola del servidor.",
    empty_catalog: "La lista de estaciones llegó vacía desde la CNE.",
    normalize_failed:
      "Las estaciones vienen en un formato que este servidor aún no interpreta; mira «diagnóstico» abajo.",
    http_404: "La URL de estaciones de la CNE respondió 404; puede haber cambiado la ruta en api.cne.cl.",
    http_any: "La API CNE devolvió un error HTTP. Revisa token, límites y estado del servicio en api.cne.cl.",
    upstream: "Problema de red o timeout al hablar con api.cne.cl.",
  };
  const ec = String(errorCode || "");
  const hintFromHttp = /^http_\d+$/.test(ec) ? hints[ec] || hints.http_any : undefined;
  return {
    ok: false,
    source: "error",
    error,
    errorCode,
    updatedAt: new Date().toISOString(),
    radiusKm,
    user: { lat, lng },
    stations: [],
    ...extra,
    hint: hints[ec] || hintFromHttp,
  };
}

function messageForCneFailure(reason) {
  const map = {
    no_token:
      "No hay credenciales CNE en el servidor (.env). No se pueden calcular ni mostrar precios oficiales.",
    auth: "Error de autenticación con la API CNE. Revisa CNE_API_TOKEN o el email y contraseña en .env.",
    invalid_json: "La API CNE devolvió datos que no se pudieron interpretar.",
  };
  if (map[reason]) return map[reason];
  const m = /^http_(\d+)$/.exec(reason);
  if (m) return `La API CNE respondió con error HTTP ${m[1]}. No se pudieron obtener precios.`;
  return `No se pudieron obtener precios de la CNE (${reason}).`;
}

/** Evita 404 en consola del navegador (no hay favicon en el proyecto). */
app.get("/favicon.ico", (_req, res) => {
  res.status(204).end();
});

app.get("/api/health", (_req, res) => {
  const loginMode = !usesStaticCneToken() && hasCneLoginCredentials();
  const payload = {
    ok: true,
    stack: "Node.js + Express (servidor) y JavaScript en el navegador; las llamadas a la CNE son HTTP desde Node (fetch).",
    cne: {
      staticToken: usesStaticCneToken(),
      loginCredentials: hasCneLoginCredentials(),
      tokenAutoRefreshActive: loginMode,
      tokenRefreshIntervalMinutes: Math.round(CNE_TOKEN_REFRESH_MS / 60000),
      lastTokenRefreshAt: cneLastTokenRefreshAt,
    },
  };
  if (cneTokenFromLogin && loginMode) {
    const jwtExp = jwtExpiresAtIso(cneTokenFromLogin);
    if (jwtExp) payload.cne.jwtExpiresAt = jwtExp;
  }
  res.json(payload);
});

/**
 * Fuerza un nuevo login CNE y actualiza el token en memoria (útil para pruebas).
 * Solo tiene efecto si usas CNE_EMAIL + CNE_PASSWORD (no token estático).
 */
app.post("/api/cne/refresh-token", async (_req, res) => {
  if (usesStaticCneToken()) {
    return res.status(400).json({
      ok: false,
      error: "Con CNE_API_TOKEN no hay renovación por login; el token es el del .env hasta que lo cambies.",
    });
  }
  if (!hasCneLoginCredentials()) {
    return res.status(503).json({ ok: false, error: "Configura CNE_EMAIL y CNE_PASSWORD en .env." });
  }
  const ok = await refreshCneLoginTokenSilent();
  if (!ok) {
    return res.status(503).json({ ok: false, error: "No se pudo obtener un token nuevo desde la CNE." });
  }
  res.json({
    ok: true,
    lastTokenRefreshAt: cneLastTokenRefreshAt,
    jwtExpiresAt: jwtExpiresAtIso(cneTokenFromLogin) || undefined,
  });
});

/** Proxy: regiones CNE → GET https://api.cne.cl/api/region */
app.get("/api/region", async (_req, res) => {
  try {
    const cneUrl = `${CNE_BASE}${CNE_REGION_PATH}`;
    const out = await getCneJsonWithRetry(cneUrl);
    if (out.noToken) {
      return res.status(503).json({
        error: "Configura CNE_API_TOKEN o CNE_EMAIL y CNE_PASSWORD en .env para consultar la API CNE.",
      });
    }
    res.status(out.res.status).json(out.body);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "No se pudo contactar la API CNE." });
  }
});

/** Proxy: comunas por región → GET https://api.cne.cl/api/comuna/{IdRegion} */
app.get("/api/comuna/:idRegion", async (req, res) => {
  try {
    const id = String(req.params.idRegion ?? "").trim();
    if (!id) {
      return res.status(400).json({ error: "Parámetro idRegion vacío." });
    }
    const cneUrl = `${CNE_BASE}${cneComunaPath(id)}`;
    const out = await getCneJsonWithRetry(cneUrl);
    if (out.noToken) {
      return res.status(503).json({
        error: "Configura CNE_API_TOKEN o CNE_EMAIL y CNE_PASSWORD en .env para consultar la API CNE.",
      });
    }
    res.status(out.res.status).json(out.body);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "No se pudo contactar la API CNE." });
  }
});

app.get("/api/stations", async (req, res) => {
  const lat = parseCoordLatLng(req.query.lat);
  const lng = parseCoordLatLng(req.query.lng);
  const radiusKm = Math.min(80, Math.max(1, parseFloat(req.query.radiusKm) || 25));

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({
      ok: false,
      source: "error",
      error: "Parámetros lat y lng requeridos (números).",
      errorCode: "bad_params",
      updatedAt: new Date().toISOString(),
      radiusKm,
      user: null,
      stations: [],
    });
  }

  let cne;
  try {
    cne = await fetchCneStations();
  } catch (e) {
    console.error(e);
    return res
      .status(502)
      .json(
        stationsErrorPayload(
          lat,
          lng,
          radiusKm,
          "upstream",
          "No se pudo conectar con la API CNE. Revisa tu red o el estado del servicio."
        )
      );
  }

  if (!cne.ok) {
    return res
      .status(503)
      .json(
        stationsErrorPayload(lat, lng, radiusKm, cne.reason || "unknown", messageForCneFailure(cne.reason || "unknown"))
      );
  }

  if (cne.stations.length === 0) {
    const raw = cne.rawStationCount ?? 0;
    if (raw > 0) {
      return res.status(503).json(
        stationsErrorPayload(
          lat,
          lng,
          radiusKm,
          "normalize_failed",
          `La CNE devolvió ${raw} estaciones, pero ninguna tiene coordenadas reconocibles (revisa formato ubicacion/latitud/longitud).`,
          { diagnostic: { rawStationCount: raw, normalizedCount: 0 } }
        )
      );
    }
    return res.status(503).json(
      stationsErrorPayload(
        lat,
        lng,
        radiusKm,
        "empty_catalog",
        "La API CNE devolvió 0 estaciones (lista vacía o formato distinto al esperado).",
        { diagnostic: { rawStationCount: 0, normalizedCount: 0 } }
      )
    );
  }

  const withDist = attachDistance(cne.stations, lat, lng).filter((s) => s.distanceKm <= radiusKm);

  const payload = {
    ok: true,
    source: "cne",
    updatedAt: new Date().toISOString(),
    radiusKm,
    user: { lat, lng },
    stations: withDist,
  };

  if (cne.catalog) {
    payload.cneCatalog = {
      tiposCombustibleCount: cne.catalog.tiposCombustible?.length ?? 0,
      distribuidoresCount: cne.catalog.distribuidores?.length ?? 0,
      catalogCachedAt: cne.catalog.cachedAt,
    };
  }

  res.json(payload);
});

app.listen(PORT, () => {
  console.log(`Bencinas Chile en http://localhost:${PORT}`);
  if (usesStaticCneToken()) {
    console.log("Modo CNE: Bearer desde CNE_API_TOKEN (sin renovación automática por login)");
  } else if (hasCneLoginCredentials()) {
    console.log(
      `Modo CNE: token vía POST /api/login; renovación automática cada ${Math.round(CNE_TOKEN_REFRESH_MS / 60000)} min`
    );
    startCneTokenAutoRefresh();
  } else {
    console.log("Sin credenciales CNE: /api/stations responderá error hasta configurar .env");
  }
});
