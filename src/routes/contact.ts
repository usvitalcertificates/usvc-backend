import { Router } from "express";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import {
  contactSubmissionSchema,
  hasSensitiveContactContent,
  isContactSubmissionSuspicious,
} from "../lib/contact-validation.js";
import { ContactMessage } from "../models/contact-message.js";
import { EmailOutbox } from "../models/email-outbox.js";

const SUPPORT_EMAIL = "support@usvitalcertificates.org";
const contactSubmissionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many messages were sent. Please try again in 15 minutes." },
});

export const contactRouter = Router();

contactRouter.post("/", contactSubmissionLimiter, async (req, res, next) => {
  try {
    const input = contactSubmissionSchema.parse(req.body);
    if (isContactSubmissionSuspicious(input.antiAbuse))
      return res.status(422).json({ message: "We could not validate this submission." });

    const sensitiveContentWarning = hasSensitiveContactContent(input.message);
    const session = await mongoose.startSession();
    let messageId = "";
    try {
      await session.withTransaction(async () => {
        const [contactMessage] = await ContactMessage.create(
          [
            {
              fullName: input.fullName,
              email: input.email,
              orderNumber: input.orderNumber,
              message: input.message,
              sensitiveContentWarning,
              status: "NEW",
              emailEvents: [
                {
                  action: "contact_email_queued",
                  metadata: {
                    templates: ["CONTACT_SUPPORT_NOTIFICATION", "CONTACT_CUSTOMER_RECEIPT"],
                  },
                },
              ],
            },
          ],
          { session },
        );
        messageId = contactMessage._id.toHexString();
        await EmailOutbox.create(
          [
            {
              _id: `contact-support:${messageId}`,
              contactMessageId: contactMessage._id,
              recipient: SUPPORT_EMAIL,
              template: "CONTACT_SUPPORT_NOTIFICATION",
            },
            {
              _id: `contact-receipt:${messageId}`,
              contactMessageId: contactMessage._id,
              recipient: input.email,
              template: "CONTACT_CUSTOMER_RECEIPT",
            },
          ],
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    res.status(201).json({ id: messageId, received: true });
  } catch (error) {
    next(error);
  }
});
