/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
var Log;
(function (Log) {
    function error(msg) {
        if (Log.connection && msg) {
            Log.connection.console.error(msg);
        }
    }
    Log.error = error;
    function warn(msg) {
        if (Log.connection && msg) {
            Log.connection.console.warn(msg);
        }
    }
    Log.warn = warn;
    function info(msg) {
        if (Log.connection && msg) {
            Log.connection.console.info(msg);
        }
    }
    Log.info = info;
})(Log = exports.Log || (exports.Log = {}));
