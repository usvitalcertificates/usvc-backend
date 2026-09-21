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
  console.error({ requestId: req.id, error });
  if (error instanceof ZodError)
    return res.status(400).json({ message: "Invalid request", issues: error.flatten() });
  if (error instanceof ApiError)
    return res.status(error.status).json({ message: error.message, requestId: req.id });
  return res.status(500).json({ message: "Unexpected server error", requestId: req.id });
};
