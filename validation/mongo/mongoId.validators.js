import { body, param } from 'express-validator';

/**
 * @param {string} mongoId
 */
export const mongoPathVariableValidation = (mongoId) => {
  return [param(mongoId).notEmpty().isMongoId().withMessage(`invalid ${mongoId}`)];
};

/**
 * @param {string} mongoId
 */
export const mongoRequestBodyValidation = (mongoId) => {
    mongoId.
  return [body(mongoId).notEmpty().isMongoId().withMessage(`invalid ${mongoId}`)];
};
