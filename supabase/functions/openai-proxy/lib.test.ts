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
  absoluteStorageSignedUrl,
  MAX_TEXT_CHARS,
  normalizeMessages,
  outputText,
  paperDetailGateAllows,
  paperKeyGateAllows,
  paperRuntimeAuditEvidence,
  paperSolutionFiles,
  paperSolutionGateAllows,
  parsePaperAnswerKeys,
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

Deno.test("paper_detail 解鎖：隔日且至少一次真實重想已保存", () => {
  assert(
    paperDetailGateAllows(
      gateData("2026-07-17", { attempts: 1, logs: [{ kind: "retry" }] }),
      "run-1",
      3,
      "2026-07-18",
    ),
  );
  assert(
    !paperDetailGateAllows(
      gateData("2026-07-18", { attempts: 0, logs: [] }),
      "run-1",
      3,
      "2026-07-18",
    ),
    "空白訂正狀態不能解鎖",
  );
  assert(
    !paperDetailGateAllows(
      gateData("2026-07-18", { attempts: 1, logs: [] }),
      "run-1",
      3,
      "2026-07-18",
    ),
    "只有計數、沒有 retry log 不能解鎖",
  );
});

Deno.test("paper_detail 解鎖：未到期、題目狀態或 run 不存在、題號超界都擋", () => {
  assert(
    !paperDetailGateAllows(
      gateData("2026-07-19", { attempts: 1, logs: [{ kind: "retry" }] }),
      "run-1",
      3,
      "2026-07-18",
    ),
    "還沒到隔天",
  );
  assert(
    !paperDetailGateAllows(
      gateData("2026-07-17", undefined),
      "run-1",
      3,
      "2026-07-18",
    ),
    "沒有該題訂正狀態",
  );
  assert(
    !paperDetailGateAllows(
      gateData("2026-07-17", { attempts: 1, logs: [{ kind: "retry" }] }),
      "run-2",
      3,
      "2026-07-18",
    ),
    "run 不存在",
  );
  assert(
    !paperDetailGateAllows(
      gateData("2026-07-17", { attempts: 1, logs: [{ kind: "retry" }] }),
      "run-1",
      21,
      "2026-07-18",
    ),
    "題號超界",
  );
  assert(!paperDetailGateAllows(undefined, "run-1", 3, "2026-07-18"));
});

Deno.test("paper_key 只接受伺服器已保存的同一回 grading 交卷", () => {
  const data = {
    paperRuns: [{
      id: "run-3",
      sourceId: "paper-mock-3",
      status: "grading",
      submittedAt: 123,
    }],
  };
  assert(paperKeyGateAllows(data, "run-3", "paper-mock-3"));
  assert(!paperKeyGateAllows(data, "run-3", "paper-mock-2"));
  assert(!paperKeyGateAllows(data, "missing", "paper-mock-3"));
  assert(
    !paperKeyGateAllows(
      { paperRuns: [{ ...data.paperRuns[0], status: "active" }] },
      "run-3",
      "paper-mock-3",
    ),
  );
  assert(
    !paperKeyGateAllows(
      { paperRuns: [{ ...data.paperRuns[0], submittedAt: 0 }] },
      "run-3",
      "paper-mock-3",
    ),
  );
});

Deno.test("真機驗收封存只接受雲端狀態中的完整 100 分鐘、恢復、滑動、保存與 PDF 證據", () => {
  const runId = "paper-run-1234567890123";
  const run = {
    id: runId,
    sourceId: "paper-mock-3",
    status: "awaiting-correction",
    d: "2026-08-29",
    calibrationEligible: true,
    freshnessConfirmedAt: 123,
    runtimeAudit: {
      schema: 1,
      appVersion: "0829q",
      runId,
      sourceId: "paper-mock-3",
      createdAt: 1,
      startedAt: 2,
      submittedAt: 3,
      activeElapsedMs: 6_000_000,
      sessions: 2,
      crashRecoveries: 0,
      strokesCommitted: 20,
      pageSwitches: [
        { at: 1, from: 0, to: 1, method: "swipe", ms: 120 },
        { at: 2, from: 1, to: 2, method: "button", ms: 180 },
        { at: 3, from: 2, to: 3, method: "button", ms: 220 },
      ],
      localSaveMs: [120, 180],
      localSaveFailures: 0,
      pendingAtSubmit: 0,
      maxSingleCanvasPixels: 10_000_000,
      maxLiveCanvasCount: 3,
      pdfPreparedAt: 4,
      device: {
        userAgent: "Mozilla/5.0 (Linux; Android 14)",
        platform: "Linux armv8l",
        screenWidth: 1315,
        screenHeight: 821,
        dpr: 2,
      },
      deviceAttestation: {
        confirmed: true,
        model: "Samsung Galaxy Tab S10 Ultra",
        source: "user-confirmation",
        confirmedAt: "2026-08-29T04:00:00.000Z",
        browserReportedModel: "SM-X920",
      },
    },
  };
  const evidence = paperRuntimeAuditEvidence({ paperRuns: [run] }, runId);
  assert(evidence);
  assertEquals(evidence.summary.passed, true);
  assertEquals(evidence.run.sourceId, "paper-mock-3");
  assertEquals(evidence.audit.pageSwitches.length, 3);
  assertEquals("unrelatedPrivateState" in evidence, false);

  const regionalRun = structuredClone(run);
  regionalRun.sourceId = "paper-regional-ra4109";
  regionalRun.runtimeAudit.sourceId = "paper-regional-ra4109";
  assert(
    paperRuntimeAuditEvidence({ paperRuns: [regionalRun] }, runId),
    "已列入私有題本的區域模考也必須能封存真機驗收",
  );

  const rejectedMutations: Array<[string, (value: typeof run) => void]> = [
    [
      "未滿 100 分鐘",
      (value) => value.runtimeAudit.activeElapsedMs = 5_998_999,
    ],
    ["沒有實際筆畫", (value) => value.runtimeAudit.strokesCommitted = 0],
    ["沒有滑動翻頁", (value) => {
      value.runtimeAudit.pageSwitches[0].method = "button";
    }],
    ["翻頁 P95 過慢", (value) => value.runtimeAudit.pageSwitches[2].ms = 800],
    ["本機保存過慢", (value) => value.runtimeAudit.localSaveMs[1] = 2_001],
    ["本機保存失敗", (value) => value.runtimeAudit.localSaveFailures = 1],
    ["交卷仍有待保存", (value) => value.runtimeAudit.pendingAtSubmit = 1],
    ["Canvas 過大", (value) => {
      value.runtimeAudit.maxSingleCanvasPixels = 12_000_001;
    }],
    ["同時 Canvas 過多", (value) => value.runtimeAudit.maxLiveCanvasCount = 4],
    ["沒有恢復", (value) => value.runtimeAudit.sessions = 1],
    ["沒有 PDF", (value) => value.runtimeAudit.pdfPreparedAt = 0],
    ["不是校準 run", (value) => value.calibrationEligible = false],
    ["未交卷", (value) => value.status = "active"],
    [
      "不是 Android",
      (value) => value.runtimeAudit.device.userAgent = "Windows",
    ],
    ["型號不符", (value) => {
      value.runtimeAudit.deviceAttestation.browserReportedModel = "SM-T000";
    }],
    ["不是本人確認", (value) => {
      value.runtimeAudit.deviceAttestation.source = "agent-claim";
    }],
  ];
  for (const [label, mutate] of rejectedMutations) {
    const candidate = structuredClone(run);
    mutate(candidate);
    assert(
      paperRuntimeAuditEvidence({ paperRuns: [candidate] }, runId) === null,
      label,
    );
  }
});

Deno.test("paper_solution 只接受同一來源且已完成隔日重想的題", () => {
  const state = gateData("2026-07-17", {
    attempts: 1,
    logs: [{ kind: "retry", direction: "先重畫圖再建式" }],
  });
  const runs = state.paperRuns as Array<Record<string, unknown>>;
  runs[0].sourceId = "paper-mock-1";
  assert(
    paperSolutionGateAllows(
      state,
      "run-1",
      "paper-mock-1",
      3,
      "2026-07-18",
    ),
  );
  assert(
    !paperSolutionGateAllows(
      state,
      "run-1",
      "paper-mock-2",
      3,
      "2026-07-18",
    ),
  );
  assertEquals(paperSolutionFiles("paper-mock-1", 12), [
    "paper-mock-1/q12-a.png",
    "paper-mock-1/q12-b.png",
  ]);
  assertEquals(paperSolutionFiles("paper-mock-1", 10), []);
  assertEquals(paperSolutionFiles("../paper-mock-1", 12), []);
  assertEquals(paperSolutionFiles("paper-official-110-trial", 1), [
    "paper-official-110-trial/page-01-c7d733fea66b.png",
  ]);
  assertEquals(paperSolutionFiles("paper-official-110-trial", 20), [
    "paper-official-110-trial/page-07-081146b891af.png",
    "paper-official-110-trial/page-08-4ab3b0649c85.png",
  ]);
  assertEquals(paperSolutionFiles("paper-regional-ra4109", 7), [
    "paper-regional-ra4109/solution-page-01-7efbca7b2c8d.png",
    "paper-regional-ra4109/solution-page-02-01b2aa5a2a31.png",
  ]);
  assertEquals(paperSolutionFiles("paper-regional-ra1103", 20), [
    "paper-regional-ra1103/solution-page-02-ddac60812621.png",
  ]);
  assertEquals(
    absoluteStorageSignedUrl(
      "https://example.supabase.co",
      "/object/sign/matha-solutions/q.png?token=x",
    ),
    "https://example.supabase.co/storage/v1/object/sign/matha-solutions/q.png?token=x",
  );
  assertThrows(() =>
    absoluteStorageSignedUrl(
      "https://example.supabase.co",
      "//evil.example/q.png",
    )
  );
});

Deno.test("PAPER_ANSWER_KEYS_JSON 嚴格驗證題型、答案與配分", () => {
  const parsed = parsePaperAnswerKeys(JSON.stringify({
    "paper-mock-3": [
      { type: "single", ans: [3], points: 5 },
      { type: "fill", ans: ["13/6"], display: "13/6", points: 5 },
      {
        type: "constructed",
        ans: ["體積 10；最遠距離 √94"],
        display: "體積 10；最遠距離 √94",
        points: 8,
        rubric: [
          { label: "求出體積" },
          { label: "比較各頂點距離" },
        ],
      },
    ],
  }));
  assertEquals(parsed["paper-mock-3"][0].ans, [3]);
  assertEquals(parsed["paper-mock-3"][1].display, "13/6");
  assertEquals(parsed["paper-mock-3"][2].rubric?.[1].label, "比較各頂點距離");
  assertThrows(() => parsePaperAnswerKeys(undefined));
  assertThrows(() =>
    parsePaperAnswerKeys(
      '{"paper-mock-3":[{"type":"single","ans":[8],"points":5}]}',
    )
  );
  assertThrows(() =>
    parsePaperAnswerKeys(
      '{"paper-mock-3":[{"type":"fill","ans":[],"points":5}]}',
    )
  );
  assertThrows(() =>
    parsePaperAnswerKeys(
      '{"paper-mock-3":[{"type":"constructed","ans":["10"],"points":8,"rubric":[]}]}',
    )
  );
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
  assert(paper.required.includes("topic"));
});
