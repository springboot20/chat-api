import { Schema, model } from "mongoose";

const ContactEntrySchema = new Schema(
  {
    category: {
      type: String,
      enum: ["friend", "family", "work", "other"],
      default: "friend",
    },

    contact: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },

    isBlocked: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

const ContactSchema = new Schema(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    contactsList: [ContactEntrySchema],
  },
  { timestamps: true },
);

// ContactSchema.index({ owner: 1 , });

export const ContactModel = model("Contact", ContactSchema);
