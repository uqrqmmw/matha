import { createClient } from "npm:@supabase/supabase-js@2.110.6";

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

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  const email = userData.user?.email;
  if (userError || !email) {
    return reply(origin, 401, { message: "登入狀態已失效，請重新登入" });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: APP_REDIRECT_URL },
  });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) {
    return reply(origin, 502, {
      message: error?.message || "無法建立一次性配對碼",
    });
  }

  return reply(origin, 200, {
    token_hash: tokenHash,
    expires_in: 3600,
    one_time: true,
  });
});
