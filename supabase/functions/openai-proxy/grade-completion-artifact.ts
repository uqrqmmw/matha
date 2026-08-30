export const PAPER_GRADE_COMPLETION_ARTIFACT_KIND =
  "matha-paper-grade-completion-artifact-v1";
export const PAPER_GRADE_COMPLETION_ARTIFACT_BUCKET = "matha-audit-private";
export const PAPER_GRADE_COMPLETION_ARTIFACT_MAX_BYTES = 2_000_000;
export const PAPER_GRADE_DISPATCH_LOST_AFTER_MS = 15 * 60 * 1000;

export type PaperGradeCompletionIdentity = {
  userBinding: string;
  runId: string;
  acceptedAttemptId: string;
  generation: number;
  modelInputBindingSha256: string;
};

function canonicalJson(value: unknown): string {
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

async function canonicalSha256(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function validIdentity(
  raw: Partial<PaperGradeCompletionIdentity>,
): raw is PaperGradeCompletionIdentity {
  return /^matha_[a-f0-9]{32}$/.test(String(raw.userBinding || "")) &&
    /^paper-run-[0-9]{10,20}$/.test(String(raw.runId || "")) &&
    /^paper-submit-[A-Za-z0-9._:-]{16,127}$/.test(
      String(raw.acceptedAttemptId || ""),
    ) && Number.isInteger(raw.generation) && Number(raw.generation) >= 0 &&
    Number(raw.generation) <= 2147483647 &&
    /^[a-f0-9]{64}$/.test(String(raw.modelInputBindingSha256 || ""));
}

function normalizedJsonObject(value: unknown) {
  try {
    const normalized = JSON.parse(JSON.stringify(value));
    return normalized && typeof normalized === "object" &&
        !Array.isArray(normalized)
      ? normalized as Record<string, unknown>
      : null;
  } catch (_) {
    return null;
  }
}

/** Every immutable job binding is present in this non-listable private path. */
export function paperGradeCompletionArtifactPath(
  identity: Partial<PaperGradeCompletionIdentity>,
) {
  if (!validIdentity(identity)) return null;
  return `grade-completions/${identity.userBinding}/${identity.runId}/${identity.acceptedAttemptId}/generation-${identity.generation}/input-${identity.modelInputBindingSha256}.json`;
}

/** No clock or random value is included: a crash retry must reproduce exactly
 * the same object bytes, not overwrite a path with a second representation. */
export async function buildPaperGradeCompletionArtifact(
  identity: Partial<PaperGradeCompletionIdentity>,
  normalizedModelJson: unknown,
  modelMetadata: unknown,
  receiptEnvelope: unknown,
) {
  const path = paperGradeCompletionArtifactPath(identity);
  const normalizedResult = normalizedJsonObject(normalizedModelJson);
  const normalizedMetadata = normalizedJsonObject(modelMetadata);
  const normalizedReceipt = normalizedJsonObject(receiptEnvelope);
  if (!path || !normalizedResult || !normalizedMetadata || !normalizedReceipt) {
    return null;
  }
  const contentDigests = {
    normalizedModelJsonSha256: await canonicalSha256(normalizedResult),
    modelMetadataSha256: await canonicalSha256(normalizedMetadata),
    receiptEnvelopeSha256: await canonicalSha256(normalizedReceipt),
  };
  const core = {
    kind: PAPER_GRADE_COMPLETION_ARTIFACT_KIND,
    schemaVersion: 1,
    identity: {
      userBinding: String(identity.userBinding),
      runId: String(identity.runId),
      acceptedAttemptId: String(identity.acceptedAttemptId),
      generation: Number(identity.generation),
      modelInputBindingSha256: String(identity.modelInputBindingSha256),
    },
    storage: {
      bucket: PAPER_GRADE_COMPLETION_ARTIFACT_BUCKET,
      path,
    },
    payload: {
      normalizedModelJson: normalizedResult,
      modelMetadata: normalizedMetadata,
      receiptEnvelope: normalizedReceipt,
    },
    contentDigests,
  };
  return { ...core, canonicalDigest: await canonicalSha256(core) };
}

export function serializePaperGradeCompletionArtifact(raw: unknown) {
  return canonicalJson(raw) + "\n";
}

/** Fail closed on an identity/path/content/canonical-digest mismatch. */
export async function verifyPaperGradeCompletionArtifact(
  raw: unknown,
  expected: Partial<PaperGradeCompletionIdentity>,
) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const artifact = raw as Record<string, unknown>;
  const identity = artifact.identity && typeof artifact.identity === "object" &&
      !Array.isArray(artifact.identity)
    ? artifact.identity as Record<string, unknown>
    : null;
  const storage = artifact.storage && typeof artifact.storage === "object" &&
      !Array.isArray(artifact.storage)
    ? artifact.storage as Record<string, unknown>
    : null;
  const payload = artifact.payload && typeof artifact.payload === "object" &&
      !Array.isArray(artifact.payload)
    ? artifact.payload as Record<string, unknown>
    : null;
  const digests = artifact.contentDigests &&
      typeof artifact.contentDigests === "object" &&
      !Array.isArray(artifact.contentDigests)
    ? artifact.contentDigests as Record<string, unknown>
    : null;
  const expectedPath = paperGradeCompletionArtifactPath(expected);
  if (
    artifact.kind !== PAPER_GRADE_COMPLETION_ARTIFACT_KIND ||
    artifact.schemaVersion !== 1 || !identity || !storage || !payload ||
    !digests || !expectedPath ||
    identity.userBinding !== expected.userBinding ||
    identity.runId !== expected.runId ||
    identity.acceptedAttemptId !== expected.acceptedAttemptId ||
    identity.generation !== expected.generation ||
    identity.modelInputBindingSha256 !== expected.modelInputBindingSha256 ||
    storage.bucket !== PAPER_GRADE_COMPLETION_ARTIFACT_BUCKET ||
    storage.path !== expectedPath
  ) return null;
  const normalizedModelJson = payload.normalizedModelJson;
  const modelMetadata = payload.modelMetadata;
  const receiptEnvelope = payload.receiptEnvelope;
  if (
    !normalizedModelJson || typeof normalizedModelJson !== "object" ||
    Array.isArray(normalizedModelJson) || !modelMetadata ||
    typeof modelMetadata !== "object" || Array.isArray(modelMetadata) ||
    !receiptEnvelope || typeof receiptEnvelope !== "object" ||
    Array.isArray(receiptEnvelope) ||
    digests.normalizedModelJsonSha256 !==
      await canonicalSha256(normalizedModelJson) ||
    digests.modelMetadataSha256 !== await canonicalSha256(modelMetadata) ||
    digests.receiptEnvelopeSha256 !== await canonicalSha256(receiptEnvelope)
  ) return null;
  const core = { ...artifact };
  delete core.canonicalDigest;
  if (
    !/^[a-f0-9]{64}$/.test(String(artifact.canonicalDigest || "")) ||
    await canonicalSha256(core) !== artifact.canonicalDigest
  ) return null;
  return artifact;
}

export function paperGradeDispatchedTerminalState(
  dispatchedAt: unknown,
  nowMs = Date.now(),
) {
  const dispatchedMs = Date.parse(String(dispatchedAt || ""));
  if (!Number.isFinite(dispatchedMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - dispatchedMs >= PAPER_GRADE_DISPATCH_LOST_AFTER_MS;
}
