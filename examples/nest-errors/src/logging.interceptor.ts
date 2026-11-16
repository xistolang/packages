import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from "@nestjs/common";
import { Request, Response } from "express";
import { catchError, Observable, tap, throwError } from "rxjs";

// one line per request that reaches the route (the throttler's 429 does not): method, URL and status, or the error
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger("HTTP");

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      tap(() => this.logger.log(`${req.method} ${req.url} ${res.statusCode}`)),
      catchError((err: Error) => {
        this.logger.warn(`${req.method} ${req.url} failed: ${err.message}`);
        return throwError(() => err);
      }),
    );
  }
}
