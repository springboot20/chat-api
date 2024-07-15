import jsonwebtoken from 'jsonwebtoken';
import { ApiError } from './ApiError.js';

const validateToken = (token, secret) => {
  try {
    let decodedToken = jsonwebtoken.verify(token, secret);
    return decodedToken;
  } catch (error) {
    throw new ApiError(401, error, []);
  }
};

export { validateToken };
