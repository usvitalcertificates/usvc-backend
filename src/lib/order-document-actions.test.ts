import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import mongoose from "mongoose";
import type { Request, Response, NextFunction } from "express";
import { ordersRouter } from "../routes/orders.js";
import { staffRouter } from "../routes/staff.js";
import { Order } from "../models/order.js";

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function action(method: string): Handler {
  const layers = ordersRouter.stack as unknown as {
    route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] };
  }[];
  const route = layers.find(
    (layer) => layer.route?.path === "/:id/document" && layer.route.methods[method],
  )?.route;
  assert.ok(route);
  return route.stack.at(-1)!.handle;
}

test("submitted PDF replacement preserves the old file on failure and forbids deletion", async (t) => {
  const oldId = new mongoose.Types.ObjectId();
  const newId = new mongoose.Types.ObjectId();
  const order = { assignedTo: "owner", status: "SUBMITTED", document: { fileId: oldId } };
  const operations: string[] = [];
  let failSave = false;
  t.mock.method(Order, "findById", () => Promise.resolve(order) as never);
  const update = t.mock.method(Order, "updateOne", () => {
    operations.push("link");
    if (failSave) return Promise.reject(new Error("save failed")) as never;
    return Promise.resolve({ matchedCount: 1 }) as never;
  });
  const originalDb = mongoose.connection.db;
  mongoose.connection.db = { collection: () => ({}) } as never;
  t.mock.method(mongoose.mongo.GridFSBucket.prototype, "openUploadStream", () => {
    operations.push("store");
    return Object.assign(
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      { id: newId },
    ) as never;
  });
  t.mock.method(mongoose.mongo.GridFSBucket.prototype, "delete", async (id) => {
    operations.push(id === oldId ? "delete-old" : "delete-new");
  });
  try {
    const invoke = async (method: string, role = "FULFILLMENT", sub = "owner") => {
      let error: unknown;
      const req = {
        params: { id: "order" },
        user: { sub, role },
        file: {
          buffer: Buffer.from("%PDF-1.7 example"),
          size: 16,
          mimetype: "application/pdf",
          originalname: "correct.pdf",
        },
      } as unknown as Request;
      const res = {
        status() {
          return this;
        },
        json() {},
      } as unknown as Response;
      await action(method)(req, res, (value) => {
        error = value;
      });
      return error;
    };
    for (const role of ["FULFILLMENT", "ADMIN"]) {
      assert.match(String(await invoke("delete", role)), /cannot be deleted after submission/);
    }
    assert.equal(update.mock.callCount(), 0);
    assert.deepEqual(operations, []);
    assert.equal(await invoke("post"), undefined);
    assert.deepEqual(operations, ["store", "link", "delete-old"]);
    const mutation = update.mock.calls[0].arguments[1] as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(mutation).sort(), ["$push", "$set"]);
    assert.deepEqual(Object.keys(mutation.$set as object), ["document"]);
    operations.length = 0;
    failSave = true;
    assert.match(String(await invoke("post")), /save failed/);
    assert.deepEqual(operations, ["store", "link", "delete-new"]);
    operations.length = 0;
    assert.match(String(await invoke("post", "FULFILLMENT", "other")), /assigned agent/);
    assert.deepEqual(operations, []);
    assert.equal(order.status, "SUBMITTED");
  } finally {
    mongoose.connection.db = originalDb;
  }
});

test("submitted-order notes append without changing submission state", async (t) => {
  t.mock.method(
    Order,
    "findById",
    () => ({ lean: async () => ({ assignedTo: "owner" }) }) as never,
  );
  const update = t.mock.method(
    Order,
    "updateOne",
    () => Promise.resolve({ matchedCount: 1 }) as never,
  );
  const layers = staffRouter.stack as unknown as {
    route?: { path: string; stack: { handle: Handler }[] };
  }[];
  const route = layers.find((layer) => layer.route?.path === "/orders/:id/notes")?.route;
  assert.ok(route);
  const handler = route.stack.at(-1)!.handle;
  let error: unknown;
  const req = {
    params: { id: "order" },
    user: { sub: "owner", role: "FULFILLMENT" },
    body: { body: "Replaced incorrect PDF." },
  } as unknown as Request;
  const res = {
    status() {
      return this;
    },
    json() {},
  } as unknown as Response;
  await handler(req, res, (value) => {
    error = value;
  });
  assert.equal(error, undefined);
  const mutation = update.mock.calls[0].arguments[1] as unknown as {
    $push: { notes: { body: string } };
  };
  assert.deepEqual(Object.keys(mutation), ["$push"]);
  assert.equal(mutation.$push.notes.body, "Replaced incorrect PDF.");
});
