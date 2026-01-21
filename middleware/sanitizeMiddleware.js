import xss from 'xss';
import Logger from '../util/logger.js';

/**
 * Input Sanitization Middleware
 * Prevents XSS attacks by sanitizing request body, query, and params
 */

const sanitizeValue = (value) => {
  if (typeof value === 'string') {
    return xss(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (typeof value === 'object' && value !== null) {
    return sanitizeObject(value);
  }
  return value;
};

const sanitizeObject = (obj) => {
  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    sanitized[key] = sanitizeValue(value);
  }
  return sanitized;
};

export const sanitizeInput = (req, res, next) => {
  try {
    // Sanitize body
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeObject(req.body);
    }

    // Sanitize query params
    if (req.query && typeof req.query === 'object') {
      req.query = sanitizeObject(req.query);
    }

    // Sanitize URL params
    if (req.params && typeof req.params === 'object') {
      req.params = sanitizeObject(req.params);
    }

    next();
  } catch (error) {
    Logger.error(`[Sanitization] Error: ${error.message}`);
    next(); // Continue even if sanitization fails (log only)
  }
};

export default sanitizeInput;
