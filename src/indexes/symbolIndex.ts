import { NameIndex, KeysDelegate, Predicate, TreeVisitor, TreeTraverser } from "../types";
import { PhpSymbol, SymbolKind, SymbolModifier } from "../symbol";

export class SymbolIndex {
    static readonly NAMED_SYMBOL_KIND_MASK = SymbolKind.Namespace |
        SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait |
        SymbolKind.Method | SymbolKind.Function | SymbolKind.File;
    static readonly NAMED_SYMBOL_EXCLUDE_MODIFIERS = SymbolModifier.Magic;

    private _nameIndex: NameIndex<PhpSymbol>;
    private _namedSymbolIndex: NameIndex<PhpSymbol>;
    private _globalVariableIndex: PhpSymbol[] = [];
    private _id: number;

    static count = 0;

    constructor() {
        this._id = SymbolIndex.count++;
        this._nameIndex = new NameIndex<PhpSymbol>(SymbolIndex._symbolKeys);
        this._namedSymbolIndex = new NameIndex<PhpSymbol>(SymbolIndex._symbolUri);
    }

    index(root: PhpSymbol) {
        let traverser = new TreeTraverser([root]);
        let symbolIndexVisitor = new SymbolIndexVisitor();

        traverser.traverse(symbolIndexVisitor);

        this._nameIndex.addMany(symbolIndexVisitor.nameIndexSymbols);
        this._namedSymbolIndex.addMany(symbolIndexVisitor.namedSymbols);
        Array.prototype.push.apply(this._globalVariableIndex, symbolIndexVisitor.globalVariables);
    }

    removeMany(uri: string) {
        this._nameIndex.removeFromKey(uri);
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
            Set.prototype.add.apply(keys, s.name.split('\\').filter((s) => { return s.length > 0 }));
            return Array.from(keys);
        }

        return PhpSymbol.keys(s);
    }

    private static _symbolUri(s: PhpSymbol) {
        return [s.location.uri];
    }
}

export class SymbolIndexVisitor implements TreeVisitor<PhpSymbol> {
    public static readonly NAMED_SYMBOL_KIND_MASK = SymbolKind.Namespace |
        SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait |
        SymbolKind.Method | SymbolKind.Function | SymbolKind.File;
    public static readonly NAMED_SYMBOL_EXCLUDE_MODIFIERS = SymbolModifier.Magic;

    public nameIndexSymbols: PhpSymbol[] = [];
    public namedSymbols: PhpSymbol[] = [];
    public globalVariables: PhpSymbol[] = [];

    preorder(node: PhpSymbol, spine: PhpSymbol[]) {
        if (SymbolIndexVisitor._isNameIndex(node)) {
            this.nameIndexSymbols.push(node);
        }

        if (SymbolIndexVisitor._isNamedSymbol(node) && node.location) {            
            this.namedSymbols.push(node);
        }

        if (SymbolIndexVisitor._isGlobalVariables(node)) {
            this.globalVariables.push(node);
        }

        return true;
    }

    /**
     * No vars, params or symbols with use modifier
     * @param s 
     */
    private static _isNameIndex(s: PhpSymbol) {
        return !(s.kind & (SymbolKind.Parameter | SymbolKind.File)) && //no params or files
            !(s.modifiers & SymbolModifier.Use) && //no use
            !(s.kind === SymbolKind.Variable && s.location) && //no variables that have a location (in built globals have no loc)
            s.name.length > 0;
    }

    private static _isNamedSymbol(s: PhpSymbol) {
        return (s.kind & this.NAMED_SYMBOL_KIND_MASK) && !(s.modifiers & this.NAMED_SYMBOL_EXCLUDE_MODIFIERS);
    }

    private static _isGlobalVariables(s: PhpSymbol) {
        return s.kind === SymbolKind.GlobalVariable;
    }
}