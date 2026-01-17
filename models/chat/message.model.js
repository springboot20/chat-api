import { Schema, model } from 'mongoose';

const messageSchema = new Schema(
  {
    content: {
      type: String,
    },

    status: {
      type: String,
      enum: ['sent', 'delivered', 'seen'],
      default: 'sent',
    },
    deliveredTo: [
      {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    seenBy: [
      {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
    ],

    mentions: {
      type: [
        {
          userId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
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
      ref: 'User',
    },
    chat: {
      type: Schema.Types.ObjectId,
      ref: 'Chat',
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    reactions: {
      type: [
        {
          messageId: {
            type: Schema.Types.ObjectId,
            ref: 'Message',
          },
          emoji: String,
          userIds: {
            type: [
              {
                type: Schema.Types.ObjectId,
                ref: 'User',
              },
            ],
            default: [],
          },
        },
      ],
      default: [],
    },
    replyId: {
      type: Schema.Types.ObjectId,
      ref: 'ChatMessage',
    },
  },
  { timestamps: true }
);

const messageModel = model('ChatMessage', messageSchema);
export { messageModel };
