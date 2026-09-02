import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { validationRefusal } from './common/validation-error';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');

  /**
   * Who may call this API from a browser.
   *
   * Two hardcoded localhost origins was right while both frontends only ever
   * ran on this machine. Deployed, they are two more origins that nobody can
   * add without a code change — and a CORS refusal shows up in the browser
   * console as a network error with no server-side trace, so it reads as the
   * API being down rather than as configuration.
   *
   * `WEB_ORIGIN` and `STORE_ORIGIN` name them. Localhost stays in the list
   * unconditionally: it costs nothing, and a production API that a developer
   * cannot point a local frontend at is its own kind of obstacle.
   */
  const origins = [
    'http://localhost:3000',
    'http://localhost:3002',
    process.env.WEB_ORIGIN,
    process.env.STORE_ORIGIN,
  ].filter((o): o is string => Boolean(o));

  app.enableCors({
    // A function rather than the array, so a Vercel preview deployment — whose
    // hostname carries a different hash every time — is not locked out of its
    // own API. Previews are matched by suffix; anything else must be named.
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) return callback(null, true); // curl, server-side, same-origin
      if (origins.includes(origin)) return callback(null, true);
      if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return callback(null, true);
      callback(null, false);
    },
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      // Otherwise this answers with `code: "Bad Request"` and an array of
      // English sentences, which no client can translate and React renders
      // concatenated. See `validationRefusal`.
      exceptionFactory: validationRefusal,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  const config = new DocumentBuilder()
    .setTitle('Motorcycle Parts Management API')
    .setDescription('Internal operations API for motorcycle parts business')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`🚀 API running on http://localhost:${port}`);
  console.log(`📄 Swagger docs at http://localhost:${port}/api/docs`);
}
bootstrap();
