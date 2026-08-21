import pino from 'pino';
import { APP_VERSION, isDev, LOG_FILE_PATH } from './constants';

const destination = pino.destination({
  dest: LOG_FILE_PATH,
  sync: false
});

export const logger = pino(
  {
    name: 'catbee-container-studio',
    level: isDev ? 'debug' : 'info',
    base: {
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      version: APP_VERSION
    },
    timestamp: pino.stdTimeFunctions.isoTime,

    ...(isDev && {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
          singleLine: true
        }
      }
    })
  },
  isDev ? undefined : destination
);

logger.info({ logFilePath: LOG_FILE_PATH }, 'Logger initialized');
