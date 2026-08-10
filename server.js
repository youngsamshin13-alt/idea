"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, ".data");
const LOCAL_STORE_PATH = path.join(DATA_DIR, "local-store.json");

loadEnvironmentFile(path.join(ROOT_DIR, ".env"));

const APP_ORIGIN = (process.env.APP_ORIGIN || "http://localhost:3000").replace(/\/+$/, "");
const ORIGIN_URL = new URL(APP_ORIGIN);
const PORT = Number(process.env.PORT || ORIGIN_URL.port || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const KAKAO_REST_API_KEY = normalizeEnvValue(process.env.KAKAO_REST_API_KEY);
const KAKAO_CLIENT_SECRET = normalizeEnvValue(process.env.KAKAO_CLIENT_SECRET);
const DELIVERY_WEBHOOK_SECRET = normalizeEnvValue(process.env.DELIVERY_WEBHOOK_SECRET);
const REDIRECT_URI = `${APP_ORIGIN}/auth/kakao/callback`;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const KAKAO_ACCESS_TOKEN_TTL_FALLBACK_MS = 6 * 60 * 60 * 1000;
const SESSION_COOKIE = "morning_session";
const OAUTH_STATE_COOKIE = "morning_oauth_state";
const KAKAO_AUTH_SCOPE = ["profile_nickname", "talk_message"].join(" ");
const DELIVERY_HOUR = 8;
const DELIVERY_MINUTE = 30;
const USE_SECURE_COOKIES = ORIGIN_URL.protocol === "https:";
const MAX_TASK_LENGTH = 120;
const PRIORITY_ORDER = new Map([
  ["high", 3],
  ["medium", 2],
  ["low", 1],
]);
const PRIORITY_LABELS = {
  high: "높음",
  medium: "보통",
  low: "낮음",
};

const loginAttempts = new Map();
const oauthStates = new Map();

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
      sendText(response, 500, "요청을 처리하는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.");
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

  if (pathname.startsWith("/api/")) {
    await handleApiRequest(request, response, pathname);
    return;
  }

  if (pathname === "/internal/deliver-due-briefings") {
    await handleInternalDeliveryRequest(request, response);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendText(response, 405, "허용되지 않은 요청입니다.");
    return;
  }

  if (pathname === "/") {
    if (!getCurrentUserContext(request)) {
      redirect(response, "/login.html");
      return;
    }

    await sendPublicFile(request, response, publicFiles.get("/index.html"));
    return;
  }

  if (pathname === "/login.html" && getCurrentUserContext(request)) {
    redirect(response, "/");
    return;
  }

  const publicFile = publicFiles.get(pathname);
  if (!publicFile) {
    sendText(response, 404, "페이지를 찾을 수 없어요.");
    return;
  }

  if (publicFile.protected && !getCurrentUserContext(request)) {
    redirect(response, "/login.html?error=session_required");
    return;
  }

  await sendPublicFile(request, response, publicFile);
}

async function handleApiRequest(request, response, pathname) {
  const context = getCurrentUserContext(request);
  if (!context) {
    sendJson(response, 401, { error: "로그인이 필요합니다." });
    return;
  }

  try {
    if (request.method === "GET" && pathname === "/api/tasks") {
      sendJson(response, 200, {
        tasks: listTasksForUser(context.user.userId),
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/tasks") {
      const body = await readJsonBody(request);
      const task = createTaskForUser(context.user.userId, body);
      sendJson(response, 201, { task });
      return;
    }

    const match = pathname.match(/^\/api\/tasks\/([^/]+)\/(complete|snooze)$/);
    if (!match) {
      sendJson(response, 404, { error: "요청한 API를 찾을 수 없어요." });
      return;
    }

    if (request.method !== "POST") {
      sendJson(response, 405, { error: "허용되지 않은 요청입니다." });
      return;
    }

    const [, encodedTaskId, action] = match;
    const taskId = decodeURIComponent(encodedTaskId);
    const task =
      action === "complete"
        ? completeTaskForUser(context.user.userId, taskId)
        : snoozeTaskForUser(context.user.userId, taskId);

    if (!task) {
      sendJson(response, 404, { error: "할 일을 찾을 수 없어요." });
      return;
    }

    sendJson(response, 200, { task });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

async function handleInternalDeliveryRequest(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "허용되지 않은 요청입니다." });
    return;
  }

  if (!DELIVERY_WEBHOOK_SECRET) {
    sendJson(response, 503, { error: "발송 웹훅 비밀값이 아직 설정되지 않았어요." });
    return;
  }

  const authHeader = request.headers.authorization || "";
  const bearerPrefix = "Bearer ";
  if (!authHeader.startsWith(bearerPrefix)) {
    sendJson(response, 401, { error: "웹훅 인증이 필요합니다." });
    return;
  }

  const receivedSecret = authHeader.slice(bearerPrefix.length).trim();
  if (!receivedSecret || !safeEqual(receivedSecret, DELIVERY_WEBHOOK_SECRET)) {
    sendJson(response, 403, { error: "웹훅 인증을 확인할 수 없어요." });
    return;
  }

  try {
    const body = await readJsonBody(request, { allowEmptyBody: true });
    const requestedTime = normalizeOptionalString(body?.asOf);
    const asOf = requestedTime ? new Date(requestedTime) : new Date();

    if (Number.isNaN(asOf.getTime())) {
      sendJson(response, 400, { error: "asOf 값이 올바른 날짜 형식이 아니에요." });
      return;
    }

    const result = await deliverDueBriefings(asOf, APP_ORIGIN);
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
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
  authorizeUrl.searchParams.set("scope", KAKAO_AUTH_SCOPE);
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
    const identity = buildKakaoIdentity(user);
    const sessionId = createSessionForUser(identity.userId);

    upsertUserRecord({
      accessToken: token.access_token,
      accessTokenExpiresAt: toIsoFromNow(
        Number.isFinite(token.expires_in) ? token.expires_in * 1000 : KAKAO_ACCESS_TOKEN_TTL_FALLBACK_MS,
      ),
      displayName: identity.displayName,
      nickname: identity.nickname,
      refreshToken: normalizeOptionalString(token.refresh_token),
      refreshTokenExpiresAt: toIsoFromNow(
        Number.isFinite(token.refresh_token_expires_in) ? token.refresh_token_expires_in * 1000 : null,
      ),
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

async function refreshKakaoToken(user) {
  if (!user?.refreshToken) {
    throw new Error("Kakao refresh token is unavailable.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: KAKAO_REST_API_KEY,
    client_secret: KAKAO_CLIENT_SECRET,
    refresh_token: user.refreshToken,
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
    throw new Error(`Kakao refresh request returned ${response.status}`);
  }

  const nextUser = upsertUserRecord({
    accessToken: payload.access_token,
    accessTokenExpiresAt: toIsoFromNow(
      Number.isFinite(payload.expires_in) ? payload.expires_in * 1000 : KAKAO_ACCESS_TOKEN_TTL_FALLBACK_MS,
    ),
    displayName: user.displayName,
    nickname: user.nickname,
    refreshToken: normalizeOptionalString(payload.refresh_token) || user.refreshToken,
    refreshTokenExpiresAt:
      toIsoFromNow(
        Number.isFinite(payload.refresh_token_expires_in) ? payload.refresh_token_expires_in * 1000 : null,
      ) || user.refreshTokenExpiresAt,
    userId: user.userId,
  });

  return nextUser;
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
  const context = getCurrentUserContext(request);

  if (context?.user?.accessToken) {
    try {
      await fetchWithTimeout("https://kapi.kakao.com/v1/user/logout", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${context.user.accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        },
      });
    } catch (error) {
      console.warn("Kakao logout request failed", { message: error.message });
    }
  }

  if (sessionId) {
    deleteSession(sessionId);
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
  const context = getCurrentUserContext(request);
  if (!context) {
    sendText(response, 401, "로그인이 필요합니다.");
    return;
  }

  const publicSession = JSON.stringify({
    displayName: formatSessionDisplayName(context.user),
    nickname: context.user.nickname,
    userId: context.user.userId,
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

function getCurrentUserContext(request) {
  const sessionId = parseCookies(request)[SESSION_COOKIE];
  if (!sessionId) {
    return null;
  }

  const store = readLocalStore();
  const session = store.sessions[sessionId];
  if (!session) {
    return null;
  }

  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    mutateLocalStore((draft) => {
      delete draft.sessions[sessionId];
    });
    return null;
  }

  const user = store.users[session.userId];
  if (!user) {
    mutateLocalStore((draft) => {
      delete draft.sessions[sessionId];
    });
    return null;
  }

  return {
    session,
    user,
  };
}

function createSessionForUser(userId) {
  const sessionId = randomToken(32);
  mutateLocalStore((draft) => {
    draft.sessions[sessionId] = {
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      sessionId,
      userId,
    };
  });
  return sessionId;
}

function deleteSession(sessionId) {
  mutateLocalStore((draft) => {
    delete draft.sessions[sessionId];
  });
}

function upsertUserRecord(record) {
  let savedUser = null;
  mutateLocalStore((draft) => {
    const existing = draft.users[record.userId] || {};
    savedUser = {
      accessToken: record.accessToken,
      accessTokenExpiresAt: record.accessTokenExpiresAt || existing.accessTokenExpiresAt || null,
      displayName: truncateDisplayName(record.displayName || existing.displayName || ""),
      nickname: record.nickname || existing.nickname || "",
      refreshToken: record.refreshToken || existing.refreshToken || "",
      refreshTokenExpiresAt: record.refreshTokenExpiresAt || existing.refreshTokenExpiresAt || null,
      updatedAt: new Date().toISOString(),
      userId: record.userId,
    };
    draft.users[record.userId] = savedUser;
  });
  return savedUser;
}

function listTasksForUser(userId) {
  const store = readLocalStore();
  return Object.values(store.tasks)
    .filter((task) => task.userId === userId)
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}

function createTaskForUser(userId, payload) {
  const text = normalizeTaskText(payload?.text);
  const priority = normalizeTaskPriority(payload?.priority);
  const nowIso = new Date().toISOString();
  const task = {
    completedAt: null,
    createdAt: nowIso,
    id: createTaskId(),
    priority,
    snoozedUntil: null,
    text,
    updatedAt: nowIso,
    userId,
  };

  mutateLocalStore((draft) => {
    draft.tasks[task.id] = task;
  });

  return task;
}

function completeTaskForUser(userId, taskId) {
  let nextTask = null;
  mutateLocalStore((draft) => {
    const existing = draft.tasks[taskId];
    if (!existing || existing.userId !== userId) {
      return;
    }

    nextTask = {
      ...existing,
      completedAt: new Date().toISOString(),
      snoozedUntil: null,
      updatedAt: new Date().toISOString(),
    };
    draft.tasks[taskId] = nextTask;
  });
  return nextTask;
}

function snoozeTaskForUser(userId, taskId) {
  let nextTask = null;
  mutateLocalStore((draft) => {
    const existing = draft.tasks[taskId];
    if (!existing || existing.userId !== userId) {
      return;
    }

    nextTask = {
      ...existing,
      snoozedUntil: getNextMorningDelivery(new Date(), 1).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    draft.tasks[taskId] = nextTask;
  });
  return nextTask;
}

async function deliverDueBriefings(asOf, origin) {
  const slot = getDeliverySlotForDate(asOf);
  if (asOf.getTime() < slot.getTime()) {
    return {
      asOf: asOf.toISOString(),
      deliveryDate: getKstDateKey(slot),
      delivered: [],
      failed: [],
      skipped: [{ reason: "scheduled_time_not_reached" }],
    };
  }

  const deliveryDate = getKstDateKey(slot);
  const delivered = [];
  const failed = [];
  const store = readLocalStore();
  const users = Object.values(store.users);

  for (const user of users) {
    const briefingKey = createBriefingKey(user.userId, deliveryDate);
    const existingBriefing = store.briefings[briefingKey];
    if (existingBriefing?.status === "sent") {
      continue;
    }

    const tasks = getBriefingTasksForDelivery(user.userId, slot);
    if (tasks.length === 0) {
      continue;
    }

    try {
      const activeUser = await getValidKakaoAccessToken(user);
      const sendResult = await sendKakaoMessage(activeUser, tasks, slot, origin);
      const briefingRecord = {
        deliveryDate,
        id: briefingKey,
        message: sendResult.text,
        resultCode: sendResult.resultCode,
        scheduledFor: slot.toISOString(),
        sentAt: new Date().toISOString(),
        status: "sent",
        taskCount: tasks.length,
        userId: user.userId,
      };

      mutateLocalStore((draft) => {
        draft.briefings[briefingKey] = briefingRecord;
      });

      delivered.push({
        deliveryDate,
        resultCode: sendResult.resultCode,
        taskCount: tasks.length,
        userId: user.userId,
      });
    } catch (error) {
      mutateLocalStore((draft) => {
        draft.briefings[briefingKey] = {
          deliveryDate,
          errorMessage: error.message,
          id: briefingKey,
          scheduledFor: slot.toISOString(),
          sentAt: null,
          status: "failed",
          taskCount: tasks.length,
          userId: user.userId,
        };
      });

      failed.push({
        deliveryDate,
        error: error.message,
        taskCount: tasks.length,
        userId: user.userId,
      });
    }
  }

  return {
    asOf: asOf.toISOString(),
    delivered,
    deliveryDate,
    failed,
    skipped: [],
  };
}

async function getValidKakaoAccessToken(user) {
  const expiresAt = new Date(user.accessTokenExpiresAt || 0).getTime();
  if (!user.accessToken || !expiresAt || expiresAt <= Date.now() + 60_000) {
    return refreshKakaoToken(user);
  }

  return user;
}

async function sendKakaoMessage(user, tasks, slot, origin) {
  const template = buildKakaoMessageTemplate(origin, slot, tasks);
  const body = new URLSearchParams({
    template_object: JSON.stringify(template),
  });

  let currentUser = user;
  let response = await fetchWithTimeout("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${currentUser.accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body,
  });

  if (response.status === 401) {
    currentUser = await refreshKakaoToken(currentUser);
    response = await fetchWithTimeout("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${currentUser.accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      },
      body,
    });
  }

  const payload = await readJsonResponse(response);
  if (!response.ok || payload.result_code !== 0) {
    const message = normalizeOptionalString(payload?.msg) || `Kakao message request returned ${response.status}`;
    throw new Error(message);
  }

  return {
    resultCode: payload.result_code,
    text: template.text,
  };
}

function buildKakaoMessageTemplate(origin, slot, tasks) {
  const safeOrigin = normalizeOriginForMessage(origin);
  return {
    link: {
      mobile_web_url: safeOrigin,
      web_url: safeOrigin,
    },
    object_type: "text",
    text: composeBriefingText(slot, tasks),
  };
}

function composeBriefingText(slot, tasks) {
  const heading = `${formatKoreanMonthDay(slot)} 아침 브리핑`;
  const lines = [heading];
  const candidates = getSortedTasks(tasks, slot).map((task, index) => {
    const label = PRIORITY_LABELS[task.priority] || PRIORITY_LABELS.medium;
    return `${index + 1}. ${truncateTaskLine(task.text)} (${label})`;
  });

  const maxTextLength = 200;
  let usedCount = 0;

  for (const line of candidates) {
    const nextText = [...lines, line].join("\n");
    if (nextText.length > maxTextLength) {
      break;
    }
    lines.push(line);
    usedCount += 1;
  }

  const remaining = candidates.length - usedCount;
  if (remaining > 0) {
    const summaryLine = `외 ${remaining}건`;
    const nextText = [...lines, summaryLine].join("\n");
    if (nextText.length <= maxTextLength) {
      lines.push(summaryLine);
    }
  }

  return lines.join("\n");
}

function getBriefingTasksForDelivery(userId, slot) {
  return listTasksForUser(userId).filter((task) => {
    if (isTaskCompleted(task)) {
      return false;
    }
    if (new Date(task.createdAt).getTime() > slot.getTime()) {
      return false;
    }
    if (!task.snoozedUntil) {
      return true;
    }
    return new Date(task.snoozedUntil).getTime() <= slot.getTime();
  });
}

function getSortedTasks(tasks, nextDelivery) {
  return [...tasks].sort((left, right) => {
    const leftCompleted = isTaskCompleted(left);
    const rightCompleted = isTaskCompleted(right);

    if (leftCompleted !== rightCompleted) {
      return Number(leftCompleted) - Number(rightCompleted);
    }

    const leftSnoozed = isTaskSnoozed(left, nextDelivery);
    const rightSnoozed = isTaskSnoozed(right, nextDelivery);

    if (leftSnoozed !== rightSnoozed) {
      return Number(leftSnoozed) - Number(rightSnoozed);
    }

    const priorityDiff =
      (PRIORITY_ORDER.get(right.priority) || 0) - (PRIORITY_ORDER.get(left.priority) || 0);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
}

function isTaskSnoozed(task, nextDelivery) {
  if (isTaskCompleted(task)) {
    return false;
  }
  if (!task.snoozedUntil) {
    return false;
  }
  return new Date(task.snoozedUntil).getTime() > nextDelivery.getTime();
}

function isTaskCompleted(task) {
  return Boolean(task?.completedAt);
}

function getNextMorningDelivery(baseDate = new Date(), extraDays = 0) {
  const nextMorning = new Date(baseDate);
  nextMorning.setDate(nextMorning.getDate() + 1 + extraDays);
  nextMorning.setHours(DELIVERY_HOUR, DELIVERY_MINUTE, 0, 0);
  return nextMorning;
}

function getDeliverySlotForDate(date) {
  return new Date(`${getKstDateKey(date)}T08:30:00+09:00`);
}

function getKstDateKey(date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Seoul",
    year: "numeric",
  });
  return formatter.format(date);
}

function formatKoreanMonthDay(date) {
  const formatter = new Intl.DateTimeFormat("ko-KR", {
    day: "numeric",
    month: "long",
    timeZone: "Asia/Seoul",
  });
  return formatter.format(date);
}

function createBriefingKey(userId, deliveryDate) {
  return `${userId}::${deliveryDate}`;
}

function truncateTaskLine(text) {
  return text.length > 42 ? `${text.slice(0, 39)}...` : text;
}

function normalizeOriginForMessage(origin) {
  const value = normalizeEnvValue(origin);
  if (!value) {
    throw new Error("APP_ORIGIN is required to compose Kakao message links.");
  }
  return value.replace(/\/+$/, "");
}

function readLocalStore() {
  const emptyStore = {
    briefings: {},
    sessions: {},
    tasks: {},
    users: {},
  };

  if (!fs.existsSync(LOCAL_STORE_PATH)) {
    return emptyStore;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_STORE_PATH, "utf8"));
    return {
      briefings: isObjectRecord(parsed?.briefings) ? parsed.briefings : {},
      sessions: isObjectRecord(parsed?.sessions) ? parsed.sessions : {},
      tasks: isObjectRecord(parsed?.tasks) ? parsed.tasks : {},
      users: isObjectRecord(parsed?.users) ? parsed.users : {},
    };
  } catch (error) {
    console.warn("Failed to read local store, recreating it.", { message: error.message });
    return emptyStore;
  }
}

function mutateLocalStore(mutator) {
  const draft = readLocalStore();
  mutator(draft);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporaryPath = `${LOCAL_STORE_PATH}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, LOCAL_STORE_PATH);
}

function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

  mutateLocalStore((draft) => {
    for (const [sessionId, session] of Object.entries(draft.sessions)) {
      if (new Date(session.expiresAt).getTime() <= now) {
        delete draft.sessions[sessionId];
      }
    }
  });

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

async function readJsonBody(request, options = {}) {
  const { allowEmptyBody = false, maxBytes = 32 * 1024 } = options;
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return allowEmptyBody ? null : {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return allowEmptyBody ? null : {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error("Request body must be valid JSON.");
  }
}

function normalizeTaskText(value) {
  const text = normalizeWhitespace(normalizeOptionalString(value));
  if (!text) {
    throw new Error("할 일 내용을 한 줄 이상 적어 주세요.");
  }
  if (text.length > MAX_TASK_LENGTH) {
    throw new Error(`할 일 내용은 ${MAX_TASK_LENGTH}자 이하로 적어 주세요.`);
  }
  return text;
}

function normalizeTaskPriority(value) {
  if (typeof value !== "string") {
    throw new Error("중요도를 확인해 주세요.");
  }
  const priority = value.trim();
  if (!PRIORITY_ORDER.has(priority)) {
    throw new Error("중요도는 높음, 보통, 낮음 중에서 선택해 주세요.");
  }
  return priority;
}

function createTaskId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `task-${Date.now()}-${randomToken(8)}`;
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
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
  if (explicitDisplayName && explicitDisplayName !== "카카오 사용자") {
    return explicitDisplayName;
  }

  return formatKakaoUserLabel(session?.userId);
}

function formatKakaoUserLabel(userId) {
  const normalizedUserId = typeof userId === "string" ? userId.trim() : String(userId || "").trim();
  if (!normalizedUserId) {
    return "카카오 사용자";
  }
  return `카카오 계정 #${normalizedUserId.slice(-6)}`;
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

function normalizeOptionalString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toIsoFromNow(durationMs) {
  if (!durationMs) {
    return null;
  }
  return new Date(Date.now() + durationMs).toISOString();
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

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
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
