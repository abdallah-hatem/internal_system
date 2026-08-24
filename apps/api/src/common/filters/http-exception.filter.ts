import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId = uuidv4();
    const where = `${request?.method} ${request?.originalUrl}`;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();

      // Expected refusals (validation, not-found, conflicts) are part of normal
      // operation; log them thinly so real faults stay easy to spot.
      this.logger.warn(
        `${correlationId} ${status} ${where} — ${
          typeof res === 'string' ? res : JSON.stringify((res as any).message)
        }`,
      );

      const body = (typeof res === 'object' ? res : {}) as Record<string, any>;

      // `code` used to carry Nest's status text ("Bad Request"), which named
      // the HTTP status the client already had and nothing about the refusal.
      // A throw raised through the api-error helpers puts a real code here,
      // and the params the client needs to phrase it in its own language.
      // Anything not yet migrated keeps the status text, so the client falls
      // back to the English message rather than showing nothing.
      response.status(status).json({
        error: {
          code: typeof res === 'string' ? 'ERROR' : body.code || body.error || 'ERROR',
          message: typeof res === 'string' ? res : body.message,
          params: body.params,
          details: typeof res === 'object' ? body.message : undefined,
          correlationId,
        },
      });
      return;
    }

    // Anything else is a genuine fault. The client is told nothing useful on
    // purpose, so the correlation id has to be findable in the logs alongside
    // the real cause — otherwise it correlates to nothing.
    const error = exception as Error & { code?: string; meta?: unknown };

    // A Prisma failure puts almost nothing in `message` and everything in
    // `code` and `meta` — P2002 with the constraint that rejected the write,
    // P2003 with the foreign key. Logging only the message produced
    // "PrismaClientKnownRequestError:" and a stack, which says a database rule
    // was broken but not which one, and cost an hour finding a duplicate key.
    const prismaDetail = error?.code
      ? ` [${error.code}${error.meta ? ` ${JSON.stringify(error.meta)}` : ''}]`
      : '';

    this.logger.error(
      `${correlationId} 500 ${where} — ${error?.message || error?.constructor?.name || String(exception)}${prismaDetail}`,
      error?.stack,
    );

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
        correlationId,
      },
    });
  }
}
