import winston from 'winston';

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Define level based on environment
const level = () => {
  const env = process.env.NODE_ENV || 'development';
  return env === 'development' ? 'debug' : 'info';
};

// Define colors for each level
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};

winston.addColors(colors);

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${info.message}`,
  ),
);

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
  )

const Logger = winston.createLogger({
  level: level(),
  levels,
 transports : [
  new winston.transports.Console({ format: consoleFormat }),
  // Add file transports for production
  new winston.transports.File({
    filename: 'logs/error.log',
    level: 'error',
    format: fileFormat
  }),
  new winston.transports.File({
     filename: 'logs/all.log',
     format: fileFormat
    }),
],
});

export default Logger;
