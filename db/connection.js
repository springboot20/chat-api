import mongoose from "mongoose";

const dataBaseConnection = async () => {
  const connectionString =
    process.env.NODE_ENV === "production" ? process.env.MONGODB_URI : process.env.MONGODB_URI_LOCAL;

  const connectData =
    process.env.NODE_ENV === "production"
      ? {
          dbName: process.env.DBNAME,
          user: process.env.USER,
          pass: process.env.PASS,
        }
      : {
          dbName: process.env.DBNAME,
        };

  return await mongoose.connect(connectionString, connectData);
};

export { dataBaseConnection };
