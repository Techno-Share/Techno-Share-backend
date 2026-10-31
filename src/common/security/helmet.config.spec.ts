import express from 'express';
import request from 'supertest';
import { securityHeaders } from './helmet.config';

/**
 * The response security headers, driven through a real HTTP round trip.
 *
 * This file is what the comment in helmet.config.ts means by "a decision that
 * can be unit-tested is one that cannot be quietly loosened". Adding Swagger UI
 * required opening four CSP directives, and the risk is not that opening —
 * which is deliberate and scoped — but that the exception later spreads to the
 * whole API because nothing says it must not.
 *
 * So the assertions below are deliberately exact. A directive gaining a value
 * fails here rather than passing unnoticed.
 */

function app() {
  const a = express();
  a.use(securityHeaders());
  a.get('/documents', (_req, res) => res.json({ ok: true }));
  a.get('/api/docs', (_req, res) => res.send('<html></html>'));
  a.get('/api/docs/swagger-ui.css', (_req, res) => res.send('body{}'));
  a.get('/api/docs-json', (_req, res) => res.json({ openapi: '3.0.0' }));
  return a;
}

const directives = (csp: string) =>
  Object.fromEntries(
    csp
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name, values];
      }),
  );

describe('security headers', () => {
  describe('the API', () => {
    it('forbids every resource type', async () => {
      const res = await request(app()).get('/documents');
      const csp = directives(res.headers['content-security-policy']);

      expect(csp['default-src']).toEqual(["'none'"]);
      expect(csp['frame-ancestors']).toEqual(["'none'"]);
      expect(csp['base-uri']).toEqual(["'none'"]);
      expect(csp['form-action']).toEqual(["'none'"]);
    });

    /**
     * The point of the split. A JSON endpoint must never inherit the
     * permissions the docs page needs.
     */
    it('grants no script, style or image source', async () => {
      const res = await request(app()).get('/documents');
      const csp = directives(res.headers['content-security-policy']);

      expect(csp['script-src']).toBeUndefined();
      expect(csp['style-src']).toBeUndefined();
      expect(csp['img-src']).toBeUndefined();
      expect(csp['connect-src']).toBeUndefined();
    });

    it('carries the rest of the header set', async () => {
      const res = await request(app()).get('/documents');

      expect(res.headers['strict-transport-security']).toBe(
        'max-age=31536000; includeSubDomains',
      );
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      // COEP stays off: cross-origin isolation buys a JSON API nothing and
      // breaks every resource that has not opted in.
      expect(res.headers['cross-origin-embedder-policy']).toBeUndefined();
    });
  });

  describe('the docs page', () => {
    it('allows exactly what Swagger UI needs, and nothing more', async () => {
      const res = await request(app()).get('/api/docs');
      const csp = directives(res.headers['content-security-policy']);

      expect(csp['default-src']).toEqual(["'none'"]);
      expect(csp['script-src']).toEqual(["'self'"]);
      expect(csp['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
      expect(csp['img-src']).toEqual(["'self'", 'data:']);
      expect(csp['connect-src']).toEqual(["'self'"]);
      expect(csp['font-src']).toEqual(["'self'"]);
    });

    /**
     * The one relaxation that was NOT needed, and must not creep in.
     *
     * This build links swagger-ui-init.js rather than inlining it, so scripts
     * run from 'self' alone. `'unsafe-inline'` on script-src would undo most of
     * what a CSP is for, and a future @nestjs/swagger that inlines its
     * initialiser should break this test rather than quietly earn the grant.
     */
    it('never allows inline scripts', async () => {
      const res = await request(app()).get('/api/docs');
      const csp = directives(res.headers['content-security-policy']);

      expect(csp['script-src']).not.toContain("'unsafe-inline'");
      expect(csp['script-src']).not.toContain("'unsafe-eval'");
    });

    it('still refuses framing and form posts', async () => {
      const res = await request(app()).get('/api/docs');
      const csp = directives(res.headers['content-security-policy']);

      expect(csp['frame-ancestors']).toEqual(["'none'"]);
      expect(csp['base-uri']).toEqual(["'none'"]);
      expect(csp['form-action']).toEqual(["'none'"]);
    });

    /** The UI loads its bundles and favicons from under the same prefix. */
    it('applies to the assets beneath it, not just the page', async () => {
      const res = await request(app()).get('/api/docs/swagger-ui.css');
      const csp = directives(res.headers['content-security-policy']);

      expect(csp['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    });

    /** `/api/docs-json` sits beside the UI and is covered by the same prefix. */
    it('covers the OpenAPI document', async () => {
      const res = await request(app()).get('/api/docs-json');

      expect(res.headers['content-security-policy']).toContain(
        "default-src 'none'",
      );
    });
  });
});
