import {
  normalizeMessages,
  outputText,
  paperDetailGateAllows,
  requestWeights,
  responseSchemas,
  safetyIdentifier,
  splitCsv,
  taipeiDate,
} from "./lib.ts";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const APP_SUPABASE_URL = "https://rrihysbxhsbxjteqmtdu.supabase.co";
const APP_SUPABASE_KEY = "sb_publishable_p6ThWGf5DLp6XRCovZMVDQ_9vJG_Y41";
const MAX_BODY_BYTES = 14_000_000;

const allowedOrigins = new Set([
  "https://uqrqmmw.github.io",
  "http://127.0.0.1:8899",
  "http://localhost:8899",
  ...splitCsv(Deno.env.get("OPENAI_ALLOWED_ORIGINS")),
]);
const allowedUserIds = splitCsv(Deno.env.get("OPENAI_ALLOWED_USER_IDS"));
const allowedEmails = new Set(
  [...splitCsv(Deno.env.get("OPENAI_ALLOWED_EMAILS"))].map((email) =>
    email.toLowerCase()
  ),
);
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

async function serviceRpc(name: string, body: Record<string, unknown>) {
  if (!serviceRoleKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(
    `${APP_SUPABASE_URL}/rest/v1/rpc/${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(String(
      payload && typeof payload === "object" &&
          (payload as Record<string, unknown>).message ||
        `Supabase RPC ${response.status}`,
    ));
  }
  return payload;
}

async function claimAiBudget(userId: string, responseType: string) {
  return await serviceRpc("claim_ai_request", {
    p_user_id: userId,
    p_kind: responseType,
    p_weight: requestWeights[responseType] || 1,
  }) as Record<string, unknown>;
}

/* OpenAI 呼叫失敗（HTTP 錯誤/逾時/沒回文字）時退還本次額度：
   否則整卷批改（權重 12）逾時幾次就把一天的安全額度燒光，卻沒拿到任何結果。 */
async function refundAiBudget(
  userId: string,
  responseType: string,
  usageDate: string,
) {
  await serviceRpc("refund_ai_request", {
    p_user_id: userId,
    p_weight: requestWeights[responseType] || 1,
    p_usage_date: usageDate || null, // 退回「扣額那天」的列（80 秒逾時可能跨台北午夜）
  }).catch(() => {});
}

async function recordAiUsage(
  userId: string,
  usageDate: string,
  usage: Record<string, unknown> | undefined,
) {
  if (!usage) return;
  await serviceRpc("record_ai_usage", {
    p_user_id: userId,
    p_input_tokens: Number(usage.input_tokens) || 0,
    p_output_tokens: Number(usage.output_tokens) || 0,
    p_usage_date: usageDate || null, // 記回「扣額那天」的列：跨午夜完成的請求不再無聲漏記
  });
}

async function verifyPaperDetailGate(userId: string, rawContext: unknown) {
  if (!serviceRoleKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  const context = rawContext && typeof rawContext === "object"
    ? rawContext as Record<string, unknown>
    : {};
  const runId = String(context.paperRunId || "");
  const questionNo = Number(context.questionNo);
  if (
    !runId || !Number.isInteger(questionNo) || questionNo < 1 || questionNo > 20
  ) {
    return false;
  }
  const query = new URL(`${APP_SUPABASE_URL}/rest/v1/app_state`);
  query.searchParams.set("select", "data");
  query.searchParams.set("user_id", `eq.${userId}`);
  query.searchParams.set("limit", "1");
  const response = await fetch(query, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Cannot verify paper review (${response.status})`);
  }
  const rows = await response.json() as Array<Record<string, unknown>>;
  const data = rows[0] && rows[0].data as Record<string, unknown> | undefined;
  return paperDetailGateAllows(data, runId, questionNo, taipeiDate());
}

function corsHeaders(origin: string) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
  };
  if (origin && allowedOrigins.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function reply(origin: string, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(origin),
  });
}

async function authenticateAppUser(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    throw new Error("請先登入數A帳號");
  }
  const response = await fetch(`${APP_SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: APP_SUPABASE_KEY },
  });
  if (!response.ok) throw new Error("登入狀態已失效，請重新登入");
  const user = await response.json() as { id?: string; email?: string };
  const id = String(user.id || "");
  const email = String(user.email || "").toLowerCase();
  if (!id) throw new Error("無法確認登入帳號");
  if (!allowedUserIds.size && !allowedEmails.size) {
    throw new Error("尚未設定 OpenAI 使用者白名單");
  }
  if (!allowedUserIds.has(id) && !allowedEmails.has(email)) {
    throw new Error("這個帳號未列入 OpenAI 使用白名單");
  }
  return { id, email };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (!allowedOrigins.size) {
    return reply(origin, 500, { message: "尚未設定 OPENAI_ALLOWED_ORIGINS" });
  }
  if (origin && !allowedOrigins.has(origin)) {
    return reply(origin, 403, { message: "這個網址未獲准呼叫 OpenAI" });
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return reply(origin, 405, { message: "只接受 POST" });
  }
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return reply(origin, 413, { message: "請求內容過大" });
  }

  let user: { id: string; email: string };
  try {
    user = await authenticateAppUser(req);
  } catch (error) {
    return reply(origin, 401, {
      message: error instanceof Error ? error.message : "登入驗證失敗",
    });
  }
  const userId = user.id;

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    return reply(origin, 500, { message: "伺服器尚未設定 OPENAI_API_KEY" });
  }

  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return reply(origin, 413, { message: "請求內容過大" });
    }
    const body = JSON.parse(raw || "{}");
    const responseType = String(body.responseType || "");
    if (
      ![
        "grade",
        "process",
        "outline",
        "concept",
        "paper_grade",
        "paper_detail",
        "text",
        "test",
      ].includes(
        responseType,
      )
    ) return reply(origin, 400, { message: "responseType 不合法" });

    const model = "gpt-5.5";
    const isTest = responseType === "test";
    const isStructured = [
      "grade",
      "process",
      "outline",
      "concept",
      "paper_grade",
      "paper_detail",
    ].includes(responseType);
    const instructions = isTest ? "Reply with exactly OK." : String(
      body.instructions ||
        (isStructured ? "依照 JSON Schema 回覆，不要增加 schema 外欄位。" : ""),
    );
    if (instructions.length > 40_000) {
      return reply(origin, 400, { message: "instructions 過長" });
    }
    const input = isTest ? "ping" : normalizeMessages(body.messages);
    if (
      responseType === "paper_detail" &&
      !(await verifyPaperDetailGate(userId, body.context))
    ) {
      return reply(origin, 403, {
        message: "本題詳解尚未開放：必須先進入已到期的隔日訂正。",
      });
    }
    const budget = await claimAiBudget(userId, responseType);
    if (!budget || budget.allowed !== true) {
      const reason = String(budget && budget.reason || "");
      return reply(origin, 429, {
        message: reason === "rate_limited"
          ? "請稍候幾秒再送出，避免重複扣用量。"
          : "今天的 AI 安全額度已用完；作答與筆跡仍會正常保存，明天再批改。",
        reason,
      });
    }
    const budgetDate = String(budget.date || "");

    const requestBody: Record<string, unknown> = {
      model,
      instructions,
      input,
      max_output_tokens: isTest
        ? 32
        : responseType === "paper_grade"
        ? 5000
        : responseType === "paper_detail"
        ? 4200
        : (isStructured ? 3500 : 3000),
      reasoning: { effort: isTest ? "none" : "medium" },
      store: false,
      safety_identifier: await safetyIdentifier(userId),
      metadata: { app: "matha", response_type: responseType },
      text: isStructured
        ? {
          format: {
            type: "json_schema",
            name: `matha_${responseType}`,
            strict: true,
            schema: responseSchemas[
              responseType as
                | "grade"
                | "process"
                | "outline"
                | "concept"
                | "paper_grade"
                | "paper_detail"
            ],
          },
        }
        : { format: { type: "text" } },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 80_000);
    let openAiResponse: Response;
    try {
      openAiResponse = await fetch(OPENAI_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      await refundAiBudget(userId, responseType, budgetDate); // 沒打到 OpenAI（逾時/網路）＝退還額度
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const response = await openAiResponse.json().catch(() => ({})) as Record<
      string,
      unknown
    >;
    if (!openAiResponse.ok) {
      await refundAiBudget(userId, responseType, budgetDate);
      const apiError = response.error as Record<string, unknown> | undefined;
      return reply(origin, openAiResponse.status, {
        message: String(
          apiError?.message || `OpenAI HTTP ${openAiResponse.status}`,
        ),
      });
    }
    if (response.status !== "completed") {
      await refundAiBudget(userId, responseType, budgetDate);
      const incomplete = response.incomplete_details as
        | Record<string, unknown>
        | undefined;
      return reply(origin, 502, {
        message: "OpenAI 輸出未完成" +
          (incomplete?.reason ? `：${incomplete.reason}` : ""),
      });
    }
    let text: string;
    try {
      text = outputText(response); // refusal 會丟錯：一樣沒拿到結果，要退款再往外拋
    } catch (error) {
      await refundAiBudget(userId, responseType, budgetDate);
      throw error;
    }
    if (!text) {
      await refundAiBudget(userId, responseType, budgetDate);
      return reply(origin, 502, { message: "OpenAI 沒有回傳文字" });
    }
    await recordAiUsage(
      userId,
      budgetDate,
      response.usage as Record<string, unknown> | undefined,
    ).catch(() => {});
    const common = {
      model: response.model,
      requestId: String(response.id || ""),
      usage: response.usage,
      budget,
    };
    if (isStructured) {
      try {
        return reply(origin, 200, { ...common, json: JSON.parse(text) });
      } catch (_) {
        await refundAiBudget(userId, responseType, budgetDate); // 拿不到可用結果就退，與其他 5xx 路徑一致
        return reply(origin, 502, {
          message: "OpenAI 回傳的結構化資料無法解析",
        });
      }
    }
    return reply(origin, 200, { ...common, text });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return reply(origin, 504, { message: "OpenAI 呼叫逾時" });
    }
    return reply(origin, 400, {
      message: error instanceof Error ? error.message : "請求格式錯誤",
    });
  }
});
