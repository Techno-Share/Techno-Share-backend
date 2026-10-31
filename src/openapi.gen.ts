/**
 * Writes the OpenAPI document to disk without starting a server.
 *
 * Used to check that every registered route appears in the document, and to
 * ship a copy clients can generate from. Built through NestFactory so the
 * document comes from the real module graph — a route missing here is a route
 * missing in production. `preview: true` keeps providers from instantiating,
 * so no database or Redis connection is needed to produce it.
 */
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { writeFileSync } from 'fs';
import { AppModule } from './app.module';
import {
  BEARER_AUTH,
  REFRESH_COOKIE_AUTH,
  API_TAGS,
} from './common/swagger/swagger.config';

async function generate() {
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
  });
  const config = new DocumentBuilder()
    .setTitle('TechnoShare API')
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      BEARER_AUTH,
    )
    .addCookieAuth(
      'refresh_token',
      { type: 'apiKey', in: 'cookie', name: 'refresh_token' },
      REFRESH_COOKIE_AUTH,
    )
    .build();
  for (const tag of Object.values(API_TAGS)) config.tags?.push({ name: tag });

  const doc = SwaggerModule.createDocument(app, config);
  writeFileSync('openapi.json', JSON.stringify(doc, null, 2));
  // Typed explicitly: inference for the accumulator differs between the
  // host's TypeScript and the container's, and this file is compiled by both.
  const ops = Object.values(doc.paths).reduce<number>(
    (n, p) => n + Object.keys(p as object).length,
    0,
  );
  console.log(
    `paths=${Object.keys(doc.paths).length} operations=${ops} schemas=${Object.keys(doc.components?.schemas ?? {}).length}`,
  );
  await app.close();
}
void generate();
