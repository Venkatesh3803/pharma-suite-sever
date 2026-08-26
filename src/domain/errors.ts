import { ZodError } from "zod";

export class AppError extends Error {
    public readonly statusCode: number;
    public readonly code?: string;

    constructor(message: string, statusCode = 500, code?: string) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}

export class NotFoundError extends AppError {
    constructor(message = "Resource not found", code = "NOT_FOUND") {
        super(message, 404, code);
    }
}

export function isAppError(err: unknown): err is AppError {
    return err instanceof AppError;
}

export function formatZodError(err: ZodError): string {
    return err.issues.map(issue => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
}
