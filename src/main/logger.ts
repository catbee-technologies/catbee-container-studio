import pino from 'pino';
import { APP_VERSION, isDev, LOG_FILE_PATH, LOG_DIR_PATH, isVerbose } from './app/constants';

const transport = pino.transport(
  isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
          singleLine: true
        }
      }
    : {
        target: 'pino-roll',
        options: {
          file: LOG_FILE_PATH,
          frequency: 'daily',
          dateFormat: 'yyyy-MM-dd',
          size: '10m',
          mkdir: true,
          limit: {
            count: 30,
            removeOtherLogFiles: true
          }
        }
      }
);

export const logger = pino(
  {
    name: 'catbee-container-studio',
    level: isDev || isVerbose ? 'debug' : 'info',
    base: {
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      version: APP_VERSION
    },
    timestamp: pino.stdTimeFunctions.isoTime
  },
  transport
);

logger.info({ logDir: LOG_DIR_PATH }, 'Logger initialized');
