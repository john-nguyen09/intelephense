/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

export interface LogWriter {
    error(msg:string);
    warn(msg:string);
    info(msg:string);
}

export namespace Log {
    export var connection: any;

    export function error(msg:string) {
        if(connection && msg) {
            connection.console.error(msg);
        }
    }

    export function warn(msg:string) {
        if(connection && msg) {
            connection.console.warn(msg);
        }
    }

    export function info(msg:string) {
        if(connection && msg) {
            connection.console.info(msg);
        }
    }
}