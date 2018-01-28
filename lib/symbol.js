/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const util = require("./util");
var PhpSymbolDoc;
(function (PhpSymbolDoc) {
    function create(description, type) {
        return {
            description: description || '',
            type: type || ''
        };
    }
    PhpSymbolDoc.create = create;
})(PhpSymbolDoc = exports.PhpSymbolDoc || (exports.PhpSymbolDoc = {}));
var PhpSymbol;
(function (PhpSymbol) {
    /**
     *
     * @param s Symbol to get keys identifier
     */
    function keys(s) {
        if (!s.name) {
            return [];
        }
        return [s.name];
    }
    PhpSymbol.keys = keys;
    function isParameter(s) {
        return s.kind === 128 /* Parameter */;
    }
    function isClassLike(s) {
        return (s.kind & (1 /* Class */ | 2 /* Interface */ | 4 /* Trait */)) > 0;
    }
    PhpSymbol.isClassLike = isClassLike;
    function signatureString(s) {
        if (!s || !(s.kind & (64 /* Function */ | 32 /* Method */))) {
            return '';
        }
        let params = s.children ? s.children.filter(isParameter) : [];
        let paramStrings = [];
        let param;
        let parts;
        let paramType;
        for (let n = 0, l = params.length; n < l; ++n) {
            param = params[n];
            parts = [];
            if (n) {
                parts.push(',');
            }
            paramType = PhpSymbol.type(param);
            if (paramType) {
                parts.push(paramType);
            }
            parts.push(param.name);
            if (param.value) {
                parts.push('=');
                parts.push(param.value);
            }
            paramStrings.push(parts.join(' '));
        }
        let sig = `(${paramStrings.join('')})`;
        let sType = PhpSymbol.type(s);
        if (sType) {
            sig += `: ${sType}`;
        }
        return sig;
    }
    PhpSymbol.signatureString = signatureString;
    function hasParameters(s) {
        return s.children && s.children.find(isParameter) !== undefined;
    }
    PhpSymbol.hasParameters = hasParameters;
    function notFqn(text) {
        if (!text) {
            return text;
        }
        let pos = text.lastIndexOf('\\') + 1;
        return text.slice(pos);
    }
    PhpSymbol.notFqn = notFqn;
    function namespace(fqn) {
        if (!fqn) {
            return '';
        }
        let pos = fqn.lastIndexOf('\\');
        return pos < 0 ? '' : fqn.slice(0, pos);
    }
    PhpSymbol.namespace = namespace;
    /**
     * Shallow clone
     * @param s
     */
    function clone(s) {
        return {
            kind: s.kind,
            name: s.name,
            children: s.children,
            location: s.location,
            modifiers: s.modifiers,
            associated: s.associated,
            type: s.type,
            doc: s.doc,
            scope: s.scope,
            value: s.value
        };
    }
    PhpSymbol.clone = clone;
    function type(s) {
        if (s.type) {
            return s.type;
        }
        else if (s.doc && s.doc.type) {
            return s.doc.type;
        }
        else {
            return '';
        }
    }
    PhpSymbol.type = type;
    function setScope(symbols, scope) {
        if (!symbols) {
            return symbols;
        }
        for (let n = 0; n < symbols.length; ++n) {
            symbols[n].scope = scope;
        }
        return symbols;
    }
    PhpSymbol.setScope = setScope;
    function create(kind, name, location) {
        return {
            kind: kind,
            name: name,
            location: location
        };
    }
    PhpSymbol.create = create;
    function filterChildren(parent, fn) {
        if (!parent || !parent.children) {
            return [];
        }
        return util.filter(parent.children, fn);
    }
    PhpSymbol.filterChildren = filterChildren;
    function findChild(parent, fn) {
        if (!parent || !parent.children) {
            return undefined;
        }
        return util.find(parent.children, fn);
    }
    PhpSymbol.findChild = findChild;
    function isAssociated(symbol, name) {
        let lcName = name.toLowerCase();
        let fn = (x) => {
            return lcName === x.name.toLowerCase();
        };
        return util.find(symbol.associated, fn);
    }
    PhpSymbol.isAssociated = isAssociated;
    /**
     * uniqueness determined by name and symbol kind
     * @param symbol
     */
    function unique(symbols) {
        let uniqueSymbols = [];
        if (!symbols) {
            return uniqueSymbols;
        }
        let map = {};
        let s;
        for (let n = 0, l = symbols.length; n < l; ++n) {
            s = symbols[n];
            if (!(map[s.name] & s.kind)) {
                uniqueSymbols.push(s);
                map[s.name] |= s.kind;
            }
        }
        return uniqueSymbols;
    }
    PhpSymbol.unique = unique;
})(PhpSymbol = exports.PhpSymbol || (exports.PhpSymbol = {}));
