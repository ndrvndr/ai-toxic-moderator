import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type AuthenticatedAccount = { id: string; display_name: string };
export type ApiRequest = IncomingMessage & {
  params: Record<string, string>;
  body: unknown;
  traceId: string;
  account?: AuthenticatedAccount;
  sessionHash?: string;
};
export type ApiResponse = ServerResponse & {
  status(code: number): ApiResponse;
  json(value: unknown): void;
};
export function failure(
  status: number,
  code: string,
  message: string,
  field_errors: { field: string; code: string }[] = [],
) {
  return new HttpException({ code, message, field_errors }, status);
}
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest<ApiRequest>();
    const response = host.switchToHttp().getResponse<ApiResponse>();
    const parserType =
      typeof error === 'object' && error !== null && 'type' in error ? error.type : null;
    const status =
      error instanceof HttpException
        ? error.getStatus()
        : parserType === 'entity.too.large'
          ? 413
          : parserType === 'entity.parse.failed'
            ? 400
            : 500;
    const payload = error instanceof HttpException ? error.getResponse() : null;
    const detail =
      typeof payload === 'object' && payload !== null && 'code' in payload
        ? (payload as {
            code: string;
            message: string;
            field_errors?: { field: string; code: string }[];
          })
        : null;
    const defaults: Record<number, [string, string]> = {
      400: ['BAD_REQUEST', 'Request tidak valid.'],
      404: ['NOT_FOUND', 'Resource tidak ditemukan.'],
      413: ['PAYLOAD_TOO_LARGE', 'Payload terlalu besar.'],
    };
    const [code, message] = defaults[status] ?? ['INTERNAL_ERROR', 'Request tidak dapat diproses.'];
    response.status(status).json({
      error: {
        code: detail?.code ?? code,
        message: detail?.message ?? message,
        field_errors: detail?.field_errors ?? [],
        trace_id: request.traceId ?? randomUUID(),
      },
    });
  }
}
