import { Global, Module } from '@nestjs/common';

/**
 * Cross-cutting security services.
 *
 * Held open deliberately after the malware scanner was removed: this is where
 * a scanner, a content-inspection service or an upload-signing helper would be
 * registered, and the module is `@Global()` so a feature module that accepts
 * files does not have to remember to import it.
 *
 * Signature validation does NOT live here — it is a pure function with no
 * dependencies (`modules/documents/utils/file-signature.ts`), so making it a
 * provider would buy nothing and cost a mock in every test that touches it.
 */
@Global()
@Module({
  providers: [],
  exports: [],
})
export class SecurityModule {}
