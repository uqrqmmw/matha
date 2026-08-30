import {
  bytesToDataUrl,
  canonicalPaperInk,
  inspectPngDimensions,
  PAPER_INK_RENDERER_VERSION,
  PAPER_INK_WORKSPACE_HEIGHT,
  PAPER_INK_WORKSPACE_WIDTH,
  renderPaperInkAuthority,
  sha256Bytes,
} from "./paper-ink-render.ts";
import {
  PAPER_GRADE_ASSET_CATALOG_VERSION,
  PAPER_GRADE_SOURCE_ASSETS,
} from "./paper-grade-assets.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function assertEquals(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual), right = JSON.stringify(expected);
  if (left !== right) throw new Error(`not equal: ${left} != ${right}`);
}

const validInk = {
  paper: true,
  revision: 2,
  s: [{
    id: "stroke-1",
    t0: 1_700_000_000_000,
    t1: 1_700_000_000_100,
    w: 1,
    c: "blue",
    qno: 3,
    pts: [[0.1, 0.2, 0.5], [0.2, 0.3, 0.7]],
  }, {
    id: "stroke-2",
    t0: 1_700_000_000_200,
    t1: 1_700_000_000_300,
    w: 0.5,
    c: "black",
    qno: 4,
    pts: [[0.8, 0.5, 0.4], [0.9, 0.6, 0.4]],
  }],
  deleted: [],
};

Deno.test("paper grading asset catalog covers every server grading source exactly", () => {
  assert(PAPER_GRADE_ASSET_CATALOG_VERSION.includes("20260830"));
  const expected: Record<string, number> = {
    "paper-mock-1": 6,
    "paper-mock-3": 4,
    "paper-official-110-trial": 8,
    "paper-official-111": 8,
    "paper-official-112": 8,
    "paper-official-113": 8,
    "paper-official-114": 8,
    "paper-official-115": 8,
    "paper-regional-ra1103": 3,
    "paper-regional-ra1104": 3,
    "paper-regional-ra2100": 3,
    "paper-regional-ra2101": 3,
    "paper-regional-ra3101": 3,
    "paper-regional-ra3102": 3,
    "paper-regional-ra4109": 4,
    "paper-regional-ra4110": 3,
  };
  assertEquals(
    Object.keys(PAPER_GRADE_SOURCE_ASSETS).sort(),
    Object.keys(expected).sort(),
  );
  for (const [sourceId, count] of Object.entries(expected)) {
    const pages = PAPER_GRADE_SOURCE_ASSETS[sourceId];
    assertEquals(pages.length, count);
    for (const page of pages) {
      assert(/^[a-f0-9]{64}$/.test(page.sha256));
      assert(page.path.endsWith(".png") && !page.path.includes(".."));
      assert(page.width * page.height > 100_000);
    }
  }
});

Deno.test("canonical ink is finite, bounded, deletion aware and question scoped", () => {
  const all = canonicalPaperInk(validInk);
  assert(all);
  assertEquals(all.strokes.map((stroke) => stroke.id), [
    "stroke-1",
    "stroke-2",
  ]);
  const q3 = canonicalPaperInk(validInk, 3);
  assert(q3);
  assertEquals(q3.strokes.map((stroke) => stroke.id), ["stroke-1"]);
  const deleted = canonicalPaperInk({ ...validInk, deleted: ["stroke-1"] });
  assert(deleted);
  assertEquals(deleted.strokes.map((stroke) => stroke.id), ["stroke-2"]);
  assertEquals(
    canonicalPaperInk({
      ...validInk,
      s: [{ ...validInk.s[0], pts: [[NaN, 0], [0, 1]] }],
    }),
    null,
  );
  assertEquals(
    canonicalPaperInk({
      ...validInk,
      s: [{ ...validInk.s[0], pts: [[-0.1, 0], [0, 1]] }],
    }),
    null,
  );
  assertEquals(canonicalPaperInk({ ...validInk, deleted: ["x", "x"] }), null);
});

Deno.test("renderer creates deterministic aligned and workspace PNGs", async () => {
  assert(PAPER_INK_RENDERER_VERSION.includes("20260830"));
  const asset = PAPER_GRADE_SOURCE_ASSETS["paper-mock-3"][0];
  const first = await renderPaperInkAuthority(asset, validInk);
  const second = await renderPaperInkAuthority(asset, validInk);
  assert(first && second);
  assertEquals(inspectPngDimensions(first.sourceAlignedPng), {
    width: asset.width,
    height: asset.height,
  });
  assertEquals(inspectPngDimensions(first.workspacePng), {
    width: PAPER_INK_WORKSPACE_WIDTH,
    height: PAPER_INK_WORKSPACE_HEIGHT,
  });
  assertEquals(
    await sha256Bytes(first.sourceAlignedPng),
    await sha256Bytes(second.sourceAlignedPng),
  );
  assertEquals(
    await sha256Bytes(first.workspacePng),
    await sha256Bytes(second.workspacePng),
  );
  assert(
    bytesToDataUrl(first.workspacePng).startsWith(
      "data:image/png;base64,iVBOR",
    ),
  );
});

Deno.test("left and right side transforms cannot be swapped", async () => {
  const left = PAPER_GRADE_SOURCE_ASSETS["paper-mock-3"][0];
  const right = PAPER_GRADE_SOURCE_ASSETS["paper-mock-3"][1];
  const renderedLeft = await renderPaperInkAuthority(left, validInk);
  const renderedRight = await renderPaperInkAuthority(right, validInk);
  assert(renderedLeft && renderedRight);
  assert(
    (await sha256Bytes(renderedLeft.sourceAlignedPng)) !==
      (await sha256Bytes(renderedRight.sourceAlignedPng)),
  );
});

Deno.test("question filter rejects old untagged correction ink", () => {
  const legacy = {
    ...validInk,
    s: validInk.s.map(({ qno: _qno, ...stroke }) => stroke),
  };
  const result = canonicalPaperInk(legacy, 3);
  assert(result);
  assertEquals(result.strokes, []);
});
