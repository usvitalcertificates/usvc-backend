import mongoose from "mongoose";

/** Single completion PDF per order. 10 MB cap; GridFS holds the bytes. */
export const ORDER_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ORDER_DOCUMENT_BUCKET = "order_docs";
export const ORDER_DOCUMENT_MIME = "application/pdf";

export interface OrderDocumentMeta {
  fileId: unknown;
  name: string;
  size: number;
  uploadedBy: string;
  uploadedAt: Date;
}

export function validateOrderDocument(file: {
  buffer?: unknown;
  size?: number;
  mimetype?: string;
  originalname?: string;
}): { name: string; size: number } {
  const size = file.size ?? 0;
  if (!file.buffer || !(file.buffer instanceof Buffer) || size === 0)
    throw new Error("A PDF file is required.");
  if (size > ORDER_DOCUMENT_MAX_BYTES) throw new Error("The PDF must be 10 MB or smaller.");
  if (file.mimetype !== ORDER_DOCUMENT_MIME) throw new Error("Only PDF files are accepted.");
  // Magic bytes first: %PDF- — the client extension/mime alone is not proof.
  if (!file.buffer.subarray(0, 5).toString("binary").startsWith("%PDF-"))
    throw new Error("The uploaded file is not a valid PDF.");
  const name = (file.originalname ?? "document.pdf").slice(0, 180) || "document.pdf";
  return { name, size };
}

function bucket() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Database is not connected.");
  return new mongoose.mongo.GridFSBucket(db, { bucketName: ORDER_DOCUMENT_BUCKET });
}

/** Store (replacing any previous) completion PDF; resolves GridFS metadata. */
export async function storeOrderDocument(
  orderId: string,
  buffer: Buffer,
  name: string,
  actorId: string,
): Promise<OrderDocumentMeta> {
  const now = new Date();
  const fileId = await new Promise<unknown>((resolve, reject) => {
    const stream = bucket().openUploadStream(name, {
      metadata: { orderId, uploadedBy: actorId, uploadedAt: now, contentType: ORDER_DOCUMENT_MIME },
    });
    stream.once("error", reject);
    stream.once("finish", () => resolve(stream.id));
    stream.end(buffer);
  });
  return { fileId, name, size: buffer.byteLength, uploadedBy: actorId, uploadedAt: now };
}

/** Remove a stored completion PDF; missing chunks are tolerated. */
export async function deleteOrderDocument(fileId: unknown): Promise<void> {
  try {
    await bucket().delete(fileId as never);
  } catch {
    /* Already gone — the unset below is authoritative. */
  }
}

/** Open a download stream for a stored completion PDF. */
export function openOrderDocument(fileId: unknown) {
  return bucket().openDownloadStream(fileId as never);
}
