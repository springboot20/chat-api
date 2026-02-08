import { Schema, model } from 'mongoose';

const statusSchema = new Schema(
  {
    postedBy: {
      ref: 'User',
      type: Schema.Types.ObjectId,
      required: true,
    },
    type: {
      type: String,
      enum: ['image', 'text', 'video'],
      default: 'text',
    },
    caption: {
      type: String,
    },
    // For Image/Video
    mediaContent: {
      url: String,
      public_id: String,
      localPath: String,
    },
    // For Text Status
    textContent: {
      text: {
        type: String,
        maxlength: 500,
      },
      backgroundColor: String,
      fontFamily: String,
    },
    viewedBy: [
      {
        ref: 'User',
        type: Schema.Types.ObjectId,
      },
    ],
    visibleTo: [
      {
        ref: 'User',
        type: Schema.Types.ObjectId,
      },
    ],
    expiresAt: {
      type: Date,
      // Sets default to 24 hours from creation
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
      // This index tells MongoDB to delete the document when the time is reached
      index: { expires: 0 },
    },
  },
  { timestamps: true },
);

const StatusModel = model('Status', statusSchema);
export { StatusModel };
