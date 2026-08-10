"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT_DIR = __dirname;
loadEnvironmentFile(path.join(ROOT_DIR, ".env"));

const APP_ORIGIN = (process.env.APP_ORIGIN || "http://localhost:3000").replace(/\/+$/, "");
const ORIGIN_URL = new URL(APP_ORIGIN);
const PORT = Number(process.env.PORT || ORIGIN_URL.port || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY || "";
const KAKAO_CLIENT_SECRET = process.env.KAKAO_CLIENT_SECRET || "";
const REDIRECT_URI = `${APP_ORIGIN}/auth/kakao/callback`;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_COOKIE = "morning_session";
const OAUTH_STATE_COOKIE = "morning_oauth_state";
const KAKAO_NICKNAME_SCOPE = "profile_nickname";
const USE_SECURE_COOKIES = ORIGIN_URL.protocol === "https:";

const sessions = new Map();
const oauthStates = new Map();
const loginAttempts = new Map();

const publicFiles = new Map([
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8", protected: true }],
  ["/login.html", { file: "login.html", type: "text/html; charset=utf-8", protected: false }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8", protected: false }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8", protected: true }],
  ["/login.js", { file: "login.js", type: "text/javascript; charset=utf-8", protected: false }],
]);

validateConfiguration();

const server = http.createServer((request, response) => {
  setSecurityHeaders(response);
  handleRequest(request, response).catch((error) => {
    console.error("Request failed", {
      path: safeRequestPath(request.url),
      message: error.message,
    });

    if (!response.headersSent) {
      sendText(response, 500, "로그인 처리 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.");
      return;
    }

    response.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Morning Kakao server: ${APP_ORIGIN}`);
  console.log(`Kakao Redirect URI: ${REDIRECT_URI}`);
});

const cleanupTimer = setInterval(cleanExpiredRecords, 5 * 60 * 1000);
cleanupTimer.unref();

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url || "/", APP_ORIGIN);
  const pathname = requestUrl.pathname;

  if (pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && pathname === "/auth/kakao") {
    startKakaoLogin(request, response);
    return;
  }

  if (request.method === "GET" && pathname === "/auth/kakao/callback") {
    await finishKakaoLogin(request, response, requestUrl);
    return;
  }

  if (request.method === "POST" && pathname === "/auth/logout") {
    await logout(request, response);
    return;
  }

  if (request.method === "GET" && pathname === "/session.js") {
    sendSessionScript(request, response);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendText(response, 405, "허용되지 않은 요청입니다.");
    return;
  }

  if (pathname === "/") {
    if (!getSession(request)) {
      redirect(response, "/login.html");
      return;
    }

    await sendPublicFile(request, response, publicFiles.get("/index.html"));
    return;
  }

  if (pathname === "/login.html" && getSession(request)) {
    redirect(response, "/");
    return;
  }

  const publicFile = publicFiles.get(pathname);
  if (!publicFile) {
    sendText(response, 404, "페이지를 찾을 수 없어요.");
    return;
  }

  if (publicFile.protected && !getSession(request)) {
    redirect(response, "/login.html?error=session_required");
    return;
  }

  await sendPublicFile(request, response, publicFile);
}

function startKakaoLogin(request, response) {
  if (!allowLoginAttempt(request.socket.remoteAddress || "unknown")) {
    redirect(response, "/login.html?error=too_many_requests");
    return;
  }

  const state = randomToken(32);
  oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);

  response.setHeader(
    "Set-Cookie",
    serializeCookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      maxAge: Math.floor(OAUTH_STATE_TTL_MS / 1000),
      path: "/auth/kakao/callback",
      sameSite: "Lax",
      secure: USE_SECURE_COOKIES,
    }),
  );

  const authorizeUrl = new URL("https://kauth.kakao.com/oauth/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", KAKAO_REST_API_KEY);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", KAKAO_NICKNAME_SCOPE);
  authorizeUrl.searchParams.set("state", state);

  redirect(response, authorizeUrl.toString());
}

async function finishKakaoLogin(request, response, requestUrl) {
  const returnedState = requestUrl.searchParams.get("state") || "";
  const stateCookie = parseCookies(request)[OAUTH_STATE_COOKIE] || "";
  const storedExpiry = oauthStates.get(returnedState);

  clearOAuthStateCookie(response);

  if (requestUrl.searchParams.has("error")) {
    if (returnedState) {
      oauthStates.delete(returnedState);
    }
    redirect(response, "/login.html?error=cancelled");
    return;
  }

  if (
    !returnedState ||
    !stateCookie ||
    !storedExpiry ||
    storedExpiry <= Date.now() ||
    !safeEqual(returnedState, stateCookie)
  ) {
    if (returnedState) {
      oauthStates.delete(returnedState);
    }
    redirect(response, "/login.html?error=invalid_state");
    return;
  }

  oauthStates.delete(returnedState);
  const authorizationCode = requestUrl.searchParams.get("code");
  if (!authorizationCode) {
    redirect(response, "/login.html?error=missing_code");
    return;
  }

  try {
    const token = await exchangeAuthorizationCode(authorizationCode);
    const user = await retrieveKakaoUser(token.access_token);
    const sessionId = randomToken(32);
    const identity = buildKakaoIdentity(user);

    sessions.set(sessionId, {
      accessToken: token.access_token,
      displayName: identity.displayName,
      expiresAt: Date.now() + SESSION_TTL_MS,
      nickname: identity.nickname,
      userId: identity.userId,
    });

    const cookies = response.getHeader("Set-Cookie");
    const sessionCookie = serializeCookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      path: "/",
      sameSite: "Lax",
      secure: USE_SECURE_COOKIES,
    });
    response.setHeader("Set-Cookie", [...normalizeCookieHeaders(cookies), sessionCookie]);
    redirect(response, "/");
  } catch (error) {
    console.error("Kakao login failed", { message: error.message });
    redirect(response, "/login.html?error=kakao_failed");
  }
}

async function exchangeAuthorizationCode(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: KAKAO_REST_API_KEY,
    client_secret: KAKAO_CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    code,
  });

  const response = await fetchWithTimeout("https://kauth.kakao.com/oauth/token", {
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
  const body = new URLSearchParams({
    property_keys: JSON.stringify(["kakao_account.profile", "kakao_account.email", "kakao_account.name"]),
  });

  const response = await fetchWithTimeout("https://kapi.kakao.com/v2/user/me", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body,
  });

  const payload = await readJsonResponse(response);
  if (!response.ok || typeof payload.id === "undefined") {
    throw new Error(`Kakao user request returned ${response.status}`);
  }

  return payload;
}

async function logout(request, response) {
  if (isCrossOriginRequest(request)) {
    sendText(response, 403, "로그아웃 요청을 확인할 수 없어요.");
    return;
  }

  const cookies = parseCookies(request);
  const sessionId = cookies[SESSION_COOKIE] || "";
  const session = getSession(request);

  if (session?.accessToken) {
    try {
      await fetchWithTimeout("https://kapi.kakao.com/v1/user/logout", {
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

  if (sessionId) {
    sessions.delete(sessionId);
  }

  response.setHeader(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE, "", {
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "Lax",
      secure: USE_SECURE_COOKIES,
    }),
  );
  redirect(response, "/login.html?status=logged_out");
}

function sendSessionScript(request, response) {
  const session = getSession(request);
  if (!session) {
    sendText(response, 401, "로그인이 필요합니다.");
    return;
  }

  const publicSession = JSON.stringify({
    displayName: formatSessionDisplayName(session),
    nickname: session.nickname,
    userId: session.userId,
  }).replace(/</g, "\\u003c");

  sendBody(
    request,
    response,
    200,
    `window.__KAKAO_SESSION__ = Object.freeze(${publicSession});`,
    "text/javascript; charset=utf-8",
  );
}

async function sendPublicFile(request, response, publicFile) {
  const filePath = path.join(ROOT_DIR, publicFile.file);
  const content = await fs.promises.readFile(filePath);
  sendBody(request, response, 200, content, publicFile.type);
}

function getSession(request) {
  const sessionId = parseCookies(request)[SESSION_COOKIE];
  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
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

function cleanExpiredRecords() {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(sessionId);
    }
  }
  for (const [state, expiresAt] of oauthStates) {
    if (expiresAt <= now) {
      oauthStates.delete(state);
    }
  }
  for (const [address, attempts] of loginAttempts) {
    const recentAttempts = attempts.filter((timestamp) => timestamp > now - 60 * 1000);
    if (recentAttempts.length === 0) {
      loginAttempts.delete(address);
    } else {
      loginAttempts.set(address, recentAttempts);
    }
  }
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
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
  return typeof nickname === "string" && nickname.trim() ? nickname.trim().slice(0, 40) : "카카오 사용자";
}

function buildKakaoIdentity(user) {
  const userId = typeof user.id === "undefined" ? "" : String(user.id);
  const nickname = pickFirstNonEmpty([
    user.kakao_account?.profile?.nickname,
    user.properties?.nickname,
  ]);
  const name = pickFirstNonEmpty([user.kakao_account?.name]);
  const email = pickFirstNonEmpty([user.kakao_account?.email]);

  return {
    displayName: truncateDisplayName(nickname || name || email || formatKakaoUserLabel(userId)),
    nickname: nickname || "",
    userId,
  };
}

function formatSessionDisplayName(session) {
  const explicitDisplayName = pickFirstNonEmpty([session?.displayName, session?.nickname]);
  if (explicitDisplayName && explicitDisplayName !== "\uce74\uce74\uc624 \uc0ac\uc6a9\uc790") {
    return explicitDisplayName;
  }

  return formatKakaoUserLabel(session?.userId);
}

function formatKakaoUserLabel(userId) {
  const normalizedUserId = typeof userId === "string" ? userId.trim() : String(userId || "").trim();
  if (!normalizedUserId) {
    return "\uce74\uce74\uc624 \uc0ac\uc6a9\uc790";
  }

  return `\uce74\uce74\uc624 \uacc4\uc815 #${normalizedUserId.slice(-6)}`;
}

function pickFirstNonEmpty(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function truncateDisplayName(value) {
  return value.length > 40 ? value.slice(0, 40) : value;
}

function setSecurityHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  if (USE_SECURE_COOKIES) {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  response.setHeader(
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
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function isCrossOriginRequest(request) {
  const origin = request.headers.origin;
  if (origin) {
    return origin !== APP_ORIGIN;
  }

  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite) {
    return !["same-origin", "same-site", "none"].includes(fetchSite);
  }

  const referer = request.headers.referer;
  if (!referer) {
    return false;
  }

  try {
    return new URL(referer).origin !== APP_ORIGIN;
  } catch (error) {
    return true;
  }
}

function parseCookies(request) {
  const result = {};
  const cookieHeader = request.headers.cookie || "";
  for (const entry of cookieHeader.split(";")) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex < 1) {
      continue;
    }
    const name = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1).trim();
    try {
      result[name] = decodeURIComponent(value);
    } catch (error) {
      result[name] = "";
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

function clearOAuthStateCookie(response) {
  response.setHeader(
    "Set-Cookie",
    serializeCookie(OAUTH_STATE_COOKIE, "", {
      httpOnly: true,
      maxAge: 0,
      path: "/auth/kakao/callback",
      sameSite: "Lax",
      secure: USE_SECURE_COOKIES,
    }),
  );
}

function normalizeCookieHeaders(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function redirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

function sendBody(request, response, statusCode, body, contentType) {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(body);
  response.writeHead(statusCode, {
    "Content-Length": content.length,
    "Content-Type": contentType,
  });
  response.end(request.method === "HEAD" ? undefined : content);
}

function randomToken(byteLength) {
  return crypto.randomBytes(byteLength).toString("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function safeRequestPath(requestUrl) {
  try {
    return new URL(requestUrl || "/", APP_ORIGIN).pathname;
  } catch (error) {
    return "invalid-url";
  }
}

function loadEnvironmentFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  }
}

function validateConfiguration() {
  if (!["http:", "https:"].includes(ORIGIN_URL.protocol)) {
    throw new Error("APP_ORIGIN must use http or https");
  }
  if (ORIGIN_URL.pathname !== "/" || ORIGIN_URL.search || ORIGIN_URL.hash) {
    throw new Error("APP_ORIGIN must not include a path, query, or hash");
  }
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("PORT must be a valid TCP port");
  }
  if (!KAKAO_REST_API_KEY || !KAKAO_CLIENT_SECRET) {
    throw new Error("KAKAO_REST_API_KEY and KAKAO_CLIENT_SECRET are required. Run setup-kakao.ps1 first.");
  }
}
