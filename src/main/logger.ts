import pino from 'pino';
import { isDev } from './constants';
import { app } from 'electron';

export const logger = pino(
  {
    name: 'catbee-container-studio',
    level: isDev ? 'debug' : 'info',
    base: {
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      version: app.getVersion()
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
  isDev
    ? undefined
    : pino.destination({
        dest: `${app.getPath('logs')}/main.log`,
        sync: false
      })
);
