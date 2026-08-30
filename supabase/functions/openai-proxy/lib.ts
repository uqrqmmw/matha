// openai-proxy 的純邏輯層：不碰 Deno.env、不發網路請求，供 index.ts 與 lib.test.ts 共用。
import { REGIONAL_PAPER_SOLUTION_MAP } from "./paper-solutions.ts";

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
  paper_correction_grade: 3,
  outline: 3,
  grade: 2,
  process: 2,
  concept: 2,
  text: 1,
  test: 1,
};

export type PaperAnswerKeyItem = {
  type: "single" | "multi" | "fill" | "constructed";
  ans: Array<number | string>;
  display?: string;
  points: number;
  rubric?: Array<{ label: string }>;
};

export function parsePaperAnswerKeys(raw: string | undefined) {
  if (!raw) throw new Error("Missing PAPER_ANSWER_KEYS_JSON");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PAPER_ANSWER_KEYS_JSON 格式不合法");
  }
  const out: Record<string, PaperAnswerKeyItem[]> = {};
  for (const [sourceId, value] of Object.entries(parsed)) {
    if (
      !/^paper-[a-z0-9-]{1,50}$/.test(sourceId) || !Array.isArray(value) ||
      !value.length || value.length > 20
    ) {
      throw new Error("PAPER_ANSWER_KEYS_JSON 題本格式不合法");
    }
    out[sourceId] = value.map((rawItem) => {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
        throw new Error("PAPER_ANSWER_KEYS_JSON 題目格式不合法");
      }
      const item = rawItem as Record<string, unknown>;
      const type = String(item.type || "") as PaperAnswerKeyItem["type"];
      const points = Number(item.points);
      const answers = Array.isArray(item.ans) ? item.ans : [];
      if (
        !["single", "multi", "fill", "constructed"].includes(type) ||
        !answers.length ||
        !Number.isFinite(points) || points <= 0 || points > 10
      ) {
        throw new Error("PAPER_ANSWER_KEYS_JSON 題目內容不合法");
      }
      if (type === "fill" || type === "constructed") {
        if (
          answers.some((answer) => typeof answer !== "string" || !answer.trim())
        ) {
          throw new Error("PAPER_ANSWER_KEYS_JSON 填答答案不合法");
        }
      } else if (
        answers.some((answer) =>
          !Number.isInteger(answer) || Number(answer) < 0 || Number(answer) > 4
        )
      ) {
        throw new Error("PAPER_ANSWER_KEYS_JSON 選項答案不合法");
      }
      const normalized: PaperAnswerKeyItem = {
        type,
        ans: answers.slice(),
        points,
      };
      if (typeof item.display === "string" && item.display.trim()) {
        normalized.display = item.display.trim();
      }
      if (type === "constructed") {
        if (
          !Array.isArray(item.rubric) || !item.rubric.length ||
          item.rubric.length > 6
        ) {
          throw new Error("PAPER_ANSWER_KEYS_JSON 非選題評分規準不合法");
        }
        normalized.rubric = item.rubric.map((rawCriterion) => {
          if (
            !rawCriterion || typeof rawCriterion !== "object" ||
            Array.isArray(rawCriterion)
          ) {
            throw new Error("PAPER_ANSWER_KEYS_JSON 非選題評分規準不合法");
          }
          const criterion = rawCriterion as Record<string, unknown>;
          const label = typeof criterion.label === "string"
            ? criterion.label.trim()
            : "";
          if (!label || label.length > 180) {
            throw new Error("PAPER_ANSWER_KEYS_JSON 非選題評分規準不合法");
          }
          return { label };
        });
      } else if (item.rubric != null) {
        throw new Error("PAPER_ANSWER_KEYS_JSON 只有非選題可設定評分規準");
      }
      return normalized;
    });
  }
  return out;
}

// This historical 20-question paper remains usable for correction/regrading,
// but it is deliberately not a fresh capability paper.  Keeping its key in
// Edge code (rather than accepting the browser copy) preserves server-owned
// scoring authority for the legacy practice path.
const PAPER_MOCK_1_ANSWER_KEY: PaperAnswerKeyItem[] = [
  { type: "single", ans: [4], points: 5 },
  { type: "single", ans: [4], points: 5 },
  { type: "single", ans: [2], points: 5 },
  { type: "single", ans: [3], points: 5 },
  { type: "single", ans: [3], points: 5 },
  { type: "single", ans: [3], points: 5 },
  { type: "single", ans: [2], points: 5 },
  { type: "multi", ans: [0, 3], points: 5 },
  { type: "multi", ans: [0, 3, 4], points: 5 },
  { type: "multi", ans: [1, 2, 4], points: 5 },
  { type: "multi", ans: [3, 4], points: 5 },
  { type: "multi", ans: [0, 3, 4], points: 5 },
  { type: "multi", ans: [2, 3, 4], points: 5 },
  { type: "fill", ans: ["50/269"], display: "50/269", points: 5 },
  { type: "fill", ans: ["0"], display: "0", points: 5 },
  { type: "fill", ans: ["10/3"], display: "10/3", points: 5 },
  { type: "fill", ans: ["728/27"], display: "728/27", points: 5 },
  { type: "single", ans: [3], points: 3 },
  { type: "fill", ans: ["-1"], display: "-1", points: 6 },
  { type: "fill", ans: ["9/26"], display: "9/26", points: 6 },
];

export function paperGradeAnswerKey(
  sourceId: string,
  configuredKeys: string | undefined,
) {
  if (sourceId === "paper-mock-1") {
    return PAPER_MOCK_1_ANSWER_KEY.map((item) => ({
      ...item,
      ans: [...item.ans],
      rubric: item.rubric ? item.rubric.map((row) => ({ ...row })) : undefined,
    }));
  }
  return parsePaperAnswerKeys(configuredKeys)[sourceId] || null;
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
            page: { type: "integer", minimum: 1, maximum: 8 },
            topic: {
              type: "string",
              enum: [
                "num",
                "line",
                "poly",
                "seq",
                "comb",
                "prob",
                "data",
                "trig1",
                "trig2",
                "exp",
                "vec",
                "vec3",
                "space",
                "mat",
              ],
            },
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
            "topic",
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
  paper_correction_grade: {
    type: "object",
    additionalProperties: false,
    properties: {
      status: {
        type: "string",
        enum: ["correct", "incorrect", "unanswered", "uncertain"],
      },
      read: { type: "string", maxLength: 240 },
    },
    required: ["status", "read"],
  },
  paper_detail: {
    type: "object",
    additionalProperties: false,
    properties: {
      readable: { type: "boolean" },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
      },
      read: { type: "string", maxLength: 800 },
      goodWork: {
        type: "array",
        maxItems: 5,
        items: { type: "string", maxLength: 220 },
      },
      firstErrorEvidence: { type: ["string", "null"], maxLength: 260 },
      firstError: { type: ["string", "null"], maxLength: 360 },
      errorKind: { type: ["string", "null"], maxLength: 80 },
      whyWrong: { type: "string", maxLength: 700 },
      repair: { type: "string", maxLength: 360 },
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
      "confidence",
      "read",
      "goodWork",
      "firstErrorEvidence",
      "firstError",
      "errorKind",
      "whyWrong",
      "repair",
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
   規則：run 與該題訂正狀態存在、已到隔天，且雲端已保存至少一次真實重想。 */
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
  if (!state) return false;
  const attempts = Number(state.attempts) || 0;
  const logs = Array.isArray(state.logs) ? state.logs : [];
  const hasRetryLog = logs.some((log) =>
    !!log && typeof log === "object" &&
    String((log as Record<string, unknown>).kind || "") === "retry"
  );
  return attempts >= 1 && hasRetryLog;
}

/* 官方詳解像素與 AI 詳批共用同一個「隔日＋真實重想」門檻，另外必須
   綁定同一回的 sourceId，避免拿已解鎖的舊 run 猜別回題本的檔名。 */
export function paperSolutionGateAllows(
  data: Record<string, unknown> | undefined,
  runId: string,
  sourceId: string,
  questionNo: number,
  today: string,
) {
  if (!paperDetailGateAllows(data, runId, questionNo, today)) return false;
  const rawRuns = data?.paperRuns;
  const runs: unknown[] = Array.isArray(rawRuns) ? rawRuns : [];
  const run = runs.find((item) =>
    item && typeof item === "object" &&
    String((item as Record<string, unknown>).id || "") === runId
  ) as Record<string, unknown> | undefined;
  return !!run && String(run.sourceId || "") === sourceId;
}

const paperSolutionMap: Record<string, Record<number, string[]>> = {
  "paper-mock-1": {
    3: ["paper-mock-1/q03.png"],
    4: ["paper-mock-1/q04.png"],
    11: ["paper-mock-1/q11.png"],
    12: ["paper-mock-1/q12-a.png", "paper-mock-1/q12-b.png"],
    13: ["paper-mock-1/q13.png"],
    14: ["paper-mock-1/q14.png"],
    16: ["paper-mock-1/q16.png"],
  },
  "paper-official-110-trial": {
    1: ["paper-official-110-trial/page-01-c7d733fea66b.png"],
    2: ["paper-official-110-trial/page-01-c7d733fea66b.png"],
    3: ["paper-official-110-trial/page-01-c7d733fea66b.png"],
    4: ["paper-official-110-trial/page-02-7ec6c9fe53db.png"],
    5: ["paper-official-110-trial/page-02-7ec6c9fe53db.png"],
    6: ["paper-official-110-trial/page-02-7ec6c9fe53db.png"],
    7: ["paper-official-110-trial/page-03-f784544033ba.png"],
    8: ["paper-official-110-trial/page-03-f784544033ba.png"],
    9: ["paper-official-110-trial/page-03-f784544033ba.png"],
    10: ["paper-official-110-trial/page-04-11fa0ac0d919.png"],
    11: ["paper-official-110-trial/page-04-11fa0ac0d919.png"],
    12: ["paper-official-110-trial/page-04-11fa0ac0d919.png"],
    13: ["paper-official-110-trial/page-05-43f004a0656a.png"],
    14: ["paper-official-110-trial/page-05-43f004a0656a.png"],
    15: ["paper-official-110-trial/page-05-43f004a0656a.png"],
    16: ["paper-official-110-trial/page-05-43f004a0656a.png"],
    17: ["paper-official-110-trial/page-06-81b4bd1cef16.png"],
    18: ["paper-official-110-trial/page-06-81b4bd1cef16.png"],
    19: ["paper-official-110-trial/page-06-81b4bd1cef16.png"],
    20: [
      "paper-official-110-trial/page-07-081146b891af.png",
      "paper-official-110-trial/page-08-4ab3b0649c85.png",
    ],
  },
  ...REGIONAL_PAPER_SOLUTION_MAP,
};

export function paperSolutionFiles(sourceId: string, questionNo: number) {
  if (!/^paper-[a-z0-9-]{1,50}$/.test(sourceId)) return [];
  if (!Number.isInteger(questionNo) || questionNo < 1 || questionNo > 20) {
    return [];
  }
  return [...(paperSolutionMap[sourceId]?.[questionNo] || [])];
}

export function absoluteStorageSignedUrl(baseUrl: string, rawUrl: string) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  const raw = String(rawUrl || "");
  if (!/^https:\/\//.test(base) || !raw) throw new Error("Signed URL 不合法");
  if (/^https:\/\//.test(raw)) return raw;
  if (raw.startsWith("/storage/v1/")) return `${base}${raw}`;
  if (raw.startsWith("/object/")) return `${base}/storage/v1${raw}`;
  throw new Error("Signed URL 路徑不合法");
}

/* 正式答案只能在 app_state 已保存同一回交卷狀態後解鎖。前端聲稱已交卷不算數；
   Edge Function 必須以 service role 讀回伺服器端狀態再判斷。 */
export function paperAcceptedRunReceiptMatches(
  data: Record<string, unknown> | undefined,
  runId: string,
  sourceId: string,
  rawAcceptedAttempt: unknown,
) {
  if (!runId || !/^paper-[a-z0-9-]{1,50}$/.test(sourceId)) return false;
  const rawRuns = data?.paperRuns;
  const runs: unknown[] = Array.isArray(rawRuns) ? rawRuns : [];
  const run = runs.find((item) =>
    item && typeof item === "object" &&
    String((item as Record<string, unknown>).id || "") === runId
  ) as Record<string, unknown> | undefined;
  const accepted =
    rawAcceptedAttempt && typeof rawAcceptedAttempt === "object" &&
      !Array.isArray(rawAcceptedAttempt)
      ? rawAcceptedAttempt as Record<string, unknown>
      : {};
  const receipt = run?.submitAttempt && typeof run.submitAttempt === "object" &&
      !Array.isArray(run.submitAttempt)
    ? run.submitAttempt as Record<string, unknown>
    : {};
  if (!run || String(run.sourceId || "") !== sourceId) return false;
  return accepted.authority === "supabase-immutable-paper-submit-attempt-v2" &&
    accepted.status === "accepted" &&
    accepted.decisionReason === "accepted-first-for-run" &&
    accepted.runId === runId && accepted.sourceId === sourceId &&
    String(receipt.attemptId || "") === accepted.attemptId &&
    String(receipt.status || "") === "accepted" &&
    String(receipt.decisionReason || "") === "accepted-first-for-run" &&
    String(receipt.inkSnapshotSha256 || "").toLowerCase() ===
      accepted.inkSnapshotSha256 &&
    Number(receipt.submittedAt) === accepted.submittedAt &&
    String(receipt.runCreatedAppVersion || "") ===
      accepted.runCreatedAppVersion &&
    Number(run.submittedAt) === accepted.submittedAt;
}

/* 正式答案必須同時有 app_state 中的同步收據與 service-role 讀回的
   immutable accepted row；單獨偽造前者永遠不能解鎖。 */
export function paperKeyGateAllows(
  data: Record<string, unknown> | undefined,
  runId: string,
  sourceId: string,
  rawAcceptedAttempt: unknown,
) {
  if (
    !paperAcceptedRunReceiptMatches(
      data,
      runId,
      sourceId,
      rawAcceptedAttempt,
    )
  ) return false;
  const runs = Array.isArray(data?.paperRuns) ? data.paperRuns : [];
  const run = runs.find((item) =>
    item && typeof item === "object" &&
    String((item as Record<string, unknown>).id || "") === runId
  ) as Record<string, unknown> | undefined;
  return String(run?.status || "") === "grading";
}

function finiteNumbers(value: unknown, limit: number) {
  return (Array.isArray(value) ? value : []).slice(-limit).map(Number).filter(
    Number.isFinite,
  );
}

function percentile(values: number[], ratio: number) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[
    Math.max(
      0,
      Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1),
    )
  ];
}

const paperRuntimeSourcePageCounts: Record<string, number> = {
  "paper-mock-1": 6,
  "paper-mock-3": 4,
  "paper-official-110-trial": 8,
  "paper-official-111": 8,
  "paper-official-112": 8,
  "paper-official-113": 8,
  "paper-official-114": 8,
  "paper-official-115": 8,
  "paper-regional-ra4109": 4,
  "paper-regional-ra4110": 3,
  "paper-regional-ra3101": 3,
  "paper-regional-ra3102": 3,
  "paper-regional-ra1104": 3,
  "paper-regional-ra2100": 3,
  "paper-regional-ra2101": 3,
  "paper-regional-ra1103": 3,
};

const paperCorrectionQuestionPages: Record<string, number[]> = {
  "paper-mock-1": [0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5],
  "paper-mock-3": [0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3],
  "paper-official-110-trial": [
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    3,
    3,
    3,
    4,
    4,
    4,
    5,
    5,
    5,
    5,
    6,
    6,
    6,
  ],
  "paper-official-111": [
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    3,
    3,
    3,
    4,
    4,
    4,
    5,
    5,
    5,
    6,
    6,
    6,
  ],
  "paper-official-112": [
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    3,
    3,
    3,
    4,
    4,
    4,
    5,
    5,
    5,
    5,
    6,
    6,
    6,
  ],
  "paper-official-113": [
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    3,
    3,
    3,
    4,
    4,
    4,
    5,
    5,
    5,
    5,
    6,
    6,
    6,
  ],
  "paper-official-114": [
    1,
    1,
    1,
    2,
    2,
    2,
    3,
    3,
    3,
    4,
    4,
    4,
    5,
    5,
    5,
    6,
    6,
    6,
    6,
    6,
  ],
  "paper-official-115": [
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    3,
    3,
    4,
    4,
    5,
    5,
    5,
    5,
    6,
    6,
    6,
    6,
  ],
  "paper-regional-ra4109": [
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    2,
    2,
    3,
    3,
    3,
  ],
  "paper-regional-ra4110": [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    2,
  ],
  "paper-regional-ra3101": [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    2,
    2,
  ],
  "paper-regional-ra3102": [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
  ],
  "paper-regional-ra1104": [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
  ],
  "paper-regional-ra2100": [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    2,
    2,
  ],
  "paper-regional-ra2101": [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
  ],
  "paper-regional-ra1103": [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
  ],
};

export function paperCorrectionQuestionPage(
  sourceId: string,
  questionNo: number,
) {
  const pages = paperCorrectionQuestionPages[sourceId];
  return Number.isInteger(questionNo) && questionNo >= 1 && pages?.length === 20
    ? pages[questionNo - 1]
    : null;
}

/** Audit artifacts are never learner-readable question-bank objects.  Keep the
 * name exported so the Edge route, browser assertions and offline verifier use
 * one fail-closed authority instead of silently drifting back to
 * `matha-content`. */
export const PAPER_AUDIT_PRIVATE_BUCKET = "matha-audit-private";

/** Server-controlled release identifiers for the exact private scan sets used
 * to compose a paper PDF.  These are deliberately not accepted from the
 * browser.  Any replacement/correction of a scan set must bump its value,
 * which invalidates old PDF content bindings. */
export const PAPER_RUNTIME_SOURCE_ASSET_VERSIONS: Record<string, string> = {
  "paper-mock-1": "private-publisher-paper-mock-1-pages-2-4-20260718-v1",
  "paper-mock-3": "private-scan-set-paper-mock-3-20260717-v1",
  "paper-official-110-trial": "private-scan-set-official-110-trial-20260829-v1",
  "paper-official-111": "private-scan-set-official-111-20260829-v1",
  "paper-official-112": "private-scan-set-official-112-20260829-v1",
  "paper-official-113": "private-scan-set-official-113-20260829-v1",
  "paper-official-114": "private-scan-set-official-114-20260829-v1",
  "paper-official-115": "private-scan-set-official-115-20260829-v1",
  "paper-regional-ra4109": "private-scan-set-regional-ra4109-20260829-v1",
  "paper-regional-ra4110": "private-scan-set-regional-ra4110-20260829-v1",
  "paper-regional-ra3101": "private-scan-set-regional-ra3101-20260829-v1",
  "paper-regional-ra3102": "private-scan-set-regional-ra3102-20260829-v1",
  "paper-regional-ra1104": "private-scan-set-regional-ra1104-20260829-v1",
  "paper-regional-ra2100": "private-scan-set-regional-ra2100-20260829-v1",
  "paper-regional-ra2101": "private-scan-set-regional-ra2101-20260829-v1",
  "paper-regional-ra1103": "private-scan-set-regional-ra1103-20260829-v1",
};

/* Content identities come from the audited private full-paper release, not
 * from a client label or a mutable app_state version.  Official/regional
 * values are canonical digests of the ordered private page SHA-256 list.
 * mock-3 is a canonical binding to the verified publisher PDF bytes and its
 * exact page selection (PDF pages 10–11). */
export const PAPER_RUNTIME_SOURCE_CONTENT_DIGESTS: Record<string, string> = {
  // SHA-256 binding for the audited publisher question PDF
  // db29c53f...50843c3, PDF pages 2-4, rendered as six printed sides.
  "paper-mock-1":
    "693fe4786763c329512c9b85f10ce4cb52dba2b5e307082fd720efed8cf18184",
  "paper-official-115":
    "f6b6935fbda564b8a453d0df99f51a36b8ca42f357ccb4a3bdc4aebaa96f2bd0",
  "paper-official-114":
    "98754d56c69e22e0cd2c12f4afd41cc60ebe318b955bde0ea39b60b63357a7e1",
  "paper-official-113":
    "fa76a5dac6861cd67dbf4376ae7937ded5d2e0c801f1b7e318ea61ab5c4b09ce",
  "paper-official-112":
    "9d0de2ecd64622fd64dea39f67657bd552c6d0da3a5f3c7ca4863cbd540d298f",
  "paper-official-111":
    "67d8533a5890db2b6dd1f5e1c56b4e29cb47b333a640a9b684e58df70f33ea1d",
  "paper-official-110-trial":
    "8ad9546e70e54923aae6cbe7dad160837a028b02df97ec52d3da045daa88a7f3",
  "paper-regional-ra4109":
    "6ec42cf899d3b5bbca40dd91bed94340f3ab3e407fa8c2eb88151c0e7cf5b6a3",
  "paper-regional-ra4110":
    "5d661954ed3353285158c015720fee320554b16b585ef0fb16e6aa28a804425d",
  "paper-regional-ra3101":
    "5c8e502be17b769df891d3b895b74461021f3eea82fe6d3bca95928a27fd4d4e",
  "paper-regional-ra3102":
    "c281069ad30c1ab5b0027c85ed684e44c7067fb9f8293d4c86ad888642a40bb5",
  "paper-regional-ra1104":
    "665edebcac9fa2088ec7ce22c11045089b998d3857f36724894629104212170a",
  "paper-regional-ra2100":
    "1c42de8cf16bddc39e1e748337ad241c3d59c25de2b5ba56b64411c40adee947",
  "paper-regional-ra2101":
    "a236c365be0df6337461f2c1f5f763809dc69ae2051321d1f6ad8cc7b065f11c",
  "paper-regional-ra1103":
    "cb3360dceaaf74bd24c25349ef7cac78c7315b44347d186aa670adfe94bf0c6d",
  "paper-mock-3":
    "d691f75f7cb2da078e4e3bfed3873791514b5e1d43d39016beef323ddbba01ca",
};

export function paperRuntimePageCount(sourceId: string) {
  return paperRuntimeSourcePageCounts[String(sourceId || "")] || 0;
}

export async function inspectPaperPdf(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.length <= 1000) return null;
  const ascii = new TextDecoder("latin1").decode(bytes);
  if (!ascii.startsWith("%PDF-")) return null;
  const tail = ascii.slice(-2048);
  const eofAt = tail.lastIndexOf("%%EOF");
  if (eofAt < 0 || tail.slice(eofAt + 5).trim() !== "") return null;
  const pages = ascii.match(/\/Type\s*\/Page(?!s)\b/g) || [];
  if (!pages.length || pages.length > 8) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  const sha256 = [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return {
    format: "application/pdf",
    magic: "%PDF-",
    eof: "%%EOF",
    sha256,
    bytes: bytes.length,
    pageCount: pages.length,
  };
}

/** Stable JSON used by the tablet and Edge Function to bind an IndexedDB
 * snapshot to the independently read-back ink_sessions row. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite canonical number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map((key) =>
      JSON.stringify(key) + ":" + canonicalJson(record[key])
    ).join(",") + "}";
  }
  throw new Error("unsupported canonical JSON value");
}

export async function canonicalSha256(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/* Capability evidence is rebuilt from the authenticated owner's app_state on
 * the server.  The browser export is useful for inspection, but it is never
 * the authority for the six-paper / latest-three gates.  Keep this allowlist
 * deliberately narrow: adding a new formal paper requires an explicit server
 * release instead of trusting a client supplied source id. */
export const CAPABILITY_FRESH_SOURCE_IDS = new Set([
  "paper-regional-ra4109",
  "paper-regional-ra4110",
  "paper-regional-ra3101",
  "paper-regional-ra3102",
  "paper-regional-ra1104",
  "paper-regional-ra2100",
  "paper-regional-ra2101",
  "paper-regional-ra1103",
  "paper-official-115",
  "paper-official-114",
  "paper-official-113",
  "paper-official-112",
  "paper-official-111",
  "paper-official-110-trial",
  "paper-mock-3",
]);

// Grading support is intentionally broader than capability evidence.  The
// historical practice paper can receive a private receipt/visual attestation,
// while every capability path continues to require CAPABILITY_FRESH_SOURCE_IDS.
export const PAPER_GRADE_SOURCE_IDS = new Set([
  ...CAPABILITY_FRESH_SOURCE_IDS,
  "paper-mock-1",
]);

export function paperGradeSourcePolicy(sourceId: string) {
  if (!PAPER_GRADE_SOURCE_IDS.has(sourceId)) return null;
  const calibrationEligible = CAPABILITY_FRESH_SOURCE_IDS.has(sourceId);
  return {
    sourceId,
    calibrationEligible,
    freshnessRequired: calibrationEligible,
    pageCount: paperRuntimePageCount(sourceId),
    sourceAssetVersion: PAPER_RUNTIME_SOURCE_ASSET_VERSIONS[sourceId] || "",
    sourceContentDigest: PAPER_RUNTIME_SOURCE_CONTENT_DIGESTS[sourceId] || "",
  };
}

const capabilityRunDigestFields = [
  "runId",
  "sourceId",
  "submittedAt",
  "gradedAt",
  "score",
  "total",
  "freshnessConfirmedAt",
  "appVersion",
  "sourceContentDigest",
  "submitAttemptDigest",
  "gradeReceiptDigest",
  "submissionContentBindingSha256",
  "modelInputBindingSha256",
  "ownerVisualAttestationDigest",
  "gradeSummary",
] as const;

const capabilityGoal = {
  requiredRuns: 3,
  distinctRuns: true,
  distinctSources: true,
  questionsPerRun: 20,
  minutesPerRun: 100,
  totalPoints: 100,
  minimumScore: 72,
};

function capabilityGradeLabel(scorePercent: number) {
  if (scorePercent >= 84) return "15 級分";
  if (scorePercent >= 78) return "14 級分";
  if (scorePercent >= 72) return "13 級分";
  if (scorePercent >= 66) return "12 級分";
  if (scorePercent >= 60) return "11 級分";
  if (scorePercent >= 54) return "10 級分";
  if (scorePercent >= 48) return "9 級分";
  return "8 級分以下";
}

function capabilityGradeSummary(rawGrade: unknown) {
  const grade = rawGrade && typeof rawGrade === "object" &&
      !Array.isArray(rawGrade)
    ? rawGrade as Record<string, unknown>
    : {};
  const source = Array.isArray(grade.questions) ? grade.questions : [];
  if (source.length !== 20) return null;
  const allowed = new Set([
    "correct",
    "incorrect",
    "uncertain",
    "unanswered",
  ]);
  const seen = new Set<number>();
  const questions: Array<Record<string, unknown>> = [];
  for (const rawItem of source) {
    const item = rawItem && typeof rawItem === "object" &&
        !Array.isArray(rawItem)
      ? rawItem as Record<string, unknown>
      : {};
    const no = Number(item.no);
    const status = String(item.status || "");
    const points = Number(item.points);
    const maxPoints = Number(item.maxPoints);
    if (
      !Number.isInteger(no) || no < 1 || no > 20 || seen.has(no) ||
      !allowed.has(status) || !Number.isFinite(points) ||
      !Number.isFinite(maxPoints) || maxPoints <= 0 || points < 0 ||
      points > maxPoints ||
      (["unanswered", "uncertain"].includes(status) && points !== 0) ||
      (status === "correct" && points !== maxPoints)
    ) return null;
    seen.add(no);
    questions.push({ no, status, points, maxPoints });
  }
  questions.sort((a, b) => Number(a.no) - Number(b.no));
  if (questions.some((item, index) => item.no !== index + 1)) return null;
  const rounded = (value: number) => Math.round(value * 100) / 100;
  const awardedPoints = rounded(questions.reduce(
    (sum, item) => sum + Number(item.points),
    0,
  ));
  const maxPoints = rounded(questions.reduce(
    (sum, item) => sum + Number(item.maxPoints),
    0,
  ));
  const score = rounded(Number(grade.score));
  if (maxPoints !== 100 || awardedPoints !== score) return null;
  const statusCounts: Record<string, number> = {
    correct: 0,
    incorrect: 0,
    uncertain: 0,
    unanswered: 0,
  };
  questions.forEach((item) => statusCounts[String(item.status)]++);
  return {
    questionCount: 20,
    awardedPoints,
    maxPoints,
    statusCounts,
    questions,
  };
}

/** The model may locate handwriting, but the server owns the arithmetic.  This
 * summary is derived from the server-only official answer key and is the only
 * score shape that may be placed in a grade receipt. */
export function paperGradeServerSummary(
  rawGrade: unknown,
  answerKey: PaperAnswerKeyItem[],
) {
  const grade = rawGrade && typeof rawGrade === "object" &&
      !Array.isArray(rawGrade)
    ? rawGrade as Record<string, unknown>
    : {};
  const rawQuestions = Array.isArray(grade.questions) ? grade.questions : [];
  if (answerKey.length !== 20 || rawQuestions.length !== 20) return null;
  const byNo = new Map<number, Record<string, unknown>>();
  for (const rawItem of rawQuestions) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      return null;
    }
    const item = rawItem as Record<string, unknown>;
    const no = Number(item.no);
    if (!Number.isInteger(no) || no < 1 || no > 20 || byNo.has(no)) {
      return null;
    }
    byNo.set(no, item);
  }
  const rounded = (value: number) => Math.round(value * 100) / 100;
  const questions = answerKey.map((key, index) => {
    const no = index + 1;
    const item = byNo.get(no);
    if (!item) return null;
    const allowed = new Set([
      "correct",
      "incorrect",
      "unanswered",
      "uncertain",
    ]);
    let status = allowed.has(String(item.status || ""))
      ? String(item.status)
      : "uncertain";
    const selected = Array.isArray(item.selectedOptions)
      ? [
        ...new Set(
          item.selectedOptions.map(Number).filter((option) =>
            Number.isInteger(option) && option >= 1 && option <= 5
          ),
        ),
      ].sort((a, b) => a - b)
      : [];
    const finalAnswer = typeof item.finalAnswer === "string"
      ? item.finalAnswer.trim()
      : "";
    const hasConcreteAnswer = key.type === "single" || key.type === "multi"
      ? selected.length > 0
      : finalAnswer.length > 0;
    const explicitlyUnanswered = item.hasFinalAnswer === false ||
      (status === "unanswered" && !hasConcreteAnswer);
    let points = 0;
    if (status === "uncertain") {
      points = 0;
    } else if (explicitlyUnanswered) {
      status = "unanswered";
    } else if (key.type === "single") {
      const accepted = key.ans.map(Number).map((option) => option + 1);
      if (selected.length !== 1) {
        status = selected.length ? "incorrect" : "uncertain";
      } else {
        status = accepted.includes(selected[0]) ? "correct" : "incorrect";
        points = status === "correct" ? key.points : 0;
      }
    } else if (key.type === "multi") {
      if (!selected.length) {
        status = "unanswered";
      } else {
        const accepted = new Set(
          key.ans.map(Number).map((option) => option + 1),
        );
        const chosen = new Set(selected);
        let differences = 0;
        for (let option = 1; option <= 5; option++) {
          if (accepted.has(option) !== chosen.has(option)) differences++;
        }
        points = differences === 0
          ? key.points
          : differences === 1
          ? key.points * 0.6
          : differences === 2
          ? key.points * 0.2
          : 0;
        points = rounded(points);
        status = points === key.points ? "correct" : "incorrect";
      }
    } else if (!finalAnswer) {
      status = status === "unanswered" ? "unanswered" : "uncertain";
    } else if (key.type === "fill") {
      // Symbolic equivalence is a vision/grading judgement.  The server does
      // not invent a second parser here; it only clamps the structured verdict
      // to the official maximum and freezes that verdict in the receipt.
      status = status === "correct"
        ? "correct"
        : status === "incorrect"
        ? "incorrect"
        : "uncertain";
      points = status === "correct" ? key.points : 0;
    } else {
      points = rounded(Math.max(
        0,
        Math.min(key.points, Number(item.points) || 0),
      ));
      status = points === key.points ? "correct" : "incorrect";
    }
    points = rounded(Math.max(0, Math.min(key.points, points)));
    return { no, status, points, maxPoints: key.points };
  });
  if (questions.some((item) => !item)) return null;
  const normalized = questions as Array<Record<string, unknown>>;
  const awardedPoints = rounded(normalized.reduce(
    (sum, item) => sum + Number(item.points),
    0,
  ));
  const maxPoints = rounded(normalized.reduce(
    (sum, item) => sum + Number(item.maxPoints),
    0,
  ));
  if (maxPoints !== 100) return null;
  const statusCounts: Record<string, number> = {
    correct: 0,
    incorrect: 0,
    uncertain: 0,
    unanswered: 0,
  };
  normalized.forEach((item) => statusCounts[String(item.status)]++);
  return {
    questionCount: 20,
    awardedPoints,
    maxPoints,
    statusCounts,
    questions: normalized,
  };
}

async function capabilityCandidate(
  rawRun: unknown,
  extMocks: unknown[],
  baseline: number,
  appVersion: string,
  verifiedGradeReceipts: unknown[],
  verifiedVisualAttestations: unknown[],
) {
  const run = rawRun && typeof rawRun === "object" && !Array.isArray(rawRun)
    ? rawRun as Record<string, unknown>
    : {};
  const runId = String(run.id || "");
  const sourceId = String(run.sourceId || "");
  if (
    !/^[A-Za-z0-9._:-]{1,160}$/.test(runId) ||
    !CAPABILITY_FRESH_SOURCE_IDS.has(sourceId) ||
    !["awaiting-key", "awaiting-correction", "completed"].includes(
      String(run.status || ""),
    ) || run.calibrationEligible !== true
  ) return null;
  const matches = extMocks.filter((rawRecord) => {
    const record = rawRecord && typeof rawRecord === "object" &&
        !Array.isArray(rawRecord)
      ? rawRecord as Record<string, unknown>
      : {};
    return record.paperRunId === runId && record.sourceId === sourceId;
  });
  if (matches.length !== 1) return null;
  const record = matches[0] as Record<string, unknown>;
  const grade = run.aiGrade && typeof run.aiGrade === "object" &&
      !Array.isArray(run.aiGrade)
    ? run.aiGrade as Record<string, unknown>
    : {};
  const receiptMatches =
    (Array.isArray(verifiedGradeReceipts) ? verifiedGradeReceipts : []).filter(
      (rawReceipt) => {
        const envelope = rawReceipt && typeof rawReceipt === "object" &&
            !Array.isArray(rawReceipt)
          ? rawReceipt as Record<string, unknown>
          : {};
        const receipt = envelope.receipt && typeof envelope.receipt === "object"
          ? envelope.receipt as Record<string, unknown>
          : {};
        return receipt.runId === runId && receipt.sourceId === sourceId;
      },
    );
  if (receiptMatches.length !== 1) return null;
  const verifiedReceipt = await verifyPaperGradeReceiptReadback(
    receiptMatches[0],
  );
  if (!verifiedReceipt) return null;
  const receipt = verifiedReceipt.receipt as Record<string, unknown>;
  const receiptReadback = verifiedReceipt.privateReadback as Record<
    string,
    unknown
  >;
  const receiptMetadata = run.serverGradeReceipt &&
      typeof run.serverGradeReceipt === "object" &&
      !Array.isArray(run.serverGradeReceipt)
    ? run.serverGradeReceipt as Record<string, unknown>
    : grade.serverGradeReceipt &&
        typeof grade.serverGradeReceipt === "object" &&
        !Array.isArray(grade.serverGradeReceipt)
    ? grade.serverGradeReceipt as Record<string, unknown>
    : {};
  const visualMatches =
    (Array.isArray(verifiedVisualAttestations)
      ? verifiedVisualAttestations
      : []).filter((rawAttestation) => {
        const envelope = rawAttestation && typeof rawAttestation === "object" &&
            !Array.isArray(rawAttestation)
          ? rawAttestation as Record<string, unknown>
          : {};
        const attestation = envelope.attestation &&
            typeof envelope.attestation === "object"
          ? envelope.attestation as Record<string, unknown>
          : {};
        return attestation.runId === runId && attestation.sourceId === sourceId;
      });
  if (visualMatches.length !== 1) return null;
  const verifiedVisual = await verifyPaperGradeVisualAttestationReadback(
    visualMatches[0],
  );
  if (!verifiedVisual) return null;
  const visual = verifiedVisual.attestation as Record<string, unknown>;
  const visualReadback = verifiedVisual.privateReadback as Record<
    string,
    unknown
  >;
  const visualMetadata = run.gradeInputVisualAttestation &&
      typeof run.gradeInputVisualAttestation === "object" &&
      !Array.isArray(run.gradeInputVisualAttestation)
    ? run.gradeInputVisualAttestation as Record<string, unknown>
    : grade.gradeInputVisualAttestation &&
        typeof grade.gradeInputVisualAttestation === "object" &&
        !Array.isArray(grade.gradeInputVisualAttestation)
    ? grade.gradeInputVisualAttestation as Record<string, unknown>
    : {};
  const submittedAt = Number(run.submittedAt);
  const gradedAt = Number(receipt.gradedAt);
  const freshnessConfirmedAt = Number(run.freshnessConfirmedAt);
  const receiptSummary = receipt.gradeSummary as Record<string, unknown>;
  const submitAttempt = receipt.submitAttempt as Record<string, unknown>;
  const runSubmitAttempt = run.submitAttempt &&
      typeof run.submitAttempt === "object" &&
      !Array.isArray(run.submitAttempt)
    ? run.submitAttempt as Record<string, unknown>
    : {};
  const score = Math.round(Number(receiptSummary.awardedPoints) * 100) / 100;
  if (
    !Number.isFinite(submittedAt) || submittedAt <= 0 ||
    !Number.isFinite(gradedAt) || gradedAt < submittedAt ||
    !Number.isFinite(freshnessConfirmedAt) || freshnessConfirmedAt <= 0 ||
    freshnessConfirmedAt > submittedAt ||
    (baseline > 0 &&
      (submittedAt < baseline || freshnessConfirmedAt < baseline)) ||
    record.calibrationEligible !== true || Number(record.questions) !== 20 ||
    Number(record.total) !== 100 || Number(record.ts) !== submittedAt ||
    Number(record.freshnessConfirmedAt) !== freshnessConfirmedAt ||
    !Number.isFinite(score) || score < 0 || score > 100 ||
    Number(run.score) !== score || Number(record.score) !== score ||
    Number(grade.score) !== score || Number(grade.gradedAt) !== gradedAt ||
    Number(run.createdAt) !== Number(receipt.runCreatedAt) ||
    String(run.runCreatedAppVersion || "") !==
      String(receipt.runCreatedAppVersion || "") ||
    String(receipt.runCreatedAppVersion || "") !== appVersion ||
    String(receipt.sourceContentDigest || "") !==
      PAPER_RUNTIME_SOURCE_CONTENT_DIGESTS[sourceId] ||
    String(runSubmitAttempt.attemptId || "") !==
      String(submitAttempt.attemptId || "") ||
    String(runSubmitAttempt.status || "") !== "accepted" ||
    String(runSubmitAttempt.decisionReason || "") !==
      "accepted-first-for-run" ||
    String(runSubmitAttempt.inkSnapshotSha256 || "") !==
      String(submitAttempt.inkSnapshotSha256 || "") ||
    Number(runSubmitAttempt.submittedAt) !==
      Number(submitAttempt.submittedAt) ||
    String(runSubmitAttempt.runCreatedAppVersion || "") !==
      String(submitAttempt.runCreatedAppVersion || "") ||
    submittedAt !== Number(receipt.submittedAt) ||
    freshnessConfirmedAt !== Number(receipt.freshnessConfirmedAt) ||
    receiptMetadata.authority !==
      "supabase-service-role-storage-readback" ||
    receiptMetadata.bucket !== receiptReadback.bucket ||
    receiptMetadata.path !== receiptReadback.path ||
    receiptMetadata.sha256 !== receiptReadback.sha256 ||
    receiptMetadata.canonicalDigest !== receipt.canonicalDigest ||
    visual.gradeReceiptDigest !== receipt.canonicalDigest ||
    visual.submitAttemptDigest !== submitAttempt.canonicalDigest ||
    visual.submitAttemptId !== submitAttempt.attemptId ||
    visual.modelInputBindingSha256 !==
      (receipt.modelInputBinding as Record<string, unknown>).canonicalDigest ||
    visual.submissionContentBindingSha256 !==
      receipt.submissionContentBindingSha256 ||
    visual.serverInkSnapshotSha256 !==
      await canonicalSha256(receipt.serverInkPages) ||
    await canonicalSha256(visual.images) !== await canonicalSha256(
        ((receipt.modelInputBinding as Record<string, unknown>)
          .imageOrder as Array<Record<string, unknown>>).map((image) => ({
            page: image.page,
            mediaType: image.mediaType,
            sha256: image.sha256,
          })),
      ) ||
    visualMetadata.authority !== "supabase-service-role-storage-readback" ||
    visualMetadata.bucket !== visualReadback.bucket ||
    visualMetadata.path !== visualReadback.path ||
    visualMetadata.sha256 !== visualReadback.sha256 ||
    visualMetadata.canonicalDigest !== visual.canonicalDigest
  ) return null;
  const gradeSummary = capabilityGradeSummary(grade);
  if (
    !gradeSummary || gradeSummary.awardedPoints !== score ||
    await canonicalSha256(gradeSummary) !==
      await canonicalSha256(receiptSummary)
  ) return null;
  const row: Record<string, unknown> = {
    runId,
    sourceId,
    submittedAt,
    gradedAt,
    score,
    total: 100,
    freshnessConfirmedAt,
    appVersion: String(receipt.runCreatedAppVersion),
    sourceContentDigest: String(receipt.sourceContentDigest),
    submitAttemptDigest: String(submitAttempt.canonicalDigest),
    gradeReceiptDigest: String(receipt.canonicalDigest),
    submissionContentBindingSha256: String(
      receipt.submissionContentBindingSha256,
    ),
    modelInputBindingSha256: String(
      (receipt.modelInputBinding as Record<string, unknown>).canonicalDigest,
    ),
    ownerVisualAttestationDigest: String(visual.canonicalDigest),
    gradeSummary,
  };
  row.canonicalDigest = await canonicalSha256(row);
  return row;
}

/** Rebuild the only server-authoritative capability core.  `runs` is never an
 * independent client list: it is exactly the chronological tail of
 * `freshRuns`, so six-paper completion and latest-three scores cannot drift. */
export async function capabilityGoalServerEvidence(
  data: Record<string, unknown> | undefined,
  appVersion: string,
  generatedAt = Date.now(),
  verifiedGradeReceipts: unknown[] = [],
  verifiedVisualAttestations: unknown[] = [],
) {
  if (!/^\d{4}[a-z]$/.test(appVersion) || !Number.isFinite(generatedAt)) {
    return null;
  }
  const baseline = Math.max(0, Number(data?.learningBaselineResetAt) || 0);
  const rawRuns = Array.isArray(data?.paperRuns)
    ? data?.paperRuns as unknown[]
    : [];
  const extMocks = Array.isArray(data?.extMocks)
    ? data?.extMocks as unknown[]
    : [];
  const candidates = (await Promise.all(
    rawRuns.map((run) =>
      capabilityCandidate(
        run,
        extMocks,
        baseline,
        appVersion,
        verifiedGradeReceipts,
        verifiedVisualAttestations,
      )
    ),
  )).filter((row): row is Record<string, unknown> => !!row).sort((a, b) =>
    Number(b.submittedAt) - Number(a.submittedAt) ||
    Number(b.gradedAt) - Number(a.gradedAt) ||
    String(b.runId).localeCompare(String(a.runId))
  );
  const selected: Array<Record<string, unknown>> = [];
  const runIds = new Set<string>(), sourceIds = new Set<string>();
  const sourceContentDigests = new Set<string>();
  for (const row of candidates) {
    const runId = String(row.runId), sourceId = String(row.sourceId);
    const sourceContentDigest = String(row.sourceContentDigest || "");
    if (
      runIds.has(runId) || sourceIds.has(sourceId) ||
      sourceContentDigests.has(sourceContentDigest)
    ) continue;
    runIds.add(runId);
    sourceIds.add(sourceId);
    sourceContentDigests.add(sourceContentDigest);
    selected.push(row);
    if (selected.length === 6) break;
  }
  const freshRuns = selected.sort((a, b) =>
    Number(a.submittedAt) - Number(b.submittedAt) ||
    Number(a.gradedAt) - Number(b.gradedAt) ||
    String(a.runId).localeCompare(String(b.runId))
  );
  const runs = freshRuns.slice(-3);
  const passes = runs.filter((row) => Number(row.score) >= 72).length;
  const latestSubmittedAt = runs.length
    ? Math.max(...runs.map((row) => Number(row.submittedAt)))
    : 0;
  const timeWindowValid = runs.length === 3 &&
    runs.every((row) =>
      Number(row.submittedAt) <= generatedAt &&
      Number(row.gradedAt) <= generatedAt &&
      Number(row.freshnessConfirmedAt) <= generatedAt &&
      generatedAt - Number(row.submittedAt) <= 180 * 86_400_000
    ) && generatedAt - latestSubmittedAt <= 90 * 86_400_000;
  const stable = freshRuns.length === 6 && runs.length === 3 && passes === 3 &&
    timeWindowValid;
  const blockers: string[] = [];
  if (freshRuns.length !== 6) {
    blockers.push(`eligible-distinct-fresh-runs:${freshRuns.length}/6`);
  }
  if (runs.length !== 3 || passes !== 3) {
    blockers.push("latest-three-one-or-more-below-72");
  }
  if (runs.length === 3 && !timeWindowValid) {
    blockers.push("latest-three-too-old-or-future");
  }
  const scorePercent = runs.length
    ? Math.round(
      runs.reduce((sum, row) => sum + Number(row.score), 0) /
        runs.length * 100,
    ) / 100
    : null;
  const payload: Record<string, unknown> = {
    kind: "matha-capability-goal-evidence-v2",
    schemaVersion: 2,
    generatedAt: new Date(generatedAt).toISOString(),
    appVersion,
    baselineResetAt: baseline,
    status: stable ? "stable" : "blocked",
    stable,
    blockers,
    goal: capabilityGoal,
    calibration: {
      source: "external",
      count: runs.length,
      passes,
      stable: runs.length === 3 && passes === 3,
      scorePercent,
      grade: scorePercent == null ? "" : capabilityGradeLabel(scorePercent),
    },
    freshCalibration: {
      requiredRuns: 6,
      count: freshRuns.length,
      complete: freshRuns.length === 6,
      distinctRuns: true,
      distinctSources: true,
      questionsPerRun: 20,
      minutesPerRun: 100,
      totalPoints: 100,
    },
    digest: {
      algorithm: "SHA-256",
      canonicalization: "recursive-key-sorted-json-v1",
      runDigestFields: [...capabilityRunDigestFields],
    },
    runs,
    freshRuns,
  };
  payload.canonicalDigest = await canonicalSha256(payload);
  return payload;
}

type PaperInkReference = {
  page: number;
  qid: string;
  clientId: string;
  localSha256: string;
  cloudSha256: string;
};

export type PaperPdfContentBinding = {
  schemaVersion: number;
  runId: string;
  sourceId: string;
  sourceAssetVersion: string;
  paperLayoutVersion: number;
  appVersion: string;
  submittedAt: number;
  gradeKind: string;
  gradeBindingSha256: string | null;
  submitDurability: Record<string, unknown>;
  contentBindingSha256: string;
};

function paperRuntimeRun(
  data: Record<string, unknown> | undefined,
  runId: string,
) {
  const rawRuns = data?.paperRuns;
  const runs: unknown[] = Array.isArray(rawRuns) ? rawRuns : [];
  return runs.find((item) =>
    item && typeof item === "object" &&
    String((item as Record<string, unknown>).id || "") === runId
  ) as Record<string, unknown> | undefined;
}

export function paperPdfStoreGate(
  data: Record<string, unknown> | undefined,
  runId: string,
  kind: string,
) {
  if (!/^paper-run-\d{10,20}$/.test(runId)) return null;
  if (!["graded", "answer"].includes(kind)) return null;
  const run = paperRuntimeRun(data, runId);
  if (!run) return null;
  const sourceId = String(run.sourceId || "");
  const pageCount = paperRuntimePageCount(sourceId);
  if (
    !pageCount || Number(run.submittedAt) <= 0 ||
    !["grading", "awaiting-correction", "completed"].includes(
      String(run.status || ""),
    ) ||
    (kind === "graded" &&
      (!run.aiGrade || typeof run.aiGrade !== "object"))
  ) return null;
  return { run, sourceId, pageCount, kind };
}

export async function paperRuntimeAuditPdfReference(
  data: Record<string, unknown> | undefined,
  runId: string,
  userHash: string,
) {
  if (!/^matha_[a-f0-9]{32}$/.test(userHash)) return null;
  const gate = paperPdfStoreGate(data, runId, "answer") ||
    paperPdfStoreGate(data, runId, "graded");
  const run = paperRuntimeRun(data, runId);
  if (!gate || !run) return null;
  const audit = run.runtimeAudit && typeof run.runtimeAudit === "object"
    ? run.runtimeAudit as Record<string, unknown>
    : {};
  const raw = audit.pdfArtifact && typeof audit.pdfArtifact === "object"
    ? audit.pdfArtifact as Record<string, unknown>
    : {};
  const kind = String(raw.kind || "");
  if (!["graded", "answer"].includes(kind)) return null;
  if (!paperPdfStoreGate(data, runId, kind)) return null;
  const binding = await paperPdfContentBinding(data, runId, kind);
  if (!binding) return null;
  const sha256 = String(raw.sha256 || "").toLowerCase();
  const contentBindingSha256 = String(
    raw.contentBindingSha256 || "",
  ).toLowerCase();
  const path = String(raw.path || "").replace(/\\/g, "/");
  const expectedPath = "runtime-audits/" + userHash + "/pdf/" + runId + "/" +
    kind + "-" + contentBindingSha256 + "-" + sha256 + ".pdf";
  if (
    raw.storageVerified !== true ||
    raw.bucket !== PAPER_AUDIT_PRIVATE_BUCKET ||
    raw.format !== "application/pdf" || raw.magic !== "%PDF-" ||
    raw.eof !== "%%EOF" || !/^[a-f0-9]{64}$/.test(sha256) ||
    !/^[a-f0-9]{64}$/.test(contentBindingSha256) ||
    contentBindingSha256 !== binding.contentBindingSha256 ||
    Number(raw.contentBindingVersion) !== binding.schemaVersion ||
    String(raw.sourceAssetVersion || "") !== binding.sourceAssetVersion ||
    String(raw.gradeBindingSha256 || "") !==
      String(binding.gradeBindingSha256 || "") ||
    path !== expectedPath || Number(raw.bytes) <= 1000 ||
    Number(raw.bytes) > 14_000_000 ||
    Number(raw.pageCount) !== gate.pageCount ||
    !Number.isFinite(Date.parse(String(raw.serverVerifiedAt || "")))
  ) return null;
  return {
    bucket: PAPER_AUDIT_PRIVATE_BUCKET,
    path,
    sha256,
    bytes: Number(raw.bytes),
    pageCount: Number(raw.pageCount),
    kind,
    format: "application/pdf",
    magic: "%PDF-",
    eof: "%%EOF",
    contentBindingVersion: Number(binding.schemaVersion),
    contentBindingSha256,
    sourceAssetVersion: String(binding.sourceAssetVersion),
    gradeBindingSha256: binding.gradeBindingSha256,
    serverVerifiedAt: String(raw.serverVerifiedAt),
  };
}

/** Return only safe, exact row references suitable for service-role queries.
 * This is deliberately not a pass decision; returned rows are revalidated. */
export function paperRuntimeAuditInkReferences(
  data: Record<string, unknown> | undefined,
  runId: string,
) {
  if (!/^paper-run-\d{10,20}$/.test(runId)) return null;
  const run = paperRuntimeRun(data, runId);
  if (!run) return null;
  const sourceId = String(run.sourceId || "");
  const expectedPages = paperRuntimeSourcePageCounts[sourceId];
  const layoutVersion = Number(run.paperLayoutVersion);
  const audit = run.runtimeAudit && typeof run.runtimeAudit === "object"
    ? run.runtimeAudit as Record<string, unknown>
    : undefined;
  const durability = audit?.submitDurability &&
      typeof audit.submitDurability === "object"
    ? audit.submitDurability as Record<string, unknown>
    : undefined;
  const rawPages = Array.isArray(durability?.pages) ? durability.pages : [];
  if (
    !expectedPages || layoutVersion !== 2 ||
    Number(audit?.schema) !== 2 || rawPages.length !== expectedPages
  ) return null;
  const references: PaperInkReference[] = [];
  const seen = new Set<number>();
  for (const item of rawPages) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const page = Number(row.page);
    const qid = String(row.qid || "");
    const clientId = String(row.clientId || "");
    const localSha256 = String(row.localSha256 || "").toLowerCase();
    const cloudSha256 = String(row.cloudSha256 || "").toLowerCase();
    if (
      !Number.isInteger(page) || page < 0 || page >= expectedPages ||
      seen.has(page) ||
      qid !== "paper:" + runId + ":v" + layoutVersion + ":" + page ||
      !/^[A-Za-z0-9_.-]{8,220}$/.test(clientId) ||
      !clientId.startsWith("ink-paper-" + runId + "-" + page + "-") ||
      row.matched !== true ||
      !/^[a-f0-9]{64}$/.test(localSha256) ||
      !/^[a-f0-9]{64}$/.test(cloudSha256)
    ) return null;
    seen.add(page);
    references.push({ page, qid, clientId, localSha256, cloudSha256 });
  }
  references.sort((a, b) => a.page - b.page);
  return { run, sourceId, expectedPages, layoutVersion, references };
}

/** Build the server authority that a stored PDF is expected to represent.
 * This is an integrity/provenance binding, not a pixel comparison: the server
 * cannot reconstruct the browser-composited PDF.  A separate owner visual-QA
 * receipt is therefore still mandatory before an audit can pass. */
export async function paperPdfContentBinding(
  data: Record<string, unknown> | undefined,
  runId: string,
  kind: string,
): Promise<PaperPdfContentBinding | null> {
  const gate = paperPdfStoreGate(data, runId, kind);
  const refs = paperRuntimeAuditInkReferences(data, runId);
  if (!gate || !refs || gate.sourceId !== refs.sourceId) return null;
  const run = gate.run;
  const audit = run.runtimeAudit && typeof run.runtimeAudit === "object" &&
      !Array.isArray(run.runtimeAudit)
    ? run.runtimeAudit as Record<string, unknown>
    : {};
  const durability = audit.submitDurability &&
      typeof audit.submitDurability === "object" &&
      !Array.isArray(audit.submitDurability)
    ? audit.submitDurability as Record<string, unknown>
    : {};
  const sourceAssetVersion =
    PAPER_RUNTIME_SOURCE_ASSET_VERSIONS[gate.sourceId] || "";
  const submittedAt = Number(run.submittedAt);
  const auditSubmittedAt = Number(audit.submittedAt);
  const readbackVerifiedAt = Number(durability.readbackVerifiedAt);
  if (
    !sourceAssetVersion || Number(audit.schema) !== 2 ||
    String(audit.runId || "") !== runId ||
    String(audit.sourceId || "") !== gate.sourceId ||
    !/^\d{4}[a-z]$/.test(String(audit.appVersion || "")) ||
    !Number.isFinite(submittedAt) || submittedAt <= 0 ||
    auditSubmittedAt !== submittedAt ||
    durability.journalDrained !== true ||
    durability.allPagesPersisted !== true ||
    durability.cloudFlushed !== true ||
    durability.revisionsUnchanged !== true ||
    Number(durability.pendingAtSubmit) !== 0 ||
    Number(audit.pendingAtSubmit) !== 0 ||
    Number(durability.expectedPages) !== refs.expectedPages ||
    Number(durability.verifiedPages) !== refs.expectedPages ||
    !Number.isFinite(readbackVerifiedAt) || readbackVerifiedAt < submittedAt
  ) return null;

  const pages = refs.references.map((ref) => ({
    page: ref.page,
    qid: ref.qid,
    clientId: ref.clientId,
    cloudSha256: ref.cloudSha256,
  }));
  if (
    pages.length !== refs.expectedPages ||
    refs.references.some((ref) => ref.localSha256 !== ref.cloudSha256)
  ) return null;

  let gradeBindingSha256: string | null = null;
  if (kind === "graded") {
    const grade = run.aiGrade && typeof run.aiGrade === "object" &&
        !Array.isArray(run.aiGrade)
      ? run.aiGrade as Record<string, unknown>
      : {};
    const gradeSummary = capabilityGradeSummary(grade);
    const gradedAt = Number(grade.gradedAt);
    if (!gradeSummary || !Number.isFinite(gradedAt) || gradedAt < submittedAt) {
      return null;
    }
    gradeBindingSha256 = await canonicalSha256({
      kind: "graded",
      model: String(grade.model || "").slice(0, 80),
      requestId: String(grade.requestId || "").slice(0, 180),
      promptVersion: String(grade.promptVersion || "").slice(0, 80),
      gradedAt,
      score: Number(gradeSummary.awardedPoints),
      gradeSummary,
    });
  }

  const core = {
    schemaVersion: 1,
    runId,
    sourceId: gate.sourceId,
    sourceAssetVersion,
    paperLayoutVersion: refs.layoutVersion,
    appVersion: String(audit.appVersion),
    submittedAt,
    gradeKind: kind,
    gradeBindingSha256,
    submitDurability: {
      journalDrained: true,
      allPagesPersisted: true,
      cloudFlushed: true,
      revisionsUnchanged: true,
      pendingAtSubmit: 0,
      readbackVerifiedAt,
      expectedPages: refs.expectedPages,
      verifiedPages: refs.expectedPages,
      pages,
    },
  };
  return {
    ...core,
    contentBindingSha256: await canonicalSha256(core),
  } as PaperPdfContentBinding;
}

export type PaperGradeReceipt = {
  kind: string;
  schemaVersion: number;
  authority: string;
  runId: string;
  sourceId: string;
  sourceAssetVersion: string;
  sourceContentDigest: string;
  paperLayoutVersion: number;
  runCreatedAt: number;
  runCreatedAppVersion: string;
  submittedAt: number;
  freshnessConfirmedAt: number | null;
  calibrationEligible: boolean;
  submitAttempt: Record<string, unknown>;
  submissionContentBindingSha256: string;
  serverInkPages: Array<Record<string, unknown>>;
  modelInputBinding: Record<string, unknown>;
  gradeGeneration: number;
  gradedAt: number;
  requestId: string;
  model: string;
  rawGradeSha256: string;
  gradeSummary: Record<string, unknown>;
  canonicalDigest: string;
};

/** Normalize the immutable database decision used to authorize grading.
 * The Edge function may only pass a row read with the service role from
 * `paper_submit_attempts`; a browser-owned app_state copy is not an authority.
 */
export async function paperGradeAcceptedSubmitAttempt(raw: unknown) {
  const row = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const attemptId = String(row.attempt_id ?? row.attemptId ?? "");
  const runId = String(row.run_id ?? row.runId ?? "");
  const sourceId = String(row.source_id ?? row.sourceId ?? "");
  const remainingMs = Number(row.remaining_ms ?? row.remainingMs);
  const inkSnapshotSha256 = String(
    row.ink_snapshot_sha256 ?? row.inkSnapshotSha256 ?? "",
  ).toLowerCase();
  const submittedAt = Number(row.submitted_at ?? row.submittedAt);
  const acceptedAtValue = row.accepted_at ?? row.acceptedAt;
  const acceptedAtMs = Date.parse(String(acceptedAtValue || ""));
  const runCreatedAppVersion = String(
    row.run_created_app_version ?? row.runCreatedAppVersion ?? "",
  );
  const runCreatedAt = Number(row.run_created_at ?? row.runCreatedAt);
  const paperLayoutVersion = Number(
    row.paper_layout_version ?? row.paperLayoutVersion,
  );
  const sourcePageCount = Number(row.source_page_count ?? row.sourcePageCount);
  const rawFreshnessConfirmedAt = row.freshness_confirmed_at ??
    row.freshnessConfirmedAt;
  const freshnessConfirmedAt = rawFreshnessConfirmedAt == null
    ? null
    : Number(rawFreshnessConfirmedAt);
  const sourcePolicy = paperGradeSourcePolicy(sourceId);
  const status = String(row.status || "");
  const decisionReason = String(
    row.decision_reason ?? row.decisionReason ?? "",
  );
  const canceledAt = row.canceled_at ?? row.canceledAt;
  const winnerAttemptId = row.winner_attempt_id ?? row.winnerAttemptId;
  const rawPageManifest = row.page_manifest ?? row.pageManifest;
  const pageManifest = (Array.isArray(rawPageManifest) ? rawPageManifest : [])
    .map((rawPage) => {
      const page = rawPage && typeof rawPage === "object" &&
          !Array.isArray(rawPage)
        ? rawPage as Record<string, unknown>
        : {};
      const updatedAtMs = Date.parse(String(
        page.updatedAt ?? page.updated_at ?? "",
      ));
      return {
        page: Number(page.page),
        qid: String(page.qid || ""),
        clientId: String(page.clientId ?? page.client_id ?? ""),
        revision: Number(page.revision),
        cloudSha256: String(
          page.cloudSha256 ?? page.cloud_sha256 ?? "",
        ).toLowerCase(),
        updatedAt: Number.isFinite(updatedAtMs)
          ? new Date(updatedAtMs).toISOString()
          : "",
      };
    }).sort((left, right) => left.page - right.page);
  const expectedPages = paperRuntimePageCount(sourceId);
  if (
    !/^paper-submit-[A-Za-z0-9._:-]{16,127}$/.test(attemptId) ||
    !/^paper-run-\d{10,20}$/.test(runId) ||
    !sourcePolicy || status !== "accepted" ||
    decisionReason !== "accepted-first-for-run" ||
    !Number.isFinite(remainingMs) || !Number.isInteger(remainingMs) ||
    remainingMs < 0 || remainingMs > 43_200_000 ||
    !/^[a-f0-9]{64}$/.test(inkSnapshotSha256) ||
    !Number.isSafeInteger(submittedAt) || submittedAt <= 0 ||
    !Number.isFinite(acceptedAtMs) || acceptedAtMs < submittedAt ||
    !/^\d{4}[a-z]$/.test(runCreatedAppVersion) ||
    runCreatedAppVersion !== "0830b" ||
    !Number.isSafeInteger(runCreatedAt) || runCreatedAt <= 0 ||
    paperLayoutVersion !== 2 || sourcePageCount !== expectedPages ||
    submittedAt <= runCreatedAt ||
    (sourcePolicy.freshnessRequired &&
      (!Number.isSafeInteger(freshnessConfirmedAt) ||
        Number(freshnessConfirmedAt) < runCreatedAt ||
        Number(freshnessConfirmedAt) > submittedAt)) ||
    (!sourcePolicy.freshnessRequired && freshnessConfirmedAt !== null) ||
    canceledAt != null || winnerAttemptId != null || expectedPages < 1 ||
    pageManifest.length !== expectedPages ||
    pageManifest.some((page, index) =>
      page.page !== index ||
      page.qid !== `paper:${runId}:v${paperLayoutVersion}:${index}` ||
      !/^paper:paper-run-[0-9]{10,20}:v[0-9]+:[0-9]+$/.test(page.qid) ||
      !page.clientId || page.clientId.length > 300 ||
      !Number.isInteger(page.revision) || page.revision < 0 ||
      !/^[a-f0-9]{64}$/.test(page.cloudSha256) || !page.updatedAt
    )
  ) return null;
  const layouts = new Set(
    pageManifest.map((page) =>
      String(page.qid).match(/:v([0-9]+):/)?.[1] || ""
    ),
  );
  if (layouts.size !== 1 || layouts.has("")) return null;
  const core = {
    authority: "supabase-immutable-paper-submit-attempt-v2",
    attemptId,
    runId,
    sourceId,
    status: "accepted",
    decisionReason: "accepted-first-for-run",
    remainingMs,
    inkSnapshotSha256,
    submittedAt,
    acceptedAt: new Date(acceptedAtMs).toISOString(),
    runCreatedAppVersion,
    runCreatedAt,
    paperLayoutVersion,
    sourcePageCount,
    freshnessConfirmedAt,
    calibrationEligible: sourcePolicy.calibrationEligible,
    sourceAssetVersion: sourcePolicy.sourceAssetVersion,
    sourceContentDigest: sourcePolicy.sourceContentDigest,
    pageManifest,
  };
  return { ...core, canonicalDigest: await canonicalSha256(core) };
}

/** Normalize the DB-issued proof of a real next-day correction checkpoint. */
export async function paperCorrectionRetryReceipt(raw: unknown) {
  const row = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const receipt = row.receipt && typeof row.receipt === "object" &&
      !Array.isArray(row.receipt)
    ? row.receipt as Record<string, unknown>
    : row;
  const runId = String(receipt.runId || "");
  const pageManifest = Array.isArray(receipt.correctionPageManifest)
    ? receipt.correctionPageManifest as Array<Record<string, unknown>>
    : [];
  const page = pageManifest[0] || {};
  const liveStrokeIds = Array.isArray(receipt.correctionLiveStrokeIds)
    ? receipt.correctionLiveStrokeIds.map(String)
    : [];
  const newStrokeIds = Array.isArray(receipt.correctionNewStrokeIds)
    ? receipt.correctionNewStrokeIds.map(String)
    : [];
  const liveStrokeDigests = Array.isArray(receipt.correctionLiveStrokeDigests)
    ? receipt.correctionLiveStrokeDigests.map((value) =>
      String(value).toLowerCase()
    )
    : [];
  const newStrokeDigests = Array.isArray(receipt.correctionNewStrokeDigests)
    ? receipt.correctionNewStrokeDigests.map((value) =>
      String(value).toLowerCase()
    )
    : [];
  const strokeSnapshot = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  const liveStrokes = Array.isArray(receipt.correctionLiveStrokes)
    ? receipt.correctionLiveStrokes.map(strokeSnapshot)
    : [];
  const newStrokes = Array.isArray(receipt.correctionNewStrokes)
    ? receipt.correctionNewStrokes.map(strokeSnapshot)
    : [];
  const snapshotMetrics = (
    strokes: Array<Record<string, unknown> | null>,
  ) => {
    let points = 0;
    const invalid = strokes.some((stroke) => {
      if (!stroke) return true;
      const keys = Object.keys(stroke).sort().join("\u0000");
      const expectedKeys = [
        "c",
        "geometryDigest",
        "id",
        "pts",
        "qno",
        "t0",
        "t1",
        "w",
      ].sort().join("\u0000");
      const pts = Array.isArray(stroke.pts) ? stroke.pts : [];
      points += pts.length;
      return keys !== expectedKeys ||
        !/^[A-Za-z0-9._:-]{1,300}$/.test(String(stroke.id || "")) ||
        Number(stroke.qno) !== Number(receipt.questionNo) ||
        !Number.isInteger(Number(stroke.qno)) ||
        !["black", "blue", "green"].includes(String(stroke.c || "")) ||
        !Number.isFinite(Number(stroke.w)) || Number(stroke.w) < 0.35 ||
        Number(stroke.w) > 2 ||
        !Number.isSafeInteger(Number(stroke.t0)) || Number(stroke.t0) < 0 ||
        !Number.isSafeInteger(Number(stroke.t1)) ||
        Number(stroke.t1) < Number(stroke.t0) ||
        pts.length < 2 || pts.length > 10_000 ||
        pts.some((point) =>
          !Array.isArray(point) || point.length !== 3 ||
          point.some((value) =>
            typeof value !== "number" || !Number.isFinite(value) ||
            value < 0 || value > 1
          )
        ) ||
        !/^[a-f0-9]{64}$/.test(String(stroke.geometryDigest || ""));
    });
    return {
      invalid,
      points,
      bytes: new TextEncoder().encode(JSON.stringify(strokes)).byteLength,
    };
  };
  const liveMetrics = snapshotMetrics(liveStrokes);
  const newMetrics = snapshotMetrics(newStrokes);
  const pageNo = Number(page.page);
  const expectedPage = paperCorrectionQuestionPage(
    String(receipt.sourceId || ""),
    Number(receipt.questionNo),
  );
  const digest = String(receipt.canonicalDigest || "").toLowerCase();
  const issuedAtMs = Date.parse(String(receipt.issuedAt || ""));
  const serverUpdatedAtMs = Date.parse(String(page.serverUpdatedAt || ""));
  if (
    receipt.authority !== "supabase-immutable-paper-correction-retry-v1" ||
    !/^paper-correction-retry-[A-Za-z0-9._:-]{16,127}$/.test(
      String(receipt.receiptId || ""),
    ) ||
    !/^paper-run-\d{10,20}$/.test(runId) ||
    !PAPER_GRADE_SOURCE_IDS.has(String(receipt.sourceId || "")) ||
    !Number.isInteger(Number(receipt.questionNo)) ||
    Number(receipt.questionNo) < 1 || Number(receipt.questionNo) > 20 ||
    !/^paper-submit-[A-Za-z0-9._:-]{16,127}$/.test(
      String(receipt.acceptedAttemptId || ""),
    ) ||
    !/^[a-f0-9]{64}$/.test(String(
      receipt.acceptedInkSnapshotSha256 || "",
    )) ||
    !/^[a-f0-9]{64}$/.test(String(
      receipt.acceptedPageManifestSha256 || "",
    )) ||
    pageManifest.length !== 1 || !Number.isInteger(pageNo) || pageNo < 0 ||
    pageNo > 19 ||
    pageNo !== expectedPage ||
    String(page.qid || "") !==
      `paper:${runId}-correction:v${
        String(page.qid || "").match(/:v([0-9]+):/)?.[1] || "?"
      }:${pageNo}` ||
    !String(page.clientId || "") || String(page.clientId).length > 300 ||
    !Number.isInteger(Number(page.revision)) || Number(page.revision) < 0 ||
    !/^[a-f0-9]{64}$/.test(String(page.cloudSha256 || "")) ||
    !Number.isFinite(Date.parse(String(page.updatedAt || ""))) ||
    !Number.isFinite(serverUpdatedAtMs) ||
    liveStrokeIds.length < 1 || newStrokeIds.length < 1 ||
    liveStrokeDigests.length < 1 || newStrokeDigests.length < 1 ||
    liveStrokes.length < 1 || liveStrokes.length > 1000 ||
    liveMetrics.invalid || liveMetrics.points > 50_000 ||
    liveMetrics.bytes > 1_000_000 ||
    newStrokes.length < 1 || newStrokes.length > 1000 ||
    newMetrics.invalid || newMetrics.points > 50_000 ||
    newMetrics.bytes > 1_000_000 ||
    new Set(liveStrokeIds).size !== liveStrokeIds.length ||
    new Set(newStrokeIds).size !== newStrokeIds.length ||
    [...liveStrokeIds].sort().join("\u0000") !== liveStrokeIds.join("\u0000") ||
    [...newStrokeIds].sort().join("\u0000") !== newStrokeIds.join("\u0000") ||
    liveStrokeIds.some((id) => !/^[A-Za-z0-9._:-]{1,300}$/.test(id)) ||
    newStrokeIds.some((id) => !liveStrokeIds.includes(id)) ||
    new Set(liveStrokeDigests).size !== liveStrokeDigests.length ||
    new Set(newStrokeDigests).size !== newStrokeDigests.length ||
    [...liveStrokeDigests].sort().join("\u0000") !==
      liveStrokeDigests.join("\u0000") ||
    [...newStrokeDigests].sort().join("\u0000") !==
      newStrokeDigests.join("\u0000") ||
    liveStrokeDigests.some((value) => !/^[a-f0-9]{64}$/.test(value)) ||
    newStrokeDigests.some((value) => !liveStrokeDigests.includes(value)) ||
    new Set(liveStrokes.map((stroke) => String(stroke?.id || ""))).size !==
      liveStrokes.length ||
    liveStrokes.map((stroke) => String(stroke?.id || "")).join("\u0000") !==
      liveStrokeIds.join("\u0000") ||
    [
        ...new Set(
          liveStrokes.map((stroke) => String(stroke?.geometryDigest || "")),
        ),
      ].sort().join("\u0000") !== liveStrokeDigests.join("\u0000") ||
    new Set(newStrokes.map((stroke) => String(stroke?.id || ""))).size !==
      newStrokes.length ||
    newStrokes.map((stroke) => String(stroke?.id || "")).join("\u0000") !==
      newStrokeIds.join("\u0000") ||
    [
        ...new Set(
          newStrokes.map((stroke) => String(stroke?.geometryDigest || "")),
        ),
      ].sort().join("\u0000") !== newStrokeDigests.join("\u0000") ||
    !Number.isFinite(issuedAtMs) || issuedAtMs < serverUpdatedAtMs ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    (row.canonical_digest != null &&
      String(row.canonical_digest).toLowerCase() !== digest)
  ) return null;
  const core = { ...receipt };
  delete core.canonicalDigest;
  if (await canonicalSha256(core) !== digest) return null;
  for (const stroke of liveStrokes) {
    if (
      !stroke || await canonicalSha256({
          pts: stroke.pts,
          c: stroke.c,
          w: stroke.w,
        }) !== String(stroke.geometryDigest || "").toLowerCase()
    ) return null;
  }
  for (const stroke of newStrokes) {
    const live = liveStrokes.find((candidate) =>
      candidate?.id === stroke?.id &&
      candidate?.geometryDigest === stroke?.geometryDigest
    );
    if (
      !stroke || !live ||
      await canonicalSha256(stroke) !== await canonicalSha256(live)
    ) return null;
  }
  return receipt;
}

async function paperGradeModelInputBinding(
  raw: unknown,
  expectedPages: number,
  expectedSourceId: string,
  serverInkPages: Array<Record<string, unknown>>,
) {
  const binding = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const images = Array.isArray(binding.imageOrder)
    ? binding.imageOrder as Array<Record<string, unknown>>
    : [];
  const pages = Array.isArray(binding.pageBindings)
    ? binding.pageBindings as Array<Record<string, unknown>>
    : [];
  const digest = String(binding.canonicalDigest || "").toLowerCase();
  if (
    binding.promptContractVersion !== "paper-grade-server-v2" ||
    binding.sourceId !== expectedSourceId ||
    !/^[a-f0-9]{64}$/.test(String(binding.promptSha256 || "")) ||
    !/^[a-f0-9]{64}$/.test(String(binding.answerKeySha256 || "")) ||
    binding.assetCatalogVersion !== "paper-grade-source-catalog-v1-20260830" ||
    binding.rendererVersion !== "paper-ink-authority-v1-20260830" ||
    Number(binding.pageCount) !== expectedPages ||
    Number(binding.imageCount) !== expectedPages * 3 ||
    images.length !== expectedPages * 3 || pages.length !== expectedPages ||
    !Number.isSafeInteger(Number(binding.totalImageBytes)) ||
    Number(binding.totalImageBytes) < 1 ||
    Number(binding.totalImageBytes) > 24_000_000 ||
    !Number.isSafeInteger(Number(binding.dataUrlChars)) ||
    Number(binding.dataUrlChars) < 1 ||
    Number(binding.dataUrlChars) > 35_000_000 ||
    images.some((image, index) =>
      Number(image.ordinal) !== index + 1 ||
      Number(image.page) !== Math.floor(index / 3) + 1 ||
      image.kind !==
        [
          "source-scan",
          "source-aligned-ink",
          "full-workspace-ink",
        ][index % 3] ||
      image.mediaType !== "image/png" ||
      !/^[a-f0-9]{64}$/.test(String(image.sha256 || "")) ||
      !Number.isInteger(Number(image.width)) ||
      !Number.isInteger(Number(image.height)) ||
      !["left", "right", "full"].includes(String(image.side || ""))
    ) || pages.some((page, index) => {
      const source = page.source as Record<string, unknown> | undefined;
      const ink = page.acceptedInk as Record<string, unknown> | undefined;
      const transform = page.transform as Record<string, unknown> | undefined;
      const expectedInk = serverInkPages[index] || {};
      return Number(page.page) !== index + 1 || !source || !ink || !transform ||
        source.bucket !== "matha-papers" || !String(source.path || "") ||
        !/^[a-f0-9]{64}$/.test(String(source.sha256 || "")) ||
        Number(ink.revision) !== Number(expectedInk.revision) ||
        String(ink.sha256 || "") !== String(expectedInk.sha256 || "") ||
        !Array.isArray(ink.liveStrokeIds) || !Array.isArray(ink.deletedIds) ||
        !Number.isSafeInteger(Number(ink.totalPoints)) ||
        !/^[a-f0-9]{64}$/.test(String(page.sourceAlignedOverlaySha256 || "")) ||
        !/^[a-f0-9]{64}$/.test(String(page.workspaceOverlaySha256 || "")) ||
        transform.sheetAspect !== "2112/2535" ||
        !Array.isArray(transform.crop) || transform.crop.length !== 4 ||
        transform.selectedSide !== source.side;
    }) ||
    !/^[a-f0-9]{64}$/.test(digest)
  ) return null;
  const core = { ...binding };
  delete core.canonicalDigest;
  if (await canonicalSha256(core) !== digest) return null;
  return binding;
}

/** Verify the exact full-page snapshots by reading the independently stored
 * ink_sessions rows.  app_state contains only references; it cannot make this
 * function pass by repeating a claimed hash in two local fields. */
export async function paperGradeSubmissionReadback(
  data: Record<string, unknown> | undefined,
  runId: string,
  serverInkRows: unknown[],
  rawPageManifest: unknown,
  rawAcceptedAttempt?: unknown,
) {
  const rawRuns = Array.isArray(data?.paperRuns) ? data.paperRuns : [];
  const cachedRun = rawRuns.find((item) =>
    item && typeof item === "object" && !Array.isArray(item) &&
    String((item as Record<string, unknown>).id || "") === runId
  ) as Record<string, unknown> | undefined;
  const accepted =
    rawAcceptedAttempt && typeof rawAcceptedAttempt === "object" &&
      !Array.isArray(rawAcceptedAttempt)
      ? rawAcceptedAttempt as Record<string, unknown>
      : null;
  const run = accepted
    ? {
      id: String(accepted.runId || ""),
      sourceId: String(accepted.sourceId || ""),
      createdAt: Number(accepted.runCreatedAt),
      submittedAt: Number(accepted.submittedAt),
      runCreatedAppVersion: String(accepted.runCreatedAppVersion || ""),
      paperLayoutVersion: Number(accepted.paperLayoutVersion),
      status: "grading",
      calibrationEligible: accepted.calibrationEligible,
      freshnessConfirmedAt: accepted.freshnessConfirmedAt,
    }
    : cachedRun;
  const binding = accepted
    ? await (async () => {
      const core = {
        schemaVersion: 2,
        authority: "supabase-accepted-attempt-and-server-asset-catalog-v1",
        runId: String(accepted.runId || ""),
        sourceId: String(accepted.sourceId || ""),
        sourceAssetVersion: String(accepted.sourceAssetVersion || ""),
        sourceContentDigest: String(accepted.sourceContentDigest || ""),
        paperLayoutVersion: Number(accepted.paperLayoutVersion),
        appVersion: String(accepted.runCreatedAppVersion || ""),
        submittedAt: Number(accepted.submittedAt),
        freshnessConfirmedAt: accepted.freshnessConfirmedAt ?? null,
        calibrationEligible: accepted.calibrationEligible === true,
        expectedPages: Number(accepted.sourcePageCount),
      };
      return { ...core, contentBindingSha256: await canonicalSha256(core) };
    })()
    : await paperPdfContentBinding(data, runId, "answer");
  const manifest = Array.isArray(rawPageManifest)
    ? rawPageManifest as Array<Record<string, unknown>>
    : [];
  const expectedPages = paperRuntimePageCount(String(run?.sourceId || ""));
  if (!run || !binding || manifest.length !== expectedPages) return null;
  const runCreatedAt = Number(run.createdAt);
  const runCreatedAppVersion = String(run.runCreatedAppVersion || "");
  if (
    !Number.isFinite(runCreatedAt) || runCreatedAt <= 0 ||
    !/^\d{4}[a-z]$/.test(runCreatedAppVersion) ||
    runCreatedAppVersion !== binding.appVersion
  ) return null;
  const rows = (Array.isArray(serverInkRows) ? serverInkRows : []).filter(
    (row) => row && typeof row === "object" && !Array.isArray(row),
  ) as Array<Record<string, unknown>>;
  if (rows.length !== expectedPages) return null;
  const serverInkPages: Array<Record<string, unknown>> = [];
  for (const ref of manifest) {
    const matches = rows.filter((row) =>
      String(row.client_id || "") === ref.clientId &&
      String(row.qid || "") === ref.qid
    );
    if (matches.length !== 1) return null;
    const row = matches[0];
    const proc = row.proc && typeof row.proc === "object" &&
        !Array.isArray(row.proc)
      ? row.proc as Record<string, unknown>
      : {};
    const strokes = row.strokes && typeof row.strokes === "object" &&
        !Array.isArray(row.strokes)
      ? row.strokes as Record<string, unknown>
      : {};
    const revision = Number(proc.revision);
    const updatedAt = Date.parse(
      String(row.updated_at || row.created_at || ""),
    );
    let serverSha256 = "";
    try {
      serverSha256 = await canonicalSha256(strokes);
    } catch (_) {
      return null;
    }
    const strokeRows = Array.isArray(strokes.s) ? strokes.s : null;
    const deletedRows = Array.isArray(strokes.deleted) ? strokes.deleted : null;
    if (
      proc.overlay !== true || proc.mode !== "paper-source" ||
      proc.event != null || Number(proc.page) !== ref.page ||
      Number(row.t0) !== runCreatedAt + ref.page ||
      !Number.isInteger(revision) || revision < 0 ||
      strokes.paper !== true || Number(strokes.revision) !== revision ||
      strokeRows === null || deletedRows === null ||
      !Number.isFinite(updatedAt) || updatedAt <= 0 ||
      revision !== Number(ref.revision) ||
      updatedAt !== Date.parse(String(ref.updatedAt || "")) ||
      serverSha256 !== String(ref.cloudSha256 || "")
    ) return null;
    serverInkPages.push({
      page: ref.page,
      qid: ref.qid,
      clientId: ref.clientId,
      sha256: serverSha256,
      revision,
      updatedAt: new Date(updatedAt).toISOString(),
      strokeCount: strokeRows.length,
      deletedCount: deletedRows.length,
    });
  }
  serverInkPages.sort((a, b) => Number(a.page) - Number(b.page));
  if (
    serverInkPages.reduce(
      (sum, row) => sum + Number(row.strokeCount || 0),
      0,
    ) < 1
  ) return null;
  const inkSnapshotSha256 = await canonicalSha256({
    schema: 1,
    runId: String(run.id || ""),
    sourceId: String(run.sourceId || ""),
    paperLayoutVersion: Number(run.paperLayoutVersion),
    submittedAt: Number(run.submittedAt),
    revisions: serverInkPages.map((row) => ({
      page: Number(row.page),
      revision: Number(row.revision),
      persistedRevision: Number(row.revision),
      dirty: false,
    })),
    pages: serverInkPages.map((row) => ({
      page: Number(row.page),
      qid: String(row.qid || ""),
      clientId: String(row.clientId || ""),
      sha256: String(row.sha256 || ""),
      cloudSha256: String(row.sha256 || ""),
    })),
  });
  return {
    run,
    binding,
    runCreatedAt,
    runCreatedAppVersion,
    serverInkPages,
    inkSnapshotSha256,
  };
}

/** Build the immutable grade receipt that the Edge function writes with the
 * service role.  Existing historical runs have no such receipt and therefore
 * intentionally cannot satisfy the formal capability gate. */
export async function paperGradeServerReceipt(
  data: Record<string, unknown> | undefined,
  rawContext: unknown,
  rawGrade: unknown,
  answerKey: PaperAnswerKeyItem[],
  serverInkRows: unknown[],
  rawServerSubmitAttempt: unknown,
  rawModelInputBinding: unknown,
  requestId: string,
  model: string,
  gradedAt = Date.now(),
): Promise<PaperGradeReceipt | null> {
  const context = rawContext && typeof rawContext === "object" &&
      !Array.isArray(rawContext)
    ? rawContext as Record<string, unknown>
    : {};
  const runId = String(context.paperRunId || "");
  const sourceId = String(context.sourceId || "");
  const gradeGeneration = Number(context.gradeGeneration ?? 0);
  const submitAttempt = await paperGradeAcceptedSubmitAttempt(
    rawServerSubmitAttempt,
  );
  if (!submitAttempt) return null;
  const submission = await paperGradeSubmissionReadback(
    data,
    runId,
    serverInkRows,
    submitAttempt.pageManifest,
    submitAttempt,
  );
  if (!submission) return null;
  const modelInputBinding = await paperGradeModelInputBinding(
    rawModelInputBinding,
    paperRuntimePageCount(sourceId),
    sourceId,
    submission.serverInkPages,
  );
  if (!modelInputBinding) return null;
  const run = submission.run;
  const submittedAt = Number(run.submittedAt);
  const policy = paperGradeSourcePolicy(sourceId);
  const rawFreshnessConfirmedAt = run.freshnessConfirmedAt;
  const freshnessConfirmedAt = policy?.freshnessRequired
    ? Number(rawFreshnessConfirmedAt)
    : null;
  const sourceContentDigest = PAPER_RUNTIME_SOURCE_CONTENT_DIGESTS[sourceId];
  if (
    !/^paper-run-\d{10,20}$/.test(runId) ||
    !policy ||
    !Number.isInteger(gradeGeneration) || gradeGeneration < 0 ||
    gradeGeneration > 2147483647 ||
    sourceId !== String(run.sourceId || "") ||
    String(run.status || "") !== "grading" ||
    Number(context.runCreatedAt) !== submission.runCreatedAt ||
    String(context.runCreatedAppVersion || "") !==
      submission.runCreatedAppVersion ||
    String(context.submitAttemptId || "") !== submitAttempt.attemptId ||
    String(context.submitAttemptInkSnapshotSha256 || "").toLowerCase() !==
      submitAttempt.inkSnapshotSha256 ||
    submission.inkSnapshotSha256 !== submitAttempt.inkSnapshotSha256 ||
    submitAttempt.runId !== runId || submitAttempt.sourceId !== sourceId ||
    submitAttempt.submittedAt !== submittedAt ||
    submitAttempt.runCreatedAppVersion !== submission.runCreatedAppVersion ||
    Number(context.submittedAt) !== submittedAt ||
    Number(context.paperLayoutVersion) !==
      submission.binding.paperLayoutVersion ||
    !Number.isFinite(submittedAt) || submittedAt <= submission.runCreatedAt ||
    (policy.freshnessRequired &&
      (!Number.isFinite(Number(freshnessConfirmedAt)) ||
        Number(freshnessConfirmedAt) <= 0 ||
        Number(freshnessConfirmedAt) > submittedAt)) ||
    (!policy.freshnessRequired && rawFreshnessConfirmedAt != null) ||
    !Number.isFinite(gradedAt) || gradedAt < submittedAt ||
    run.calibrationEligible !== policy.calibrationEligible ||
    !/^[a-f0-9]{64}$/.test(String(sourceContentDigest || "")) ||
    !/^resp_[A-Za-z0-9_-]{8,180}$/.test(requestId) ||
    !model || model.length > 80
  ) return null;
  const gradeSummary = paperGradeServerSummary(rawGrade, answerKey);
  if (!gradeSummary) return null;
  const rawGradeSha256 = await canonicalSha256(rawGrade);
  const core = {
    kind: "matha-paper-grade-receipt-v1",
    schemaVersion: 1,
    authority: "supabase-edge-service-role-grade-receipt",
    runId,
    sourceId,
    sourceAssetVersion: submission.binding.sourceAssetVersion,
    sourceContentDigest,
    paperLayoutVersion: submission.binding.paperLayoutVersion,
    runCreatedAt: submission.runCreatedAt,
    runCreatedAppVersion: submission.runCreatedAppVersion,
    submittedAt,
    freshnessConfirmedAt,
    calibrationEligible: policy.calibrationEligible,
    submitAttempt,
    submissionContentBindingSha256: submission.binding.contentBindingSha256,
    serverInkPages: submission.serverInkPages,
    modelInputBinding,
    gradeGeneration,
    gradedAt,
    requestId,
    model,
    rawGradeSha256,
    gradeSummary,
  };
  return {
    ...core,
    canonicalDigest: await canonicalSha256(core),
  };
}

/** Validate a receipt plus the Edge-only live private readback wrapper. */
export async function verifyPaperGradeReceiptReadback(raw: unknown) {
  const envelope = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const receipt = envelope.receipt && typeof envelope.receipt === "object" &&
      !Array.isArray(envelope.receipt)
    ? envelope.receipt as Record<string, unknown>
    : {};
  const readback = envelope.privateReadback &&
      typeof envelope.privateReadback === "object" &&
      !Array.isArray(envelope.privateReadback)
    ? envelope.privateReadback as Record<string, unknown>
    : {};
  const runId = String(receipt.runId || "");
  const sourceId = String(receipt.sourceId || "");
  const canonicalDigest = String(receipt.canonicalDigest || "").toLowerCase();
  const gradeSummary = receipt.gradeSummary &&
      typeof receipt.gradeSummary === "object" &&
      !Array.isArray(receipt.gradeSummary)
    ? receipt.gradeSummary as Record<string, unknown>
    : {};
  const summary = capabilityGradeSummary({
    score: gradeSummary.awardedPoints,
    questions: gradeSummary.questions,
  });
  const pages = Array.isArray(receipt.serverInkPages)
    ? receipt.serverInkPages as Array<Record<string, unknown>>
    : [];
  const expectedPages = paperRuntimePageCount(sourceId);
  const policy = paperGradeSourcePolicy(sourceId);
  const modelInputBinding = await paperGradeModelInputBinding(
    receipt.modelInputBinding,
    expectedPages,
    sourceId,
    pages,
  );
  const submitAttempt = await paperGradeAcceptedSubmitAttempt(
    receipt.submitAttempt,
  );
  if (
    receipt.kind !== "matha-paper-grade-receipt-v1" ||
    Number(receipt.schemaVersion) !== 1 ||
    receipt.authority !== "supabase-edge-service-role-grade-receipt" ||
    !/^paper-run-\d{10,20}$/.test(runId) ||
    !policy ||
    receipt.sourceAssetVersion !==
      PAPER_RUNTIME_SOURCE_ASSET_VERSIONS[sourceId] ||
    receipt.sourceContentDigest !==
      PAPER_RUNTIME_SOURCE_CONTENT_DIGESTS[sourceId] ||
    Number(receipt.paperLayoutVersion) !== 2 ||
    !Number.isInteger(Number(receipt.gradeGeneration)) ||
    Number(receipt.gradeGeneration) < 0 ||
    Number(receipt.gradeGeneration) > 2147483647 ||
    !/^\d{4}[a-z]$/.test(String(receipt.runCreatedAppVersion || "")) ||
    !Number.isFinite(Number(receipt.runCreatedAt)) ||
    Number(receipt.runCreatedAt) <= 0 ||
    !Number.isFinite(Number(receipt.submittedAt)) ||
    Number(receipt.submittedAt) <= Number(receipt.runCreatedAt) ||
    !Number.isFinite(Number(receipt.gradedAt)) ||
    Number(receipt.gradedAt) < Number(receipt.submittedAt) ||
    (policy.freshnessRequired &&
      (!Number.isFinite(Number(receipt.freshnessConfirmedAt)) ||
        Number(receipt.freshnessConfirmedAt) <= 0 ||
        Number(receipt.freshnessConfirmedAt) > Number(receipt.submittedAt))) ||
    (!policy.freshnessRequired && receipt.freshnessConfirmedAt !== null) ||
    receipt.calibrationEligible !== policy.calibrationEligible ||
    !submitAttempt || submitAttempt.runId !== runId ||
    submitAttempt.sourceId !== sourceId ||
    submitAttempt.submittedAt !== Number(receipt.submittedAt) ||
    submitAttempt.runCreatedAppVersion !==
      String(receipt.runCreatedAppVersion || "") ||
    await canonicalSha256(submitAttempt) !==
      await canonicalSha256(receipt.submitAttempt) ||
    !/^[a-f0-9]{64}$/.test(String(
      receipt.submissionContentBindingSha256 || "",
    )) ||
    !/^[a-f0-9]{64}$/.test(String(receipt.rawGradeSha256 || "")) ||
    !/^resp_[A-Za-z0-9_-]{8,180}$/.test(String(receipt.requestId || "")) ||
    !String(receipt.model || "") || String(receipt.model).length > 80 ||
    !modelInputBinding || !summary ||
    summary.awardedPoints !== Number(gradeSummary.awardedPoints) ||
    summary.maxPoints !== 100 || pages.length !== expectedPages ||
    pages.some((page, index) =>
      Number(page.page) !== index ||
      !/^[a-f0-9]{64}$/.test(String(page.sha256 || "")) ||
      Number(page.strokeCount) < 0 || Number(page.deletedCount) < 0
    ) ||
    pages.reduce((sum, page) => sum + Number(page.strokeCount || 0), 0) < 1 ||
    !/^[a-f0-9]{64}$/.test(canonicalDigest)
  ) return null;
  const core = { ...receipt };
  delete core.canonicalDigest;
  if (await canonicalSha256(core) !== canonicalDigest) return null;
  const expectedPath = new RegExp(
    "^grade-receipts/matha_[a-f0-9]{32}/" + runId.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    ) + "/grade-" + canonicalDigest + "\\.json$",
  );
  const readbackAt = Date.parse(String(readback.readbackVerifiedAt || ""));
  if (
    readback.authority !== "supabase-service-role-storage-readback" ||
    readback.bucket !== PAPER_AUDIT_PRIVATE_BUCKET ||
    !expectedPath.test(String(readback.path || "")) ||
    !/^[a-f0-9]{64}$/.test(String(readback.sha256 || "")) ||
    readback.canonicalDigest !== canonicalDigest ||
    !Number.isFinite(readbackAt) || readbackAt < Number(receipt.gradedAt)
  ) return null;
  return { receipt, privateReadback: readback };
}

/** Owner attestation for the exact model-input image set.  This deliberately
 * does not claim server-side pixel reconstruction: it records that the owner
 * visually confirmed the grade view as this run, then binds that statement to
 * the immutable grade receipt, per-page image hashes and ink snapshot. */
export async function paperGradeVisualAttestation(
  rawReceiptEnvelope: unknown,
  rawRun: unknown,
  rawOwnerConfirmation: unknown,
  attestedAt = Date.now(),
) {
  const verified = await verifyPaperGradeReceiptReadback(rawReceiptEnvelope);
  const run = rawRun && typeof rawRun === "object" && !Array.isArray(rawRun)
    ? rawRun as Record<string, unknown>
    : {};
  if (!verified) return null;
  const receipt = verified.receipt as Record<string, unknown>;
  const binding = receipt.modelInputBinding as Record<string, unknown>;
  const images = binding.imageOrder as Array<Record<string, unknown>>;
  const submitAttempt = receipt.submitAttempt as Record<string, unknown>;
  const confirmation = rawOwnerConfirmation &&
      typeof rawOwnerConfirmation === "object" &&
      !Array.isArray(rawOwnerConfirmation)
    ? rawOwnerConfirmation as Record<string, unknown>
    : {};
  const confirmedPages = Array.isArray(confirmation.confirmedPages)
    ? confirmation.confirmedPages as Array<Record<string, unknown>>
    : [];
  const expectedPages = images.map((image) => ({
    page: Number(image.page),
    mediaType: String(image.mediaType),
    sha256: String(image.sha256),
  }));
  if (
    String(run.id || "") !== receipt.runId ||
    String(run.sourceId || "") !== receipt.sourceId ||
    Number(run.submittedAt) !== Number(receipt.submittedAt) ||
    Number(run.createdAt) !== Number(receipt.runCreatedAt) ||
    String(run.runCreatedAppVersion || "") !==
      String(receipt.runCreatedAppVersion || "") ||
    confirmation.ownerStatement !==
      "I reviewed every model-input page and confirm it is this paper run" ||
    String(confirmation.gradeReceiptDigest || "") !==
      String(receipt.canonicalDigest || "") ||
    String(confirmation.modelInputBindingSha256 || "") !==
      String(binding.canonicalDigest || "") ||
    String(confirmation.submitAttemptDigest || "") !==
      String(submitAttempt.canonicalDigest || "") ||
    String(confirmation.submitAttemptId || "") !==
      String(submitAttempt.attemptId || "") ||
    await canonicalSha256(confirmedPages) !==
      await canonicalSha256(expectedPages) ||
    !Number.isFinite(attestedAt) || attestedAt < Number(receipt.gradedAt)
  ) return null;
  const serverInkSnapshotSha256 = await canonicalSha256(
    receipt.serverInkPages,
  );
  const core = {
    kind: "matha-paper-grade-visual-attestation-v2",
    schemaVersion: 2,
    authority: "authenticated-owner-self-attestation",
    ownerStatement:
      "I reviewed every model-input page and confirm it is this paper run",
    runId: receipt.runId,
    sourceId: receipt.sourceId,
    runCreatedAppVersion: receipt.runCreatedAppVersion,
    submittedAt: receipt.submittedAt,
    gradedAt: receipt.gradedAt,
    attestedAt,
    gradeReceiptDigest: receipt.canonicalDigest,
    submitAttemptDigest: submitAttempt.canonicalDigest,
    submitAttemptId: submitAttempt.attemptId,
    modelInputBindingSha256: binding.canonicalDigest,
    submissionContentBindingSha256: receipt.submissionContentBindingSha256,
    serverInkSnapshotSha256,
    images: expectedPages,
  };
  return { ...core, canonicalDigest: await canonicalSha256(core) };
}

export async function verifyPaperGradeVisualAttestationReadback(raw: unknown) {
  const envelope = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const attestation = envelope.attestation &&
      typeof envelope.attestation === "object" &&
      !Array.isArray(envelope.attestation)
    ? envelope.attestation as Record<string, unknown>
    : {};
  const readback = envelope.privateReadback &&
      typeof envelope.privateReadback === "object" &&
      !Array.isArray(envelope.privateReadback)
    ? envelope.privateReadback as Record<string, unknown>
    : {};
  const runId = String(attestation.runId || "");
  const digest = String(attestation.canonicalDigest || "").toLowerCase();
  const images = Array.isArray(attestation.images)
    ? attestation.images as Array<Record<string, unknown>>
    : [];
  const expectedPages = paperRuntimePageCount(String(attestation.sourceId));
  if (
    attestation.kind !== "matha-paper-grade-visual-attestation-v2" ||
    Number(attestation.schemaVersion) !== 2 ||
    attestation.authority !== "authenticated-owner-self-attestation" ||
    attestation.ownerStatement !==
      "I reviewed every model-input page and confirm it is this paper run" ||
    !/^paper-run-\d{10,20}$/.test(runId) ||
    !PAPER_GRADE_SOURCE_IDS.has(String(attestation.sourceId)) ||
    !/^\d{4}[a-z]$/.test(String(attestation.runCreatedAppVersion || "")) ||
    !Number.isFinite(Number(attestation.submittedAt)) ||
    !Number.isFinite(Number(attestation.gradedAt)) ||
    !Number.isFinite(Number(attestation.attestedAt)) ||
    Number(attestation.attestedAt) < Number(attestation.gradedAt) ||
    !/^[a-f0-9]{64}$/.test(String(attestation.gradeReceiptDigest || "")) ||
    !/^[a-f0-9]{64}$/.test(String(attestation.submitAttemptDigest || "")) ||
    !/^paper-submit-[A-Za-z0-9._:-]{16,127}$/.test(String(
      attestation.submitAttemptId || "",
    )) ||
    !/^[a-f0-9]{64}$/.test(String(
      attestation.modelInputBindingSha256 || "",
    )) ||
    !/^[a-f0-9]{64}$/.test(String(
      attestation.submissionContentBindingSha256 || "",
    )) ||
    !/^[a-f0-9]{64}$/.test(String(
      attestation.serverInkSnapshotSha256 || "",
    )) ||
    images.length !== expectedPages * 3 ||
    images.some((image, index) =>
      Number(image.page) !== Math.floor(index / 3) + 1 ||
      !["image/png", "image/jpeg"].includes(String(image.mediaType || "")) ||
      !/^[a-f0-9]{64}$/.test(String(image.sha256 || ""))
    ) ||
    !/^[a-f0-9]{64}$/.test(digest)
  ) return null;
  const core = { ...attestation };
  delete core.canonicalDigest;
  if (await canonicalSha256(core) !== digest) return null;
  const expectedPath = new RegExp(
    `^grade-visual-attestations/matha_[a-f0-9]{32}/${runId}/` +
      `attestation-${digest}\\.json$`,
  );
  const readbackAt = Date.parse(String(readback.readbackVerifiedAt || ""));
  if (
    readback.authority !== "supabase-service-role-storage-readback" ||
    readback.bucket !== PAPER_AUDIT_PRIVATE_BUCKET ||
    !expectedPath.test(String(readback.path || "")) ||
    !/^[a-f0-9]{64}$/.test(String(readback.sha256 || "")) ||
    readback.canonicalDigest !== digest || !Number.isFinite(readbackAt) ||
    readbackAt < Number(attestation.attestedAt)
  ) return null;
  return { attestation, privateReadback: readback };
}

/* 真機驗收封存只信任 Edge Function 以 service role 重新讀回的 app_state。
   不接受前端直接上傳一份自稱合格的 JSON，也完全不呼叫 OpenAI。 */
export function paperRuntimeAuditLegacyReadOnlyEvidence(
  data: Record<string, unknown> | undefined,
  runId: string,
) {
  if (!/^paper-run-\d{10,20}$/.test(runId)) return null;
  const rawRuns = data?.paperRuns;
  const runs: unknown[] = Array.isArray(rawRuns) ? rawRuns : [];
  const run = runs.find((item) =>
    item && typeof item === "object" &&
    String((item as Record<string, unknown>).id || "") === runId
  ) as Record<string, unknown> | undefined;
  if (!run) return null;
  const sourceId = String(run.sourceId || "");
  if (
    !/^paper-(?:mock-3|official-(?:11[1-5]|110-trial)|regional-ra(?:4109|4110|3101|3102|1104|2100|2101|1103))$/
      .test(sourceId)
  ) {
    return null;
  }
  if (
    !["awaiting-correction", "completed"].includes(String(run.status || ""))
  ) {
    return null;
  }
  if (
    run.calibrationEligible !== true || Number(run.freshnessConfirmedAt) <= 0
  ) {
    return null;
  }
  const audit = run.runtimeAudit && typeof run.runtimeAudit === "object"
    ? run.runtimeAudit as Record<string, unknown>
    : undefined;
  if (
    !audit || Number(audit.schema) !== 1 ||
    String(audit.runId || "") !== runId ||
    String(audit.sourceId || "") !== sourceId ||
    !/^\d{4}[a-z]$/.test(String(audit.appVersion || ""))
  ) return null;
  const attestation = audit.deviceAttestation &&
      typeof audit.deviceAttestation === "object"
    ? audit.deviceAttestation as Record<string, unknown>
    : {};
  const device = audit.device && typeof audit.device === "object"
    ? audit.device as Record<string, unknown>
    : {};
  const reportedModel = String(attestation.browserReportedModel || "");
  const userAgent = String(device.userAgent || "");
  const width = Number(device.screenWidth) || 0;
  const height = Number(device.screenHeight) || 0;
  if (
    attestation.confirmed !== true ||
    attestation.model !== "Samsung Galaxy Tab S10 Ultra" ||
    attestation.source !== "user-confirmation" ||
    !Number.isFinite(Date.parse(String(attestation.confirmedAt || ""))) ||
    !userAgent.includes("Android") ||
    (reportedModel
      ? !/SM-X9/i.test(reportedModel)
      : maxDimension(width, height) < 1100 || minDimension(width, height) < 700)
  ) return null;

  const rawSwitches =
    (Array.isArray(audit.pageSwitches) ? audit.pageSwitches : []).slice(-240);
  const pageSwitches = rawSwitches.map((item) => {
    const row = item && typeof item === "object"
      ? item as Record<string, unknown>
      : {};
    return {
      at: Number(row.at) || 0,
      from: Number(row.from) || 0,
      to: Number(row.to) || 0,
      method: String(row.method || "").slice(0, 20),
      ms: Number(row.ms),
    };
  }).filter((row) => Number.isFinite(row.ms) && row.ms >= 0);
  const saveMs = finiteNumbers(audit.localSaveMs, 240).filter((value) =>
    value >= 0
  );
  const sourcePageCounts: Record<string, number> = {
    "paper-mock-3": 4,
    "paper-official-110-trial": 8,
    "paper-official-111": 8,
    "paper-official-112": 8,
    "paper-official-113": 8,
    "paper-official-114": 8,
    "paper-official-115": 8,
    "paper-regional-ra4109": 4,
    "paper-regional-ra4110": 3,
    "paper-regional-ra3101": 3,
    "paper-regional-ra3102": 3,
    "paper-regional-ra1104": 3,
    "paper-regional-ra2100": 3,
    "paper-regional-ra2101": 3,
    "paper-regional-ra1103": 3,
  };
  const requiredSwitches = Math.max(1, (sourcePageCounts[sourceId] || 8) - 1);
  const pageP95Ms = percentile(pageSwitches.map((row) => row.ms), 0.95);
  const localSaveP95Ms = percentile(saveMs, 0.95);
  const checks = [
    {
      id: "duration",
      status: Number(audit.activeElapsedMs) >= 5_999_000 ? "pass" : "fail",
    },
    {
      id: "page",
      status: pageSwitches.length >= requiredSwitches && pageP95Ms != null &&
          pageP95Ms <= 500 && pageSwitches.some((row) => row.method === "swipe")
        ? "pass"
        : "fail",
    },
    {
      id: "save",
      status: saveMs.length > 0 && Math.max(...saveMs) <= 2000 &&
          Number(audit.localSaveFailures) === 0
        ? "pass"
        : "fail",
    },
    {
      id: "canvas",
      status: Number(audit.maxSingleCanvasPixels) > 0 &&
          Number(audit.maxSingleCanvasPixels) <= 12_000_000 &&
          Number(audit.maxLiveCanvasCount) <= 3
        ? "pass"
        : "fail",
    },
    {
      id: "resume",
      status: Number(audit.sessions) >= 2 ? "pass" : "fail",
    },
    { id: "pdf", status: Number(audit.pdfPreparedAt) > 0 ? "pass" : "fail" },
  ];
  if (
    checks.some((row) => row.status !== "pass") ||
    Number(audit.strokesCommitted) < 1 ||
    Number(audit.pendingAtSubmit) !== 0
  ) return null;

  const safeAudit = {
    schema: 1,
    appVersion: String(audit.appVersion),
    runId,
    sourceId,
    createdAt: Number(audit.createdAt) || null,
    startedAt: Number(audit.startedAt) || null,
    submittedAt: Number(audit.submittedAt) || null,
    activeElapsedMs: Number(audit.activeElapsedMs),
    sessions: Number(audit.sessions),
    crashRecoveries: Number(audit.crashRecoveries) || 0,
    strokesCommitted: Number(audit.strokesCommitted),
    pageSwitches,
    localSaveMs: saveMs,
    localSaveFailures: Number(audit.localSaveFailures) || 0,
    pendingAtSubmit: Number(audit.pendingAtSubmit) || 0,
    maxSingleCanvasPixels: Number(audit.maxSingleCanvasPixels),
    maxLiveCanvasCount: Number(audit.maxLiveCanvasCount),
    pdfPreparedAt: Number(audit.pdfPreparedAt),
    device: {
      userAgent: userAgent.slice(0, 320),
      platform: String(device.platform || "").slice(0, 80),
      screenWidth: width,
      screenHeight: height,
      dpr: Number(device.dpr) || null,
    },
  };
  return {
    kind: "matha-paper-runtime-audit-v1",
    exportedAt: String(attestation.confirmedAt),
    appVersion: String(audit.appVersion),
    deviceAttestation: {
      confirmed: true,
      model: "Samsung Galaxy Tab S10 Ultra",
      source: "user-confirmation",
      confirmedAt: String(attestation.confirmedAt),
      browserReportedModel: reportedModel.slice(0, 80),
    },
    run: {
      id: runId,
      sourceId,
      date: String(run.d || ""),
      status: String(run.status),
    },
    summary: { passed: true, checks, pageP95Ms, localSaveP95Ms },
    audit: safeAudit,
  };
}

/* Schema v2 is the only form eligible for a new formal archive. V1 remains
   readable in existing files/the app, but the legacy evaluator above is never
   used as release authority. The v2 decision also requires service-role
   readback rows from ink_sessions; app_state alone can never pass. */
export async function paperRuntimeAuditEvidence(
  data: Record<string, unknown> | undefined,
  runId: string,
  serverInkRows: unknown[] = [],
  serverPdfArtifact: unknown = null,
) {
  if (!/^paper-run-\d{10,20}$/.test(runId)) return null;
  const run = paperRuntimeRun(data, runId);
  if (!run) return null;
  const sourceId = String(run.sourceId || "");
  const expectedPages = paperRuntimeSourcePageCounts[sourceId];
  if (!expectedPages) return null;
  if (
    !["awaiting-correction", "completed"].includes(String(run.status || "")) ||
    run.calibrationEligible !== true || Number(run.freshnessConfirmedAt) <= 0
  ) return null;

  const audit = run.runtimeAudit && typeof run.runtimeAudit === "object"
    ? run.runtimeAudit as Record<string, unknown>
    : undefined;
  if (
    !audit || Number(audit.schema) !== 2 ||
    String(audit.runId || "") !== runId ||
    String(audit.sourceId || "") !== sourceId ||
    !/^\d{4}[a-z]$/.test(String(audit.appVersion || ""))
  ) return null;

  const attestation = audit.deviceAttestation &&
      typeof audit.deviceAttestation === "object"
    ? audit.deviceAttestation as Record<string, unknown>
    : {};
  const device = audit.device && typeof audit.device === "object"
    ? audit.device as Record<string, unknown>
    : {};
  const reportedModel = String(attestation.browserReportedModel || "");
  const userAgent = String(device.userAgent || "");
  const width = Number(device.screenWidth) || 0;
  const height = Number(device.screenHeight) || 0;
  if (
    attestation.confirmed !== true ||
    attestation.model !== "Samsung Galaxy Tab S10 Ultra" ||
    attestation.source !== "user-confirmation" ||
    !Number.isFinite(Date.parse(String(attestation.confirmedAt || ""))) ||
    !userAgent.includes("Android") ||
    (reportedModel
      ? !/SM-X9/i.test(reportedModel)
      : maxDimension(width, height) < 1100 ||
        minDimension(width, height) < 700)
  ) return null;

  const rawSwitches =
    (Array.isArray(audit.pageSwitches) ? audit.pageSwitches : []).slice(-240);
  const pageSwitches = rawSwitches.map((item) => {
    const row = item && typeof item === "object"
      ? item as Record<string, unknown>
      : {};
    return {
      at: Number(row.at),
      from: Number(row.from),
      to: Number(row.to),
      method: String(row.method || "").slice(0, 20),
      ms: Number(row.ms),
      painted: row.painted === true,
    };
  }).filter((row) =>
    Number.isFinite(row.at) && row.at > 0 &&
    Number.isInteger(row.from) && Number.isInteger(row.to) &&
    Number.isFinite(row.ms) && row.ms >= 0 && row.painted &&
    ["swipe", "button"].includes(row.method) && row.from !== row.to &&
    row.from >= 0 && row.from < expectedPages && row.to >= 0 &&
    row.to < expectedPages
  );
  if (pageSwitches.length !== rawSwitches.length) return null;

  const rawVisited = Array.isArray(audit.visitedPages)
    ? audit.visitedPages.map(Number)
    : [];
  const visitedPages = [...new Set(rawVisited)].sort((a, b) => a - b);
  const initialPage = Number(audit.initialPage);
  if (
    !Number.isInteger(initialPage) || initialPage < 0 ||
    initialPage >= expectedPages ||
    visitedPages.length !== rawVisited.length ||
    visitedPages.length !== expectedPages ||
    visitedPages.some((page, index) => page !== index)
  ) return null;
  const swipeSwitches = pageSwitches.filter((row) => row.method === "swipe");
  const swipePages = new Set<number>([initialPage]);
  for (const row of swipeSwitches) {
    swipePages.add(row.from);
    swipePages.add(row.to);
  }
  const requiredSwitches = Math.max(1, expectedPages - 1);
  const pageP95Ms = percentile(swipeSwitches.map((row) => row.ms), 0.95);

  const saveMs = finiteNumbers(audit.localSaveMs, 240).filter((value) =>
    value >= 0
  );
  const localSaveP95Ms = percentile(saveMs, 0.95);

  const recoveryEvents =
    (Array.isArray(audit.recoveryEvents) ? audit.recoveryEvents : []).slice(-20)
      .map((item) => {
        const row = item && typeof item === "object"
          ? item as Record<string, unknown>
          : {};
        return {
          checkpointUpdatedAt: Number(row.checkpointUpdatedAt) || 0,
          recoveredAt: Number(row.recoveredAt) || 0,
          sourceId: String(row.sourceId || ""),
          page: Number(row.page),
          remainingMs: Number(row.remainingMs),
          inkVerified: row.inkVerified === true,
          checkpointInkSha256: String(row.checkpointInkSha256 || "")
            .toLowerCase(),
          recoveredInkSha256: String(row.recoveredInkSha256 || "")
            .toLowerCase(),
          pageCount: Number(row.pageCount),
          strokeCount: Number(row.strokeCount),
          deletedCount: Number(row.deletedCount),
        };
      });
  const totalMs = 100 * 60_000;
  const validRecoveries = recoveryEvents.filter((row) =>
    row.checkpointUpdatedAt > 0 &&
    row.recoveredAt >= row.checkpointUpdatedAt &&
    row.sourceId === sourceId && Number.isInteger(row.page) &&
    row.page >= 0 && row.page < expectedPages &&
    Number.isFinite(row.remainingMs) && row.remainingMs >= 0 &&
    row.remainingMs <= totalMs && row.inkVerified === true &&
    /^[a-f0-9]{64}$/.test(row.checkpointInkSha256) &&
    row.checkpointInkSha256 === row.recoveredInkSha256 &&
    row.pageCount === expectedPages &&
    Number.isInteger(row.strokeCount) && row.strokeCount >= 0 &&
    Number.isInteger(row.deletedCount) && row.deletedCount >= 0
  );

  const durability = audit.submitDurability &&
      typeof audit.submitDurability === "object"
    ? audit.submitDurability as Record<string, unknown>
    : {};
  const refs = paperRuntimeAuditInkReferences(data, runId);
  if (!refs) return null;
  const pdfKind = String(
    audit.pdfArtifact && typeof audit.pdfArtifact === "object" &&
      !Array.isArray(audit.pdfArtifact)
      ? (audit.pdfArtifact as Record<string, unknown>).kind || ""
      : "",
  );
  const contentBinding = await paperPdfContentBinding(data, runId, pdfKind);
  if (!contentBinding) return null;
  const readbackAt = Number(durability.readbackVerifiedAt) || 0;
  const submittedAt = Number(audit.submittedAt) || 0;
  const durabilityShapeOk = durability.journalDrained === true &&
    durability.allPagesPersisted === true &&
    durability.cloudFlushed === true &&
    durability.revisionsUnchanged === true &&
    Number(durability.pendingAtSubmit) === 0 &&
    Number(durability.expectedPages) === expectedPages &&
    Number(durability.verifiedPages) === expectedPages &&
    Number(audit.pendingAtSubmit) === 0 &&
    submittedAt > 0 && readbackAt >= submittedAt;

  const rows = (Array.isArray(serverInkRows) ? serverInkRows : []).filter(
    (row) => row && typeof row === "object" && !Array.isArray(row),
  ) as Array<Record<string, unknown>>;
  const serverPages: Array<Record<string, unknown>> = [];
  let inkReadbackOk = durabilityShapeOk && rows.length === expectedPages;
  for (const ref of refs.references) {
    const matches = rows.filter((row) =>
      String(row.client_id || "") === ref.clientId &&
      String(row.qid || "") === ref.qid
    );
    if (matches.length !== 1) {
      inkReadbackOk = false;
      continue;
    }
    const row = matches[0];
    const proc = row.proc && typeof row.proc === "object"
      ? row.proc as Record<string, unknown>
      : {};
    const strokes = row.strokes && typeof row.strokes === "object"
      ? row.strokes as Record<string, unknown>
      : {};
    const revision = Number(proc.revision);
    const updatedAt = Date.parse(
      String(row.updated_at || row.created_at || ""),
    );
    let serverSha256 = "";
    try {
      serverSha256 = await canonicalSha256(strokes);
    } catch (_) {
      inkReadbackOk = false;
    }
    const strokeRows = Array.isArray(strokes.s) ? strokes.s : null;
    const deletedRows = Array.isArray(strokes.deleted) ? strokes.deleted : null;
    const rowOk = proc.overlay === true && proc.mode === "paper-source" &&
      proc.event == null && Number(proc.page) === ref.page &&
      Number(row.t0) === Number(run.createdAt) + ref.page &&
      Number.isInteger(revision) && revision >= 0 &&
      strokes.paper === true && Number(strokes.revision) === revision &&
      strokeRows !== null && deletedRows !== null &&
      Number.isFinite(updatedAt) && updatedAt > 0 &&
      ref.localSha256 === ref.cloudSha256 &&
      serverSha256 === ref.cloudSha256;
    if (!rowOk) inkReadbackOk = false;
    serverPages.push({
      page: ref.page,
      qid: ref.qid,
      clientId: ref.clientId,
      sha256: serverSha256,
      revision: Number.isInteger(revision) ? revision : null,
      updatedAt: Number.isFinite(updatedAt)
        ? new Date(updatedAt).toISOString()
        : null,
      strokeCount: strokeRows?.length ?? null,
      deletedCount: deletedRows?.length ?? null,
      matched: rowOk,
    });
  }
  serverPages.sort((a, b) => Number(a.page) - Number(b.page));
  if (
    serverPages.reduce(
      (sum, row) => sum + Number(row.strokeCount || 0),
      0,
    ) < 1
  ) inkReadbackOk = false;

  const rawPdf = audit.pdfArtifact && typeof audit.pdfArtifact === "object"
    ? audit.pdfArtifact as Record<string, unknown>
    : {};
  const pdfArtifact = {
    format: String(rawPdf.format || ""),
    magic: String(rawPdf.magic || ""),
    eof: String(rawPdf.eof || ""),
    sha256: String(rawPdf.sha256 || "").toLowerCase(),
    bytes: Number(rawPdf.bytes),
    pageCount: Number(rawPdf.pageCount),
    kind: String(rawPdf.kind || ""),
    generatedAt: Number(rawPdf.generatedAt),
    storageVerified: rawPdf.storageVerified === true,
    bucket: String(rawPdf.bucket || ""),
    path: String(rawPdf.path || "").replace(/\\/g, "/"),
    contentBindingVersion: Number(rawPdf.contentBindingVersion),
    contentBindingSha256: String(rawPdf.contentBindingSha256 || "")
      .toLowerCase(),
    sourceAssetVersion: String(rawPdf.sourceAssetVersion || ""),
    gradeBindingSha256: rawPdf.gradeBindingSha256 == null
      ? null
      : String(rawPdf.gradeBindingSha256 || "").toLowerCase(),
    serverVerifiedAt: String(rawPdf.serverVerifiedAt || ""),
  };
  const serverPdf = serverPdfArtifact &&
      typeof serverPdfArtifact === "object" &&
      !Array.isArray(serverPdfArtifact)
    ? serverPdfArtifact as Record<string, unknown>
    : {};
  const pdfOk = pdfArtifact.format === "application/pdf" &&
    pdfArtifact.magic === "%PDF-" &&
    pdfArtifact.eof === "%%EOF" &&
    /^[a-f0-9]{64}$/.test(pdfArtifact.sha256) &&
    Number.isInteger(pdfArtifact.bytes) && pdfArtifact.bytes > 1000 &&
    pdfArtifact.bytes <= 14_000_000 &&
    pdfArtifact.pageCount === expectedPages &&
    ["graded", "answer"].includes(pdfArtifact.kind) &&
    Number.isFinite(pdfArtifact.generatedAt) &&
    pdfArtifact.generatedAt >= submittedAt &&
    pdfArtifact.storageVerified &&
    pdfArtifact.bucket === PAPER_AUDIT_PRIVATE_BUCKET &&
    pdfArtifact.contentBindingVersion === contentBinding.schemaVersion &&
    pdfArtifact.contentBindingSha256 ===
      contentBinding.contentBindingSha256 &&
    pdfArtifact.sourceAssetVersion === contentBinding.sourceAssetVersion &&
    pdfArtifact.gradeBindingSha256 ===
      contentBinding.gradeBindingSha256 &&
    new RegExp(
      `^runtime-audits/matha_[a-f0-9]{32}/pdf/${runId}/` +
        `(?:graded|answer)-[a-f0-9]{64}-[a-f0-9]{64}\\.pdf$`,
    ).test(pdfArtifact.path) &&
    pdfArtifact.path.endsWith(
      `/${pdfArtifact.kind}-${pdfArtifact.contentBindingSha256}-${pdfArtifact.sha256}.pdf`,
    ) &&
    Number.isFinite(Date.parse(pdfArtifact.serverVerifiedAt)) &&
    serverPdf.storageVerified === true &&
    serverPdf.bucket === pdfArtifact.bucket &&
    serverPdf.path === pdfArtifact.path &&
    serverPdf.sha256 === pdfArtifact.sha256 &&
    serverPdf.bytes === pdfArtifact.bytes &&
    serverPdf.pageCount === pdfArtifact.pageCount &&
    serverPdf.kind === pdfArtifact.kind &&
    serverPdf.format === pdfArtifact.format &&
    serverPdf.magic === pdfArtifact.magic &&
    serverPdf.eof === pdfArtifact.eof &&
    Number(serverPdf.contentBindingVersion) ===
      pdfArtifact.contentBindingVersion &&
    serverPdf.contentBindingSha256 === pdfArtifact.contentBindingSha256 &&
    serverPdf.sourceAssetVersion === pdfArtifact.sourceAssetVersion &&
    (serverPdf.gradeBindingSha256 == null
        ? null
        : String(serverPdf.gradeBindingSha256)) ===
      pdfArtifact.gradeBindingSha256;

  /* The server proves exact bytes, provenance and ink hashes, but cannot
     reconstruct the browser-rendered pixels.  Content correctness therefore
     needs an explicit human review tied to this exact PDF and binding. */
  const rawPixelQa = audit.pdfPixelQa &&
      typeof audit.pdfPixelQa === "object" && !Array.isArray(audit.pdfPixelQa)
    ? audit.pdfPixelQa as Record<string, unknown>
    : {};
  const pixelQaConfirmedAt = String(rawPixelQa.confirmedAt || "");
  const pdfPixelQa = {
    confirmed: rawPixelQa.confirmed === true,
    source: String(rawPixelQa.source || ""),
    reviewer: String(rawPixelQa.reviewer || ""),
    pdfSha256: String(rawPixelQa.pdfSha256 || "").toLowerCase(),
    contentBindingSha256: String(
      rawPixelQa.contentBindingSha256 || "",
    ).toLowerCase(),
    confirmedAt: pixelQaConfirmedAt,
  };
  const pixelQaAt = Date.parse(pixelQaConfirmedAt);
  const pdfVerifiedAt = Date.parse(pdfArtifact.serverVerifiedAt);
  const pdfPixelQaOk = pdfPixelQa.confirmed &&
    pdfPixelQa.source === "owner-visual-review" &&
    pdfPixelQa.reviewer === "authenticated-owner" &&
    pdfPixelQa.pdfSha256 === pdfArtifact.sha256 &&
    pdfPixelQa.contentBindingSha256 === pdfArtifact.contentBindingSha256 &&
    Number.isFinite(pixelQaAt) && Number.isFinite(pdfVerifiedAt) &&
    pixelQaAt >= pdfVerifiedAt;

  const checks = [
    {
      id: "duration",
      status: Number(audit.activeElapsedMs) >= 5_999_000 &&
          Number(audit.activeElapsedMs) <= 6_001_000
        ? "pass"
        : "fail",
    },
    {
      id: "page",
      status: swipeSwitches.length >= requiredSwitches &&
          swipePages.size === expectedPages &&
          pageP95Ms != null && pageP95Ms <= 500
        ? "pass"
        : "fail",
    },
    {
      id: "save",
      status: saveMs.length > 0 && Math.max(...saveMs) <= 2000 &&
          Number(audit.localSaveFailures) === 0 &&
          (!Array.isArray(audit.localSaveFailureIds) ||
            audit.localSaveFailureIds.length === 0)
        ? "pass"
        : "fail",
    },
    {
      id: "canvas",
      status: Number(audit.maxSingleCanvasPixels) > 0 &&
          Number(audit.maxSingleCanvasPixels) <= 12_000_000 &&
          Number(audit.maxLiveCanvasCount) <= 3
        ? "pass"
        : "fail",
    },
    {
      id: "resume",
      status: Number(audit.crashRecoveries) >= 1 &&
          Number(audit.sessions) >= Number(audit.crashRecoveries) + 1 &&
          validRecoveries.length === Number(audit.crashRecoveries) &&
          validRecoveries.length === recoveryEvents.length &&
          validRecoveries.length >= 1
        ? "pass"
        : "fail",
    },
    { id: "pdf", status: pdfOk ? "pass" : "fail" },
    { id: "pdf-visual", status: pdfPixelQaOk ? "pass" : "fail" },
    { id: "durability", status: inkReadbackOk ? "pass" : "fail" },
  ];
  if (
    checks.some((row) => row.status !== "pass") ||
    Number(audit.strokesCommitted) < 1
  ) return null;

  const safeAudit = {
    schema: 2,
    appVersion: String(audit.appVersion),
    runId,
    sourceId,
    createdAt: Number(audit.createdAt) || null,
    startedAt: Number(audit.startedAt) || null,
    submittedAt,
    activeElapsedMs: Number(audit.activeElapsedMs),
    sessions: Number(audit.sessions),
    crashRecoveries: Number(audit.crashRecoveries),
    recoveryEvents: validRecoveries,
    strokesCommitted: Number(audit.strokesCommitted),
    initialPage,
    visitedPages,
    pageSwitches,
    localSaveMs: saveMs,
    localSaveFailures: Number(audit.localSaveFailures) || 0,
    localSaveFailureIds: [],
    pendingAtSubmit: 0,
    submitDurability: {
      journalDrained: true,
      allPagesPersisted: true,
      cloudFlushed: true,
      revisionsUnchanged: true,
      pendingAtSubmit: 0,
      readbackVerifiedAt: readbackAt,
      expectedPages,
      verifiedPages: expectedPages,
    },
    maxSingleCanvasPixels: Number(audit.maxSingleCanvasPixels),
    maxLiveCanvasCount: Number(audit.maxLiveCanvasCount),
    pdfArtifact,
    pdfPixelQa,
    deviceAttestation: {
      confirmed: true,
      model: "Samsung Galaxy Tab S10 Ultra",
      source: "user-confirmation",
      confirmedAt: String(attestation.confirmedAt),
      browserReportedModel: reportedModel.slice(0, 80),
    },
    device: {
      userAgent: userAgent.slice(0, 320),
      platform: String(device.platform || "").slice(0, 80),
      screenWidth: width,
      screenHeight: height,
      dpr: Number(device.dpr) || null,
    },
  };
  return {
    kind: "matha-paper-runtime-audit-v2",
    schemaVersion: 2,
    exportedAt: new Date(readbackAt).toISOString(),
    appVersion: String(audit.appVersion),
    deviceAttestation: {
      confirmed: true,
      model: "Samsung Galaxy Tab S10 Ultra",
      source: "user-confirmation",
      confirmedAt: String(attestation.confirmedAt),
      browserReportedModel: reportedModel.slice(0, 80),
    },
    run: {
      id: runId,
      sourceId,
      date: String(run.d || ""),
      status: String(run.status),
      pageCount: expectedPages,
      paperLayoutVersion: refs.layoutVersion,
    },
    summary: { passed: true, checks, pageP95Ms, localSaveP95Ms },
    inkReadback: {
      route: "service-role-postgrest",
      queriedAfterClientReadbackAt: readbackAt,
      expectedPages,
      verifiedPages: serverPages.length,
      pages: serverPages,
    },
    audit: safeAudit,
  };
}

function maxDimension(a: number, b: number) {
  return Math.max(a, b);
}

function minDimension(a: number, b: number) {
  return Math.min(a, b);
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
