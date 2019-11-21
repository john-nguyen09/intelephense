/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export interface LogWriter {
    error(msg: string);
    warn(msg: string);
    info(msg: string);
}

export namespace Log {
    export var console: any = global.console;
    const logPath = path.join(os.homedir(), '.intelephense', 'error.log');

    export function error(err: any) {
        if (err) {
            if ('message' in err) {
                console.error(err.message);
                if ('stack' in err) {
                    console.error(err.stack);
                }
            } else {
                console.error(err);
            }
        }
    }

    export function warn(msg: string) {
        if (msg) {
            console.warn(msg);
        }
    }

    export function info(msg: string) {
        if (msg) {
            console.info(msg);
        }
    }

    export function writeLog(msg: string) {
        fs.appendFileSync(logPath, msg);
    }
}