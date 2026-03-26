# Bencinas Chile

Aplicación web responsive para consultar precios de combustibles en estaciones cercanas (Chile). Usa geolocalización, listado ordenable (precio / distancia), filtro por tipo de combustible, mapa interactivo con **Leaflet** y **OpenStreetMap**, y enlace a **Google Maps** para navegar.

## Requisitos

- [Node.js](https://nodejs.org/) 18 o superior

## Stack tecnológico (¿JavaScript o Java?)

Todo el proyecto es **JavaScript**: no hay Java.

| Parte | Tecnología |
|--------|------------|
| **Servidor** | **Node.js** + **Express** (`server.js`): recibe peticiones del navegador y llama a `api.cne.cl` con **`fetch`** (HTTP/JSON). |
| **Web** | **HTML, CSS** y **JavaScript** en el navegador (`public/`), sin React: el mapa usa **Leaflet**. |
| **Datos CNE** | El **token y las credenciales solo viven en el servidor** (`.env`); el front llama a rutas como `/api/stations` en tu mismo origen. |

### Token CNE: renovación automática

- Si usas **`CNE_EMAIL` + `CNE_PASSWORD`**, al arrancar el servidor se programa un **login periódico** (`POST https://api.cne.cl/api/login`) cada **45 minutos** (mínimo 5 min). Así el token en memoria se renueva **antes** de que suele caducar. Puedes cambiar el intervalo con **`CNE_TOKEN_REFRESH_MINUTES`** en `.env`.
- Si usas solo **`CNE_API_TOKEN`**, el valor es **fijo** hasta que lo cambies en `.env`; no hay login automático.
- Sigue existiendo la **renovación reactiva**: si la CNE responde error de token, se vuelve a hacer login una vez (modo email/contraseña).
- **Manual (pruebas):** `POST http://localhost:3000/api/cne/refresh-token` fuerza un nuevo login (solo con email/contraseña en `.env`).
- **`GET /api/health`** indica si el auto-refresh está activo, el intervalo, `lastTokenRefreshAt` y, si el token es JWT, `jwtExpiresAt`.

## Instalación y ejecución

```bash
cd "C:\Users\matia\Desktop\Proyecti gasolinera"
npm install
npm start
```

Abre en el navegador: **http://localhost:3000**

En la raíz del proyecto hay un **`.env`** (vacío) listo para que completes `CNE_EMAIL` / `CNE_PASSWORD` o `CNE_API_TOKEN` y `PORT`. Ese archivo está en `.gitignore` y no debe subirse a git. El servidor carga **siempre** `.env` desde la misma carpeta que `server.js` (aunque ejecutes `node` desde otro directorio).

Si ves **503** en `/api/stations`, abre la pestaña *Red* del navegador y lee el cuerpo JSON: incluye `error`, `errorCode` y `hint` (p. ej. `no_token` = falta credencial o `.env` no cargado).

Si borras `.env` y quieres volver a generarlo desde la plantilla, en Windows puedes ejecutar **`setup-env.cmd`** o **`powershell -File setup-env.ps1`** (solo crean `.env` si no existe).

Para **probar solo el login y el listado de estaciones** (sin levantar la web):

```bash
npm run test:cne
```

(Requiere `.env` con `CNE_EMAIL`/`CNE_PASSWORD` o `CNE_API_TOKEN`. No pegues contraseñas en chats ni subas `.env` a repositorios públicos.)

## Datos: solo API CNE

La **Comisión Nacional de Energía (CNE)** expone la API oficial en [https://api.cne.cl/](https://api.cne.cl/) (documentación: [https://apidocs.cne.cl/](https://apidocs.cne.cl/)). **No se generan precios simulados**: si faltan credenciales, la API falla o no hay estaciones en el radio, la app muestra un **mensaje de error** explícito. El backend usa:

- `GET /api/v4/estaciones` — listado nacional (coordenadas en `ubicacion.latitud` / `ubicacion.longitud`, precios en `precios` con claves como `93`, `95`, `97`, `DI`, `GLP`, y variantes autodespacho `A93`, etc.).
- `GET /api/v4/combustible/vehicular/tiposcombustibles` y `GET /api/v4/combustible/vehicular/distribuidores` — catálogos (cache en memoria; se reflejan en la respuesta como contadores).

Todas requieren cabecera `Authorization: Bearer <token>` (login o `CNE_API_TOKEN`).

El servidor también expone **proxies** (mismo origen que la web, sin exponer el token en el navegador):

| Ruta local | Destino CNE |
|------------|-------------|
| `GET /api/region` | `GET https://api.cne.cl/api/region` |
| `GET /api/comuna/:idRegion` | `GET https://api.cne.cl/api/comuna/{IdRegion}` |

Ejemplos con el servidor en marcha: `http://localhost:3000/api/region`, `http://localhost:3000/api/comuna/13` (sustituye `13` por el id de región que devuelva el listado de regiones).

- **Con autenticación configurada** (ver abajo): el servidor obtiene precios reales y filtra por distancia respecto a tu `lat`/`lng`.
- **Sin credenciales**, error de autenticación, error HTTP de la CNE o catálogo vacío: respuesta **503/502** con `error` y `errorCode` (lista y mapa vacíos).
- **Sin estaciones dentro del radio** (pero la CNE respondió bien): respuesta **200** con `stations: []` y mensaje en la UI para ampliar el radio.

### Cómo obtener el token (documentación CNE)

Hay dos formas soportadas por este proyecto:

#### 1) Login con email y contraseña (documentado como “Login usuario para obtener Token”)

- **POST** `https://api.cne.cl/api/login`
- Cuerpo: `application/x-www-form-urlencoded` con `email` y `password`
- Respuesta **200**: JSON `{ "token": "..." }`

En `.env` puedes poner:

```env
CNE_EMAIL=tu_correo@ejemplo.cl
CNE_PASSWORD=tu_contraseña
```

El servidor hace el login, guarda el token **solo en memoria** y lo reutiliza. Si la API devuelve error de token, vuelve a iniciar sesión automáticamente (mientras existan `CNE_EMAIL` y `CNE_PASSWORD`).

**Seguridad:** no subas `.env` a repositorios públicos; la contraseña solo debe vivir en el servidor o en tu máquina local.

#### 2) Token Bearer directo

Si ya tienes un string de token (por ejemplo desde el registro o otra herramienta), en `.env`:

```env
CNE_API_TOKEN=tu_token_aqui
```

Si **`CNE_API_TOKEN` está definido**, tiene prioridad sobre email/contraseña.

#### Registro en la CNE

1. Registro y acceso en [https://api.cne.cl/register](https://api.cne.cl/register) (y documentación en apidocs).
2. Alternativa en PowerShell sin archivo `.env`:

   ```powershell
   $env:CNE_EMAIL="tu_correo@ejemplo.com"
   $env:CNE_PASSWORD="tu_contraseña"
   npm start
   ```

## Mapas y otras API keys

- **Leaflet + OpenStreetMap**: no requiere API key; los tiles se cargan desde `tile.openstreetmap.org`.
- **Google Maps**: no es obligatorio; el botón “Abrir en Google Maps” usa la URL pública de búsqueda/direcciones y **no necesita** clave de Google Maps Platform.

Si en el futuro quisieras incrustar el mapa de Google en la página, necesitarías una clave en [Google Cloud Console](https://console.cloud.google.com/) con la API Maps JavaScript activada y restricciones por dominio/referrer.

## Geolocalización

- **HTTPS o localhost**: el navegador permite pedir ubicación con permiso del usuario.
- **Celular abriendo `http://IP-de-tu-PC:3000`**: muchos navegadores tratan eso como contexto **no seguro** y **bloquean** el GPS. Soluciones: publicar con **HTTPS** o usar un túnel tipo **ngrok**; la app usará una ubicación de referencia si el GPS no está disponible.
- La app hace **varios intentos** (alta/baja precisión y `watchPosition`) para mejorar el resultado en Android/iOS.

Tras actualizar el código del **servidor** (`server.js`), reinicia con `Ctrl+C` y `npm start` para que el campo **`marca`** (COPEC, Shell, etc.) llegue al navegador y el filtro de distribuidores funcione.
- Si todo falla, se usa **Santiago centro** solo como referencia temporal (con mensaje claro).

## Estructura del proyecto

- `server.js` — API `GET /api/stations`, proxies `GET /api/region`, `GET /api/comuna/:idRegion`, y archivos estáticos
- `public/index.html`, `public/styles.css`, `public/app.js` — interfaz y mapa

## Licencia de datos

Los datos oficiales son responsabilidad de la CNE; esta app solo los consume y muestra errores si no puede obtenerlos.
