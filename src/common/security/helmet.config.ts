import helmet from 'helmet';
import type { RequestHandler } from 'express';
import { SWAGGER_PATH } from '../swagger/swagger.config';

/**
 * Response security headers.
 *
 * Kept here rather than inline in `main.ts` for one reason: these are security
 * decisions, and a decision that can be unit-tested is one that cannot be
 * quietly loosened. `helmet.config.spec.ts` drives this through a real HTTP
 * round trip and asserts the exact header set.
 *
 * Every option below is written out even where it matches helmet's own
 * default. A default can change between major versions; a posture should not
 * change because a dependency was bumped.
 */

/** Everything served under here is Swagger UI. */
const DOCS_PREFIX = `/${SWAGGER_PATH}`;

/**
 * The headers every API response carries.
 *
 * Split from the docs policy below so the strict one stays strict: Swagger UI
 * needs to load a stylesheet and run a script, and granting that to the whole
 * API to serve one page would be the wrong trade.
 */
function apiHeaders(): RequestHandler {
  return helmet({
    /**
     * Every endpoint except the docs answers with JSON — no HTML, no static
     * assets, no template engine. So the policy is the strictest there is: a
     * response from here has no legitimate reason to load a script, a style, a
     * font or an image.
     *
     * Swagger UI is the one exception and is served under its own policy, in
     * docsHeaders() below, rather than by loosening this one.
     */
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        // Clickjacking. Paired with X-Frame-Options below, which covers
        // clients predating CSP level 2.
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },

    /**
     * HSTS is only ever honoured over HTTPS — a browser ignores it on the
     * plain HTTP used in development — so it is set unconditionally rather
     * than gated on NODE_ENV, which keeps both environments on one code path.
     *
     * `preload` is off deliberately. Submitting a domain to the preload list
     * is effectively irreversible and binds every subdomain, present and
     * future. That is the institute's call, not a default to inherit.
     */
    strictTransportSecurity: {
      maxAge: 31_536_000, // one year
      includeSubDomains: true,
      preload: false,
    },

    /**
     * COOP is safe here because Google sign-in is a top-level redirect (see
     * GoogleSignInButton.vue), not a popup — nothing depends on
     * `window.opener`. The two `window.open` call sites in the client already
     * pass `noopener`.
     */
    crossOriginOpenerPolicy: { policy: 'same-origin' },

    /**
     * CORP does not interfere with the SPA: a cross-origin `fetch()` is
     * governed by the CORS check, while CORP governs no-cors subresource
     * loads — which is exactly the access worth denying. Note this protects
     * the API's own responses only; document bytes are served by MinIO, not by
     * this process.
     */
    crossOriginResourcePolicy: { policy: 'same-origin' },

    /**
     * COEP stays off. It buys cross-origin isolation, which a JSON API has no
     * use for, and it breaks every resource that has not opted in.
     */
    crossOriginEmbedderPolicy: false,

    /** Nothing here should leak a path to a third party in a Referer. */
    referrerPolicy: { policy: 'no-referrer' },

    /** DENY rather than helmet's SAMEORIGIN — it matches frame-ancestors. */
    xFrameOptions: { action: 'deny' },

    /**
     * The one that matters most next to the upload work: without it a browser
     * may ignore a declared Content-Type and sniff the bytes, which turns a
     * mislabelled response into whatever the content looks like.
     */
    xContentTypeOptions: true,

    /**
     * Explicitly 0. The legacy XSS auditor is removed from modern browsers and
     * its filter was itself exploitable; `1; mode=block` is worse than off.
     */
    xXssProtection: true,
  });
}

/**
 * The same headers, with the narrowest CSP that lets Swagger UI render.
 *
 * Four directives are opened, and only these:
 *
 *  - `script-src 'self'` — the three bundle files. Notably WITHOUT
 *    `'unsafe-inline'`: this build of @nestjs/swagger emits no inline
 *    `<script>`, it links `swagger-ui-init.js` instead, so the dangerous
 *    relaxation is not needed. If a future version inlines its initialiser the
 *    page will break here rather than silently weakening the policy.
 *  - `style-src 'self' 'unsafe-inline'` — the stylesheet, plus two inline
 *    `<style>` blocks the page really does carry.
 *  - `img-src 'self' data:` — the two favicons, and icons embedded as data
 *    URIs inside the stylesheet.
 *  - `connect-src 'self'` — "Try it out" calls this same origin.
 *
 * Everything else stays `'none'`, and the page serves no user data: it is the
 * spec document and a UI built from it.
 */
function docsHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    strictTransportSecurity: {
      maxAge: 31_536_000,
      includeSubDomains: true,
      preload: false,
    },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
    xFrameOptions: { action: 'deny' },
    xContentTypeOptions: true,
    xXssProtection: true,
  });
}

/**
 * Picks the policy by path, so `main.ts` still installs one handler.
 *
 * Prefix match rather than an exact one: the UI fetches its bundles and
 * favicons from under the same path, and `/api/docs-json` sits beside it.
 */
export function securityHeaders(): RequestHandler {
  const api = apiHeaders();
  const docs = docsHeaders();
  return (req, res, next) =>
    req.path.startsWith(DOCS_PREFIX)
      ? docs(req, res, next)
      : api(req, res, next);
}
