import { encodeRgbPng, sha256Bytes } from "./paper-ink-render.ts";
import {
  PAPER_GRADE_MAX_DATA_URL_CHARS,
  PAPER_GRADE_MAX_IMAGE_COUNT,
  PAPER_GRADE_MAX_TOTAL_IMAGE_BYTES,
  PAPER_GRADE_PROMPT_CONTRACT_VERSION,
  paperGradeRequestSizeAllowed,
  preparePaperGradeModelInputForAssets,
  verifiedPaperGradeAsset,
} from "./paper-grade-model-input.ts";
import type { PaperGradeSourceAsset } from "./paper-grade-assets.ts";
import { canonicalSha256 } from "./lib.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function assertEquals(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual), right = JSON.stringify(expected);
  if (left !== right) throw new Error(`not equal: ${left} != ${right}`);
}

async function fixture() {
  const width = 96, height = 64;
  const pixels = new Uint8Array(width * height * 3);
  pixels.fill(245);
  const png = await encodeRgbPng(width, height, pixels);
  const asset: PaperGradeSourceAsset = {
    path: "fixture/page.png",
    sha256: await sha256Bytes(png),
    width,
    height,
    side: "full",
  };
  const ink = {
    paper: true,
    revision: 1,
    s: [{
      id: "stroke-server-1",
      t0: 1_700_000_000_000,
      t1: 1_700_000_000_100,
      w: 1,
      c: "black",
      pts: [[0.1, 0.2, 0.5], [0.3, 0.4, 0.6]],
    }],
    deleted: [],
  };
  return { png, asset, ink };
}

Deno.test("storage bytes require catalog SHA and exact PNG dimensions", async () => {
  const { png, asset } = await fixture();
  assert(await verifiedPaperGradeAsset(asset, png));
  const tampered = Uint8Array.from(png);
  tampered[tampered.length - 8] ^= 1;
  assertEquals(await verifiedPaperGradeAsset(asset, tampered), null);
  assertEquals(
    await verifiedPaperGradeAsset({ ...asset, width: asset.width + 1 }, png),
    null,
  );
});

Deno.test("model input is built only from server source and frozen ink", async () => {
  const { png, asset, ink } = await fixture();
  const result = await preparePaperGradeModelInputForAssets(
    "fixture-source",
    Array.from({ length: 20 }, (_, index) => ({
      type: "single",
      ans: [index % 5],
      points: 5,
    })),
    [asset],
    [{
      page: 0,
      revision: 1,
      serverInkSha256: await canonicalSha256(ink),
      ink,
    }],
    async () => png,
  );
  assert(result);
  assertEquals(
    result.modelInputBinding.promptContractVersion,
    PAPER_GRADE_PROMPT_CONTRACT_VERSION,
  );
  assertEquals(result.modelInputBinding.pageCount, 1);
  assertEquals(result.modelInputBinding.imageOrder.length, 3);
  assertEquals(
    result.modelInputBinding.imageOrder.map((row: Record<string, unknown>) =>
      row.kind
    ),
    ["source-scan", "source-aligned-ink", "full-workspace-ink"],
  );
  const content = result.input[0].content as Array<Record<string, unknown>>;
  assertEquals(content.filter((row) => row.type === "input_image").length, 3);
  assert(
    content.filter((row) => row.type === "input_image").every((row) =>
      String(row.image_url).startsWith("data:image/png;base64,")
    ),
  );
});

Deno.test("wrong ink hash and swapped side are fail closed", async () => {
  const { png, asset, ink } = await fixture();
  const answerKey = Array.from({ length: 20 }, () => ({
    type: "single",
    ans: [0],
    points: 5,
  }));
  const bad = await preparePaperGradeModelInputForAssets(
    "fixture-source",
    answerKey,
    [asset],
    [{ page: 0, revision: 1, serverInkSha256: "0".repeat(64), ink }],
    async () => png,
  );
  assertEquals(bad, null);
  const full = await preparePaperGradeModelInputForAssets(
    "fixture-source",
    answerKey,
    [asset],
    [{
      page: 0,
      revision: 1,
      serverInkSha256: await canonicalSha256(ink),
      ink,
    }],
    async () => png,
  );
  const left = await preparePaperGradeModelInputForAssets(
    "fixture-source",
    answerKey,
    [{ ...asset, side: "left" }],
    [{
      page: 0,
      revision: 1,
      serverInkSha256: await canonicalSha256(ink),
      ink,
    }],
    async () => png,
  );
  assert(full && left);
  assert(
    full.modelInputBinding.canonicalDigest !==
      left.modelInputBinding.canonicalDigest,
  );
});

Deno.test("model request has explicit aggregate image and encoding caps", () => {
  assert(paperGradeRequestSizeAllowed(24, 24_000_000, 35_000_000));
  assertEquals(
    paperGradeRequestSizeAllowed(
      PAPER_GRADE_MAX_IMAGE_COUNT + 1,
      1,
      1,
    ),
    false,
  );
  assertEquals(
    paperGradeRequestSizeAllowed(
      1,
      PAPER_GRADE_MAX_TOTAL_IMAGE_BYTES + 1,
      1,
    ),
    false,
  );
  assertEquals(
    paperGradeRequestSizeAllowed(
      1,
      1,
      PAPER_GRADE_MAX_DATA_URL_CHARS + 1,
    ),
    false,
  );
});
