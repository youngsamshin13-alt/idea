const ASSETS = __ASSET_MAP__;

const SESSION_COOKIE = "morning_session";
const OAUTH_STATE_COOKIE = "morning_oauth_state";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const KAKAO_ACCESS_TOKEN_TTL_FALLBACK_MS = 6 * 60 * 60 * 1000;
const KAKAO_AUTH_SCOPE = ["profile_nickname", "talk_message"].join(" ");
const DELIVERY_HOUR = 8;
const DELIVERY_MINUTE = 30;
const MAX_TASK_LENGTH = 120;

const PRIORITY_ORDER = new Map([
  ["high", 3],
  ["medium", 2],
  ["low", 1],
]);

const PRIORITY_LABELS = {
  high: "높음",
  low: "낮음",
  medium: "보통",
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const loginAttempts = new Map();

let schemaPromise = null;

export default {
  async fetch(request, env, ctx) {
    try {
      ctx.waitUntil(cleanExpiredRecords(env));
      return await handleRequest(request, env);
    } catch (error) {
      console.error("Request failed", {
        path: safeRequestPath(request.url),
        message: error.message,
      });

      return createTextResponse(
        request,
        500,
        "요청을 처리하는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.",
      );
    }
  },

  async scheduled(controller, env, ctx) {
    const origin = getConfiguredMessageOrigin(env);
    if (!origin) {
      console.error("Scheduled delivery skipped because APP_ORIGIN is missing.");
      return;
    }

    ctx.waitUntil(deliverDueBriefings(env, new Date(controller.scheduledTime), origin));
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

  if (pathname.startsWith("/api/")) {
    return handleApiRequest(request, env, pathname);
  }

  if (pathname === "/internal/deliver-due-briefings") {
    return handleInternalDeliveryRequest(request, env);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return createTextResponse(request, 405, "허용되지 않은 요청입니다.", {
      Allow: "GET, HEAD",
    });
  }

  if (pathname === "/") {
    const session = await getCurrentUserContext(request, env);
    if (!session) {
      return redirect(request, "/login.html");
    }

    return sendPublicFile(request, "/index.html");
  }

  if (pathname === "/login.html" && (await getCurrentUserContext(request, env))) {
    return redirect(request, "/");
  }

  const publicFile = ASSETS[pathname];
  if (!publicFile) {
    return createTextResponse(request, 404, "페이지를 찾을 수 없어요.");
  }

  if (publicFile.protected && !(await getCurrentUserContext(request, env))) {
    return redirect(request, "/login.html?error=session_required");
  }

  return sendPublicFile(request, pathname);
}

async function handleApiRequest(request, env, pathname) {
  const context = await getCurrentUserContext(request, env);
  if (!context) {
    return createJsonResponse(request, 401, { error: "로그인이 필요합니다." });
  }

  try {
    if (request.method === "GET" && pathname === "/api/tasks") {
      return createJsonResponse(request, 200, {
        tasks: await listTasksForUser(env, context.user.userId),
      });
    }

    if (request.method === "POST" && pathname === "/api/tasks") {
      const body = await readJsonBody(request);
      const task = await createTaskForUser(env, context.user.userId, body);
      return createJsonResponse(request, 201, { task });
    }

    const match = pathname.match(/^\/api\/tasks\/([^/]+)\/(complete|snooze)$/);
    if (!match) {
      return createJsonResponse(request, 404, { error: "요청한 API를 찾을 수 없어요." });
    }

    if (request.method !== "POST") {
      return createJsonResponse(request, 405, { error: "허용되지 않은 요청입니다." });
    }

    const [, encodedTaskId, action] = match;
    const taskId = decodeURIComponent(encodedTaskId);
    const task =
      action === "complete"
        ? await completeTaskForUser(env, context.user.userId, taskId)
        : await snoozeTaskForUser(env, context.user.userId, taskId);

    if (!task) {
      return createJsonResponse(request, 404, { error: "할 일을 찾을 수 없어요." });
    }

    return createJsonResponse(request, 200, { task });
  } catch (error) {
    return createJsonResponse(request, 400, { error: error.message });
  }
}

async function handleInternalDeliveryRequest(request, env) {
  if (request.method !== "POST") {
    return createJsonResponse(request, 405, { error: "허용되지 않은 요청입니다." });
  }

  const secret = normalizeEnvValue(env.DELIVERY_WEBHOOK_SECRET);
  if (!secret) {
    return createJsonResponse(request, 503, { error: "발송 웹훅 비밀값이 아직 설정되지 않았어요." });
  }

  const authHeader = request.headers.get("authorization") || "";
  const bearerPrefix = "Bearer ";
  if (!authHeader.startsWith(bearerPrefix)) {
    return createJsonResponse(request, 401, { error: "웹훅 인증이 필요합니다." });
  }

  const receivedSecret = authHeader.slice(bearerPrefix.length).trim();
  if (!receivedSecret || !safeEqual(receivedSecret, secret)) {
    return createJsonResponse(request, 403, { error: "웹훅 인증을 확인할 수 없어요." });
  }

  try {
    const body = await readJsonBody(request, { allowEmptyBody: true });
    const requestedTime = normalizeOptionalString(body?.asOf);
    const asOf = requestedTime ? new Date(requestedTime) : new Date();

    if (Number.isNaN(asOf.getTime())) {
      return createJsonResponse(request, 400, { error: "asOf 값이 올바른 날짜 형식이 아니에요." });
    }

    const origin = getConfiguredMessageOrigin(env) || getRequestOrigin(request);
    const result = await deliverDueBriefings(env, asOf, origin);
    return createJsonResponse(request, 200, result);
  } catch (error) {
    return createJsonResponse(request, 400, { error: error.message });
  }
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
  authorizeUrl.searchParams.set("scope", KAKAO_AUTH_SCOPE);
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
    const redirectUri = `${getRequestOrigin(request)}/auth/kakao/callback`;
    const token = await exchangeAuthorizationCode(authorizationCode, redirectUri, env);
    const user = await retrieveKakaoUser(token.access_token);
    const identity = buildKakaoIdentity(user);

    await upsertUserRecord(env, {
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

    const sessionId = await createSessionForUser(env, identity.userId);
    const sessionCookie = await createSignedCookie(
      SESSION_COOKIE,
      { sessionId },
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

async function refreshKakaoToken(env, user) {
  if (!user?.refreshToken) {
    throw new Error("Kakao refresh token is unavailable.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.KAKAO_REST_API_KEY,
    client_secret: env.KAKAO_CLIENT_SECRET,
    refresh_token: user.refreshToken,
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
    throw new Error(`Kakao refresh request returned ${response.status}`);
  }

  await upsertUserRecord(env, {
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

  return getUserById(env, user.userId);
}

async function retrieveKakaoUser(accessToken) {
  const body = new URLSearchParams({
    property_keys: JSON.stringify(["kakao_account.profile", "kakao_account.email", "kakao_account.name"]),
  });

  const response = await fetch("https://kapi.kakao.com/v2/user/me", {
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

async function logout(request, env) {
  if (isCrossOriginRequest(request)) {
    return createTextResponse(request, 403, "로그아웃 요청을 확인할 수 없어요.");
  }

  const sessionPayload = await readSignedCookie(request, SESSION_COOKIE, env);
  const context = await getCurrentUserContext(request, env);

  if (context?.user?.accessToken) {
    try {
      await fetch("https://kapi.kakao.com/v1/user/logout", {
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

  if (sessionPayload?.sessionId) {
    await deleteSession(env, sessionPayload.sessionId);
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
  const context = await getCurrentUserContext(request, env);
  if (!context) {
    return createTextResponse(request, 401, "로그인이 필요합니다.");
  }

  const publicSession = JSON.stringify({
    displayName: formatSessionDisplayName(context.user),
    nickname: context.user.nickname,
    userId: context.user.userId,
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

async function getCurrentUserContext(request, env) {
  const sessionToken = await readSignedCookie(request, SESSION_COOKIE, env);
  if (!sessionToken?.sessionId) {
    return null;
  }

  await ensureDatabase(env);
  const row = await env.DB.prepare(
    `
      SELECT
        s.session_id AS sessionId,
        s.user_id AS userId,
        s.created_at AS sessionCreatedAt,
        s.expires_at AS sessionExpiresAt,
        u.display_name AS displayName,
        u.nickname AS nickname,
        u.access_token AS accessToken,
        u.access_token_expires_at AS accessTokenExpiresAt,
        u.refresh_token AS refreshToken,
        u.refresh_token_expires_at AS refreshTokenExpiresAt
      FROM sessions s
      JOIN users u ON u.user_id = s.user_id
      WHERE s.session_id = ?
    `,
  )
    .bind(sessionToken.sessionId)
    .first();

  if (!row) {
    return null;
  }

  if (new Date(row.sessionExpiresAt).getTime() <= Date.now()) {
    await deleteSession(env, row.sessionId);
    return null;
  }

  return {
    session: {
      createdAt: row.sessionCreatedAt,
      expiresAt: row.sessionExpiresAt,
      sessionId: row.sessionId,
      userId: row.userId,
    },
    user: {
      accessToken: row.accessToken,
      accessTokenExpiresAt: row.accessTokenExpiresAt,
      displayName: row.displayName,
      nickname: row.nickname,
      refreshToken: row.refreshToken,
      refreshTokenExpiresAt: row.refreshTokenExpiresAt,
      userId: row.userId,
    },
  };
}

async function createSessionForUser(env, userId) {
  await ensureDatabase(env);
  const sessionId = randomToken(32);
  const nowIso = new Date().toISOString();

  await env.DB.prepare(
    `
      INSERT INTO sessions (session_id, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `,
  )
    .bind(sessionId, userId, nowIso, new Date(Date.now() + SESSION_TTL_MS).toISOString())
    .run();

  return sessionId;
}

async function deleteSession(env, sessionId) {
  await ensureDatabase(env);
  await env.DB.prepare("DELETE FROM sessions WHERE session_id = ?").bind(sessionId).run();
}

async function upsertUserRecord(env, record) {
  await ensureDatabase(env);
  const nowIso = new Date().toISOString();

  await env.DB.prepare(
    `
      INSERT INTO users (
        user_id,
        display_name,
        nickname,
        access_token,
        access_token_expires_at,
        refresh_token,
        refresh_token_expires_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        display_name = excluded.display_name,
        nickname = excluded.nickname,
        access_token = excluded.access_token,
        access_token_expires_at = excluded.access_token_expires_at,
        refresh_token = CASE
          WHEN excluded.refresh_token != '' THEN excluded.refresh_token
          ELSE users.refresh_token
        END,
        refresh_token_expires_at = CASE
          WHEN excluded.refresh_token_expires_at IS NOT NULL THEN excluded.refresh_token_expires_at
          ELSE users.refresh_token_expires_at
        END,
        updated_at = excluded.updated_at
    `,
  )
    .bind(
      record.userId,
      truncateDisplayName(record.displayName || ""),
      record.nickname || "",
      record.accessToken,
      record.accessTokenExpiresAt || null,
      record.refreshToken || "",
      record.refreshTokenExpiresAt || null,
      nowIso,
    )
    .run();
}

async function getUserById(env, userId) {
  await ensureDatabase(env);
  const row = await env.DB.prepare(
    `
      SELECT
        user_id AS userId,
        display_name AS displayName,
        nickname,
        access_token AS accessToken,
        access_token_expires_at AS accessTokenExpiresAt,
        refresh_token AS refreshToken,
        refresh_token_expires_at AS refreshTokenExpiresAt
      FROM users
      WHERE user_id = ?
    `,
  )
    .bind(userId)
    .first();

  return row || null;
}

async function listUsers(env) {
  await ensureDatabase(env);
  const result = await env.DB.prepare(
    `
      SELECT
        user_id AS userId,
        display_name AS displayName,
        nickname,
        access_token AS accessToken,
        access_token_expires_at AS accessTokenExpiresAt,
        refresh_token AS refreshToken,
        refresh_token_expires_at AS refreshTokenExpiresAt
      FROM users
    `,
  ).all();

  return Array.isArray(result.results) ? result.results : [];
}

async function listTasksForUser(env, userId) {
  await ensureDatabase(env);
  const result = await env.DB.prepare(
    `
      SELECT
        id,
        user_id AS userId,
        text,
        priority,
        created_at AS createdAt,
        snoozed_until AS snoozedUntil,
        completed_at AS completedAt,
        updated_at AS updatedAt
      FROM tasks
      WHERE user_id = ?
      ORDER BY created_at ASC
    `,
  )
    .bind(userId)
    .all();

  return Array.isArray(result.results) ? result.results : [];
}

async function createTaskForUser(env, userId, payload) {
  await ensureDatabase(env);
  const text = normalizeTaskText(payload?.text);
  const priority = normalizeTaskPriority(payload?.priority);
  const nowIso = new Date().toISOString();
  const taskId = randomTaskId();

  await env.DB.prepare(
    `
      INSERT INTO tasks (
        id,
        user_id,
        text,
        priority,
        created_at,
        snoozed_until,
        completed_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
    `,
  )
    .bind(taskId, userId, text, priority, nowIso, nowIso)
    .run();

  return getTaskById(env, userId, taskId);
}

async function completeTaskForUser(env, userId, taskId) {
  await ensureDatabase(env);
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `
      UPDATE tasks
      SET completed_at = ?, snoozed_until = NULL, updated_at = ?
      WHERE id = ? AND user_id = ?
    `,
  )
    .bind(nowIso, nowIso, taskId, userId)
    .run();

  return getTaskById(env, userId, taskId);
}

async function snoozeTaskForUser(env, userId, taskId) {
  await ensureDatabase(env);
  const nowIso = new Date().toISOString();
  const snoozedUntil = getNextMorningDelivery(new Date(), 1).toISOString();

  await env.DB.prepare(
    `
      UPDATE tasks
      SET snoozed_until = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `,
  )
    .bind(snoozedUntil, nowIso, taskId, userId)
    .run();

  return getTaskById(env, userId, taskId);
}

async function getTaskById(env, userId, taskId) {
  await ensureDatabase(env);
  const row = await env.DB.prepare(
    `
      SELECT
        id,
        user_id AS userId,
        text,
        priority,
        created_at AS createdAt,
        snoozed_until AS snoozedUntil,
        completed_at AS completedAt,
        updated_at AS updatedAt
      FROM tasks
      WHERE id = ? AND user_id = ?
    `,
  )
    .bind(taskId, userId)
    .first();

  return row || null;
}

async function getBriefingRecord(env, userId, deliveryDate) {
  await ensureDatabase(env);
  const row = await env.DB.prepare(
    `
      SELECT
        id,
        user_id AS userId,
        delivery_date AS deliveryDate,
        scheduled_for AS scheduledFor,
        sent_at AS sentAt,
        status,
        result_code AS resultCode,
        message,
        error_message AS errorMessage,
        task_count AS taskCount
      FROM briefings
      WHERE user_id = ? AND delivery_date = ?
    `,
  )
    .bind(userId, deliveryDate)
    .first();

  return row || null;
}

async function saveBriefingRecord(env, record) {
  await ensureDatabase(env);
  await env.DB.prepare(
    `
      INSERT INTO briefings (
        id,
        user_id,
        delivery_date,
        scheduled_for,
        sent_at,
        status,
        result_code,
        message,
        error_message,
        task_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, delivery_date) DO UPDATE SET
        scheduled_for = excluded.scheduled_for,
        sent_at = excluded.sent_at,
        status = excluded.status,
        result_code = excluded.result_code,
        message = excluded.message,
        error_message = excluded.error_message,
        task_count = excluded.task_count
    `,
  )
    .bind(
      record.id,
      record.userId,
      record.deliveryDate,
      record.scheduledFor,
      record.sentAt,
      record.status,
      record.resultCode ?? null,
      record.message ?? null,
      record.errorMessage ?? null,
      record.taskCount ?? 0,
    )
    .run();
}

async function deliverDueBriefings(env, asOf, origin) {
  const slot = getDeliverySlotForDate(asOf);
  if (asOf.getTime() < slot.getTime()) {
    return {
      asOf: asOf.toISOString(),
      delivered: [],
      deliveryDate: getKstDateKey(slot),
      failed: [],
      skipped: [{ reason: "scheduled_time_not_reached" }],
    };
  }

  const deliveryDate = getKstDateKey(slot);
  const delivered = [];
  const failed = [];
  const users = await listUsers(env);

  for (const user of users) {
    const existingBriefing = await getBriefingRecord(env, user.userId, deliveryDate);
    if (existingBriefing?.status === "sent") {
      continue;
    }

    const tasks = await getBriefingTasksForDelivery(env, user.userId, slot);
    if (tasks.length === 0) {
      continue;
    }

    try {
      const activeUser = await getValidKakaoAccessToken(env, user);
      const sendResult = await sendKakaoMessage(activeUser, tasks, slot, origin, env);

      await saveBriefingRecord(env, {
        deliveryDate,
        id: createBriefingKey(user.userId, deliveryDate),
        message: sendResult.text,
        resultCode: sendResult.resultCode,
        scheduledFor: slot.toISOString(),
        sentAt: new Date().toISOString(),
        status: "sent",
        taskCount: tasks.length,
        userId: user.userId,
      });

      delivered.push({
        deliveryDate,
        resultCode: sendResult.resultCode,
        taskCount: tasks.length,
        userId: user.userId,
      });
    } catch (error) {
      await saveBriefingRecord(env, {
        deliveryDate,
        errorMessage: error.message,
        id: createBriefingKey(user.userId, deliveryDate),
        message: null,
        resultCode: null,
        scheduledFor: slot.toISOString(),
        sentAt: null,
        status: "failed",
        taskCount: tasks.length,
        userId: user.userId,
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

async function getValidKakaoAccessToken(env, user) {
  const expiresAt = new Date(user.accessTokenExpiresAt || 0).getTime();
  if (!user.accessToken || !expiresAt || expiresAt <= Date.now() + 60_000) {
    return refreshKakaoToken(env, user);
  }

  return user;
}

async function sendKakaoMessage(user, tasks, slot, origin, env) {
  const template = buildKakaoMessageTemplate(origin, slot, tasks);
  const body = new URLSearchParams({
    template_object: JSON.stringify(template),
  });

  let currentUser = user;
  let response = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${currentUser.accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body,
  });

  if (response.status === 401) {
    currentUser = await refreshKakaoToken(env, currentUser);
    response = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
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
  const safeOrigin = normalizeMessageOrigin(origin);
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

  let usedCount = 0;
  for (const line of candidates) {
    const nextText = [...lines, line].join("\n");
    if (nextText.length > 200) {
      break;
    }
    lines.push(line);
    usedCount += 1;
  }

  const remaining = candidates.length - usedCount;
  if (remaining > 0) {
    const summaryLine = `외 ${remaining}건`;
    const nextText = [...lines, summaryLine].join("\n");
    if (nextText.length <= 200) {
      lines.push(summaryLine);
    }
  }

  return lines.join("\n");
}

async function getBriefingTasksForDelivery(env, userId, slot) {
  const tasks = await listTasksForUser(env, userId);
  return tasks.filter((task) => {
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

async function ensureDatabase(env) {
  if (!env.DB) {
    throw new Error("D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json.");
  }

  if (!schemaPromise) {
    schemaPromise = env.DB.batch([
      env.DB.prepare(
        `
          CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            nickname TEXT NOT NULL DEFAULT '',
            access_token TEXT NOT NULL,
            access_token_expires_at TEXT,
            refresh_token TEXT NOT NULL DEFAULT '',
            refresh_token_expires_at TEXT,
            updated_at TEXT NOT NULL
          )
        `,
      ),
      env.DB.prepare(
        `
          CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
          )
        `,
      ),
      env.DB.prepare(
        `
          CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            text TEXT NOT NULL,
            priority TEXT NOT NULL,
            created_at TEXT NOT NULL,
            snoozed_until TEXT,
            completed_at TEXT,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
          )
        `,
      ),
      env.DB.prepare(
        `
          CREATE TABLE IF NOT EXISTS briefings (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            delivery_date TEXT NOT NULL,
            scheduled_for TEXT NOT NULL,
            sent_at TEXT,
            status TEXT NOT NULL,
            result_code INTEGER,
            message TEXT,
            error_message TEXT,
            task_count INTEGER NOT NULL DEFAULT 0,
            UNIQUE (user_id, delivery_date),
            FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
          )
        `,
      ),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_tasks_user_id_created_at ON tasks (user_id, created_at)"),
      env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS idx_tasks_user_id_completed_at ON tasks (user_id, completed_at)",
      ),
      env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS idx_briefings_user_id_delivery_date ON briefings (user_id, delivery_date)",
      ),
      env.DB.prepare("PRAGMA optimize"),
    ]).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }

  await schemaPromise;
}

async function cleanExpiredRecords(env) {
  if (!env.DB) {
    return;
  }

  await ensureDatabase(env);
  const nowIso = new Date().toISOString();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(nowIso).run();
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

function getConfiguredMessageOrigin(env) {
  return normalizeOptionalString(env.APP_ORIGIN).replace(/\/+$/, "");
}

function isAuthConfigured(env) {
  return Boolean(
    normalizeEnvValue(env.KAKAO_REST_API_KEY) &&
      normalizeEnvValue(env.KAKAO_CLIENT_SECRET) &&
      getSessionSecret(env) &&
      env.DB,
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
  return crypto.subtle.verify("HMAC", key, fromBase64Url(signature), textEncoder.encode(payload));
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

async function readJsonBody(request, options = {}) {
  const { allowEmptyBody = false } = options;
  const raw = (await request.text()).trim();
  if (!raw) {
    return allowEmptyBody ? null : {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error("요청 본문은 JSON 형식이어야 해요.");
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

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
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

function formatSessionDisplayName(user) {
  const explicitDisplayName = pickFirstNonEmpty([user?.displayName, user?.nickname]);
  if (explicitDisplayName && explicitDisplayName !== "카카오 사용자") {
    return explicitDisplayName;
  }

  return formatKakaoUserLabel(user?.userId);
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
  return new Intl.DateTimeFormat("ko-KR", {
    day: "numeric",
    month: "long",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function createBriefingKey(userId, deliveryDate) {
  return `${userId}::${deliveryDate}`;
}

function randomTaskId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `task-${Date.now()}-${randomToken(8)}`;
}

function truncateTaskLine(text) {
  return text.length > 42 ? `${text.slice(0, 39)}...` : text;
}

function normalizeMessageOrigin(origin) {
  const normalized = normalizeOptionalString(origin).replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("APP_ORIGIN is required to compose Kakao message links.");
  }
  return normalized;
}

function isSecureRequest(request) {
  return new URL(request.url).protocol === "https:";
}

function isCrossOriginRequest(request) {
  const origin = request.headers.get("origin");
  if (origin) {
    return origin !== getRequestOrigin(request);
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) {
    return !["same-origin", "same-site", "none"].includes(fetchSite);
  }

  const referer = request.headers.get("referer");
  if (!referer) {
    return false;
  }

  try {
    return new URL(referer).origin !== getRequestOrigin(request);
  } catch (error) {
    return true;
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

function createJsonResponse(request, statusCode, payload, extraHeaders = {}) {
  return createBodyResponse(
    request,
    statusCode,
    JSON.stringify(payload),
    "application/json; charset=utf-8",
    extraHeaders,
  );
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

function safeEqual(left, right) {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= leftBytes[index] ^ rightBytes[index];
  }
  return diff === 0;
}

function safeRequestPath(requestUrl) {
  try {
    return new URL(requestUrl).pathname;
  } catch (error) {
    return "invalid-url";
  }
}
