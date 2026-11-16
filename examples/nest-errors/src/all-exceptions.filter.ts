import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import { Request, Response } from "express";

// every error as { success: false, statusCode, message, path }: the message of the exception's body, or its text
// when it was made with one (ThrottlerException, new HttpException("text", 409))
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    let status = 500;
    let message = "Internal server error";
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "string") {
        message = body;
      } else {
        const fields = body as Record<string, unknown>;
        const m = fields["message"];
        message = Array.isArray(m) ? m.join("; ") : String(m);
      }
    }
    response.status(status).json({ success: false, statusCode: status, message: message, path: request.url });
  }
}
