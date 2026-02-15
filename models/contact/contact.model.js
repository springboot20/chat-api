import { Schema, model } from 'mongoose';

const ContactSchema = new Schema(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: ['friend', 'family', 'work', 'other'],
      default: 'friend',
    },
    contact: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    isBlocked: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

ContactSchema.index({ owner: 1, contact: 1 }, { unique: true });

export const ContactModel = model('Contact', ContactSchema);
