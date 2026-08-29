import { errorResponse } from "./http";

export type PreconditionResult =
  | { type: "ok"; mode: "create" | "update" }
  | { type: "error"; response: Response };

export function evaluatePreconditions(
  exists: boolean,
  currentEtag: string | null,
  currentRevision: number | null,
  request: Request,
): PreconditionResult {
  const ifMatch = request.headers.get("If-Match");
  const ifNoneMatch = request.headers.get("If-None-Match");
  const hasMatch = ifMatch !== null && ifMatch !== "";
  const hasNoneMatch = ifNoneMatch !== null && ifNoneMatch !== "";
  if (!hasMatch && !hasNoneMatch) {
    return {
      type: "error",
      response: errorResponse(
        428,
        "precondition_required",
        "If-Match or If-None-Match is required.",
      ),
    };
  }
  if (ifNoneMatch === "*") {
    if (exists) {
      return {
        type: "error",
        response: errorResponse(412, "precondition_failed", "Precondition failed."),
      };
    }
    return { type: "ok", mode: "create" };
  }
  if (hasMatch) {
    if (!exists || currentEtag !== ifMatch) {
      return {
        type: "error",
        response: errorResponse(409, "conflict", "Conflict.", {
          currentEtag,
          currentRevision,
        }),
      };
    }
    return { type: "ok", mode: "update" };
  }
  return {
    type: "error",
    response: errorResponse(
      428,
      "precondition_required",
      "If-Match or If-None-Match is required.",
    ),
  };
}

export function evaluateIfMatch(
  exists: boolean,
  currentEtag: string | null,
  currentRevision: number | null,
  request: Request,
): PreconditionResult {
  if (!exists) {
    return {
      type: "error",
      response: errorResponse(404, "not_found", "Not Found"),
    };
  }
  const ifMatch = request.headers.get("If-Match");
  if (ifMatch === null || ifMatch === "") {
    return {
      type: "error",
      response: errorResponse(
        428,
        "precondition_required",
        "If-Match or If-None-Match is required.",
      ),
    };
  }
  if (currentEtag !== ifMatch) {
    return {
      type: "error",
      response: errorResponse(409, "conflict", "Conflict.", {
        currentEtag,
        currentRevision,
      }),
    };
  }
  return { type: "ok", mode: "update" };
}
