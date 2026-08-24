const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  "";
const APP_REDIRECT_URL = "https://uqrqmmw.github.io/matha/";

const allowedOrigins = new Set([
  "https://uqrqmmw.github.io",
  "http://127.0.0.1:8899",
  "http://localhost:8899",
]);

function headers(origin: string) {
  const out: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
  };
  if (allowedOrigins.has(origin)) out["Access-Control-Allow-Origin"] = origin;
  return out;
}

function reply(origin: string, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: headers(origin),
  });
}

async function supabaseJson(
  path: string,
  key: string,
  authorization: string,
  init: RequestInit = {},
) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: authorization,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const record = data && typeof data === "object"
      ? data as Record<string, unknown>
      : {};
    throw new Error(String(
      record.message || record.msg || record.error_description ||
        `Supabase ${response.status}`,
    ));
  }
  return data;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (origin && !allowedOrigins.has(origin)) {
    return reply(origin, 403, { message: "這個網址不能建立配對連結" });
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: headers(origin) });
  }
  if (req.method !== "POST") {
    return reply(origin, 405, { message: "只接受 POST" });
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return reply(origin, 500, { message: "配對服務尚未完成伺服器設定" });
  }

  const authorization = req.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    return reply(origin, 401, { message: "請先登入再建立配對連結" });
  }

  let user: Record<string, unknown>;
  try {
    user = await supabaseJson(
      "/auth/v1/user",
      SUPABASE_ANON_KEY,
      authorization,
    ) as Record<string, unknown>;
  } catch (_) {
    return reply(origin, 401, { message: "登入狀態已失效，請重新登入" });
  }
  const email = typeof user.email === "string" ? user.email : "";
  const userId = typeof user.id === "string" ? user.id : "";
  if (!email || !userId) {
    return reply(origin, 401, { message: "登入狀態已失效，請重新登入" });
  }

  // 與資料層同一份白名單（app_users）：未核可帳號連配對碼也不給，別留第二套授權標準
  let approved: Array<Record<string, unknown>> = [];
  try {
    approved = await supabaseJson(
      `/rest/v1/app_users?select=enabled&user_id=eq.${
        encodeURIComponent(userId)
      }&limit=1`,
      SUPABASE_SERVICE_ROLE_KEY,
      `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ) as Array<Record<string, unknown>>;
  } catch (_) {
    return reply(origin, 502, { message: "目前無法核對帳號權限" });
  }
  if (!Array.isArray(approved) || approved[0]?.enabled !== true) {
    return reply(origin, 403, { message: "這個帳號尚未被核可使用本系統" });
  }

  let link: Record<string, unknown>;
  try {
    link = await supabaseJson(
      "/auth/v1/admin/generate_link",
      SUPABASE_SERVICE_ROLE_KEY,
      `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      {
        method: "POST",
        body: JSON.stringify({
          type: "magiclink",
          email,
          redirect_to: APP_REDIRECT_URL,
        }),
      },
    ) as Record<string, unknown>;
  } catch (error) {
    return reply(origin, 502, {
      message: error instanceof Error ? error.message : "無法建立一次性配對碼",
    });
  }
  const properties = link.properties && typeof link.properties === "object"
    ? link.properties as Record<string, unknown>
    : link;
  const tokenHash = typeof properties.hashed_token === "string"
    ? properties.hashed_token
    : "";
  if (!tokenHash) {
    return reply(origin, 502, { message: "配對服務沒有回傳一次性代碼" });
  }

  return reply(origin, 200, {
    token_hash: tokenHash,
    expires_in: 3600,
    one_time: true,
  });
});
