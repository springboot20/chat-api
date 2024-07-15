import { Schema, model } from 'mongoose';

const messageSchema = new Schema(
  {
    content: {
      type: String,
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
      ref: 'User',
    },
    chat: {
      type: Schema.Types.ObjectId,
      ref: 'Chat',
    },
  },
  { timestamps: true }
);

const messageModel = model('ChatMessage', messageSchema);
export { messageModel };
