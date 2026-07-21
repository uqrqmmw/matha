// openai-proxy 的純邏輯層：不碰 Deno.env、不發網路請求，供 index.ts 與 lib.test.ts 共用。
export const MAX_MESSAGES = 24;
export const MAX_IMAGES = 8;
export const MAX_TEXT_CHARS = 80_000;

export const splitCsv = (value: string | undefined) =>
  new Set(
    String(value || "").split(",").map((item) => item.trim()).filter(Boolean),
  );

export const requestWeights: Record<string, number> = {
  paper_grade: 12,
  paper_detail: 5,
  outline: 3,
  grade: 2,
  process: 2,
  concept: 2,
  text: 1,
  test: 1,
};

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
const paperGradeMarkSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: {
      type: "string",
      enum: [
        "check",
        "cross",
        "partial",
        "strike",
        "add",
        "unanswered",
        "uncertain",
      ],
    },
    box: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: { type: "number", minimum: 0, maximum: 1 },
    },
    label: { type: "string", maxLength: 16 },
    option: { type: "integer", minimum: 0, maximum: 5 },
  },
  required: ["kind", "box", "label", "option"],
};
const stuckSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    phase: {
      type: "string",
      enum: ["讀題", "選方法", "想公式", "卡計算", "驗算收尾"],
    },
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
export const responseSchemas = {
  grade: {
    type: "object",
    additionalProperties: false,
    properties: {
      read: { type: "string" },
      correct: { type: "boolean" },
      ...sharedProperties,
    },
    required: [
      "read",
      "correct",
      "firstError",
      "errKind",
      "praise",
      "nextTime",
      "marks",
      "stuck",
    ],
  },
  process: {
    type: "object",
    additionalProperties: false,
    properties: sharedProperties,
    required: ["firstError", "errKind", "praise", "nextTime", "marks", "stuck"],
  },
  outline: {
    type: "object",
    additionalProperties: false,
    properties: {
      readable: { type: "boolean" },
      coverage: { type: "integer", minimum: 0, maximum: 100 },
      covered: {
        type: "array",
        maxItems: 20,
        items: { type: "string", maxLength: 80 },
      },
      missing: {
        type: "array",
        maxItems: 20,
        items: { type: "string", maxLength: 80 },
      },
      inaccurate: {
        type: "array",
        maxItems: 12,
        items: { type: "string", maxLength: 120 },
      },
      nextFocus: { type: "string", maxLength: 160 },
    },
    required: [
      "readable",
      "coverage",
      "covered",
      "missing",
      "inaccurate",
      "nextFocus",
    ],
  },
  concept: {
    type: "object",
    additionalProperties: false,
    properties: {
      understood: { type: "boolean" },
      accurate: {
        type: "array",
        maxItems: 8,
        items: { type: "string", maxLength: 100 },
      },
      missing: {
        type: "array",
        maxItems: 8,
        items: { type: "string", maxLength: 100 },
      },
      misconception: nullableText,
      clearerVersion: { type: "string", maxLength: 260 },
      nextPrompt: { type: "string", maxLength: 140 },
    },
    required: [
      "understood",
      "accurate",
      "missing",
      "misconception",
      "clearerVersion",
      "nextPrompt",
    ],
  },
  paper_grade: {
    type: "object",
    additionalProperties: false,
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            no: { type: "integer", minimum: 1, maximum: 20 },
            page: { type: "integer", minimum: 1, maximum: 6 },
            read: { type: "string", maxLength: 120 },
            status: {
              type: "string",
              enum: ["correct", "incorrect", "unanswered", "uncertain"],
            },
            hasFinalAnswer: { type: "boolean" },
            finalAnswer: { type: "string", maxLength: 120 },
            selectedOptions: {
              type: "array",
              maxItems: 5,
              items: { type: "integer", minimum: 1, maximum: 5 },
            },
            points: { type: "number", minimum: 0, maximum: 10 },
            marks: {
              type: "array",
              maxItems: 7,
              items: paperGradeMarkSchema,
            },
          },
          required: [
            "no",
            "page",
            "read",
            "status",
            "hasFinalAnswer",
            "finalAnswer",
            "selectedOptions",
            "points",
            "marks",
          ],
        },
      },
      note: { type: "string", maxLength: 160 },
    },
    required: ["questions", "note"],
  },
  paper_detail: {
    type: "object",
    additionalProperties: false,
    properties: {
      readable: { type: "boolean" },
      read: { type: "string", maxLength: 300 },
      firstError: { type: ["string", "null"], maxLength: 300 },
      errorKind: { type: ["string", "null"], maxLength: 80 },
      explanation: { type: "string", maxLength: 1400 },
      solution: {
        type: "array",
        maxItems: 8,
        items: { type: "string", maxLength: 300 },
      },
      answer: { type: "string", maxLength: 120 },
      nextTime: { type: "string", maxLength: 180 },
      marks: { type: "array", maxItems: 2, items: markSchema },
    },
    required: [
      "readable",
      "read",
      "firstError",
      "errorKind",
      "explanation",
      "solution",
      "answer",
      "nextTime",
      "marks",
    ],
  },
};

export function normalizeMessages(raw: unknown) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_MESSAGES) {
    throw new Error("messages 數量不合法");
  }
  let images = 0;
  let textChars = 0;
  const messages = raw.map((message) => {
    if (!message || typeof message !== "object") {
      throw new Error("message 格式不合法");
    }
    const item = message as Record<string, unknown>;
    const role = String(item.role || "");
    if (!["user", "assistant"].includes(role)) {
      throw new Error("message role 不合法");
    }
    if (typeof item.content === "string") {
      textChars += item.content.length;
      return { role, content: item.content };
    }
    if (!Array.isArray(item.content)) throw new Error("message content 不合法");
    const content = item.content.map((part) => {
      if (!part || typeof part !== "object") {
        throw new Error("content part 不合法");
      }
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
        if (
          !source || source.type !== "base64" ||
          !/^image\/(png|jpeg|webp|gif)$/.test(mediaType) || !data
        ) {
          throw new Error("圖片格式不合法");
        }
        images += 1;
        return {
          type: "input_image",
          image_url: `data:${mediaType};base64,${data}`,
          detail: "original",
        };
      }
      throw new Error("不支援的 content part");
    });
    return { role, content };
  });
  if (images > MAX_IMAGES) throw new Error("單次最多 8 張圖片");
  if (textChars > MAX_TEXT_CHARS) throw new Error("單次文字內容過長");
  return messages;
}

export async function safetyIdentifier(userId: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(userId),
  );
  return "matha_" +
    [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("").slice(0, 32);
}

export function taipeiDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/* 逐題詳解開放判定（純函式）：data＝該使用者 app_state.data。
   規則：run 與該題訂正狀態存在，且已到隔天（due ≤ 台北今天）。前端另記查看時間；不再強迫先保存失敗紀錄。 */
export function paperDetailGateAllows(
  data: Record<string, unknown> | undefined,
  runId: string,
  questionNo: number,
  today: string,
) {
  if (
    !runId || !Number.isInteger(questionNo) || questionNo < 1 ||
    questionNo > 20
  ) {
    return false;
  }
  const rawRuns = data?.paperRuns;
  const runs: unknown[] = Array.isArray(rawRuns) ? rawRuns : [];
  const run = runs.find((item) =>
    item && typeof item === "object" &&
    String((item as Record<string, unknown>).id || "") === runId
  ) as Record<string, unknown> | undefined;
  if (!run || String(run.due || "") > today) return false;
  const review = run.review && typeof run.review === "object"
    ? run.review as Record<string, unknown>
    : {};
  const state = review[String(questionNo)] as
    | Record<string, unknown>
    | undefined;
  return !!state;
}

export function outputText(response: Record<string, unknown>) {
  const texts: string[] = [];
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (
      !item || typeof item !== "object" ||
      (item as Record<string, unknown>).type !== "message"
    ) continue;
    for (
      const part of Array.isArray((item as Record<string, unknown>).content)
        ? (item as Record<string, unknown>).content as unknown[]
        : []
    ) {
      if (!part || typeof part !== "object") continue;
      const block = part as Record<string, unknown>;
      if (block.type === "refusal") throw new Error("OpenAI 拒絕處理這次內容");
      if (block.type === "output_text" && typeof block.text === "string") {
        texts.push(block.text);
      }
    }
  }
  return texts.join("").trim();
}
