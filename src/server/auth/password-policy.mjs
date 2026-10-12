import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
export const passwordSchema = z.string()
  .min(PASSWORD_MIN_LENGTH, "Password must be at least 10 characters.")
  .max(PASSWORD_MAX_LENGTH, "Password must not exceed 200 characters.");

export class PasswordValidationError extends TypeError {
  constructor(message) {
    super(message);
    this.code = "INVALID_PASSWORD";
    this.statusCode = 400;
  }
}

export function validatePassword(password) {
  const result = passwordSchema.safeParse(password);
  if (!result.success) throw new PasswordValidationError(result.error.issues[0].message);
  return result.data;
}
