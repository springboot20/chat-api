import { Schema, model } from "mongoose";

const messageSchema = new Schema(
  {
    content: {
      type: String,
    },
    mentions: {
      type: [
        {
          userId: {
            type: Schema.Types.ObjectId,
            ref: "User",
          },
          position: {
            type: Number,
          },
          username: {
            type: String,
          },
        },
      ],
      default: [],
    },
    attachments: {
      type: [
        {
          url: String,
          localPath: String,
        },
      ],
      default: [],
    },
    sender: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    chat: {
      type: Schema.Types.ObjectId,
      ref: "Chat",
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    reactions: {
      type: [
        {
          emoji: String,
          userId: {
            type: Schema.Types.ObjectId,
            ref: "User",
          },
        },
      ],
      default: [],
    },
    replyId: {
      type: Schema.Types.ObjectId,
      ref: "ChatMessage",
    },
  },
  { timestamps: true }
);

const messageModel = model("ChatMessage", messageSchema);
export { messageModel };
