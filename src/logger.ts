/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

export interface LogWriter {
    error(msg: string);
    warn(msg: string);
    info(msg: string);
}

export namespace Log {
    export var console: any = global.console;

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
}