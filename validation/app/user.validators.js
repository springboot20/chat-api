import { body, param } from "express-validator";
import { AvailableUserRole } from "../../constants/constants.js";

export const userRegisterValidation = () => {
  return [
    body("username")
      .trim()
      .notEmpty()
      .withMessage("Username is required")
      .toLowerCase(),
    body("email")
      .trim()
      .notEmpty()
      .withMessage("email is required")
      .isEmail()
      .normalizeEmail()
      .withMessage("Email must be an email")
      .toLowerCase(),
    body("password")
      .trim()
      .notEmpty()
      .withMessage("Password is required")
      .isLength({ min: 3 })
      .withMessage("Password should be a minimum of 3 "),
    body("role")
      .optional()
      .trim()
      .isIn(AvailableUserRole)
      .withMessage("Invalid user role"),
  ];
};

export const userLoginValidation = () => {
  return [
    body("username").optional(),
    body("email").optional().isEmail().withMessage("Email is invalid"),
    body("password").trim().notEmpty().withMessage("Password is required"),
  ];
};

export const userForgotPasswordValidation = () => {
  return [body("email").isEmail().withMessage("Email is invalid")];
};

export const userResetPasswordValidation = () => {
  return [
    body("password").trim().notEmpty().withMessage("Password is require"),
  ];
};

export const userAssignRoleValidation = () => {
  return [
    body("role")
      .trim()
      .optional()
      .isIn(AvailableUserRole)
      .withMessage("Invalid user role"),
  ];
};

export const userChangeCurrentPasswordValidation = () => {
  return [
    body("existingPassword")
      .notEmpty()
      .withMessage("Existing password is require"),
    body("newPassword").notEmpty().withMessage("New password is require"),
  ];
};
