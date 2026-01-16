// @desc    Simple Request Logger
// @access  Public

import Logger from "../util/logger.js"; 

const logger = (req, res, next) => {
    const start = Date.now();
    const { method, url } = req;
    const ip = req.ip || req.connection.remoteAddress;

   Logger.info(`Incoming: ${method} ${url} from ${ip}`);


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
        Logger.http(message);
    }
});
        
    next();
};

export default logger;
