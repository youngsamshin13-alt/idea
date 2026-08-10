const ASSETS = __ASSET_MAP__;

const SESSION_COOKIE = "morning_session";
const OAUTH_STATE_COOKIE = "morning_oauth_state";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const loginAttempts = new Map();

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("Request failed", {
        path: safeRequestPath(request.url),
        message: error.message,
      });

      return createTextResponse(
        request,
        500,
        "濡쒓렇??泥섎━ 以?臾몄젣媛 ?앷꼈?댁슂. ?좎떆 ???ㅼ떆 ?쒕룄??二쇱꽭??",
      );
    }
  },
};

async function handleRequest(request, env) {
  const requestUrl = new URL(request.url);
  const pathname = requestUrl.pathname;

  if (pathname === "/favicon.ico") {
    return createResponse(request, 204);
  }

  if (request.method === "GET" && pathname === "/auth/kakao") {
    return startKakaoLogin(request, env);
  }

  if (request.method === "GET" && pathname === "/auth/kakao/callback") {
    return finishKakaoLogin(request, env, requestUrl);
  }

  if (request.method === "POST" && pathname === "/auth/logout") {
    return logout(request, env);
  }

  if (request.method === "GET" && pathname === "/session.js") {
    return sendSessionScript(request, env);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return createTextResponse(request, 405, "?덉슜?섏? ?딆? ?붿껌?낅땲??", {
      Allow: "GET, HEAD",
    });
  }

  if (pathname === "/") {
    const session = await getSession(request, env);
    if (!session) {
      return redirect(request, "/login.html");
    }

    return sendPublicFile(request, "/index.html");
  }

  if (pathname === "/login.html" && (await getSession(request, env))) {
    return redirect(request, "/");
  }

  const publicFile = ASSETS[pathname];
  if (!publicFile) {
    return createTextResponse(request, 404, "?섏씠吏瑜?李얠쓣 ???놁뼱??");
  }

  if (publicFile.protected && !(await getSession(request, env))) {
    return redirect(request, "/login.html?error=session_required");
  }

  return sendPublicFile(request, pathname);
}

async function startKakaoLogin(request, env) {
  if (!allowLoginAttempt(getClientAddress(request))) {
    return redirect(request, "/login.html?error=too_many_requests");
  }

  if (!isAuthConfigured(env)) {
    return redirect(request, "/login.html?error=configuration");
  }

  const state = randomToken(32);
  const origin = getRequestOrigin(request);
  const stateCookie = await createSignedCookie(
    OAUTH_STATE_COOKIE,
    {
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
      state,
    },
    env,
    {
      httpOnly: true,
      maxAge: Math.floor(OAUTH_STATE_TTL_MS / 1000),
      path: "/auth/kakao/callback",
      sameSite: "Lax",
      secure: isSecureRequest(request),
    },
  );

  const authorizeUrl = new URL("https://kauth.kakao.com/oauth/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", env.KAKAO_REST_API_KEY);
  authorizeUrl.searchParams.set("redirect_uri", `${origin}/auth/kakao/callback`);
  authorizeUrl.searchParams.set("state", state);

  return redirect(request, authorizeUrl.toString(), [stateCookie]);
}

async function finishKakaoLogin(request, env, requestUrl) {
  const returnedState = requestUrl.searchParams.get("state") || "";
  const stateCookie = await readSignedCookie(request, OAUTH_STATE_COOKIE, env);
  const clearCookie = serializeCookie(OAUTH_STATE_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/auth/kakao/callback",
    sameSite: "Lax",
    secure: isSecureRequest(request),
  });

  if (requestUrl.searchParams.has("error")) {
    return redirect(request, "/login.html?error=cancelled", [clearCookie]);
  }

  if (
    !returnedState ||
    !stateCookie ||
    stateCookie.expiresAt <= Date.now() ||
    stateCookie.state !== returnedState
  ) {
    return redirect(request, "/login.html?error=invalid_state", [clearCookie]);
  }

  const authorizationCode = requestUrl.searchParams.get("code");
  if (!authorizationCode) {
    return redirect(request, "/login.html?error=missing_code", [clearCookie]);
  }

  if (!isAuthConfigured(env)) {
    return redirect(request, "/login.html?error=configuration", [clearCookie]);
  }

  try {
    const token = await exchangeAuthorizationCode(
      authorizationCode,
      `${getRequestOrigin(request)}/auth/kakao/callback`,
      env,
    );
    const user = await retrieveKakaoUser(token.access_token);
    const sessionCookie = await createSignedCookie(
      SESSION_COOKIE,
      {
        accessToken: token.access_token,
        expiresAt: Date.now() + SESSION_TTL_MS,
        nickname: getKakaoNickname(user),
        userId: String(user.id),
      },
      env,
      {
        httpOnly: true,
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
        path: "/",
        sameSite: "Lax",
        secure: isSecureRequest(request),
      },
    );

    return redirect(request, "/", [clearCookie, sessionCookie]);
  } catch (error) {
    console.error("Kakao login failed", { message: error.message });
    return redirect(request, "/login.html?error=kakao_failed", [clearCookie]);
  }
}

async function exchangeAuthorizationCode(code, redirectUri, env) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env.KAKAO_REST_API_KEY,
    client_secret: env.KAKAO_CLIENT_SECRET,
    redirect_uri: redirectUri,
    code,
  });

  const response = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body,
  });

  const payload = await readJsonResponse(response);
  if (!response.ok || !payload.access_token) {
    throw new Error(`Kakao token request returned ${response.status}`);
  }

  return payload;
}

async function retrieveKakaoUser(accessToken) {
  const response = await fetch("https://kapi.kakao.com/v2/user/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
  });

  const payload = await readJsonResponse(response);
  if (!response.ok || typeof payload.id === "undefined") {
    throw new Error(`Kakao user request returned ${response.status}`);
  }

  return payload;
}

async function logout(request, env) {
  if (!isSameOriginRequest(request)) {
    return createTextResponse(request, 403, "濡쒓렇?꾩썐 ?붿껌???뺤씤?????놁뼱??");
  }

  const session = await getSession(request, env);
  if (session?.accessToken) {
    try {
      await fetch("https://kapi.kakao.com/v1/user/logout", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        },
      });
    } catch (error) {
      console.warn("Kakao logout request failed", { message: error.message });
    }
  }

  const clearSessionCookie = serializeCookie(SESSION_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "Lax",
    secure: isSecureRequest(request),
  });

  return redirect(request, "/login.html?status=logged_out", [clearSessionCookie]);
}

async function sendSessionScript(request, env) {
  const session = await getSession(request, env);
  if (!session) {
    return createTextResponse(request, 401, "濡쒓렇?몄씠 ?꾩슂?⑸땲??");
  }

  const publicSession = JSON.stringify({
    nickname: session.nickname,
    userId: session.userId,
  }).replace(/</g, "\\u003c");

  return createBodyResponse(
    request,
    200,
    `window.__KAKAO_SESSION__ = Object.freeze(${publicSession});`,
    "text/javascript; charset=utf-8",
  );
}

function sendPublicFile(request, pathname) {
  const asset = ASSETS[pathname];
  return createBodyResponse(request, 200, asset.body, asset.contentType);
}

async function getSession(request, env) {
  const session = await readSignedCookie(request, SESSION_COOKIE, env);
  if (!session || session.expiresAt <= Date.now()) {
    return null;
  }

  return session;
}

function allowLoginAttempt(address) {
  const now = Date.now();
  const recentAttempts = (loginAttempts.get(address) || []).filter(
    (timestamp) => timestamp > now - 60 * 1000,
  );

  if (recentAttempts.length >= 10) {
    loginAttempts.set(address, recentAttempts);
    return false;
  }

  recentAttempts.push(now);
  loginAttempts.set(address, recentAttempts);
  return true;
}

function getClientAddress(request) {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

function getRequestOrigin(request) {
  return new URL(request.url).origin;
}

function isAuthConfigured(env) {
  return Boolean(
    normalizeEnvValue(env.KAKAO_REST_API_KEY) &&
      normalizeEnvValue(env.KAKAO_CLIENT_SECRET) &&
      getSessionSecret(env),
  );
}

function normalizeEnvValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getSessionSecret(env) {
  return normalizeEnvValue(env.SESSION_SECRET);
}

async function createSignedCookie(name, value, env, options) {
  const payload = toBase64Url(textEncoder.encode(JSON.stringify(value)));
  const signature = await signValue(payload, env);
  return serializeCookie(name, `${payload}.${signature}`, options);
}

async function readSignedCookie(request, name, env) {
  const secret = getSessionSecret(env);
  if (!secret) {
    return null;
  }

  const token = parseCookies(request).get(name);
  if (!token) {
    return null;
  }

  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return null;
  }

  const isValid = await verifyValue(payload, signature, env);
  if (!isValid) {
    return null;
  }

  try {
    return JSON.parse(textDecoder.decode(fromBase64Url(payload)));
  } catch (error) {
    return null;
  }
}

async function signValue(payload, env) {
  const key = await importSigningKey(env);
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return toBase64Url(new Uint8Array(signature));
}

async function verifyValue(payload, signature, env) {
  const key = await importSigningKey(env);
  return crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(signature),
    textEncoder.encode(payload),
  );
}

async function importSigningKey(env) {
  const secret = getSessionSecret(env);
  if (!secret) {
    throw new Error("SESSION_SECRET is required");
  }

  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + padding);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Kakao returned an invalid response (${response.status})`);
  }
}

function getKakaoNickname(user) {
  const nickname = user.properties?.nickname || user.kakao_account?.profile?.nickname;
  return typeof nickname === "string" && nickname.trim() ? nickname.trim().slice(0, 40) : "移댁뭅???ъ슜??";
}

function isSecureRequest(request) {
  return new URL(request.url).protocol === "https:";
}

function isSameOriginRequest(request) {
  const origin = request.headers.get("origin");
  if (origin) {
    return origin === getRequestOrigin(request);
  }

  const referer = request.headers.get("referer");
  if (!referer) {
    return false;
  }

  try {
    return new URL(referer).origin === getRequestOrigin(request);
  } catch (error) {
    return false;
  }
}

function parseCookies(request) {
  const result = new Map();
  const cookieHeader = request.headers.get("cookie") || "";

  for (const entry of cookieHeader.split(";")) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex < 1) {
      continue;
    }

    const name = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1).trim();

    try {
      result.set(name, decodeURIComponent(value));
    } catch (error) {
      result.set(name, "");
    }
  }

  return result;
}

function serializeCookie(name, value, options) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge === 0 || options.maxAge) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.path) {
    parts.push(`Path=${options.path}`);
  }
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  return parts.join("; ");
}

function redirect(request, location, cookies = []) {
  const headers = createSecurityHeaders(request);
  headers.set("Location", location);

  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(null, {
    headers,
    status: 302,
  });
}

function createTextResponse(request, statusCode, message, extraHeaders = {}) {
  return createBodyResponse(request, statusCode, message, "text/plain; charset=utf-8", extraHeaders);
}

function createBodyResponse(request, statusCode, body, contentType, extraHeaders = {}) {
  const headers = createSecurityHeaders(request);
  headers.set("Content-Type", contentType);

  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  return new Response(request.method === "HEAD" ? null : body, {
    headers,
    status: statusCode,
  });
}

function createResponse(request, statusCode) {
  return new Response(null, {
    headers: createSecurityHeaders(request),
    status: statusCode,
  });
}

function createSecurityHeaders(request) {
  const headers = new Headers();
  headers.set("Cache-Control", "no-store");
  if (isSecureRequest(request)) {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; "),
  );
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return headers;
}

function randomToken(byteLength) {
  const randomBytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return toBase64Url(randomBytes);
}

function safeRequestPath(requestUrl) {
  try {
    return new URL(requestUrl).pathname;
  } catch (error) {
    return "invalid-url";
  }
}
