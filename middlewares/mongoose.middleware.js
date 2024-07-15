import mongoose from 'mongoose';

export const withTransaction = (fn) => {
  return async (req, res) => {
    try {
      let result;
      await mongoose.connection.transaction(async (session) => {
        result = await fn(req, res, session);
        return result;
      });
      return result;
    } catch (error) {
      console.log(error);
    }
  };
};
