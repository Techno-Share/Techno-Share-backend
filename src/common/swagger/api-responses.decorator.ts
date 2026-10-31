import { applyDecorators } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiPayloadTooLargeResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { BEARER_AUTH } from './swagger.config';

/**
 * A minimal OpenAPI schema shape.
 *
 * Declared here rather than imported: `SchemaObject` lives behind
 * `@nestjs/swagger/dist/...`, which this project's `nodenext` resolution
 * cannot reach — the package's `exports` map publishes the root only. The
 * decorators below accept a plain object anyway, so a local type costs
 * nothing and survives the package reorganising its internals.
 */
type Schema = Record<string, unknown>;

/**
 * Swagger helpers for the response patterns that repeat across the API.
 *
 * These exist because the same three or four failure modes apply to almost
 * every route — listing them by hand on 97 handlers would be noise, and the
 * copies would drift. Each decorator below states only what is actually true
 * of the guards and filters in use; nothing here changes behaviour.
 */

/** The error body Nest's exception filter produces. Errors are NOT wrapped. */
export const ERROR_SCHEMA: Schema = {
  type: 'object',
  properties: {
    statusCode: { type: 'number', example: 400 },
    message: {
      oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      description:
        'A string, or an array of strings when validation rejected several fields.',
    },
    error: { type: 'string', example: 'Bad Request' },
  },
};

/**
 * Wrap a payload schema in the success envelope the TransformInterceptor adds.
 *
 * Every handler's return value goes into `data` untouched, so the documented
 * schema has to sit inside the envelope or the examples would not match what a
 * client receives.
 */
export function envelope(
  dataSchema: Schema,
  message = 'Request successful',
): Schema {
  return {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: dataSchema,
      message: { type: 'string', example: message },
    },
  };
}

/** The same envelope around a named DTO class. */
export function envelopeOf(model: Parameters<typeof getSchemaPath>[0]) {
  return envelope({ $ref: getSchemaPath(model) });
}

/** The envelope around a page of a paginated list. */
export function envelopePage(itemSchema: Schema) {
  return envelope({
    type: 'object',
    properties: {
      items: { type: 'array', items: itemSchema },
      total: {
        type: 'number',
        description: 'Rows matching the filter, across all pages.',
        example: 97,
      },
      page: { type: 'number', example: 1 },
      limit: { type: 'number', example: 10 },
    },
  });
}

/**
 * Requires a valid access token.
 *
 * Adds the bearer requirement and the 401 that `JwtAuthGuard` produces when
 * the token is missing, expired, or belongs to a deleted or banned account —
 * the guard re-checks the account on every request, so a token issued before a
 * ban stops working on the next call.
 */
export function ApiAuth() {
  return applyDecorators(
    ApiBearerAuth(BEARER_AUTH),
    ApiUnauthorizedResponse({
      description:
        'Missing or invalid access token, or the account has been banned or deleted.',
      schema: ERROR_SCHEMA,
    }),
  );
}

/** Signed in, and `role = admin`. */
export function ApiAdminOnly() {
  return applyDecorators(
    ApiAuth(),
    ApiForbiddenResponse({
      description: 'Admin access required.',
      schema: ERROR_SCHEMA,
    }),
  );
}

/**
 * Signed in, and an admin or a moderator of at least one department.
 *
 * The 403 covers two distinct refusals: not being a reviewer at all, and being
 * one for a different department than the resource belongs to.
 */
export function ApiReviewerOnly() {
  return applyDecorators(
    ApiAuth(),
    ApiForbiddenResponse({
      description:
        'Reviewer access required, or the resource belongs to a department you do not moderate.',
      schema: ERROR_SCHEMA,
    }),
  );
}

/** For routes that take an id and can be asked for one that does not exist. */
export function ApiNotFound(description = 'Resource not found.') {
  return ApiNotFoundResponse({ description, schema: ERROR_SCHEMA });
}

/** For routes the caller must own. */
export function ApiOwnerOnly(description: string) {
  return ApiForbiddenResponse({ description, schema: ERROR_SCHEMA });
}

/**
 * Routes carrying a `@RateLimitTier`.
 *
 * The response also sets `Retry-After` in seconds — the exception filter reads
 * it from the thrown error so services never touch the response themselves.
 */
export function ApiRateLimited() {
  return ApiTooManyRequestsResponse({
    description:
      'Rate limit exceeded for this endpoint. The `Retry-After` header gives the wait in seconds.',
    schema: ERROR_SCHEMA,
  });
}

/**
 * What Multer returns when it refuses a file before the handler runs.
 *
 * Statuses come from MulterExceptionFilter, which re-throws each MulterError
 * as an HttpException: a file over the size cap is 413, and everything else it
 * recognises (too many files, unexpected field name, unreadable upload) is
 * 400. Those bodies carry `statusCode` and `message` only — no `error` key.
 *
 * @param maxMb the per-file cap quoted in the 413 message
 */
export function ApiUploadLimits(maxMb: number) {
  return applyDecorators(
    ApiPayloadTooLargeResponse({
      description: `A file is larger than the ${maxMb} MB limit.`,
      schema: ERROR_SCHEMA,
    }),
    ApiBadRequestResponse({
      description:
        'Too many files, an unexpected field name, or the upload could not be read.',
      schema: ERROR_SCHEMA,
    }),
  );
}
