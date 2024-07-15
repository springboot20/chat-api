import mongoose from 'mongoose';

const dataBaseConnection = async () => {
  return await mongoose.connect(process.env.MONGODB_URI, {
    user: process.env.USER,
    dbName: process.env.DBNAME,
    pass: process.env.PASS,
  });
};

export { dataBaseConnection };
