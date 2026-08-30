import { canonicalSha256, paperGradeAcceptedSubmitAttempt } from "./lib.ts";
import type { PaperGradeSourceAsset } from "./paper-grade-assets.ts";
import {
  PAPER_DETAIL_MAX_DECODED_IMAGE_BYTES,
  PAPER_DETAIL_MAX_ENCODED_CHARS,
  PAPER_DETAIL_PROMPT_CONTRACT_VERSION,
  paperDetailRequestSizeAllowed,
  preparePaperDetailModelInput,
  preparePaperDetailModelInputForCatalogAssets,
} from "./paper-detail-model-input.ts";
import { encodeRgbPng, sha256Bytes } from "./paper-ink-render.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function assertEquals(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual), right = JSON.stringify(expected);
  if (left !== right) throw new Error("not equal: " + left + " != " + right);
}

async function correctionStroke(id: string, qno: number, offset: number) {
  const pts = [
    [0.15 + offset, 0.25, 0.5],
    [0.35 + offset, 0.45, 0.7],
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

async function sourceFixture() {
  const width = 96, height = 64;
  const pixels = new Uint8Array(width * height * 3);
  pixels.fill(246);
  // Non-uniform grayscale diagram: exact-byte preservation is observable.
  for (let x = 8; x < 88; x++) {
    const at = (31 * width + x) * 3;
    pixels[at] = pixels[at + 1] = pixels[at + 2] = 35;
  }
  for (let y = 10; y < 26; y++) {
    for (let x = 60; x < 82; x++) {
      const at = (y * width + x) * 3;
      pixels[at] = pixels[at + 1] = pixels[at + 2] = 155;
    }
  }
  const png = await encodeRgbPng(width, height, pixels);
  const asset: PaperGradeSourceAsset = {
    path: "server-catalog/diagram-gray-page.png",
    sha256: await sha256Bytes(png),
    width,
    height,
    side: "left",
  };
  return { png, asset };
}

async function authorityFixture(questionNo = 3) {
  const runId = "paper-run-1700000000000";
  const initialInk = {
    paper: true,
    revision: 4,
    s: [{
      id: "initial-untagged",
      t0: 1_700_000_000_000,
      t1: 1_700_000_000_100,
      w: 1,
      c: "black",
      pts: [[0.1, 0.2, 0.5], [0.3, 0.4, 0.7]],
    }, {
      id: "initial-other-question",
      qno: 4,
      t0: 1_700_000_000_200,
      t1: 1_700_000_000_300,
      w: 1,
      c: "green",
      pts: [[0.6, 0.5, 0.5], [0.8, 0.7, 0.7]],
    }],
    deleted: [],
  };
  const initialSha = await canonicalSha256(initialInk);
  const updatedAt = "2026-08-29T00:00:00.000Z";
  const pageManifest = Array.from({ length: 6 }, (_, page) => ({
    page,
    qid: "paper:" + runId + ":v2:" + page,
    clientId: page === 0 ? "accepted-page-zero" : "accepted-page-" + page,
    revision: page === 0 ? 4 : 0,
    cloudSha256: page === 0 ? initialSha : String(page).repeat(64),
    updatedAt,
  }));
  const rawAcceptedAttempt = {
    attempt_id: "paper-submit-unit-detail-1700000000000",
    run_id: runId,
    source_id: "paper-mock-1",
    status: "accepted",
    decision_reason: "accepted-first-for-run",
    remaining_ms: 1_000,
    ink_snapshot_sha256: "a".repeat(64),
    submitted_at: 1_700_000_100_000,
    accepted_at: "2023-11-14T22:15:01.000Z",
    run_created_app_version: "0830b",
    run_created_at: 1_700_000_000_000,
    paper_layout_version: 2,
    source_page_count: 6,
    freshness_confirmed_at: null,
    page_manifest: pageManifest,
  };
  const accepted = await paperGradeAcceptedSubmitAttempt(rawAcceptedAttempt);
  assert(accepted);

  const first = await correctionStroke("correction-a-old", questionNo, 0);
  const second = await correctionStroke("correction-b-new", questionNo, 0.1);
  const liveStrokes = [first, second];
  const liveDigests = [
    ...new Set(liveStrokes.map((stroke) => stroke.geometryDigest)),
  ].sort();
  const correctionCore = {
    authority: "supabase-immutable-paper-correction-retry-v1",
    receiptId: "paper-correction-retry-detail-1700000000000",
    runId,
    sourceId: "paper-mock-1",
    questionNo,
    acceptedAttemptId: accepted.attemptId,
    acceptedInkSnapshotSha256: accepted.inkSnapshotSha256,
    acceptedPageManifestSha256: await canonicalSha256(accepted.pageManifest),
    correctionPageManifest: [{
      page: 0,
      qid: "paper:" + runId + "-correction:v2:0",
      clientId: "detail-correction-client",
      revision: 7,
      cloudSha256: "c".repeat(64),
      updatedAt: "2026-08-30T00:00:00.000Z",
      serverUpdatedAt: "2026-08-30T00:00:00.000Z",
    }],
    correctionLiveStrokeIds: liveStrokes.map((stroke) => stroke.id),
    correctionNewStrokeIds: [second.id],
    correctionLiveStrokeDigests: liveDigests,
    correctionNewStrokeDigests: [second.geometryDigest],
    correctionLiveStrokes: liveStrokes,
    correctionNewStrokes: [second],
    issuedAt: "2026-08-30T00:00:01.000Z",
  };
  const correctionReceipt = {
    ...correctionCore,
    canonicalDigest: await canonicalSha256(correctionCore),
  };
  const acceptedInkPage = {
    page: 0,
    qid: pageManifest[0].qid,
    clientId: pageManifest[0].clientId,
    revision: pageManifest[0].revision,
    updatedAt: pageManifest[0].updatedAt,
    ink: initialInk,
  };
  return {
    accepted,
    rawAcceptedAttempt,
    acceptedInkPage,
    correctionReceipt,
  };
}

function decodeDataUrl(value: string) {
  const encoded = value.split(",", 2)[1] || "";
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

async function validInput() {
  const { png, asset } = await sourceFixture();
  const authority = await authorityFixture();
  const result = await preparePaperDetailModelInputForCatalogAssets(
    "paper-mock-1",
    3,
    { type: "single", ans: [1], points: 5 },
    authority.rawAcceptedAttempt,
    authority.acceptedInkPage,
    authority.correctionReceipt,
    {
      userNote: "我原本把負號看錯。",
      attemptLogs: [{
        attempt: 1,
        direction: "重新代入",
        topic: "代數",
        concept: "符號",
      }],
    },
    [asset],
    async () => png,
  );
  return { png, asset, ...authority, result };
}

Deno.test("detail input is server-owned A-E and binds both ink layers", async () => {
  const { result, accepted, correctionReceipt } = await validInput();
  assert(result);
  assertEquals(
    result.modelInputBinding.promptContractVersion,
    PAPER_DETAIL_PROMPT_CONTRACT_VERSION,
  );
  assertEquals(result.modelInputBinding.questionNo, 3);
  assertEquals(
    result.modelInputBinding.acceptedAttempt.canonicalDigest,
    accepted.canonicalDigest,
  );
  assertEquals(
    result.modelInputBinding.correction.retryReceiptDigest,
    correctionReceipt.canonicalDigest,
  );
  // Initial legacy ink is page-scoped and is never guessed away.
  assertEquals(
    result.modelInputBinding.acceptedInitialInk.liveStrokeIds,
    ["initial-other-question", "initial-untagged"],
  );
  // correction-a-old proves the full live snapshot, not only the newest delta.
  assertEquals(
    result.modelInputBinding.correction.liveStrokeIds,
    ["correction-a-old", "correction-b-new"],
  );
  assertEquals(
    result.modelInputBinding.imageOrder.map((row: Record<string, unknown>) =>
      row.kind
    ),
    [
      "source-scan",
      "accepted-initial-source-aligned-ink",
      "accepted-initial-full-workspace-ink",
      "correction-source-aligned-ink",
      "correction-full-workspace-ink",
    ],
  );
  const content = result.input[0].content as Array<Record<string, unknown>>;
  assertEquals(content.filter((row) => row.type === "input_image").length, 5);
  const prompt = String(content[0].text || "");
  for (
    const expected of [
      "goodWork",
      "firstErrorEvidence",
      "whyWrong",
      "repair",
      "solution",
      "非權威背景",
    ]
  ) assert(prompt.includes(expected));
});

Deno.test("source diagram and grayscale PNG is forwarded byte-for-byte", async () => {
  const { png, result } = await validInput();
  assert(result);
  const content = result.input[0].content as Array<Record<string, unknown>>;
  const images = content.filter((row) => row.type === "input_image");
  assertEquals([...decodeDataUrl(String(images[0].image_url))], [...png]);
  assertEquals(
    result.modelInputBinding.imageOrder[0].sha256,
    await sha256Bytes(png),
  );
});

Deno.test("question number is exact on a shared logical page", async () => {
  const { png, asset } = await sourceFixture();
  const authority = await authorityFixture(4);
  assertEquals(
    await preparePaperDetailModelInputForCatalogAssets(
      "paper-mock-1",
      3,
      { ans: [1] },
      authority.rawAcceptedAttempt,
      authority.acceptedInkPage,
      authority.correctionReceipt,
      undefined,
      [asset],
      async () => png,
    ),
    null,
  );
});

Deno.test("accepted page, retry receipt and asset digests fail closed", async () => {
  const { png, asset } = await sourceFixture();
  const authority = await authorityFixture();
  const invoke = (
    acceptedInkPage: typeof authority.acceptedInkPage,
    correctionReceipt: unknown,
    bytes = png,
  ) =>
    preparePaperDetailModelInputForCatalogAssets(
      "paper-mock-1",
      3,
      { ans: [1] },
      authority.rawAcceptedAttempt,
      acceptedInkPage,
      correctionReceipt,
      undefined,
      [asset],
      async () => bytes,
    );
  const mutatedInk = structuredClone(authority.acceptedInkPage.ink);
  mutatedInk.revision = 5;
  assertEquals(
    await invoke(
      { ...authority.acceptedInkPage, ink: mutatedInk },
      authority.correctionReceipt,
    ),
    null,
  );
  assertEquals(
    await invoke(authority.acceptedInkPage, {
      ...authority.correctionReceipt,
      canonicalDigest: "0".repeat(64),
    }),
    null,
  );
  const tampered = Uint8Array.from(png);
  tampered[tampered.length - 8] ^= 1;
  assertEquals(
    await invoke(
      authority.acceptedInkPage,
      authority.correctionReceipt,
      tampered,
    ),
    null,
  );
});

Deno.test("browser input is absent and bounded background rejects overflow", async () => {
  const { png, asset } = await sourceFixture();
  const authority = await authorityFixture();
  assertEquals(preparePaperDetailModelInput.length, 8);
  assertEquals(preparePaperDetailModelInputForCatalogAssets.length, 9);
  assertEquals(
    await preparePaperDetailModelInputForCatalogAssets(
      "paper-mock-1",
      3,
      { ans: [1] },
      authority.rawAcceptedAttempt,
      authority.acceptedInkPage,
      authority.correctionReceipt,
      { userNote: "x".repeat(501) },
      [asset],
      async () => png,
    ),
    null,
  );
  const { result } = await validInput();
  assert(result);
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

Deno.test("geometry and aggregate byte bounds reject invalid requests", async () => {
  assert(
    paperDetailRequestSizeAllowed(
      5,
      PAPER_DETAIL_MAX_DECODED_IMAGE_BYTES,
      PAPER_DETAIL_MAX_ENCODED_CHARS,
    ),
  );
  assertEquals(
    paperDetailRequestSizeAllowed(
      4,
      PAPER_DETAIL_MAX_DECODED_IMAGE_BYTES,
      PAPER_DETAIL_MAX_ENCODED_CHARS,
    ),
    false,
  );
  assertEquals(
    paperDetailRequestSizeAllowed(
      5,
      PAPER_DETAIL_MAX_DECODED_IMAGE_BYTES + 1,
      1,
    ),
    false,
  );
  assertEquals(
    paperDetailRequestSizeAllowed(
      5,
      1,
      PAPER_DETAIL_MAX_ENCODED_CHARS + 1,
    ),
    false,
  );

  const { png, asset } = await sourceFixture();
  const authority = await authorityFixture();
  const receipt = structuredClone(authority.correctionReceipt);
  receipt.correctionLiveStrokes[0].pts[0][0] = -0.1;
  const { canonicalDigest: _oldDigest, ...core } = receipt;
  receipt.canonicalDigest = await canonicalSha256(core);
  assertEquals(
    await preparePaperDetailModelInputForCatalogAssets(
      "paper-mock-1",
      3,
      { ans: [1] },
      authority.rawAcceptedAttempt,
      authority.acceptedInkPage,
      receipt,
      undefined,
      [asset],
      async () => png,
    ),
    null,
  );
});

Deno.test("unknown source cannot bypass the module-owned catalog", async () => {
  const authority = await authorityFixture();
  assertEquals(
    await preparePaperDetailModelInput(
      "paper-not-in-server-catalog",
      3,
      { ans: [1] },
      authority.rawAcceptedAttempt,
      authority.acceptedInkPage,
      authority.correctionReceipt,
      undefined,
      async () => {
        throw new Error("fetcher must not run");
      },
    ),
    null,
  );
});
