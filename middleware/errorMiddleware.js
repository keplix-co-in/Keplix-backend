// @desc    Centralized Error Handling Middleware
// @access  Public

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

    // Server-side logging
    console.error(`[Error] ${req.method} ${req.url}: ${err.message}`);
    if (process.env.NODE_ENV === 'development') {
        console.error(err.stack);
    }

    res.json({
        success: false,
        message: err.message || "An unexpected error occurred",
        code: errorCode,
        stack: process.env.NODE_ENV === 'production' ? null : err.stack,
    });
};
