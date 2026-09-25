'use strict';

/** 领域错误：携带 HTTP 状态码与稳定错误码，供 API 层统一映射。 */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const badRequest = (code, message, details) => new ApiError(400, code, message, details);
const notFound = (code, message, details) => new ApiError(404, code, message, details);
const conflict = (code, message, details) => new ApiError(409, code, message, details);
const unprocessable = (code, message, details) => new ApiError(422, code, message, details);

module.exports = { ApiError, badRequest, notFound, conflict, unprocessable };
