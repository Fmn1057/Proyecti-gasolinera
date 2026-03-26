/**
 * Prueba credenciales CNE sin arrancar el servidor.
 * Uso: desde la raíz del proyecto → npm run test:cne
 * Requiere .env con CNE_EMAIL+CNE_PASSWORD o CNE_API_TOKEN (no imprime secretos).
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const CNE_BASE = "https://api.cne.cl";
const LOGIN_URL = `${CNE_BASE}/api/login`;
const ESTACIONES_URL = `${CNE_BASE}/api/v4/estaciones`;

function maskEmail(email) {
  if (!email || typeof email !== "string") return "(vacío)";
  const [u, d] = email.split("@");
  if (!d) return "***";
  const u2 = u.length <= 2 ? "*" : `${u.slice(0, 2)}…`;
  return `${u2}@${d}`;
}

async function tryEstaciones(bearer) {
  const res = await fetch(ESTACIONES_URL, {
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
    body = { _raw: text.slice(0, 200) };
  }
  const isArr = Array.isArray(body);
  const len = isArr ? body.length : body?.data?.length ?? body?.estaciones?.length ?? null;
  return { status: res.status, body, approxCount: len, isArr };
}

async function main() {
  const staticToken = String(process.env.CNE_API_TOKEN || "").trim();
  const email = String(process.env.CNE_EMAIL || "").trim();
  const password = process.env.CNE_PASSWORD;

  console.log("--- Prueba API CNE ---\n");

  if (!staticToken && (!email || password === undefined || password === "")) {
    console.error(
      "No hay credenciales: crea un archivo .env en la raíz del proyecto con:\n" +
        "  CNE_EMAIL=tu_correo\n" +
        "  CNE_PASSWORD=tu_contraseña\n" +
        "o bien:\n" +
        "  CNE_API_TOKEN=tu_token\n" +
        "\n(Luego ejecuta de nuevo: npm run test:cne)"
    );
    process.exit(1);
  }

  let bearer = staticToken || null;
  let via = staticToken ? "CNE_API_TOKEN" : null;

  if (!bearer) {
    console.log(`Login: POST ${LOGIN_URL}`);
    console.log(`Email (mascarado): ${maskEmail(email)}\n`);

    const res = await fetch(LOGIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        email,
        password: String(password),
      }).toString(),
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error("Login: respuesta no es JSON. HTTP", res.status);
      console.error(text.slice(0, 500));
      process.exit(1);
    }

    if (!res.ok || !data.token || typeof data.token !== "string") {
      console.error("Login fallido. HTTP", res.status);
      console.error("Cuerpo (sin token):", { ...data, token: data.token ? "[presente]" : undefined });
      process.exit(1);
    }

    bearer = data.token.trim();
    via = "CNE_EMAIL + CNE_PASSWORD (login)";
    console.log("Login: OK (token recibido, no se muestra en consola)\n");
  } else {
    console.log(`Token estático: presente (${via})\n`);
  }

  console.log(`Estaciones: GET ${ESTACIONES_URL}`);
  const r = await tryEstaciones(bearer);
  console.log("HTTP", r.status);
  if (r.approxCount != null) {
    console.log("Registros (aprox.):", r.approxCount);
  } else {
    console.log(
      "Cuerpo (resumen):",
      typeof r.body === "object" && r.body !== null
        ? Object.keys(r.body).slice(0, 12)
        : r.body
    );
  }

  if (r.status === 200 && r.body?.status && String(r.body.status).toLowerCase().includes("token")) {
    console.error("\nLa API indica problema de token:", r.body.status);
    process.exit(1);
  }

  if (!r.status || r.status >= 400) {
    console.error("\nFallo al consultar estaciones.");
    process.exit(1);
  }

  console.log("\n✓ Prueba completada correctamente (autenticación:", via + ").");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
