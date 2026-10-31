import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Names for the two security schemes, exported so controllers reference the
 * scheme by constant rather than by a string literal that can drift.
 */
export const BEARER_AUTH = 'bearer';
export const REFRESH_COOKIE_AUTH = 'refreshCookie';

/** Where the UI and the raw document are served from. */
export const SWAGGER_PATH = 'api/docs';
export const SWAGGER_JSON_PATH = 'api/docs-json';

/**
 * Tags, declared once so every controller draws from the same list and the UI
 * does not grow a section per spelling.
 */
export const API_TAGS = {
  auth: 'Auth',
  users: 'Users',
  documents: 'Documents',
  books: 'Books',
  subjects: 'Subjects',
  majors: 'Majors',
  notifications: 'Notifications',
  telegram: 'Telegram',
  moderation: 'Moderation',
  admin: 'Admin',
  health: 'Health',
} as const;

const DESCRIPTION = `
Document and textbook sharing for students of the Institute of Technology of
Cambodia.

### Response shape

Every **successful** response is wrapped by a global interceptor:

\`\`\`json
{ "success": true, "data": <the documented payload>, "message": "Request successful" }
\`\`\`

The schema shown under each endpoint is what lands in \`data\`. Two groups of
endpoints bypass the wrapper because they write the response themselves:
\`/health/*\` and the Google OAuth redirects.

**Errors are not wrapped.** They keep Nest's own shape:

\`\`\`json
{ "statusCode": 400, "message": "Validation failed", "error": "Bad Request" }
\`\`\`

Validation failures return \`message\` as an array of strings, one per broken
rule. A \`429\` also carries a \`Retry-After\` header, in seconds.

### Authentication

Sign-in endpoints return a short-lived **access token** in the body and set a
long-lived **refresh token** in an \`httpOnly\` cookie named
\`refresh_token\` (\`Secure\`, \`SameSite=None\`, so it survives the SPA and API
being on different origins).

Send the access token as \`Authorization: Bearer <token>\` — use **Authorize**
above. \`POST /auth/refresh\` and \`POST /auth/logout\` read the cookie instead,
so they work from a browser and cannot be exercised from this page with a
bearer token alone.

### Authorization

| Level | Enforced by | Refused with |
| --- | --- | --- |
| Signed in | \`JwtAuthGuard\` | \`401\` |
| Admin | \`AdminGuard\` | \`403 Admin access required\` |
| Reviewer | \`ReviewerGuard\` | \`403 Reviewer access required\` |

A reviewer is an admin **or** a moderator of at least one department. Passing
\`ReviewerGuard\` does not grant access to a particular resource — each handler
additionally checks that the resource's department is one the caller moderates,
so a moderator can receive \`403\` on a document belonging to another department.

Ownership is checked inside the handlers: editing or deleting a document, book
or subject requires being its owner, or an admin.
`.trim();

/**
 * Mounts Swagger UI and the OpenAPI document.
 *
 * Called from `bootstrap()` after the global pipes are in place, so the schemas
 * shown here are produced from the same DTO classes the ValidationPipe
 * enforces — a field documented as required is required by the running API.
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('TechnoShare API')
    .setDescription(DESCRIPTION)
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Access token from POST /auth/login or POST /auth/verify-email. ' +
          'Paste the token only — "Bearer" is added for you.',
      },
      BEARER_AUTH,
    )
    /**
     * Declared so the two cookie-driven endpoints are honest about what they
     * read. Browsers attach the cookie themselves and scripts cannot set an
     * httpOnly cookie, so this documents the requirement rather than making it
     * callable from the UI.
     */
    .addCookieAuth(
      'refresh_token',
      {
        type: 'apiKey',
        in: 'cookie',
        name: 'refresh_token',
        description:
          'httpOnly refresh cookie set by login, email verification and ' +
          'refresh. Sent automatically by the browser; it cannot be supplied ' +
          'from this page.',
      },
      REFRESH_COOKIE_AUTH,
    )
    .build();

  for (const tag of Object.values(API_TAGS)) config.tags?.push({ name: tag });

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    jsonDocumentUrl: SWAGGER_JSON_PATH,
    swaggerOptions: {
      // Keeps the token across a page reload, so a reader is not re-pasting it
      // every time they try an endpoint.
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      docExpansion: 'none',
    },
    customSiteTitle: 'TechnoShare API',
  });
}
