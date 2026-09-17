// @desc    Centralized Error Handling Middleware
// @access  Public

import Logger from '../util/logger.js';

// 404 Not Found Handler
export const notFound = (req, res, next) => {
    const error = new Error(`Not Found - ${req.originalUrl}`);
    res.status(404);
    next(error);
};

// General Error Handler
export const errorHandler = (err, req, res, next) => {
    // Determine status code
    let statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    
    // If explicit status code in error object
    if (err.statusCode) {
        statusCode = err.statusCode;
    }

    res.status(statusCode);

    // Map status codes to error string codes
    let errorCode = "INTERNAL_SERVER_ERROR";
    if (statusCode === 400) errorCode = "BAD_REQUEST";
    else if (statusCode === 401) errorCode = "UNAUTHORIZED";
    else if (statusCode === 403) errorCode = "FORBIDDEN";
    else if (statusCode === 404) errorCode = "NOT_FOUND";
    else if (statusCode === 429) errorCode = "TOO_MANY_REQUESTS";

    // Override with custom code if provided
    if (err.code && typeof err.code === 'string') {
        errorCode = err.code;
    }

    // Server-side loggingz
    Logger.error(`[Error] ${req.method} ${req.url}: ${err.message}`);
    if (process.env.NODE_ENV === 'development') {
        Logger.error(err.stack);
    }

    // Fail closed in production: Prisma (and other libraries) throw errors
    // whose `.message` and `.code` carry raw driver detail -- column names,
    // constraint names, connection strings in some cases (audit #111). A 5xx
    // in production gets a fixed, safe message; explicit 4xx errors thrown by
    // our own code (validation, auth, not-found) keep their message, since
    // those are written for the client on purpose.
    const isServerError = statusCode >= 500;
    const safeForClient = !isServerError || process.env.NODE_ENV !== 'production';

    res.json({
        success: false,
        message: safeForClient ? (err.message || "An unexpected error occurred") : "Internal server error",
        code: safeForClient ? errorCode : 'INTERNAL_SERVER_ERROR',
        // Fail closed: only include the stack trace when explicitly running
        // in development, not merely "whenever NODE_ENV isn't 'production'".
        stack: process.env.NODE_ENV === 'development' ? err.stack : null,
    });
};
