// openai-proxy 純邏輯層的行為測試（CI 以 `deno test` 執行）。
// 取代原本只用 regex 對原始碼字串斷言的做法：這裡實際執行驗證邏輯。
// 斷言自帶（不拉 jsr/@std）：零遠端依賴，CI 離線也能跑。
function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`not equal:\n  actual:   ${a}\n  expected: ${b}`);
  }
}
function assertThrows(fn: () => unknown) {
  let threw = false;
  try {
    fn();
  } catch (_) {
    threw = true;
  }
  if (!threw) throw new Error("expected function to throw");
}
import {
  MAX_TEXT_CHARS,
  normalizeMessages,
  outputText,
  paperDetailGateAllows,
  requestWeights,
  responseSchemas,
  safetyIdentifier,
  splitCsv,
  taipeiDate,
} from "./lib.ts";

Deno.test("splitCsv 去空白、去空項", () => {
  assertEquals([...splitCsv(" a@x.io , ,b@x.io,")], ["a@x.io", "b@x.io"]);
  assertEquals(splitCsv(undefined).size, 0);
});

Deno.test("整卷批改權重最高；未知類型無權重（index.ts 呼叫端以 || 1 補預設）", () => {
  assert(requestWeights.paper_grade === 12);
  assert(requestWeights.paper_detail === 5);
  for (const weight of Object.values(requestWeights)) {
    assert(
      Number.isInteger(weight) && weight >= 1 && weight <= 20,
      "權重須落在 claim_ai_request 的 1–20 夾擠範圍",
    );
  }
  assertEquals(requestWeights["nonsense"], undefined);
});

Deno.test("normalizeMessages：合法文字與圖片轉成 Responses 格式", () => {
  const out = normalizeMessages([
    { role: "user", content: "hi" },
    {
      role: "user",
      content: [
        { type: "text", text: "看這張" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "aGk=" },
        },
      ],
    },
  ]);
  assertEquals(out[0], { role: "user", content: "hi" });
  const parts = out[1].content as Array<Record<string, unknown>>;
  assertEquals(parts[0], { type: "input_text", text: "看這張" });
  assertEquals(parts[1].type, "input_image");
  assertEquals(parts[1].detail, "original");
  assert(String(parts[1].image_url).startsWith("data:image/png;base64,"));
});

Deno.test("normalizeMessages：拒絕壞 role、壞圖片、超量圖片與超長文字", () => {
  assertThrows(() => normalizeMessages([]));
  assertThrows(() => normalizeMessages([{ role: "system", content: "x" }]));
  assertThrows(() =>
    normalizeMessages([{
      role: "user",
      content: [{
        type: "image",
        source: { type: "url", media_type: "image/png", data: "x" },
      }],
    }])
  );
  assertThrows(() =>
    normalizeMessages([{
      role: "user",
      content: [{
        type: "image",
        source: { type: "base64", media_type: "image/svg+xml", data: "x" },
      }],
    }])
  );
  const nineImages = Array.from({ length: 9 }, () => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "aGk=" },
  }));
  assertThrows(() =>
    normalizeMessages([{ role: "user", content: nineImages }])
  );
  assertThrows(() =>
    normalizeMessages([{
      role: "user",
      content: "x".repeat(MAX_TEXT_CHARS + 1),
    }])
  );
});

Deno.test("outputText：串接 output_text、遇 refusal 直接丟錯", () => {
  assertEquals(
    outputText({
      output: [{
        type: "message",
        content: [
          { type: "output_text", text: "A" },
          { type: "output_text", text: "B" },
        ],
      }],
    }),
    "AB",
  );
  assertThrows(() =>
    outputText({
      output: [{ type: "message", content: [{ type: "refusal" }] }],
    })
  );
  assertEquals(outputText({}), "");
});

const gateData = (due: string, state: Record<string, unknown> | undefined) => ({
  paperRuns: [{ id: "run-1", due, review: state ? { "3": state } : {} }],
});

Deno.test("paper_detail 解鎖：隔日以後＋至少一次重想才放行", () => {
  assert(
    paperDetailGateAllows(
      gateData("2026-07-17", { attempts: 1 }),
      "run-1",
      3,
      "2026-07-18",
    ),
  );
  assert(
    paperDetailGateAllows(
      gateData("2026-07-18", { logs: [{}] }),
      "run-1",
      3,
      "2026-07-18",
    ),
  );
});

Deno.test("paper_detail 解鎖：未到期、無重想、run 不存在、題號超界都擋", () => {
  assert(
    !paperDetailGateAllows(
      gateData("2026-07-19", { attempts: 1 }),
      "run-1",
      3,
      "2026-07-18",
    ),
    "還沒到隔天",
  );
  assert(
    !paperDetailGateAllows(
      gateData("2026-07-17", { attempts: 0, logs: [] }),
      "run-1",
      3,
      "2026-07-18",
    ),
    "沒有重想紀錄",
  );
  assert(
    !paperDetailGateAllows(
      gateData("2026-07-17", { attempts: 1 }),
      "run-2",
      3,
      "2026-07-18",
    ),
    "run 不存在",
  );
  assert(
    !paperDetailGateAllows(
      gateData("2026-07-17", { attempts: 1 }),
      "run-1",
      21,
      "2026-07-18",
    ),
    "題號超界",
  );
  assert(!paperDetailGateAllows(undefined, "run-1", 3, "2026-07-18"));
});

Deno.test("taipeiDate 回傳台北時區的 YYYY-MM-DD", () => {
  const value = taipeiDate();
  assert(/^\d{4}-\d{2}-\d{2}$/.test(value));
  const expected = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  assertEquals(value, expected);
});

Deno.test("safetyIdentifier 穩定且不含原始 user id", async () => {
  const a = await safetyIdentifier("user-123");
  const b = await safetyIdentifier("user-123");
  const c = await safetyIdentifier("user-456");
  assertEquals(a, b);
  assert(a !== c);
  assert(a.startsWith("matha_"));
  assert(!a.includes("user-123"));
});

Deno.test("結構化 schema 每一層物件都關閉額外欄位，整卷必含 finalAnswer", () => {
  // 遞迴檢查：任何巢狀層（markSchema、stuckSchema、paper_grade 題目物件…）漏設
  // additionalProperties:false 都會讓 strict json_schema 部署失敗或放行雜欄位
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.type === "object" && obj.properties) {
      assertEquals(obj.additionalProperties, false);
      assert(Array.isArray(obj.required), `${path} 缺 required`);
      for (const [key, child] of Object.entries(obj.properties)) {
        walk(child, `${path}.${key}`);
      }
    }
    if (obj.type === "array") walk(obj.items, `${path}[]`);
  };
  for (const [name, schema] of Object.entries(responseSchemas)) {
    walk(schema, name);
  }
  const paper = responseSchemas.paper_grade.properties.questions.items;
  assert(paper.required.includes("finalAnswer"));
  assert(paper.required.includes("selectedOptions"));
});
