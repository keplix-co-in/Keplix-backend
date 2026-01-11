// @desc    Simple Request Logger
// @access  Public

const logger = (req, res, next) => {
    const start = Date.now();
    const { method, url } = req;
    const ip = req.ip || req.connection.remoteAddress;

    // Log the request
    console.log(`[${new Date().toISOString()}] Incoming: ${method} ${url} from ${ip}`);

    // Capture the original send function to log response status/time
    const originalSend = res.send;
    
    // Hook into response finish
    res.on('finish', () => {
        const duration = Date.now() - start;
        const status = res.statusCode; 
        
        let logColor = '\x1b[32m'; // Green
        if (status >= 400) logColor = '\x1b[33m'; // Yellow
        if (status >= 500) logColor = '\x1b[31m'; // Red
        const resetColor = '\x1b[0m';

        console.log(`${logColor}[${status}]${resetColor} ${method} ${url} - ${duration}ms`);
    });

    next();
};

export default logger;
