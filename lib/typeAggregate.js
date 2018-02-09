/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const symbol_1 = require("./symbol");
const util = require("./util");
const typeString_1 = require("./typeString");
class TypeAggregate {
    constructor(symbolStore, symbol, excludeTraits) {
        this.symbolStore = symbolStore;
        this._excludeTraits = false;
        if (!symbol) {
            throw new Error('Invalid Argument');
        }
        this._symbol = symbol;
        this._excludeTraits = excludeTraits;
    }
    get type() {
        return this._symbol;
    }
    get name() {
        return Array.isArray(this._symbol) ? this._symbol[0].name : this._symbol.name;
    }
    isBaseClass(name) {
        let lcName = name.toLowerCase();
        let fn = (x) => {
            return x.kind === 1 /* Class */ && lcName === x.name.toLowerCase();
        };
        return !!this.associated(fn);
    }
    isAssociated(name) {
        if (!name) {
            return false;
        }
        let lcName = name.toLowerCase();
        let fn = (x) => {
            return x.name.toLowerCase() === lcName;
        };
        return this.associated(fn).length > 0;
    }
    associated(filter) {
        let assoc = this._getAssociated();
        return filter ? util.filter(assoc, filter) : assoc;
    }
    firstMember(predicate) {
        let member;
        let symbols = Array.isArray(this._symbol) ? this._symbol : [this._symbol];
        for (let n = 0; n < symbols.length; ++n) {
            if ((member = symbol_1.PhpSymbol.findChild(symbols[n], predicate))) {
                return member;
            }
        }
        for (let s of this._associatedIterator()) {
            if ((member = symbol_1.PhpSymbol.findChild(s, predicate))) {
                return member;
            }
        }
        return undefined;
    }
    members(mergeStrategy, predicate) {
        let associated = this._getAssociated().slice(0);
        let kind;
        let name;
        if (Array.isArray(this._symbol)) {
            associated.unshift(...this._symbol);
            kind = this._symbol[0].kind;
            name = this._symbol[0].name;
        }
        else {
            associated.unshift(this._symbol);
            kind = this._symbol.kind;
            name = this._symbol.name;
        }
        let members;
        switch (kind) {
            case 1 /* Class */:
                members = this._classMembers(associated, mergeStrategy, predicate);
                break;
            case 2 /* Interface */:
                members = this._interfaceMembers(associated, predicate);
                break;
            case 4 /* Trait */:
                members = this._traitMembers(associated, predicate);
                break;
            default:
                members = [];
                break;
        }
        //$this and static return types are resolved to fqn at this point as fqn is known
        return this._resolveThisAndStaticReturnType(members, name);
    }
    _resolveThisAndStaticReturnType(members, name) {
        let resolved = [];
        let s;
        let type;
        let sClone;
        for (let n = 0; n < members.length; ++n) {
            s = members[n];
            if ((s.kind & (32 /* Method */ | 16 /* Property */)) > 0 && s.doc && s.doc.type) {
                type = typeString_1.TypeString.resolveThisOrStatic(s.doc.type, name);
                if (type !== s.doc.type) {
                    //clone the symbol to use resolved type
                    sClone = symbol_1.PhpSymbol.clone(s);
                    sClone.doc = { description: s.doc.description, type: type };
                    resolved.push(sClone);
                    continue;
                }
            }
            resolved.push(s);
        }
        return resolved;
    }
    /**
     * root type should be first element of associated array
     * @param associated
     * @param predicate
     */
    _classMembers(associated, strategy, predicate) {
        let members = [];
        let s;
        let traits = [];
        let p = predicate;
        let noPrivate = (x) => {
            return !(x.modifiers & 4 /* Private */) && (!predicate || predicate(x));
        };
        for (let n = 0; n < associated.length; ++n) {
            s = associated[n];
            if (s.kind === 4 /* Trait */) {
                traits.push(s);
            }
            else if (s.children) {
                Array.prototype.push.apply(members, p ? s.children.filter(p) : s.children);
            }
            p = noPrivate;
        }
        p = noPrivate;
        members = this._mergeMembers(members, strategy);
        //@todo trait precendence/alias
        Array.prototype.push.apply(members, this._traitMembers(traits, p));
        return members;
    }
    _interfaceMembers(interfaces, predicate) {
        let members = [];
        let s;
        for (let n = 0; n < interfaces.length; ++n) {
            s = interfaces[n];
            if (s.children) {
                Array.prototype.push.apply(members, predicate ? s.children.filter(predicate) : s.children);
            }
        }
        return members;
    }
    _traitMembers(traits, predicate) {
        //@todo support trait precendence and alias here
        return this._interfaceMembers(traits, predicate);
    }
    _mergeMembers(symbols, strategy) {
        let map = {};
        let s;
        let mapped;
        if (strategy === 0 /* None */) {
            return symbols;
        }
        for (let n = 0; n < symbols.length; ++n) {
            s = symbols[n];
            mapped = map[s.name];
            if (!mapped ||
                ((mapped.modifiers & 256 /* Magic */) > 0 && !(s.modifiers & 256 /* Magic */)) || //always prefer non magic
                (strategy === 2 /* Documented */ && (!mapped.doc || this.hasInheritdoc(mapped.doc.description)) && s.doc) ||
                (strategy === 3 /* Base */)) {
                map[s.name] = s;
            }
        }
        return Object.keys(map).map((v) => { return map[v]; });
    }
    hasInheritdoc(description) {
        if (!description) {
            return false;
        }
        description = description.toLowerCase().trim();
        return description === '@inheritdoc' || description === '{@inheritdoc}';
    }
    _getAssociated() {
        if (this._associated) {
            return this._associated;
        }
        return this._associated = Array.from(this._associatedIterator());
    }
    _symbolsAssociatedReduce(accum, current) {
        if (current.associated) {
            Array.prototype.push.apply(accum, current.associated);
        }
        return accum;
    }
    *_associatedIterator() {
        let associated = new Set();
        let symbols;
        let queue = [];
        let stub;
        let s;
        if (Array.isArray(this._symbol)) {
            Array.prototype.push.apply(queue, this._symbol.reduce(this._symbolsAssociatedReduce, []));
        }
        else if (this._symbol.associated) {
            Array.prototype.push.apply(queue, this._symbol.associated);
        }
        let filterFn = (x) => {
            return symbol_1.PhpSymbol.isClassLike(x) && !associated.has(x);
        };
        while ((stub = queue.shift())) {
            if (this._excludeTraits && stub.kind === 4 /* Trait */) {
                continue;
            }
            symbols = this.symbolStore.find(stub.name, filterFn);
            for (let n = 0; n < symbols.length; ++n) {
                s = symbols[n];
                associated.add(s);
                if (s.associated) {
                    Array.prototype.push.apply(queue, s.associated);
                }
                yield s;
            }
        }
    }
    static create(symbolStore, fqn) {
        if (!fqn) {
            return null;
        }
        let symbols = symbolStore.find(fqn, symbol_1.PhpSymbol.isClassLike);
        if (!symbols.length) {
            return null;
        }
        else if (symbols.length === 1) {
            return new TypeAggregate(symbolStore, symbols[0]);
        }
        else {
            return new TypeAggregate(symbolStore, symbols);
        }
    }
}
exports.TypeAggregate = TypeAggregate;
