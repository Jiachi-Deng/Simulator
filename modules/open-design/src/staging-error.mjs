export class StagingError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingError";
    this.code = code;
  }
}

export function stagingFail(code, message) {
  throw new StagingError(code, message);
}

export function stagingAssert(condition, code, message) {
  if (!condition) stagingFail(code, message);
}
