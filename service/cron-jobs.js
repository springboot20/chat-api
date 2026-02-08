import cron from 'node-cron';
import { StatusModel } from '../models/index.js';
import { deleteFileFromCloudinary } from '../configs/cloudinary.config.js';
import { removeLocalFile } from '../helper.js';

const mode = process.env.NODE_ENV;

/**
 * Cleanup expired statuses
 * Runs every hour
 */
export const setupStatusCleanupJob = () => {
  // Run every hour
  cron.schedule('0 * * * *', async () => {
    try {
      console.log('🧹 Running status cleanup job...');

      const expiredStatuses = await StatusModel.find({
        expiresAt: { $lt: new Date() },
      });

      if (expiredStatuses.length === 0) {
        console.log('✅ No expired statuses to clean up');
        return;
      }

      console.log(`📊 Found ${expiredStatuses.length} expired statuses`);

      // Delete media files
      let deletedMediaCount = 0;
      for (const status of expiredStatuses) {
        if (status.mediaContent?.public_id || status.mediaContent?.localPath) {
          try {
            if (mode === 'production' && status.mediaContent.public_id) {
              await deleteFileFromCloudinary(status.mediaContent.public_id);
            } else if (status.mediaContent.localPath) {
              removeLocalFile(status.mediaContent.localPath);
            }
            deletedMediaCount++;
          } catch (error) {
            console.error(`❌ Error deleting media for status ${status._id}:`, error.message);
          }
        }
      }

      // Delete from database
      const result = await StatusModel.deleteMany({
        expiresAt: { $lt: new Date() },
      });

      console.log(`✅ Cleanup complete:`);
      console.log(`   - Deleted ${result.deletedCount} status documents`);
      console.log(`   - Deleted ${deletedMediaCount} media files`);
    } catch (error) {
      console.error('❌ Error in status cleanup job:', error);
    }
  });

  console.log('⏰ Status cleanup cron job scheduled (runs every hour)');
};

/**
 * Alternative: Cleanup job that runs every 6 hours
 */
export const setupStatusCleanupJob6Hours = () => {
  // Run every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    try {
      console.log('🧹 Running 6-hour status cleanup job...');

      const result = await StatusModel.deleteMany({
        expiresAt: { $lt: new Date() },
      });

      console.log(`✅ Deleted ${result.deletedCount} expired statuses`);
    } catch (error) {
      console.error('❌ Error in cleanup job:', error);
    }
  });

  console.log('⏰ Status cleanup cron job scheduled (runs every 6 hours)');
};

/**
 * Manual cleanup function (can be called on-demand)
 */
export const manualStatusCleanup = async () => {
  try {
    console.log('🧹 Starting manual status cleanup...');

    const expiredStatuses = await StatusModel.find({
      expiresAt: { $lt: new Date() },
    }).select('_id mediaContent');

    if (expiredStatuses.length === 0) {
      return { success: true, message: 'No expired statuses found', deletedCount: 0 };
    }

    // Delete media files
    for (const status of expiredStatuses) {
      if (status.mediaContent?.public_id || status.mediaContent?.localPath) {
        try {
          if (mode === 'production' && status.mediaContent.public_id) {
            await deleteFileFromCloudinary(status.mediaContent.public_id);
          } else if (status.mediaContent.localPath) {
            removeLocalFile(status.mediaContent.localPath);
          }
        } catch (error) {
          console.error(`Error deleting media for status ${status._id}:`, error.message);
        }
      }
    }

    // Delete from database
    const result = await StatusModel.deleteMany({
      expiresAt: { $lt: new Date() },
    });

    return {
      success: true,
      message: 'Cleanup completed successfully',
      deletedCount: result.deletedCount,
    };
  } catch (error) {
    console.error('Error in manual cleanup:', error);
    return {
      success: false,
      message: error.message,
      deletedCount: 0,
    };
  }
};
