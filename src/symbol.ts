/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { TypeString } from './typeString';
import { BinarySearch } from './types';
import { Location, Range } from 'vscode-languageserver-types';
import { Predicate, HashedLocation } from './types';
import * as util from './util';

export const enum SymbolKind {
    None = 0,
    Class = 1 << 0,
    Interface = 1 << 1,
    Trait = 1 << 2,
    Constant = 1 << 3,
    Property = 1 << 4,
    Method = 1 << 5,
    Function = 1 << 6,
    Parameter = 1 << 7,
    Variable = 1 << 8,
    Namespace = 1 << 9,
    ClassConstant = 1 << 10,
    Constructor = 1 << 11,
    File = 1 << 12,
    GlobalVariable = 1 << 13
}

export const enum SymbolModifier {
    None = 0,
    Public = 1 << 0,
    Protected = 1 << 1,
    Private = 1 << 2,
    Final = 1 << 3,
    Abstract = 1 << 4,
    Static = 1 << 5,
    ReadOnly = 1 << 6,
    WriteOnly = 1 << 7,
    Magic = 1 << 8,
    Anonymous = 1 << 9,
    Reference = 1 << 10,
    Variadic = 1 << 11,
    Use = 1 << 12
}

export interface PhpSymbolDoc {
    description?: string;
    type?: string;
}

export namespace PhpSymbolDoc {
    export function create(description?: string, type?: string): PhpSymbolDoc {
        return {
            description: description || '',
            type: type || ''
        };
    }
}

export interface PhpSymbol extends SymbolIdentifier {
    modifiers?: SymbolModifier;
    doc?: PhpSymbolDoc;
    type?: string;
    associated?: PhpSymbol[];
    children?: PhpSymbol[];
    value?: string;
    location?: HashedLocation;
}

export interface SymbolIdentifier {
    kind: SymbolKind;
    name: string;
    scope?: string;
}

export namespace PhpSymbol {

    /**
     * 
     * @param s Symbol to get keys identifier
     */
    export function keys(s: PhpSymbol) {
        if (!s.name) {
            return [];
        }

        return [s.name];
            return [s.name.toLowerCase()];
        }

    }

    function isParameter(s: PhpSymbol) {
        return s.kind === SymbolKind.Parameter;
    }

    export function isClassLike(s: PhpSymbol) {
        return (s.kind & (SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait)) > 0;
    }

    export function signatureString(s: PhpSymbol, excludeTypeInfo?: boolean) {

        if (!s || !(s.kind & (SymbolKind.Function | SymbolKind.Method))) {
            return '';
        }

        const params = s.children ? s.children.filter(isParameter) : [];
        const paramStrings: String[] = [];
        let param: PhpSymbol;
        let parts: string[];
        let paramType: string;

        for (let n = 0, l = params.length; n < l; ++n) {
            param = params[n];
            parts = [];

            if (n) {
                parts.push(',');
            }

            if (!excludeTypeInfo) {
                paramType = PhpSymbol.type(param);
                if (paramType) {
                    parts.push(paramType);
                }
            }

            parts.push(param.name);

            if (param.value) {
                parts.push('=');
                parts.push(param.value);
            }

            paramStrings.push(parts.join(' '));
        }

        let sig = `(${paramStrings.join('')})`;

        if (!excludeTypeInfo) {
            const sType = PhpSymbol.type(s);
            if (sType) {
                sig += `: ${sType}`;
            }
        }

        return sig;

    }

    export function hasParameters(s: PhpSymbol) {
        return s.children && s.children.find(isParameter) !== undefined;
    }

    export function notFqn(text: string) {
        if (!text) {
            return text;
        }
        let pos = text.lastIndexOf('\\') + 1;
        return text.slice(pos);
    }

    export function namespace(fqn: string) {
        if (!fqn) {
            return '';
        }

        let pos = fqn.lastIndexOf('\\');
        return pos < 0 ? '' : fqn.slice(0, pos);
    }

    /**
     * Shallow clone
     * @param s 
     */
    export function clone(s: PhpSymbol): PhpSymbol {
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

    export function type(s: PhpSymbol) {
        if (s.type) {
            return s.type;
        } else if (s.doc && s.doc.type) {
            return s.doc.type;
        } else {
            return '';
        }

    }

    export function setScope(symbols: PhpSymbol[], scope: string) {
        if (!symbols) {
            return symbols;
        }
        for (let n = 0; n < symbols.length; ++n) {
            symbols[n].scope = scope;
        }
        return symbols;
    }

    export function create(kind: SymbolKind, name: string, location?: HashedLocation): PhpSymbol {
        return {
            kind: kind,
            name: name,
            location: location
        };
    }

    export function filterChildren(parent: PhpSymbol, fn: Predicate<PhpSymbol>) {
        if (!parent || !parent.children) {
            return [];
        }

        return util.filter<PhpSymbol>(parent.children, fn);
    }

    export function findChild(parent: PhpSymbol, fn: Predicate<PhpSymbol>) {
        if (!parent || !parent.children) {
            return undefined;
        }

        return util.find<PhpSymbol>(parent.children, fn);
    }

    export function isAssociated(symbol: PhpSymbol, name: string) {
        let lcName = name.toLowerCase();
        let fn = (x: PhpSymbol) => {
            return lcName === x.name.toLowerCase();
        }
        return util.find(symbol.associated, fn);
    }

    /**
     * uniqueness determined by name and symbol kind
     * @param symbol 
     */
    export function unique(symbols: PhpSymbol[]) {

        let uniqueSymbols: PhpSymbol[] = [];
        if (!symbols) {
            return uniqueSymbols;
        }

        let map: { [index: string]: SymbolKind } = {};
        let s: PhpSymbol;

        for (let n = 0, l = symbols.length; n < l; ++n) {
            s = symbols[n];
            if (!(map[s.name] & s.kind)) {
                uniqueSymbols.push(s);
                map[s.name] |= s.kind;
            }
        }

        return uniqueSymbols;
    }

}

/**
 * uniqueness determined by name and symbol kind
 */
export class UniqueSymbolSet {

    private _symbols: PhpSymbol[];
    private _map: { [index: string]: SymbolKind } = {};

    constructor() {
        this._symbols = [];
    }

    add(s: PhpSymbol) {
        if (!this.has(s)) {
            this._symbols.push(s);
            this._map[s.name] |= s.kind;
        }
    }

    has(s: PhpSymbol) {
        return (this._map[s.name] & s.kind) === s.kind;
    }

    toArray() {
        return this._symbols.slice(0);
    }

}
