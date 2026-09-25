/** 领域错误：携带 HTTP 状态码，API 层直接映射。 */
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus = 400,
    public details: unknown = undefined,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const Errors = {
  notFound: (what: string) => new DomainError('NOT_FOUND', `${what}不存在`, 404),
  invalidState: (msg: string) => new DomainError('INVALID_STATE', msg, 409),
  conflict: (code: string, msg: string) => new DomainError(code, msg, 409),
  validation: (msg: string, details?: unknown) =>
    new DomainError('VALIDATION_FAILED', msg, 422, details),
  trialFailed: (msg: string, details?: unknown) =>
    new DomainError('TRIAL_FAILED', msg, 422, details),
};
