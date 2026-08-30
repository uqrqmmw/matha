import type { PaperGradeSourceAsset } from "./paper-grade-assets.ts";

export const PAPER_INK_RENDERER_VERSION = "paper-ink-authority-v1-20260830";
export const PAPER_INK_WORKSPACE_WIDTH = 768;
export const PAPER_INK_WORKSPACE_HEIGHT = Math.round(
  PAPER_INK_WORKSPACE_WIDTH * 2535 / 2112,
);

const MAX_STROKES = 4_000;
const MAX_POINTS_PER_STROKE = 12_000;
const MAX_TOTAL_POINTS = 300_000;
const MAX_SOURCE_PIXELS = 12_000_000;
const MAX_PNG_BYTES = 12_000_000;
const COLORS: Record<string, readonly [number, number, number]> = {
  black: [52, 58, 54],
  blue: [49, 95, 120],
  green: [79, 113, 88],
};

export type CanonicalPaperInkStroke = {
  id: string;
  t0: number;
  t1: number | null;
  w: number;
  c: "black" | "blue" | "green";
  qno?: number;
  pts: Array<[number, number, number]>;
};

export type CanonicalPaperInk = {
  strokes: CanonicalPaperInkStroke[];
  deleted: string[];
  totalPoints: number;
};

function finiteInRange(value: unknown, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max
    ? number
    : null;
}

/**
 * Treat database JSON as hostile.  The renderer never coerces malformed
 * points, silently resurrects deleted strokes, or accepts duplicate IDs.
 */
export function canonicalPaperInk(
  raw: unknown,
  requiredQuestionNo: number | null = null,
): CanonicalPaperInk | null {
  const payload = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const source = Array.isArray(payload.s) ? payload.s : null;
  const rawDeleted = Array.isArray(payload.deleted) ? payload.deleted : null;
  if (!source || !rawDeleted || source.length > MAX_STROKES) return null;
  const deleted = rawDeleted.map((value) => String(value || ""));
  if (
    deleted.some((id) => !id || id.length > 180) ||
    new Set(deleted).size !== deleted.length
  ) return null;
  const deletedSet = new Set(deleted);
  const ids = new Set<string>();
  const strokes: CanonicalPaperInkStroke[] = [];
  let totalPoints = 0;
  for (const rawStroke of source) {
    if (
      !rawStroke || typeof rawStroke !== "object" || Array.isArray(rawStroke)
    ) {
      return null;
    }
    const stroke = rawStroke as Record<string, unknown>;
    const id = String(stroke.id || "");
    if (!id || id.length > 180 || ids.has(id)) return null;
    ids.add(id);
    if (stroke.dead === true || deletedSet.has(id)) continue;
    const qno = stroke.qno == null ? null : Number(stroke.qno);
    if (
      qno != null && (!Number.isInteger(qno) || qno < 1 || qno > 20)
    ) return null;
    if (requiredQuestionNo != null && qno !== requiredQuestionNo) continue;
    const points = Array.isArray(stroke.pts) ? stroke.pts : null;
    if (!points || points.length < 2 || points.length > MAX_POINTS_PER_STROKE) {
      return null;
    }
    totalPoints += points.length;
    if (totalPoints > MAX_TOTAL_POINTS) return null;
    const canonicalPoints: Array<[number, number, number]> = [];
    for (const point of points) {
      if (!Array.isArray(point) || point.length < 2 || point.length > 3) {
        return null;
      }
      const x = finiteInRange(point[0], 0, 1);
      const y = finiteInRange(point[1], 0, 1);
      const pressure = point.length > 2 ? finiteInRange(point[2], 0, 1) : 0.5;
      if (x == null || y == null || pressure == null) return null;
      canonicalPoints.push([x, y, pressure]);
    }
    const width = finiteInRange(stroke.w, 0.35, 2);
    const color = String(stroke.c || "black");
    const t0 = Number(stroke.t0);
    const t1 = stroke.t1 == null ? null : Number(stroke.t1);
    if (
      width == null || !Object.hasOwn(COLORS, color) ||
      !Number.isSafeInteger(t0) || t0 <= 0 ||
      (t1 != null && (!Number.isSafeInteger(t1) || t1 < t0))
    ) return null;
    const normalized: CanonicalPaperInkStroke = {
      id,
      t0,
      t1,
      w: width,
      c: color as CanonicalPaperInkStroke["c"],
      pts: canonicalPoints,
    };
    if (qno != null) normalized.qno = qno;
    strokes.push(normalized);
  }
  strokes.sort((left, right) => left.id.localeCompare(right.id));
  deleted.sort();
  return { strokes, deleted, totalPoints };
}

function u32be(value: number) {
  return new Uint8Array([
    value >>> 24 & 255,
    value >>> 16 & 255,
    value >>> 8 & 255,
    value & 255,
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: readonly Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array) {
  const kind = new TextEncoder().encode(type);
  const content = concatBytes([kind, data]);
  return concatBytes([u32be(data.length), content, u32be(crc32(content))]);
}

async function deflate(bytes: Uint8Array) {
  const owned = Uint8Array.from(bytes);
  const stream = new Blob([owned.buffer]).stream().pipeThrough(
    new CompressionStream("deflate"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeRgbPng(
  width: number,
  height: number,
  pixels: Uint8Array,
) {
  if (
    !Number.isInteger(width) || !Number.isInteger(height) || width < 1 ||
    height < 1 || width * height > MAX_SOURCE_PIXELS ||
    pixels.length !== width * height * 3
  ) throw new Error("invalid PNG dimensions");
  const scanlines = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const target = y * (1 + width * 3);
    scanlines[target] = 0;
    scanlines.set(
      pixels.subarray(y * width * 3, (y + 1) * width * 3),
      target + 1,
    );
  }
  const ihdr = concatBytes([
    u32be(width),
    u32be(height),
    new Uint8Array([8, 2, 0, 0, 0]),
  ]);
  const png = concatBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", await deflate(scanlines)),
    pngChunk("IEND", new Uint8Array()),
  ]);
  if (png.length > MAX_PNG_BYTES) throw new Error("rendered PNG too large");
  return png;
}

export function inspectPngDimensions(bytes: Uint8Array) {
  if (
    bytes.length < 24 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) =>
      bytes[index] === value
    ) ||
    new TextDecoder().decode(bytes.subarray(12, 16)) !== "IHDR"
  ) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 && width * height <= MAX_SOURCE_PIXELS
    ? { width, height }
    : null;
}

function whitePixels(width: number, height: number) {
  const pixels = new Uint8Array(width * height * 3);
  pixels.fill(255);
  return pixels;
}

function putPixel(
  pixels: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  color: readonly [number, number, number],
) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const index = (y * width + x) * 3;
  pixels[index] = color[0];
  pixels[index + 1] = color[1];
  pixels[index + 2] = color[2];
}

function disc(
  pixels: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
  color: readonly [number, number, number],
) {
  const r = Math.max(1, Math.min(16, Math.ceil(radius)));
  const cx = Math.round(x), cy = Math.round(y);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= radius * radius + 0.75) {
        putPixel(pixels, width, height, cx + dx, cy + dy, color);
      }
    }
  }
}

function segment(
  pixels: Uint8Array,
  width: number,
  height: number,
  from: readonly number[],
  to: readonly number[],
  radius: number,
  color: readonly [number, number, number],
) {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) * 1.3));
  for (let step = 0; step <= steps; step++) {
    const ratio = step / steps;
    disc(
      pixels,
      width,
      height,
      from[0] + dx * ratio,
      from[1] + dy * ratio,
      radius,
      color,
    );
  }
}

function strokeRadius(stroke: CanonicalPaperInkStroke, outputScale: number) {
  const pressure = stroke.pts.reduce((sum, point) => sum + point[2], 0) /
    stroke.pts.length;
  return Math.max(
    0.8,
    (1.35 + Math.max(0.15, pressure) * 1.5) * stroke.w * outputScale / 2,
  );
}

function drawWorkspace(
  pixels: Uint8Array,
  width: number,
  height: number,
  ink: CanonicalPaperInk,
) {
  // Make the transform visible to the model without inserting untrusted text.
  const border: [number, number, number] = [210, 205, 196];
  const x0 = Math.round(width * 0.03), y0 = Math.round(height * 0.025);
  const x1 = Math.round(width * 0.97), y1 = Math.round(height * 0.965);
  for (let x = x0; x <= x1; x++) {
    putPixel(pixels, width, height, x, y0, border);
    putPixel(pixels, width, height, x, y1, border);
  }
  for (let y = y0; y <= y1; y++) {
    putPixel(pixels, width, height, x0, y, border);
    putPixel(pixels, width, height, x1, y, border);
  }
  for (const stroke of ink.strokes) {
    const points = stroke.pts.map((
      point,
    ) => [point[0] * width, point[1] * height]);
    const radius = strokeRadius(stroke, width / 1536);
    for (let index = 1; index < points.length; index++) {
      segment(
        pixels,
        width,
        height,
        points[index - 1],
        points[index],
        radius,
        COLORS[stroke.c],
      );
    }
  }
}

function sourceTransform(
  asset: PaperGradeSourceAsset,
  point: readonly number[],
) {
  const cropWidth = asset.side === "full" ? 0.8 : 0.708;
  const x = (point[0] - 0.03) / cropWidth;
  const y = (point[1] - 0.025) / 0.94;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  if (asset.side === "full") return [x * asset.width, y * asset.height];
  const half = asset.width / 2;
  const offset = asset.side === "right" ? half : 0;
  return [offset + x * half, y * asset.height];
}

function drawSourceAligned(
  pixels: Uint8Array,
  asset: PaperGradeSourceAsset,
  ink: CanonicalPaperInk,
) {
  for (const stroke of ink.strokes) {
    const radiusScale = asset.side === "full"
      ? asset.width / (1536 * 0.8)
      : (asset.width / 2) / (1536 * 0.708);
    const radius = strokeRadius(stroke, radiusScale);
    for (let index = 1; index < stroke.pts.length; index++) {
      const from = sourceTransform(asset, stroke.pts[index - 1]);
      const to = sourceTransform(asset, stroke.pts[index]);
      // A crossing segment is still represented in the full-workspace image;
      // source alignment only includes geometry entirely within the scan crop.
      if (!from || !to) continue;
      segment(
        pixels,
        asset.width,
        asset.height,
        from,
        to,
        radius,
        COLORS[stroke.c],
      );
    }
  }
}

export async function renderPaperInkAuthority(
  asset: PaperGradeSourceAsset,
  rawInk: unknown,
  requiredQuestionNo: number | null = null,
) {
  if (
    !Number.isInteger(asset.width) || !Number.isInteger(asset.height) ||
    asset.width < 1 || asset.height < 1 ||
    asset.width * asset.height > MAX_SOURCE_PIXELS ||
    !["left", "right", "full"].includes(asset.side)
  ) return null;
  const ink = canonicalPaperInk(rawInk, requiredQuestionNo);
  if (!ink) return null;
  const alignedPixels = whitePixels(asset.width, asset.height);
  drawSourceAligned(alignedPixels, asset, ink);
  const workspacePixels = whitePixels(
    PAPER_INK_WORKSPACE_WIDTH,
    PAPER_INK_WORKSPACE_HEIGHT,
  );
  drawWorkspace(
    workspacePixels,
    PAPER_INK_WORKSPACE_WIDTH,
    PAPER_INK_WORKSPACE_HEIGHT,
    ink,
  );
  return {
    ink,
    sourceAlignedPng: await encodeRgbPng(
      asset.width,
      asset.height,
      alignedPixels,
    ),
    workspacePng: await encodeRgbPng(
      PAPER_INK_WORKSPACE_WIDTH,
      PAPER_INK_WORKSPACE_HEIGHT,
      workspacePixels,
    ),
  };
}

export async function sha256Bytes(bytes: Uint8Array) {
  const owned = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned.buffer);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  )
    .join("");
}

export function bytesToDataUrl(bytes: Uint8Array, mediaType = "image/png") {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return `data:${mediaType};base64,${btoa(binary)}`;
}
