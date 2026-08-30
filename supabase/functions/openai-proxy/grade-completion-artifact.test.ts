import {
  buildPaperGradeCompletionArtifact,
  PAPER_GRADE_DISPATCH_LOST_AFTER_MS,
  paperGradeCompletionArtifactPath,
  paperGradeDispatchedTerminalState,
  serializePaperGradeCompletionArtifact,
  verifyPaperGradeCompletionArtifact,
} from "./grade-completion-artifact.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

const identity = {
  userBinding: `matha_${"a".repeat(32)}`,
  runId: "paper-run-1234567890123",
  acceptedAttemptId: "paper-submit-abcdefghijklmnop",
  generation: 3,
  modelInputBindingSha256: "b".repeat(64),
};

const normalized = { score: 75, questions: [{ no: 1, correct: true }] };
const metadata = { model: "gpt-5.5", requestId: "resp_123", usage: null };
const receiptEnvelope = {
  receipt: {
    gradeGeneration: 3,
    submitAttempt: { attemptId: identity.acceptedAttemptId },
    modelInputBinding: {
      canonicalDigest: identity.modelInputBindingSha256,
    },
  },
  privateReadback: {
    submitAttemptId: identity.acceptedAttemptId,
    gradeGeneration: 3,
    modelInputBindingSha256: identity.modelInputBindingSha256,
  },
};

Deno.test("completion artifact path binds all immutable job identity fields", () => {
  const path = paperGradeCompletionArtifactPath(identity);
  assert(path?.includes(identity.userBinding));
  assert(path?.includes(identity.runId));
  assert(path?.includes(identity.acceptedAttemptId));
  assert(path?.includes("generation-3"));
  assert(path?.includes(identity.modelInputBindingSha256));
  assert(
    paperGradeCompletionArtifactPath({ ...identity, generation: -1 }) === null,
  );
});

Deno.test("completion artifact bytes are deterministic and digest verified", async () => {
  const first = await buildPaperGradeCompletionArtifact(
    identity,
    normalized,
    metadata,
    receiptEnvelope,
  );
  const second = await buildPaperGradeCompletionArtifact(
    identity,
    normalized,
    metadata,
    receiptEnvelope,
  );
  assert(first && second);
  assert(first.canonicalDigest === second.canonicalDigest);
  assert(
    serializePaperGradeCompletionArtifact(first) ===
      serializePaperGradeCompletionArtifact(second),
  );
  assert(await verifyPaperGradeCompletionArtifact(first, identity));
});

Deno.test("completion artifact rejects payload, digest, path, and identity tamper", async () => {
  const artifact = await buildPaperGradeCompletionArtifact(
    identity,
    normalized,
    metadata,
    receiptEnvelope,
  );
  assert(artifact);
  const payloadTamper = structuredClone(artifact);
  (payloadTamper.payload.normalizedModelJson as Record<string, unknown>).score =
    100;
  assert(
    await verifyPaperGradeCompletionArtifact(payloadTamper, identity) === null,
  );
  const digestTamper = structuredClone(artifact);
  digestTamper.canonicalDigest = "c".repeat(64);
  assert(
    await verifyPaperGradeCompletionArtifact(digestTamper, identity) === null,
  );
  const pathTamper = structuredClone(artifact);
  pathTamper.storage.path = pathTamper.storage.path.replace(
    "generation-3",
    "generation-4",
  );
  assert(
    await verifyPaperGradeCompletionArtifact(pathTamper, identity) === null,
  );
  assert(
    await verifyPaperGradeCompletionArtifact(artifact, {
      ...identity,
      generation: 4,
    }) === null,
  );
});

Deno.test("dispatched job becomes terminal only after the explicit TTL", () => {
  const dispatched = Date.parse("2026-08-30T00:00:00.000Z");
  assert(
    !paperGradeDispatchedTerminalState(
      new Date(dispatched).toISOString(),
      dispatched + PAPER_GRADE_DISPATCH_LOST_AFTER_MS - 1,
    ),
  );
  assert(
    paperGradeDispatchedTerminalState(
      new Date(dispatched).toISOString(),
      dispatched + PAPER_GRADE_DISPATCH_LOST_AFTER_MS,
    ),
  );
});
