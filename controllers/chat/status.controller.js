import { StatusCodes } from 'http-status-codes';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { StatusModel, chatModel } from '../../models/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import mongoose from 'mongoose';
import {
  deleteFileFromCloudinary,
  uploadFileToCloudinary,
} from '../../configs/cloudinary.config.js';
import { getLocalFilePath, getStaticFilePath, removeLocalFile } from '../../helper.js';

const mode = process.env.NODE_ENV;

export const postTextStatus = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { text, backgroundColor, type } = req.body;

  const chats = await chatModel
    .find({ participants: new mongoose.Types.ObjectId(userId) })
    .select('participants')
    .lean();

  const visibleTo = [
    ...new Set(
      chats.flatMap((chat) =>
        chat.participants.map((id) => id.toString()).filter((id) => id !== userId.toString()),
      ),
    ),
  ];

  const statusDoc = await StatusModel.create({
    postedBy: userId,
    type: 'text',
    textContent: { text, backgroundColor, type },
    visibleTo,
  });

  await statusDoc.populate('postedBy', 'name username avatar');

  return new ApiResponse(StatusCodes.CREATED, 'Status Posted', statusDoc);
});

export const postNewStatus = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const { metadata } = req.body;

  const parsedMetadata = JSON.parse(metadata);
  const statusFiles = req.files.statusMedias;

  if (!statusFiles || statusFiles.length === 0) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'At least one media file is required');
  }

  if (statusFiles.length !== parsedMetadata.length) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Metadata count must match file count');
  }

  let mediaFilesResult = [];

  if (statusFiles && statusFiles.length > 0) {
    if (mode === 'production') {
      const uploadPromises = statusFiles.map(async (file) => {
        return uploadFileToCloudinary(
          file.buffer,
          `${process.env.CLOUDINARY_BASE_FOLDER}/statusMedias`,
        );
      });

      const apiResult = await Promise.all(uploadPromises);

      for (const media of apiResult) {
        mediaFilesResult.push({
          url: media?.secure_url,
          public_id: media?.public_id,
        });
      }
    } else {
      for (const file of statusFiles) {
        let category;

        if (file.mimetype.startsWith('image/')) {
          category = 'images';
        } else if (file.mimetype.startsWith('video/')) {
          category = 'videos';
        }

        const fileUrl = getStaticFilePath(req, category, file.filename);
        const localPath = getLocalFilePath(category, file.filename);

        const mediaFile = {
          url: fileUrl,
          localPath,
        };

        mediaFilesResult.push(mediaFile);
      }
    }
  }

  const chats = await chatModel
    .find({ participants: new mongoose.Types.ObjectId(userId) })
    .select('participants')
    .lean();

  const visibleTo = [
    ...new Set(
      chats.flatMap((chat) =>
        chat.participants.map((id) => id.toString()).filter((id) => id !== userId.toString()),
      ),
    ),
  ];

  const statusDocs = parsedMetadata.map((meta, index) => {
    const upload = mediaFilesResult[index];

    return {
      postedBy: userId,
      type: meta.type,
      caption: meta.caption,
      mediaContent: {
        url: upload?.secure_url || upload?.url,
        public_id: upload?.public_id,
        localPath: upload?.localPath,
      },
      visibleTo,
    };
  });

  const savedStatuses = await StatusModel.insertMany(statusDocs);

  // Populate user details
  await StatusModel.populate(savedStatuses, { path: 'postedBy', select: 'name username avatar' });

  return new ApiResponse(200, 'Status Posted', savedStatuses);
});

export const getStatusStoriesFeed = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const statuses = await StatusModel.aggregate([
    // Only show active statuses (not expired)
    { $match: { expiresAt: { $gt: new Date() } } },

    // Only show statuses visible to current user
    {
      $match: {
        $or: [
          { visibleTo: new mongoose.Types.ObjectId(userId) },
        ],
      },
    },

    { $sort: { createdAt: -1 } },

    {
      $group: {
        _id: '$postedBy',
        items: { $push: '$$ROOT' }, // Put all their statuses into an 'items' array
        lastUpdated: { $first: '$createdAt' },
      },
    },
    // Populate user details
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'user',
      },
    },
    { $unwind: '$user' },

    // Sort groups by last update
    { $sort: { lastUpdated: -1 } },

    // Remove sensitive user data
    {
      $project: {
        'user.password': 0,
        'user.email': 0,
      },
    },
  ]);

  return new ApiResponse(StatusCodes.OK, 'Status feed fetched successfully', statuses);
});

export const getUserStatusStories = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const statusStories = await StatusModel.aggregate([
    { $match: { postedBy: new mongoose.Types.ObjectId(userId) } },

    // Only active statuses
    { $match: { expiresAt: { $gt: new Date() } } },

    { $sort: { createdAt: 1 } },

    // Populate viewers
    {
      $lookup: {
        from: 'users',
        localField: 'viewedBy',
        foreignField: '_id',
        as: 'viewedByDetails',
      },
    },

    {
      $group: {
        _id: '$postedBy',
        items: {
          $push: {
            _id: '$_id',
            type: '$type',
            caption: '$caption',
            mediaContent: '$mediaContent',
            textContent: '$textContent',
            createdAt: '$createdAt',
            expiresAt: '$expiresAt',
            viewedBy: '$viewedByDetails',
            viewCount: { $size: '$viewedBy' },
          },
        },
        lastUpdated: { $last: '$createdAt' },
      },
    },

    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'user',
      },
    },
    { $unwind: '$user' },

    {
      $project: {
        'user.password': 0,
        'user.email': 0,
        'items.viewedBy.password': 0,
        'items.viewedBy.email': 0,
      },
    },
  ]);

  return new ApiResponse(
    StatusCodes.OK,
    'User status fetched successfully',
    statusStories.length > 0 ? statusStories[0] : null,
  );
});

export const markStatusAsViewed = asyncHandler(async (req, res) => {
  const { statusId } = req.params;
  const userId = req.user._id;

  // Validate status ID
  if (!mongoose.Types.ObjectId.isValid(statusId)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Invalid status ID');
  }

  // Find status
  const status = await StatusModel.findById(statusId);

  if (!status) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Status not found');
  }

  // Check if status is expired
  if (new Date(status.expiresAt) < new Date()) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Status has expired');
  }

  // Check if user has permission to view
  const canView =
    status.postedBy.toString() === userId.toString() ||
    status.visibleTo.some((id) => id.toString() === userId.toString());

  if (!canView) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'You do not have permission to view this status');
  }

  // Check if already viewed
  const alreadyViewed = status.viewedBy.some((id) => id.toString() === userId.toString());

  if (!alreadyViewed) {
    // Add user to viewedBy array
    status.viewedBy.push(userId);
    await status.save();
  }

  return new ApiResponse(StatusCodes.OK, 'Status marked as viewed', { statusId, viewedBy: userId });
});

export const deleteUserStatusStories = asyncHandler(async (req, res) => {
  const { statusId } = req.params;
  const userId = req.user._id;

  // Validate status ID
  if (!mongoose.Types.ObjectId.isValid(statusId)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Invalid status ID');
  }

  // Find status
  const status = await StatusModel.findById(statusId);

  if (!status) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Status not found');
  }

  // Check if user owns the status
  if (status.postedBy.toString() !== userId.toString()) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'You can only delete your own status');
  }

  // Delete media from cloudinary/local storage
  if (status.mediaContent?.public_id) {
    if (mode === 'production') {
      await deleteFileFromCloudinary(status.mediaContent.public_id);
    } else if (status.mediaContent.localPath) {
      removeLocalFile(status.mediaContent.localPath);
    }
  }

  // Delete status from database
  await StatusModel.findByIdAndDelete(statusId);

  return new ApiResponse(StatusCodes.OK, 'Status deleted successfully', { statusId });
});

export const cleanupExpiredStatuses = asyncHandler(async (req, res) => {
  const expiredStatuses = await StatusModel.find({
    expiresAt: { $lt: new Date() },
  });

  // Delete media files
  for (const status of expiredStatuses) {
    if (status.mediaContent?.public_id) {
      if (mode === 'production') {
        try {
          await deleteFileFromCloudinary(status.mediaContent.public_id);
        } catch (error) {
          console.error('Error deleting from cloudinary:', error);
        }
      } else if (status.mediaContent.localPath) {
        removeLocalFile(status.mediaContent.localPath);
      }
    }
  }

  // Delete from database
  const result = await StatusModel.deleteMany({
    expiresAt: { $lt: new Date() },
  });

  return new ApiResponse(StatusCodes.OK, 'Expired statuses cleaned up', {
    deletedCount: result.deletedCount,
  });
});
