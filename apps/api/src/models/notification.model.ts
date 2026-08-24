import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { NOTIFICATION_TYPES } from '@safecheck/shared';

const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },

    title: { type: String, required: true },
    body: { type: String, required: true },
    href: { type: String, default: null },

    readAt: { type: Date, default: null },

    /** Which channels actually delivered, for support and debugging. */
    delivered: {
      socket: { type: Boolean, default: false },
      email: { type: Boolean, default: false },
    },
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });

export type NotificationDoc = InferSchemaType<typeof notificationSchema> & {
  _id: Types.ObjectId;
};
export const Notification = model('Notification', notificationSchema);
