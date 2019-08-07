/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { Predicate } from './types';
import * as util from './utils';
import { Location } from 'vscode-languageserver';

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

export function symbolKindToString(kind: SymbolKind) {
    switch (kind) {
        case SymbolKind.None:
            return 'None';
        case SymbolKind.Class:
            return 'Class';
        case SymbolKind.Interface:
            return 'Interface';
        case SymbolKind.Trait:
            return 'Trait';
        case SymbolKind.Constant:
            return 'Constant';
        case SymbolKind.Property:
            return 'Property';
        case SymbolKind.Method:
            return 'Method';
        case SymbolKind.Function:
            return 'Function';
        case SymbolKind.Parameter:
            return 'Parameter';
        case SymbolKind.Variable:
            return 'Variable';
        case SymbolKind.Namespace:
            return 'Namespace';
        case SymbolKind.ClassConstant:
            return 'ClassConstant';
        case SymbolKind.Constructor :
            return 'Constructor';
        case SymbolKind.File:
            return 'File';
        case SymbolKind.GlobalVariable:
            return 'GlobalVariable';
        default:
            return 'Unknown';
    }
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

export function modifiersToString(modifiers: SymbolModifier): string {
    const results: string[] = [];

    if ((modifiers & SymbolModifier.Public) !== 0) {
        results.push('Public');
    }
    if ((modifiers & SymbolModifier.Protected) !== 0) {
        results.push('Protected');
    }
    if ((modifiers & SymbolModifier.Private) !== 0) {
        results.push('Private');
    }
    if ((modifiers & SymbolModifier.Final) !== 0) {
        results.push('Final');
    }
    if ((modifiers & SymbolModifier.Abstract) !== 0) {
        results.push('Abstract');
    }
    if ((modifiers & SymbolModifier.Static) !== 0) {
        results.push('Static');
    }
    if ((modifiers & SymbolModifier.ReadOnly) !== 0) {
        results.push('ReadOnly');
    }
    if ((modifiers & SymbolModifier.WriteOnly) !== 0) {
        results.push('WriteOnly');
    }
    if ((modifiers & SymbolModifier.Magic) !== 0) {
        results.push('Magic');
    }
    if ((modifiers & SymbolModifier.Anonymous) !== 0) {
        results.push('Anonymous');
    }
    if ((modifiers & SymbolModifier.Reference) !== 0) {
        results.push('Reference');
    }
    if ((modifiers & SymbolModifier.Variadic) !== 0) {
        results.push('Variadic');
    }
    if ((modifiers & SymbolModifier.Use) !== 0) {
        results.push('Use');
    }

    return results.join(' | ');
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
    scope?: string;
    modifiers?: SymbolModifier;
    doc?: PhpSymbolDoc;
    type?: string;
    associated?: PhpSymbol[];
    children?: PhpSymbol[];
    value?: string;
    location?: Location;
}

export interface SymbolIdentifier {
    kind: SymbolKind;
    name: string;
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
    }

    function isParameter(s: PhpSymbol) {
        return s.kind === SymbolKind.Parameter;
    }

    export function isClassLike(s: PhpSymbol) {
        return (s.kind & (SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait)) > 0;
    }

    export function signatureString(s: PhpSymbol) {

        if (!s || !(s.kind & (SymbolKind.Function | SymbolKind.Method))) {
            return '';
        }

        let params = s.children ? s.children.filter(isParameter) : [];
        let paramStrings: String[] = [];
        let param: PhpSymbol;
        let parts: string[];
        let paramType: string;

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

    export function namespace(fqn:string) {
        if(!fqn) {
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
        for (let n = 0; n < symbols.length; ++n) {
            symbols[n].scope = scope;
        }
        return symbols;
    }

    export function create(kind: SymbolKind, name: string, location?: Location): PhpSymbol {
        return {
            kind: kind,
            name: name,
            location: location
        };
    }

    export function filterChildren(parent: PhpSymbol | undefined, fn: Predicate<PhpSymbol>) {
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

    /**
     * Equality determined by location
     * 
     * @param s1 First symbol
     * @param s2 Second symbol
     */
    export function equality(s1: PhpSymbol, s2: PhpSymbol) {
        if (!s1.location || !s2.location) {
            return s1.name == s2.name &&
                s1.kind == s2.kind &&
                s1.modifiers == s2.modifiers;
        }

        return s1.location.uri == s2.location.uri &&
            util.rangeEquality(s1.location.range, s2.location.range);
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
