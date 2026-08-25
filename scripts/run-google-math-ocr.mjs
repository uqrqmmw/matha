#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

const HELP = `Usage:
  node scripts/run-google-math-ocr.mjs --input-dir <page-images> --output <dir> \\
    --processor <full-processor-resource> [--concurrency 1..8] [--delayMs 250]

  node scripts/run-google-math-ocr.mjs --input <file[,file...]> --output <dir> \\
    --project <project-id> --location <region> --processor <processor-id>

The runner enables Google Enterprise Document OCR Math OCR, records the exact
source SHA-256 beside every response, retries transient failures, refreshes an
expiring gcloud access token, and reuses only outputs with a matching hash.`;

function parseArgs(argv) {
  const result = { location: "us", delayMs: 250, concurrency: 1 };
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    result[name] = value;
    i += 1;
  }
  if (!result.processor) throw new Error("--processor is required");
  if (!result.output) throw new Error("--output is required");
  if (!result.input && !result["input-dir"]) {
    throw new Error("Provide --input or --input-dir");
  }
  if (!result.processor.startsWith("projects/") && !result.project) {
    throw new Error("--project is required when --processor is not a full resource name");
  }
  result.delayMs = Number(result.delayMs);
  result.concurrency = Math.max(1, Math.min(8, Number(result.concurrency)));
  return result;
}

function mimeType(path) {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  if (ext === ".pdf") return "application/pdf";
  throw new Error(`Unsupported input type: ${ext}`);
}

function accessToken() {
  if (process.platform === "win32") {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "& gcloud auth print-access-token"],
      { encoding: "utf8", windowsHide: true },
    ).trim();
  }
  return execFileSync("gcloud", ["auth", "print-access-token"], {
    encoding: "utf8",
  }).trim();
}

let tokenState = { value: "", refreshAt: 0 };

function currentAccessToken(force = false) {
  if (force || !tokenState.value || Date.now() >= tokenState.refreshAt) {
    tokenState = { value: accessToken(), refreshAt: Date.now() + 45 * 60 * 1000 };
  }
  return tokenState.value;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function requestWithRetry(url, body) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    let token = currentAccessToken();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (response.ok) return response.json();
    const detail = await response.text();
    lastError = new Error(`Document AI ${response.status}: ${detail}`);
    if (response.status === 401 && attempt < 5) {
      token = currentAccessToken(true);
      continue;
    }
    if (![429, 500, 502, 503, 504].includes(response.status)) throw lastError;
    await sleep(750 * 2 ** (attempt - 1));
  }
  throw lastError;
}

async function atomicJson(path, value) {
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const outputDir = resolve(args.output);
  const directInputs = args.input
    ? args.input.split(",").map((item) => resolve(item.trim())).filter(Boolean)
    : [];
  const directoryInputs = args["input-dir"]
    ? (await readdir(resolve(args["input-dir"]), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.(png|jpe?g|tiff?|pdf)$/i.test(entry.name))
      .map((entry) => resolve(args["input-dir"], entry.name))
    : [];
  const inputs = [...new Set([...directInputs, ...directoryInputs])].sort();
  if (!inputs.length) throw new Error("No supported input files found");
  await mkdir(outputDir, { recursive: true });

  const processor = args.processor.startsWith("projects/")
    ? args.processor
    : `projects/${args.project}/locations/${args.location}/processors/${args.processor}`;
  const url = `https://${args.location}-documentai.googleapis.com/v1/${processor}:process`;
  const manifest = new Array(inputs.length);
  let cursor = 0;

  async function processOne(input, index) {
    const bytes = await readFile(input);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const outputName = `${basename(input, extname(input))}.document-ai.json`;
    const outputPath = join(outputDir, outputName);
    let reused = false;

    try {
      const existing = JSON.parse(await readFile(outputPath, "utf8"));
      reused = existing?._mathaSource?.sha256 === digest;
    } catch {
      reused = false;
    }

    if (!reused) {
      const response = await requestWithRetry(url, {
        rawDocument: {
          content: bytes.toString("base64"),
          mimeType: mimeType(input),
        },
        processOptions: {
          ocrConfig: {
            enableImageQualityScores: true,
            premiumFeatures: { enableMathOcr: true },
          },
        },
        fieldMask: "text,pages.pageNumber,pages.dimension,pages.layout,pages.blocks,pages.paragraphs,pages.lines,pages.tokens,pages.visualElements,pages.detectedLanguages,pages.imageQualityScores",
      });
      response._mathaSource = {
        input,
        sha256: digest,
        bytes: (await stat(input)).size,
        processor,
        processedAt: new Date().toISOString(),
      };
      await atomicJson(outputPath, response);
    }

    manifest[index] = { input, output: outputPath, sha256: digest, reused };
    process.stdout.write(`${reused ? "reused" : "processed"}: ${basename(input)}\n`);
    if (!reused) await sleep(args.delayMs);
  }

  async function worker() {
    while (cursor < inputs.length) {
      const index = cursor;
      cursor += 1;
      await processOne(inputs[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(args.concurrency, inputs.length) }, worker));

  await atomicJson(join(outputDir, "manifest.json"), {
    schema: 1,
    kind: "google-document-ai-math-ocr-run",
    processor,
    generatedAt: new Date().toISOString(),
    files: manifest,
  });
  process.stdout.write(`completed: ${manifest.length} file(s)\n`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
