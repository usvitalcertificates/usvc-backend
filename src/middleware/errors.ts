import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const errors: ErrorRequestHandler = (error, req, res, next) => {
  // Never log validation input, recovery credentials or processor payloads.
  console.error({
    requestId: req.id,
    status: error instanceof ApiError ? error.status : error instanceof ZodError ? 400 : 500,
    type: error instanceof Error ? error.name : "UnknownError",
  });
  if (error instanceof ZodError) return res.status(400).json({ message: "Invalid request" });
  if (error instanceof ApiError)
    return res.status(error.status).json({ message: error.message, requestId: req.id });
  return res.status(500).json({ message: "Unexpected server error", requestId: req.id });
};
