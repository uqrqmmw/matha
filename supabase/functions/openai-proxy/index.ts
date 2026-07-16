const OPENAI_URL = "https://api.openai.com/v1/responses";
const APP_SUPABASE_URL = "https://rrihysbxhsbxjteqmtdu.supabase.co";
const APP_SUPABASE_KEY = "sb_publishable_p6ThWGf5DLp6XRCovZMVDQ_9vJG_Y41";
const MAX_BODY_BYTES = 14_000_000;
const MAX_MESSAGES = 24;
const MAX_IMAGES = 8;
const MAX_TEXT_CHARS = 80_000;

const splitCsv = (value: string | undefined) => new Set(
  String(value || "").split(",").map((item) => item.trim()).filter(Boolean),
);

const allowedOrigins = new Set([
  "https://uqrqmmw.github.io",
  "http://127.0.0.1:8899",
  "http://localhost:8899",
  ...splitCsv(Deno.env.get("OPENAI_ALLOWED_ORIGINS")),
]);
const allowedUserIds = splitCsv(Deno.env.get("OPENAI_ALLOWED_USER_IDS"));
const allowedEmails = new Set(
  [...splitCsv(Deno.env.get("OPENAI_ALLOWED_EMAILS"))].map((email) => email.toLowerCase()),
);

function corsHeaders(origin: string) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
  };
  if (origin && allowedOrigins.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function reply(origin: string, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(origin) });
}

const nullableText = { type: ["string", "null"] };
const markSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    box: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: { type: "number", minimum: 0, maximum: 1 },
    },
    label: { type: "string", maxLength: 16 },
  },
  required: ["box", "label"],
};
const stuckSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    phase: { type: "string", enum: ["讀題", "選方法", "想公式", "卡計算", "驗算收尾"] },
    what: { type: "string", maxLength: 80 },
    unstick: { type: "string", maxLength: 60 },
  },
  required: ["phase", "what", "unstick"],
};
const sharedProperties = {
  firstError: nullableText,
  errKind: nullableText,
  praise: { type: "string" },
  nextTime: { type: "string" },
  marks: { type: "array", maxItems: 2, items: markSchema },
  stuck: { type: "array", maxItems: 3, items: stuckSchema },
};
const responseSchemas = {
  grade: {
    type: "object",
    additionalProperties: false,
    properties: {
      read: { type: "string" },
      correct: { type: "boolean" },
      ...sharedProperties,
    },
    required: ["read", "correct", "firstError", "errKind", "praise", "nextTime", "marks", "stuck"],
  },
  process: {
    type: "object",
    additionalProperties: false,
    properties: sharedProperties,
    required: ["firstError", "errKind", "praise", "nextTime", "marks", "stuck"],
  },
};

function normalizeMessages(raw: unknown) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_MESSAGES) throw new Error("messages 數量不合法");
  let images = 0;
  let textChars = 0;
  const messages = raw.map((message) => {
    if (!message || typeof message !== "object") throw new Error("message 格式不合法");
    const item = message as Record<string, unknown>;
    const role = String(item.role || "");
    if (!["user", "assistant"].includes(role)) throw new Error("message role 不合法");
    if (typeof item.content === "string") {
      textChars += item.content.length;
      return { role, content: item.content };
    }
    if (!Array.isArray(item.content)) throw new Error("message content 不合法");
    const content = item.content.map((part) => {
      if (!part || typeof part !== "object") throw new Error("content part 不合法");
      const block = part as Record<string, unknown>;
      if (block.type === "text") {
        const value = String(block.text || "");
        textChars += value.length;
        return { type: "input_text", text: value };
      }
      if (block.type === "image") {
        const source = block.source as Record<string, unknown> | undefined;
        const mediaType = String(source && source.media_type || "");
        const data = String(source && source.data || "");
        if (!source || source.type !== "base64" || !/^image\/(png|jpeg|webp|gif)$/.test(mediaType) || !data) {
          throw new Error("圖片格式不合法");
        }
        images += 1;
        return { type: "input_image", image_url: `data:${mediaType};base64,${data}`, detail: "original" };
      }
      throw new Error("不支援的 content part");
    });
    return { role, content };
  });
  if (images > MAX_IMAGES) throw new Error("單次最多 8 張圖片");
  if (textChars > MAX_TEXT_CHARS) throw new Error("單次文字內容過長");
  return messages;
}

async function safetyIdentifier(userId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId));
  return "matha_" + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function authenticateAppUser(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) throw new Error("請先登入數A帳號");
  const response = await fetch(`${APP_SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: APP_SUPABASE_KEY },
  });
  if (!response.ok) throw new Error("登入狀態已失效，請重新登入");
  const user = await response.json() as { id?: string; email?: string };
  const id = String(user.id || "");
  const email = String(user.email || "").toLowerCase();
  if (!id) throw new Error("無法確認登入帳號");
  if (!allowedUserIds.size && !allowedEmails.size) throw new Error("尚未設定 OpenAI 使用者白名單");
  if (!allowedUserIds.has(id) && !allowedEmails.has(email)) {
    throw new Error("這個帳號未列入 OpenAI 使用白名單");
  }
  return { id, email };
}

function outputText(response: Record<string, unknown>) {
  const texts: string[] = [];
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (!item || typeof item !== "object" || (item as Record<string, unknown>).type !== "message") continue;
    for (const part of Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content as unknown[] : []) {
      if (!part || typeof part !== "object") continue;
      const block = part as Record<string, unknown>;
      if (block.type === "refusal") throw new Error("OpenAI 拒絕處理這次內容");
      if (block.type === "output_text" && typeof block.text === "string") texts.push(block.text);
    }
  }
  return texts.join("").trim();
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (!allowedOrigins.size) return reply(origin, 500, { message: "尚未設定 OPENAI_ALLOWED_ORIGINS" });
  if (origin && !allowedOrigins.has(origin)) return reply(origin, 403, { message: "這個網址未獲准呼叫 OpenAI" });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return reply(origin, 405, { message: "只接受 POST" });
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) return reply(origin, 413, { message: "請求內容過大" });

  let user: { id: string; email: string };
  try { user = await authenticateAppUser(req); }
  catch (error) { return reply(origin, 401, { message: error instanceof Error ? error.message : "登入驗證失敗" }); }
  const userId = user.id;

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return reply(origin, 500, { message: "伺服器尚未設定 OPENAI_API_KEY" });

  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return reply(origin, 413, { message: "請求內容過大" });
    const body = JSON.parse(raw || "{}");
    const responseType = String(body.responseType || "");
    if (!["grade", "process", "text", "test"].includes(responseType)) return reply(origin, 400, { message: "responseType 不合法" });

    const model = Deno.env.get("OPENAI_MODEL") || "gpt-5.6";
    const isTest = responseType === "test";
    const isStructured = responseType === "grade" || responseType === "process";
    const instructions = isTest
      ? "Reply with exactly OK."
      : String(body.instructions || (isStructured ? "依照 JSON Schema 回覆，不要增加 schema 外欄位。" : ""));
    if (instructions.length > 40_000) return reply(origin, 400, { message: "instructions 過長" });
    const input = isTest ? "ping" : normalizeMessages(body.messages);

    const requestBody: Record<string, unknown> = {
      model,
      instructions,
      input,
      max_output_tokens: isTest ? 32 : (isStructured ? 3500 : 3000),
      reasoning: { effort: isTest ? "none" : "medium" },
      store: false,
      safety_identifier: await safetyIdentifier(userId),
      metadata: { app: "matha", response_type: responseType },
      text: isStructured
        ? { format: { type: "json_schema", name: `matha_${responseType}`, strict: true, schema: responseSchemas[responseType as "grade" | "process"] } }
        : { format: { type: "text" } },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 80_000);
    let openAiResponse: Response;
    try {
      openAiResponse = await fetch(OPENAI_URL, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(requestBody),
      });
    } finally {
      clearTimeout(timeout);
    }

    const response = await openAiResponse.json().catch(() => ({})) as Record<string, unknown>;
    if (!openAiResponse.ok) {
      const apiError = response.error as Record<string, unknown> | undefined;
      return reply(origin, openAiResponse.status, { message: String(apiError?.message || `OpenAI HTTP ${openAiResponse.status}`) });
    }
    if (response.status !== "completed") {
      const incomplete = response.incomplete_details as Record<string, unknown> | undefined;
      return reply(origin, 502, { message: "OpenAI 輸出未完成" + (incomplete?.reason ? `：${incomplete.reason}` : "") });
    }
    const text = outputText(response);
    if (!text) return reply(origin, 502, { message: "OpenAI 沒有回傳文字" });
    const common = { model: response.model, usage: response.usage };
    if (isStructured) {
      try { return reply(origin, 200, { ...common, json: JSON.parse(text) }); }
      catch (_) { return reply(origin, 502, { message: "OpenAI 回傳的結構化資料無法解析" }); }
    }
    return reply(origin, 200, { ...common, text });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return reply(origin, 504, { message: "OpenAI 呼叫逾時" });
    return reply(origin, 400, { message: error instanceof Error ? error.message : "請求格式錯誤" });
  }
});
