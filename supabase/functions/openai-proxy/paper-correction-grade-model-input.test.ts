import { canonicalSha256 } from "./lib.ts";
import type { PaperGradeSourceAsset } from "./paper-grade-assets.ts";
import {
  PAPER_CORRECTION_GRADE_MAX_DECODED_IMAGE_BYTES,
  PAPER_CORRECTION_GRADE_MAX_ENCODED_CHARS,
  PAPER_CORRECTION_GRADE_PROMPT_CONTRACT_VERSION,
  paperCorrectionGradeRequestSizeAllowed,
  preparePaperCorrectionGradeModelInput,
  preparePaperCorrectionGradeModelInputForCatalogAssets,
} from "./paper-correction-grade-model-input.ts";
import { encodeRgbPng, sha256Bytes } from "./paper-ink-render.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual), right = JSON.stringify(expected);
  if (left !== right) throw new Error(`not equal: ${left} != ${right}`);
}

async function snapshot(
  id: string,
  qno: number,
  offset: number,
) {
  const pts = [
    [0.11 + offset, 0.21, 0.5],
    [0.31 + offset, 0.41, 0.7],
  ];
  const c = offset ? "blue" : "black";
  const w = offset ? 1.2 : 1;
  return {
    id,
    qno,
    pts,
    c,
    w,
    t0: 1_700_000_000_000 + offset * 1_000,
    t1: 1_700_000_000_100 + offset * 1_000,
    geometryDigest: await canonicalSha256({ pts, c, w }),
  };
}

async function receiptFixture(questionNo = 3) {
  const runId = "paper-run-1700000000000";
  const oldStroke = await snapshot("old-stroke", questionNo, 0);
  const retryStroke = await snapshot("retry-stroke", questionNo, 0.1);
  const liveStrokes = [oldStroke, retryStroke];
  const liveDigests = [
    ...new Set(liveStrokes.map((stroke) => stroke.geometryDigest)),
  ].sort();
  const core = {
    authority: "supabase-immutable-paper-correction-retry-v1",
    receiptId: "paper-correction-retry-unit-1700000000000",
    runId,
    sourceId: "paper-mock-1",
    questionNo,
    acceptedAttemptId: "paper-submit-unit-1700000000000",
    acceptedInkSnapshotSha256: "a".repeat(64),
    acceptedPageManifestSha256: "b".repeat(64),
    correctionPageManifest: [{
      page: 0,
      qid: `paper:${runId}-correction:v2:0`,
      clientId: "unit-correction-client",
      revision: 7,
      cloudSha256: "c".repeat(64),
      updatedAt: "2026-08-30T00:00:00.000Z",
      serverUpdatedAt: "2026-08-30T00:00:00.000Z",
    }],
    correctionLiveStrokeIds: liveStrokes.map((stroke) => stroke.id),
    correctionNewStrokeIds: [retryStroke.id],
    correctionLiveStrokeDigests: liveDigests,
    correctionNewStrokeDigests: [retryStroke.geometryDigest],
    correctionLiveStrokes: liveStrokes,
    correctionNewStrokes: [retryStroke],
    issuedAt: "2026-08-30T00:00:01.000Z",
  };
  return {
    ...core,
    canonicalDigest: await canonicalSha256(core),
  };
}

async function imageFixture() {
  const width = 96, height = 64;
  const pixels = new Uint8Array(width * height * 3);
  pixels.fill(242);
  const png = await encodeRgbPng(width, height, pixels);
  const asset: PaperGradeSourceAsset = {
    path: "server-catalog/unit-page.png",
    sha256: await sha256Bytes(png),
    width,
    height,
    side: "left",
  };
  return { png, asset };
}

async function validInput() {
  const { png, asset } = await imageFixture();
  const receipt = await receiptFixture();
  const result = await preparePaperCorrectionGradeModelInputForCatalogAssets(
    "paper-mock-1",
    3,
    { type: "single", ans: [1], points: 5 },
    receipt,
    [asset],
    async () => png,
  );
  return { png, asset, receipt, result };
}

Deno.test("correction model input uses A/B/C and the full live-stroke snapshot", async () => {
  const { asset, receipt, result } = await validInput();
  assert(result);
  assertEquals(
    result.modelInputBinding.promptContractVersion,
    PAPER_CORRECTION_GRADE_PROMPT_CONTRACT_VERSION,
  );
  assertEquals(result.modelInputBinding.questionNo, 3);
  assertEquals(result.modelInputBinding.retryReceiptId, receipt.receiptId);
  assertEquals(
    result.modelInputBinding.retryReceiptDigest,
    receipt.canonicalDigest,
  );
  // old-stroke is not in correctionNewStrokes. Its presence proves the model
  // receives correctionLiveStrokes rather than only the newest delta.
  assertEquals(
    result.modelInputBinding.liveStrokeIds,
    ["old-stroke", "retry-stroke"],
  );
  assertEquals(result.modelInputBinding.liveStrokeCount, 2);
  assertEquals(result.modelInputBinding.source.path, asset.path);
  assertEquals(
    result.modelInputBinding.imageOrder.map((row: Record<string, unknown>) =>
      row.kind
    ),
    [
      "source-scan",
      "source-aligned-correction-ink",
      "full-workspace-correction-ink",
    ],
  );
  const content = result.input[0].content as Array<Record<string, unknown>>;
  assertEquals(content.filter((row) => row.type === "input_image").length, 3);
  const prompt = String(content[0].text || "");
  for (const state of ["correct", "incorrect", "unanswered", "uncertain"]) {
    assert(prompt.includes(state));
  }
  assert(prompt.includes("禁止回傳詳解"));
  assert(prompt.includes("第一錯步"));
});

Deno.test("same-page strokes for a different question fail closed", async () => {
  const { png, asset } = await imageFixture();
  // Mock-paper questions 3 and 4 are both logical page 0. Page equality alone
  // therefore cannot make this receipt valid for question 3.
  const question4Receipt = await receiptFixture(4);
  const result = await preparePaperCorrectionGradeModelInputForCatalogAssets(
    "paper-mock-1",
    3,
    { ans: [1] },
    question4Receipt,
    [asset],
    async () => png,
  );
  assertEquals(result, null);
});

Deno.test("tampered receipt digest and wrong source asset bytes fail closed", async () => {
  const { png, asset } = await imageFixture();
  const receipt = await receiptFixture();
  assertEquals(
    await preparePaperCorrectionGradeModelInputForCatalogAssets(
      "paper-mock-1",
      3,
      { ans: [1] },
      { ...receipt, canonicalDigest: "0".repeat(64) },
      [asset],
      async () => png,
    ),
    null,
  );
  const tampered = Uint8Array.from(png);
  tampered[tampered.length - 8] ^= 1;
  assertEquals(
    await preparePaperCorrectionGradeModelInputForCatalogAssets(
      "paper-mock-1",
      3,
      { ans: [1] },
      receipt,
      [asset],
      async () => tampered,
    ),
    null,
  );
});

Deno.test("browser composites and messages are not part of the authority API", async () => {
  const { result } = await validInput();
  assert(result);
  assertEquals(preparePaperCorrectionGradeModelInput.length, 5);
  assertEquals(
    preparePaperCorrectionGradeModelInputForCatalogAssets.length,
    6,
  );
  const serialized = JSON.stringify(result);
  for (
    const forbidden of [
      "browserComposite",
      "browserImage",
      "imageB64",
      "messages",
    ]
  ) assert(!serialized.includes(forbidden));
});

Deno.test("correction image request enforces decoded and encoded aggregate caps", () => {
  assert(
    paperCorrectionGradeRequestSizeAllowed(
      PAPER_CORRECTION_GRADE_MAX_DECODED_IMAGE_BYTES,
      PAPER_CORRECTION_GRADE_MAX_ENCODED_CHARS,
    ),
  );
  assertEquals(
    paperCorrectionGradeRequestSizeAllowed(
      PAPER_CORRECTION_GRADE_MAX_DECODED_IMAGE_BYTES + 1,
      1,
    ),
    false,
  );
  assertEquals(
    paperCorrectionGradeRequestSizeAllowed(
      1,
      PAPER_CORRECTION_GRADE_MAX_ENCODED_CHARS + 1,
    ),
    false,
  );
  assertEquals(paperCorrectionGradeRequestSizeAllowed(-1, 1), false);
  assertEquals(paperCorrectionGradeRequestSizeAllowed(1, 1.5), false);
});

Deno.test("unknown source cannot bypass the module-owned server catalog", async () => {
  const receipt = await receiptFixture();
  assertEquals(
    await preparePaperCorrectionGradeModelInput(
      "paper-not-in-server-catalog",
      3,
      { ans: [1] },
      receipt,
      async () => {
        throw new Error("fetcher must not run");
      },
    ),
    null,
  );
});
