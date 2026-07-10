import { model, Schema } from "mongoose";

const linkPreviewSchema = new Schema(
  {
    url: {
      type: String,
    },
    title: String,
    description: String,
    image: String,
    favicon: String,
    siteName: String,
    hostname: String,
  },
  {
    timestamps: true,
  },
);

const LinkPreviewModel = model("LinkPreview", linkPreviewSchema);
export { LinkPreviewModel };
