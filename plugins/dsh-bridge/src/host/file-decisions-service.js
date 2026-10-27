/** Bridge actions keep file decisions and local artifact writes as separate operations. */
export function createFileDecisionActions({ client, attempt }) {
  const text = (payload, key) => {
    if (typeof payload?.[key] !== "string" || !payload[key]) throw Object.assign(new Error(`${key} is required`), { code: "INVALID_REQUEST" });
    return payload[key];
  };
  return {
    "files.dependency.review": payload => attempt(() => client.files.dependencyReview(text(payload, "runId"))),
    "files.dependency.resolve": payload => attempt(() => client.files.resolveDependency(text(payload, "runId"), {
      requestId: text(payload, "requestId"), expectedFileRevision: payload.expectedFileRevision, choice: payload.choice,
      ...(payload.paths === undefined ? {} : { paths: payload.paths }),
    })),
    "files.retention": () => attempt(() => client.files.retention()),
    "files.collect": payload => attempt(() => client.files.collectContent(text(payload, "requestId"))),
    "files.expire": payload => attempt(() => client.files.expireSnapshot(text(payload, "snapshotId"), {
      requestId: text(payload, "requestId"), expectedRootHash: text(payload, "expectedRootHash"),
    })),
  };
}
