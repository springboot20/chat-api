import { Schema, model } from 'mongoose';

const chatSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    isGroupChat: {
      type: Boolean,
      default: false,
    },
    participants: {
      type: [
        {
          type: Schema.Types.ObjectId,
          ref: 'User',
        },
      ],
      index: true,
    },
    lastMessage: {
      type: Schema.Types.ObjectId,
      ref: 'ChatMessage',
    },
    admin: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true },
);

chatSchema.index({ participants: 1 });

const chatModel = model('Chat', chatSchema);
export { chatModel };
