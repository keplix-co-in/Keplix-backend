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
    // If status code is 200 (OK) but there is an error, default to 500
    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    
    res.status(statusCode);

    // Log the error for server-side debugging
    console.error(`[Error] ${req.method} ${req.url}:`, err.message);
    if (process.env.NODE_ENV === 'development') {
        console.error(err.stack);
    }

    res.json({
        success: false,
        code: statusCode,
        message: err.message,
        // Only show stack trace in development
        stack: process.env.NODE_ENV === 'production' ? null : err.stack,
    });
};
