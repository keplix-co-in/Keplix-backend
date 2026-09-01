// @desc    Simple Request Logger
// @access  Public

import Logger from "../util/logger.js";

// Every request used to log an unconditional `Logger.info("Incoming: ...")`
// line. In production, Winston's level is 'info' (see util/logger.js), so
// that line -- and only 4xx/5xx completions, since 2xx/3xx complete at
// 'http', below the 'info' threshold -- shipped to stdout on EVERY single
// request, which Cloud Run forwards straight to Cloud Logging. That
// unconditional per-request volume was ~90% of a ₹1690 monthly GCP bill
// (₹1056 of it Cloud Logging alone). Demoted both lines to 'debug', which
// the production level filters out entirely -- error/warn completions
// (4xx/5xx) still log via the branches below, since those matter for
// debugging real problems and are comparatively rare.
const logger = (req, res, next) => {
    const start = Date.now();
    const { method, url } = req;
    const ip = req.ip || req.connection.remoteAddress;

   Logger.debug(`Incoming: ${method} ${url} from ${ip}`);


   // Hook into response finish
   res.on('finish', ()=>{
    const duration = Date.now() - start;
    const status = res.statusCode;

   const message= `[${status}] ${method}  ${url} - ${duration}ms`;

    if(status >=500){
        Logger.error(message);
    } else if (status >= 400){
        Logger.warn(message);
    } else {
        Logger.debug(message);
    }
});

    next();
};

export default logger;
