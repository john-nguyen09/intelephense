import { NameIndex, Predicate, TreeVisitor, TreeTraverser } from "../types";
import { PhpSymbol, SymbolKind, SymbolModifier } from "../symbol";
import { BUILTIN_SYMBOLS_URI } from '../symbolStore';

export class SymbolIndex {
    private static _instance: SymbolIndex;

    private _nameIndex: NameIndex<PhpSymbol>;
    private _namedSymbolIndex: NameIndex<PhpSymbol>;
    private _globalVariableIndex: PhpSymbol[] = [];

    constructor() {
        this._nameIndex = new NameIndex<PhpSymbol>(SymbolIndex._symbolKeys);
        this._namedSymbolIndex = new NameIndex<PhpSymbol>(SymbolIndex._symbolUri);
    }

    index(root: PhpSymbol) {
        let traverser = new TreeTraverser([root]);
        let symbolIndexVisitor = new SymbolIndexVisitor();

        traverser.traverse(symbolIndexVisitor);

        this._namedSymbolIndex.addMany(symbolIndexVisitor.namedSymbols);
        this._nameIndex.addMany(symbolIndexVisitor.namedSymbols);
        Array.prototype.push.apply(this._globalVariableIndex, symbolIndexVisitor.globalVariables);
    }

    removeMany(uri: string) {
        let namedSymbols = this.getNamedSymbol(uri);

        this._nameIndex.removeMany(namedSymbols);
        this._namedSymbolIndex.removeFromKey(uri);
    }

    find(key: string) {
        return this._nameIndex.find(key);
    }

    filter(filter: Predicate<PhpSymbol>) {
        return this._nameIndex.filter(filter);
    }

    match(text: string) {
        return this._nameIndex.match(text);
    }

    getNamedSymbol(uri: string) {
        return this._namedSymbolIndex.find(uri);
    }

    getGlobalVariables() {
        return this._globalVariableIndex;
    }

    private static _symbolKeys(s: PhpSymbol) {
        if (s.kind === SymbolKind.Namespace) {
            let keys = new Set<string>();

            Set.prototype.add.apply(keys, s.name.split('\\').filter((s) => { return s && s.length > 0 }));
            return Array.from(keys);
        }

        return PhpSymbol.keys(s);
    }

    private static _symbolUri(s: PhpSymbol) {
        if (!s.location) {
            return [BUILTIN_SYMBOLS_URI];
        }

        return [s.location.uri];
    }
}

export class SymbolIndexVisitor implements TreeVisitor<PhpSymbol> {
    public static readonly NAMED_SYMBOL_KIND_MASK = SymbolKind.Namespace |
        SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait |
        SymbolKind.Method | SymbolKind.Function | SymbolKind.File |
        SymbolKind.Constant | SymbolKind.ClassConstant;
    public static readonly NAMED_SYMBOL_EXCLUDE_MODIFIERS = SymbolModifier.Magic;

    public namedSymbols: PhpSymbol[] = [];
    public globalVariables: PhpSymbol[] = [];

    preorder(node: PhpSymbol, spine: PhpSymbol[]) {
        if (SymbolIndexVisitor._isNamedSymbol(node)) {
            this.namedSymbols.push(node);
        }

        if (SymbolIndexVisitor._isGlobalVariables(node)) {
            this.globalVariables.push(node);
        }

        return true;
    }

    private static _isNamedSymbol(s: PhpSymbol) {
        return (s.kind & this.NAMED_SYMBOL_KIND_MASK) && !(s.modifiers & this.NAMED_SYMBOL_EXCLUDE_MODIFIERS);
    }

    private static _isGlobalVariables(s: PhpSymbol) {
        return s.kind === SymbolKind.GlobalVariable;
    }
}